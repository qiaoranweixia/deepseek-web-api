/**
 * 本地控制台的**页面**（由本地接口自己提供：`http://127.0.0.1:<端口>/`）。
 *
 * 为什么要有它：DSH 面板里的设置接口早就齐全，但那套接口**只有 DSH 自己的页面打得通**
 * （外部 curl 会撞同源守卫）。用户真正缺的是"一个端口把开关都管起来"，
 * 而不是再记一堆 curl/JSON —— 于是把同一套接口挂到本地端口上，再配这一页。
 *
 * 页面本身不引任何外部资源（离线可用、也不给本机页面留外链），
 * 调的就是面板那几条路由：/status、/gate、/context-mode、/api-server、/login/token、/logout、/usage。
 * 样式沿用面板那套令牌（`--dsw-alias-*`，缺失时回落到随系统主题切换的 --fb-*）。
 */

export const CONSOLE_TITLE = 'DeepSeek 网页版 · 本地控制台'

export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${CONSOLE_TITLE}</title>
<style>
:root{--fb-fg:#1f2329;--fb-fg2:#545b66;--fb-fg3:#8b93a3;--fb-bg1:#f6f7f9;--fb-bg2:#fff;--fb-bd:#e8eaee;--fb-bd2:#d7dae0;--fb-hover:#0000000f;--fb-code:#f3f4f6;
--fg:var(--dsw-alias-label-primary,var(--fb-fg));--fg2:var(--dsw-alias-label-secondary,var(--fb-fg2));--fg3:var(--dsw-alias-label-tertiary,var(--fb-fg3));
--bg1:var(--dsw-alias-bg-layer-1,var(--fb-bg1));--bg2:var(--dsw-alias-bg-layer-2,var(--fb-bg2));--bd:var(--dsw-alias-border-l1,var(--fb-bd));--bd2:var(--dsw-alias-border-l2,var(--fb-bd2));
--hover:var(--dsw-alias-interactive-bg-hover,var(--fb-hover));--code-bg:var(--dsw-alias-markdown-code-block,var(--fb-code));
--accent:var(--dsw-alias-brand-primary,#3b6ef0);--on-accent:var(--dsw-alias-label-primary-foreground,#fff);
--ok:var(--dsw-alias-state-success-primary,#1a9f5a);--warn:var(--dsw-alias-state-warn-label,#9a6a00);--err:var(--dsw-alias-state-error-primary,#d93025);
--mono:var(--dsw-alias-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
@media (prefers-color-scheme:dark){:root{--fb-fg:#ededed;--fb-fg2:#b6bcc6;--fb-fg3:#858c99;--fb-bg1:#212121;--fb-bg2:#2a2a2a;--fb-bd:#333;--fb-bd2:#3d3d3d;--fb-hover:#ffffff14;--fb-code:#1c1c1c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg1);color:var(--fg);font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:720px;margin:0 auto;padding:24px 20px 60px}
.title{font-size:16px;font-weight:600;letter-spacing:-.01em;margin:0 0 4px}
.sub{color:var(--fg2);font-size:12px;margin:0 0 20px}
.card{background:var(--bg2);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin:0 0 14px}
.head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;margin:0 0 10px}
.badge{font-size:11px;font-weight:500;padding:1px 9px;border-radius:999px;white-space:nowrap}
.badge.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 15%,transparent)}
.badge.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 16%,transparent)}
.badge.err{color:var(--err);background:color-mix(in srgb,var(--err) 14%,transparent)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:0 12px;margin:0}
.kv>*{padding:5px 0;border-top:1px solid var(--bd);min-width:0}
.kv>:nth-child(1),.kv>:nth-child(2){border-top:none;padding-top:0}
.kv .k{color:var(--fg2);font-size:12px;white-space:nowrap}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 0}
.btn{font:inherit;font-size:12px;font-weight:500;padding:6px 13px;border-radius:8px;border:1px solid transparent;background:var(--accent);color:var(--on-accent);cursor:pointer}
.btn.ghost{background:transparent;border-color:var(--bd2);color:var(--fg)}
.btn.ghost:hover{background:var(--hover)}
.btn.danger{background:transparent;border-color:var(--bd2);color:var(--err)}
.btn.armed{background:var(--err);border-color:var(--err);color:#fff}
.btn:disabled{opacity:.45;cursor:not-allowed}
.seg{display:inline-flex;gap:2px;padding:3px;border-radius:999px;background:var(--bg1);border:1px solid var(--bd)}
.seg button{appearance:none;border:0;background:transparent;font:inherit;font-size:12px;font-weight:500;color:var(--fg2);padding:4px 14px;border-radius:999px;cursor:pointer}
.seg button.active{background:var(--bg2);color:var(--fg);font-weight:600;box-shadow:inset 0 0 0 1px var(--bd2)}
.input,textarea{font:inherit;font-size:12.5px;background:var(--bg1);color:var(--fg);border:1px solid var(--bd2);border-radius:8px;padding:7px 10px;outline:none}
textarea{width:100%;min-height:56px;font-family:var(--mono);font-size:12px;resize:vertical}
.hint{color:var(--fg3);font-size:12px;margin:8px 0 0}
.code{font-family:var(--mono);font-size:12px;background:var(--code-bg);border:1px solid var(--bd);border-radius:6px;padding:6px 8px;overflow-x:auto}
.msg{margin:0 0 14px;padding:10px 12px;border-radius:8px;background:var(--bg2);border:1px solid var(--bd);border-left:3px solid var(--fg3);white-space:pre-wrap;font-size:12px}
.msg.ok{border-left-color:var(--ok)}.msg.err{border-left-color:var(--err)}
.switch{display:inline-flex;align-items:center;gap:9px;font-size:13px;cursor:pointer;user-select:none}
.switch input{position:absolute;opacity:0;width:0;height:0}
.track{width:34px;height:20px;border-radius:999px;background:var(--bd2);position:relative;transition:background-color .18s;flex:0 0 auto}
.track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .18s}
.switch input:checked+.track{background:var(--accent)}
.switch input:checked+.track::after{transform:translateX(14px)}
[hidden]{display:none!important}
</style>
</head>
<body>
<div class="wrap">
  <h1 class="title">DeepSeek 网页版 · 本地控制台</h1>
  <p class="sub">这个页面是插件自己提供的（就长在本地接口那个端口上）。改动即时生效，和 DSH 设置页共用同一份配置。</p>

  <div id="alert" class="msg" hidden></div>

  <section class="card">
    <div class="head">账号 <span id="acctBadge" class="badge">读取中…</span></div>
    <div class="kv" id="acctKv"></div>
    <p class="hint">取 token：在<strong>已登录 chat.deepseek.com</strong> 的那个浏览器里按 F12 → Console，
      粘贴下面这行（点右边按钮复制），回车后会打印出一串字符 —— <strong>那串字符才是 token</strong>，
      把它粘回上面的输入框。</p>
    <div class="code" id="tokenCmd">JSON.parse(localStorage.getItem('userToken')).value</div>
    <div class="row"><textarea id="tokenInput" placeholder="在这里粘贴刚才打印出来的那一串（只有字母数字，没有引号/括号/中文）"></textarea></div>
    <div class="row">
      <button class="btn" id="tokenBtn">保存并验证</button>
      <button class="btn ghost" id="copyCmdBtn">复制上面那行命令</button>
      <button class="btn danger" id="logoutBtn">退出当前账号</button>
      <span class="hint" style="margin:0">凭证与 DSH 面板共用同一份；退出 = 删除本机凭证</span>
    </div>
    <div class="row">
      <button class="btn ghost" id="browserBtn">开浏览器窗口登录（不用 token）</button>
      <span class="hint" style="margin:0">会弹出一个<strong>独立 profile</strong> 的 Edge/Chrome 窗口
        （不碰你日常浏览器的 cookie），在里面正常登录、窗口自己关掉就完成了</span>
    </div>
  </section>

  <section class="card">
    <div class="head">会话清理（网页端那些临时对话删不删）</div>
    <div class="row"><span class="seg" id="cleanupSeg"></span></div>
    <p class="hint" id="cleanupHint"></p>
  </section>

  <section class="card">
    <div class="head">上下文投喂</div>
    <div class="row"><span class="seg" id="contextSeg"></span></div>
    <p class="hint" id="contextHint"></p>
  </section>

  <section class="card">
    <div class="head">请求节流（防风控）</div>
    <div class="row">
      <label class="switch"><input type="checkbox" id="allowConcurrent"><span class="track"></span>允许并发（不推荐）</label>
    </div>
    <div class="row">
      <span class="hint" style="margin:0">间隔</span>
      <input class="input" id="minMs" type="number" step="100" style="width:110px">
      <span class="hint" style="margin:0">~</span>
      <input class="input" id="maxMs" type="number" step="100" style="width:110px">
      <span class="hint" style="margin:0">毫秒（区间内随机）</span>
      <button class="btn" id="gateBtn">保存</button>
    </div>
  </section>

  <section class="card">
    <div class="head">本地接口</div>
    <div class="row">
      <label class="switch"><input type="checkbox" id="relayEnabled"><span class="track"></span>开启</label>
      <span class="hint" style="margin:0">端口</span><input class="input" id="relayPort" type="number" style="width:100px">
      <span class="hint" style="margin:0">本地 key</span><input class="input" id="relayKey" type="text" style="width:150px" placeholder="留空 = 不校验">
      <button class="btn" id="relayBtn">保存</button>
    </div>
    <p class="hint" id="relayHint"></p>
  </section>

  <section class="card">
    <div class="head">今天用量</div>
    <div class="kv" id="usageKv"></div>
  </section>

  <p class="hint" id="paths"></p>
</div>
<script>
var API = '/deepseek-web-login/api';
var KEY = new URLSearchParams(location.search).get('key') || '';
var state = { gate: null, context: null, relay: null, status: null };

function headers() { return KEY ? { 'content-type': 'application/json', authorization: 'Bearer ' + KEY } : { 'content-type': 'application/json' }; }
function call(path, init) { return fetch(API + path, Object.assign({ headers: headers() }, init || {})).then(function (r) { return r.json(); }); }
function post(path, body) { return call(path, { method: 'POST', body: JSON.stringify(body) }); }
function say(text, kind) { var el = document.getElementById('alert'); el.textContent = text; el.className = 'msg' + (kind ? ' ' + kind : ''); el.hidden = !text; }
function seg(node, options, current, onPick) {
  node.textContent = '';
  options.forEach(function (item) {
    var b = document.createElement('button');
    b.textContent = item.label;
    b.title = item.title || '';
    if (item.value === current) b.className = 'active';
    b.onclick = function () { onPick(item.value); };
    node.appendChild(b);
  });
}
function kv(node, rows) {
  node.textContent = '';
  rows.forEach(function (pair) {
    var k = document.createElement('div'); k.className = 'k'; k.textContent = pair[0];
    var v = document.createElement('div'); v.textContent = pair[1];
    node.appendChild(k); node.appendChild(v);
  });
}

function render() {
  var st = state.status || {};
  var auth = st.auth || {};
  var badge = document.getElementById('acctBadge');
  badge.textContent = auth.loggedIn ? (auth.unverified ? '未校验' : '已登录') : '未登录';
  badge.className = 'badge ' + (auth.loggedIn ? (auth.unverified ? 'warn' : 'ok') : 'err');
  kv(document.getElementById('acctKv'), [
    ['账号', auth.display || '（未识别）'],
    ['登录态', auth.loggedIn ? (auth.lastVerifyError && auth.lastVerifyError.message ? '需要重新登录：' + auth.lastVerifyError.message : '可用') : '没有凭证'],
    ['传输层', st.config && st.config.version ? 'v' + st.config.version : '—'],
  ]);

  var gate = state.gate || {};
  seg(document.getElementById('cleanupSeg'), [
    { value: 'immediate', label: '立即删', title: '每次调用结束后约 1.5 秒删掉临时会话' },
    { value: 'deferred', label: '攒批删', title: '攒够几个或等一会儿批量删（默认）' },
    { value: 'keep', label: '不删', title: '网页端的临时会话全部保留' },
  ], gate.sessionCleanup, function (value) { post('/gate', { sessionCleanup: value }).then(load); });
  document.getElementById('cleanupHint').textContent = gate.sessionCleanup === 'keep'
    ? '当前：不删 —— 网页端会攒出一串对话（每 20 轮左右换一个新会话，旧的不删）。'
    : gate.sessionCleanup === 'immediate'
      ? '当前：立即删 —— 用完就删，网页端基本只看到最新的。'
      : '当前：攒批删（默认）—— 攒 ' + ((gate.cleanupBatch && gate.cleanupBatch.min) || 6) + '~' + ((gate.cleanupBatch && gate.cleanupBatch.max) || 10) + ' 个或等 ' + Math.round(((gate.cleanupDelayMs && gate.cleanupDelayMs.min) || 60000) / 1000) + '~' + Math.round(((gate.cleanupDelayMs && gate.cleanupDelayMs.max) || 120000) / 1000) + ' 秒后批量删除。';

  seg(document.getElementById('contextSeg'), [
    { value: 'full', label: '每轮全量', title: '每轮重发整段历史（默认，最稳）' },
    { value: 'chained', label: '链式增量', title: '只发新增内容，历史交给服务端维护（请求更小，网页端看起来像正常对话）' },
  ], state.context && state.context.mode, function (value) { post('/context-mode', { mode: value }).then(load); });
  document.getElementById('contextHint').textContent = (state.context && state.context.hint) || '';

  document.getElementById('allowConcurrent').checked = gate.allowConcurrent === true;
  document.getElementById('minMs').value = gate.minRequestIntervalMs != null ? gate.minRequestIntervalMs : 2000;
  document.getElementById('maxMs').value = gate.maxRequestIntervalMs != null ? gate.maxRequestIntervalMs : 4000;

  var relay = state.relay || {};
  document.getElementById('relayEnabled').checked = relay.enabled !== false;
  document.getElementById('relayPort').value = relay.port != null ? relay.port : 8788;
  document.getElementById('relayKey').value = relay.key || '';
  document.getElementById('relayHint').textContent = '当前监听：' + (relay.running ? 'http://127.0.0.1:' + relay.effectivePort + '/v1' : '未运行')
    + '（只监听本机；改端口/key/开关后立即重绑，端口变了就用新地址重开这个页面）';

  var paths = st.paths || {};
  document.getElementById('paths').textContent = paths.webLogin ? '配置目录：' + paths.webLogin : '';
}

function load() {
  return Promise.all([call('/status'), call('/gate'), call('/context-mode'), call('/api-server')]).then(function (r) {
    state.status = r[0]; state.gate = r[1]; state.context = r[2]; state.relay = r[3];
    render();
  }).catch(function (error) { say('读取设置失败：' + error.message, 'err'); });
}

document.getElementById('tokenBtn').onclick = function () {
  var token = document.getElementById('tokenInput').value.trim();
  if (!token) { say('先粘贴 userToken —— 浏览器 F12 → Console 执行输入框里那行命令，把打印结果贴进来', 'err'); return; }
  say('正在校验 token……');
  post('/login/token', { token: token }).then(function (result) {
    say(result && result.ok ? '凭证已保存：' + (result.display || '') + (result.error ? '（' + result.error + '）' : '') : '登录失败：' + ((result && result.error) || '未知原因'), result && result.ok ? 'ok' : 'err');
    if (result && result.ok) document.getElementById('tokenInput').value = '';
    return load();
  });
};

document.getElementById('copyCmdBtn').onclick = function () {
  var cmd = "JSON.parse(localStorage.getItem('userToken')).value";
  var done = function (ok) { say(ok ? '已复制命令 —— 去浏览器 F12 → Console 粘贴、回车，把打印出来的那串粘回来' : '复制失败：请手动选中上面那行命令再按 Ctrl+C', ok ? 'ok' : 'err'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(cmd).then(function () { done(true); }, function () { done(false); });
  } else { done(false); }
};

document.getElementById('browserBtn').onclick = function () {
  var btn = document.getElementById('browserBtn');
  btn.disabled = true;
  say('正在打开登录窗口……在里面登录 chat.deepseek.com（手机号/邮箱/验证码都行），登录成功后窗口会自己关闭 —— 这期间**这个页面别关**。');
  post('/login/browser', { fresh: true }).then(function (result) {
    var ok = result && (result.ok === true || result.started === true || result.mode === 'window');
    say(ok ? '登录完成：' + (result.display || '') + (result.message ? '（' + result.message + '）' : '') : '登录没完成：' + ((result && (result.message || result.reason)) || '未知原因'), ok ? 'ok' : 'err');
    btn.disabled = false;
    return load();
  }).catch(function (error) {
    say('登录请求失败：' + error.message + '（若浏览器里提示"使用环境异常"，改用下面的 token 那条路）', 'err');
    btn.disabled = false;
  });
};

var armed = false;
var logoutBtn = document.getElementById('logoutBtn');
logoutBtn.onclick = function () {
  if (!armed) { armed = true; logoutBtn.className = 'btn armed'; logoutBtn.textContent = '确认退出？'; setTimeout(function () { armed = false; logoutBtn.className = 'btn danger'; logoutBtn.textContent = '退出当前账号'; }, 4000); return; }
  armed = false; logoutBtn.className = 'btn danger'; logoutBtn.textContent = '退出当前账号';
  post('/logout', {}).then(function () { say('已退出：本机凭证已删除。', 'ok'); return load(); });
};

document.getElementById('gateBtn').onclick = function () {
  post('/gate', {
    allowConcurrent: document.getElementById('allowConcurrent').checked,
    minRequestIntervalMs: Number(document.getElementById('minMs').value),
    maxRequestIntervalMs: Number(document.getElementById('maxMs').value),
  }).then(function (result) {
    say(result && result.ok !== false ? '节流设置已保存（即时生效）' : '保存失败：' + ((result && result.error) || ''), result && result.ok !== false ? 'ok' : 'err');
    return load();
  });
};

document.getElementById('relayBtn').onclick = function () {
  post('/api-server', {
    enabled: document.getElementById('relayEnabled').checked,
    port: Number(document.getElementById('relayPort').value),
    key: document.getElementById('relayKey').value,
  }).then(function (result) {
    say(result && result.ok ? '本地接口设置已保存' + (result.effectivePort && result.effectivePort !== Number(document.getElementById('relayPort').value) ? '（实际用了 ' + result.effectivePort + ' 端口，用新地址重开本页）' : '') : '保存失败：' + ((result && result.error) || ''), result && result.ok ? 'ok' : 'err');
    return load();
  });
};

load().then(function () {
  return call('/usage?days=1').then(function (usage) {
    var t = usage.totals || {};
    var rows = [
      ['调用次数', String(t.calls != null ? t.calls : '—') + (t.failed ? '（失败 ' + t.failed + '）' : '')],
      ['输入 token', String(t.in != null ? t.in : '—')],
      ['输出 token', String(t.out != null ? t.out : '—')],
    ];
    kv(document.getElementById('usageKv'), rows);
  }).catch(function () { kv(document.getElementById('usageKv'), [['用量', '暂时读不到（不影响使用）']]); });
});
</script>
</body>
</html>
`
