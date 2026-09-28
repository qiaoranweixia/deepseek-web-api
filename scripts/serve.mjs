#!/usr/bin/env node
/**
 * 独立启动器 —— 不开 DSH，直接在终端里把本地 OpenAI 兼容接口跑起来。
 *
 *   node scripts/serve.mjs                     # 按 api-server.json 启动（没有该文件就用默认 8788）
 *   node scripts/serve.mjs --enable            # 配置里写着关？顺手打开（写的和面板是同一个开关）
 *   node scripts/serve.mjs --token <userToken> # 没有 DSH 面板时：贴 token 直接登录（可再加 --cookie）
 *   node scripts/serve.mjs --login            # 同上，但会先帮你打开浏览器并提示怎么取 token（回车粘贴）
 *   node scripts/serve.mjs --token-file <路径> # 控制台粘贴不灵时：把 token 存成 txt，让启动器读
 *   node scripts/serve.mjs --port 8899         # 临时换端口（不写配置，只影响本次运行）
 *   node scripts/serve.mjs --help
 *
 * 为什么能这么短：宿主包 `lib/index.js` 是**自包含**的，`apply()` 只依赖几个宿主能力
 * （llm / webServer / effect / get）。这里喂最小替身，于是请求闸门、账号库、会话清理、
 * 调用台账、登录态探活全都还是**同一份实现** —— 不存在"源码里是一套、启动器里又一套"。
 *
 * ⚠️ 两件事必须写在明面上（启动横幅里也会再打一次）：
 *  1. 没有 Electron 就没有 `net.fetch` ⇒ 传输层只能走 Node，指纹不如在 DSH 里跑；
 *     长期高频用，还是建议在 DSH 里开这个接口。
 *  2. 闸门是**进程内**的：DSH 里那份插件如果正在用同一个账号跑任务，两边各排各的队，
 *     极端情况下会撞上「同一账号并发生成」（那正是封号那件事）。要么只留一边，要么用不同账号。
 *     如果 DSH 那份插件已经把接口开着了，这个脚本会**检测到并直接退出**，不会起第二个。
 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOST_BUNDLE = join(ROOT, 'lib', 'index.js')
const argv = process.argv.slice(2)

function printUsage() {
  console.log(`用法: node scripts/serve.mjs [--enable] [--port <端口>] [--login | --token <值> | --token-file <路径>] [--cookie <cookie>]

  （无参数）      按配置启动本地接口；配置不存在就用 8788 + 不校验 key
  --enable        若配置里写着 enabled:false，就把它改成 true 再启动
  --login         帮你打开 chat.deepseek.com（用你**日常浏览器**，Edge 上已经登着就省事了），
                  按屏幕提示在 F12 控制台里取一行 token 贴回来 —— 不回显、不进聊天记录
  --token <值>    手动登录（凭证写进账号库，和 DSH 面板共用同一份）。拿法：在浏览器登录
                  chat.deepseek.com → F12 → Console 执行
                    JSON.parse(localStorage.getItem('userToken')).value
                  把打印出来的结果整串贴进来（包装 JSON 或裸 token 都认）
  --token-file <路径>  同上，但从文件第一行读 —— 控制台里 Ctrl+V 没反应（老 conhost）时用这条：
                  notepad %USERPROFILE%\\ds-token.txt → 粘进去保存 → 再跑本命令
  --port <端口>   本次运行临时换端口（不改 api-server.json；端口被占照样会顺延）
  --cookie <值>   可选，形如 name=value; name2=value2（浏览器里 document.cookie）
  --help          这份说明

配置/日志目录：\${DSH_HOME || ~/.dsh}/web-login/
登录：凭证与 DSH 面板共用 —— 面板里登过就不用再登；没有面板时用 --token。`)
}

if (argv.includes('--help') || argv.includes('-h')) {
  printUsage()
  process.exit(0)
}

if (!existsSync(HOST_BUNDLE)) {
  console.error(`[serve] 找不到宿主产物 ${HOST_BUNDLE}`)
  console.error('[serve] 先在包目录构建一次：node scripts/build.mjs（若缺依赖先 npm ci）')
  process.exit(1)
}

const { apply, readRelayConfig, writeRelayConfig, normalizeRelayConfig, relaySettingsPath, loginWithToken } =
  await import(pathToFileURL(HOST_BUNDLE).href)

/** 取 `--flag value` 形式的值（缺值就当没给，别把下一个参数吞掉）。 */
function flagValue(name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

/** 用日常浏览器打开一个网址（登录那条路靠它 —— 插件自己的窗口是独立 profile，借不到你的 Edge 登录态）。 */
function openInBrowser(url) {
  // 测试/自动化里别真开浏览器窗口（也顺手留个"我不想它弹窗"的开关）
  if (process.env.DSWL_NO_BROWSER === '1') return true
  try {
    const [command, args] =
      process.platform === 'win32'
        ? // rundll32 直接把 URL 交给默认浏览器就返回；走 cmd /c start 会多留一个 cmd 进程挂在浏览器上
          ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    spawn(command, args, { stdio: 'ignore', detached: true }).unref()
    return true
  } catch {
    return false
  }
}

/** 读一行输入且**不回显**（token 是完整可登录凭证，别留在终端回滚缓冲里）。 */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = () => {}
    process.stdout.write(question)
    rl.question('', (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(String(answer ?? '').trim())
    })
  })
}

let tokenInput = flagValue('--token')
const tokenFile = flagValue('--token-file')
if (!tokenInput && tokenFile) {
  const { readFileSync } = await import('node:fs')
  try {
    // 控制台粘贴不灵（老 conhost 的 Ctrl+V）时走这条：记事本存成 txt，这里只读第一行
    tokenInput = readFileSync(tokenFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim()
    console.log(`[serve] 已从 ${tokenFile} 读到 ${tokenInput.length} 个字符`)
    console.log('[serve] 提醒：这个 txt 里是可登录凭证，用完请删掉它（.gitignore 已挡住，但别留着）。')
  } catch (error) {
    console.error(`[serve] 读不了 ${tokenFile}：${error?.message ?? error}`)
    process.exit(1)
  }
}

if (!tokenInput && argv.includes('--login')) {
  const url = 'https://chat.deepseek.com'
  const opened = openInBrowser(url)
  console.log(`[serve] ${opened ? '已用你的默认浏览器打开' : '请手动打开'} ${url}（日常浏览器里登着就直接用）`)
  console.log("[serve] 按 F12 → Console，执行下面这行，再把打印出来的结果贴到这里回车：")
  console.log("          JSON.parse(localStorage.getItem('userToken')).value")
  console.log('[serve] 提示：粘贴时看不到字符是正常的（刻意不回显）；Ctrl+V 没反应就改用**右键**粘贴，')
  console.log('[serve]       或者把 token 存成 txt，改用 --token-file <路径>。')
  tokenInput = await askHidden('[serve] 粘贴 userToken 后按回车（不回显）: ')
  if (!tokenInput) {
    console.error('[serve] 没收到 token，已取消。')
    process.exit(1)
  }
  // 看不到回显是刻意的 ⇒ 这里必须给一个"收到了"的凭据，
  // 否则"粘上了"和"没粘上"在屏幕上长得一模一样（用户实测反馈过）。
  console.log(`[serve] 收到 ${tokenInput.length} 个字符，正在校验……`)
}

if (tokenInput) {
  // 实测仅凭 Bearer token 就能完成校验 / PoW / 生成（见 README 的「手动粘贴 Token」）；
  // 真要带 cookie 就用 --cookie 显式给，别在交互里多问一句。
  const result = await loginWithToken(tokenInput, flagValue('--cookie'), {
    info: (m) => console.log(`[插件] ${m}`),
  })
  if (!result?.ok) {
    console.error(`[serve] 登录失败：${result?.error ?? '未知原因'}`)
    process.exit(1)
  }
  console.log(`[serve] 凭证已保存${result.display ? `（${result.display}）` : ''}${result.error ? ` —— ${result.error}` : ''}`)
}

// 生效值 = 文件 > 启动器的意图（默认开），合并规则直接借插件那套 —— 不在这里再写一遍
const fileConfig = readRelayConfig() ?? {}
const wantsEnable = argv.includes('--enable')
if (fileConfig.enabled === false && !wantsEnable) {
  console.error('[serve] 接口在配置里是关着的（api-server.json: enabled:false）。')
  console.error('[serve] 打开它：node scripts/serve.mjs --enable')
  console.error(`[serve] 配置文件：${relaySettingsPath()}`)
  process.exit(1)
}
const effective = normalizeRelayConfig({ enabled: true, ...fileConfig, ...(wantsEnable ? { enabled: true } : {}) })
// `--port`：只影响**本次运行**，不写配置文件（用户想在别的端口上并排跑一份时用）
const portOverride = Number(flagValue('--port'))
const hasPortOverride = Number.isFinite(portOverride) && portOverride > 0
if (hasPortOverride) {
  effective.port = Math.floor(portOverride)
  console.log(`[serve] 本次运行临时使用端口 ${effective.port}（不改配置文件）`)
}
if (wantsEnable && fileConfig.enabled !== true) {
  try {
    writeRelayConfig({ ...effective, enabled: true })
    console.log(`[serve] 已把 ${relaySettingsPath()} 里的 enabled 写成 true`)
  } catch (error) {
    console.warn(`[serve] 写配置失败（不影响本次启动）：${error?.message ?? error}`)
  }
}

/**
 * 探一下某个端口上是不是**我们自己**的接口。
 * 为什么不看进程列表：用户可能已经开着 DSH（插件自带接口），那是最常见的情况，
 * 而端口探测能顺带把"它到底在哪个端口"问出来（端口被占时插件会顺延）。
 */
async function probePort(port, timeoutMs = 600) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return undefined
    const body = await response.json()
    return body?.provider === 'deepseek-web' ? body : undefined
  } catch {
    return undefined
  }
}

/** 在 port..port+9 里找已经活着的接口（插件顺延最多 10 个，范围对齐它）。 */
async function findLive(basePort) {
  for (let i = 0; i < 10; i += 1) {
    const port = basePort + i
    const info = await probePort(port)
    if (info) return { port, info }
  }
  return undefined
}

function printFillIn(port, info) {
  const models = Array.isArray(info?.models) && info.models.length > 0 ? info.models.join(' / ') : 'deepseek-chat / deepseek-reasoner'
  console.log('')
  console.log('================ 本地接口已就绪 ================')
  console.log(`  地址   http://127.0.0.1:${port}/v1`)
  console.log(`  模型   ${models}`)
  console.log(`  Key    ${effective.key ? '用你在 api-server.json 里设的那个' : '留空（没设 key）'}`)
  console.log('  自检   curl.exe http://127.0.0.1:' + port + '/healthz')
  console.log(`  配置   ${relaySettingsPath()}`)
  console.log('  传输   node（独立进程拿不到 Chromium 网络栈 —— 指纹不如在 DSH 里跑）')
  console.log('  ⚠️    这个窗口别关；Ctrl+C 停止。别让 DSH 同时用同一个账号跑任务。')
  console.log('===============================================')
}

const already = await findLive(effective.port)
if (already) {
  console.log(`[serve] 接口已经在跑了：http://127.0.0.1:${already.port}/v1`)
  console.log('[serve] （多半是 DSH 里的插件，或另一个启动器窗口）—— 不会起第二个。')
  printFillIn(already.port, already.info)
  process.exit(0)
}

/** 插件日志原样转发（只把多行的 require 栈压成一行，免得黑窗口被噪音刷掉）。 */
const forward = (message) => String(message ?? '').replace(/^deepseek-web: /, '[插件] ').replace(/\s*\n\s*/g, ' / ')

const disposers = []
const ctx = {
  logger: {
    info: (message) => console.log(forward(message)),
    warn: (message) => console.warn(forward(message)),
  },
  // 宿主用它挂副作用（探活循环 / 本地接口 / 退出收尾）；收集起来，Ctrl+C 时按逆序执行
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  get: () => undefined, // 没有 DSH 的附件服务 ⇒ 本地接口本来也不接收图片
  llm: { registerAdapter() {} },
  webServer: { register() {} },
}

try {
  // force：命令行说了算 —— 否则 api-server.json 里的旧端口会把 --port 悄悄盖掉（实测踩过）
  apply(ctx, { apiServer: { enabled: true, ...(hasPortOverride ? { port: effective.port, force: true } : {}) } })
} catch (error) {
  console.error(`[serve] 启动失败：${error?.message ?? error}`)
  process.exit(1)
}

// 等它真的能应答（而不是"apply 返回了"就宣布成功）——
// 端口被占时插件会顺延，所以这里在同一个范围内找。
let live
for (let i = 0; i < 50 && !live; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100))
  live = await findLive(effective.port)
}
if (!live) {
  console.error('[serve] 接口没起来 —— 上面几行插件日志里应该有原因（端口占满 / 环境不允许监听）。')
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch {}
  }
  process.exit(1)
}

printFillIn(live.port, live.info)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[serve] 正在收尾（把待删的网页端会话交出去）……')
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {}
    }
    setTimeout(() => process.exit(0), 300)
  })
}
