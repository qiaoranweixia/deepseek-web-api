/**
 * 独立启动器（scripts/serve.mjs）回归 —— 不开 DSH 把接口跑起来。
 *
 * 为什么值得单独守：这是**用户真正会双击的那条路**（start-api.cmd → serve.mjs → lib/index.js），
 * 而"源码是对的、产物/入口没接上"正是本仓库反复踩的坑（0.1.82 的 P0-1 就是这样漏到线上的）。
 * 所以这里不看源码字符串，直接**起进程 + 打 HTTP**。
 *
 * 用法: node tests/check-serve.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const HOME = mkdtempSync(join(tmpdir(), 'dswl-serve-'))
process.env.DSH_HOME = HOME

const { readRelayConfig, writeRelayConfig, relaySettingsPath } = await import('../src/api-server.ts')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`)
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

/** 让系统挑一个当前空闲的端口（起一个服务器拿端口，再关掉）。 */
async function freePort() {
  const probe = createServer(() => {})
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function startLauncher(args = [], { stdin } = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'scripts', 'serve.mjs'), ...args], {
    cwd: ROOT,
    // DSWL_NO_BROWSER：别在跑用例时真弹出浏览器窗口（--login 那条会用日常浏览器）
    env: { ...process.env, DSH_HOME: HOME, DSWL_NO_BROWSER: '1' },
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  if (stdin !== undefined) child.stdin.end(stdin)
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    output += String(chunk)
  })
  return { child, output: () => output }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill() // Windows 上这一步是硬终止；Ctrl+C 那条优雅路径由人用，不在这里测
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function healthz(port, timeoutMs = 600) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  }
}

async function waitForHealthz(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const body = await healthz(port)
    if (body?.provider === 'deepseek-web') return body
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return undefined
}

await test('起得来：按 api-server.json 的端口监听，/healthz 与 /v1/models 都能答', async () => {
  const port = await freePort()
  writeRelayConfig({ enabled: true, port, key: '' })
  const launcher = startLauncher()
  try {
    const info = await waitForHealthz(port)
    assert.ok(info, `等了 20 秒没等到接口就绪。启动器输出：\n${launcher.output()}`)
    assert.deepEqual(info.models, ['deepseek-chat', 'deepseek-reasoner'])
    // 客户端要用的那条地址必须在横幅里印出来（不然用户不知道该填什么）
    assert.match(launcher.output(), new RegExp(`http://127\\.0\\.0\\.1:${port}/v1`))
    const models = await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json())
    assert.deepEqual(
      models.data.map((model) => model.id),
      ['deepseek-chat', 'deepseek-reasoner'],
    )
  } finally {
    await stopChild(launcher.child)
  }
})

await test('控制台：一个端口就能改设置（GET / 出页面，GET /deepseek-web-login/api/gate 出真实设置）', async () => {
  const port = await freePort()
  writeRelayConfig({ enabled: true, port, key: '' })
  const launcher = startLauncher()
  try {
    assert.ok(await waitForHealthz(port), `接口没起来：\n${launcher.output()}`)
    const page = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    assert.match(html, /本地控制台/)
    for (const label of ['会话清理', '上下文投喂', '请求节流', '本地接口']) {
      assert.ok(html.includes(label), `页面上应该有「${label}」这一块`)
    }
    // ⚠️ 页面"渲染得出来"不等于"脚本跑得起来"：2026-09-28 就栽过一次
    //    （JS 里一处没转义的引号让整段脚本语法错误 → 页面永远停在"读取中…"，
    //     而只查字符串的断言全绿）。这里必须真的编译一遍。
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
    assert.ok(script && script.length > 500, '页面必须带脚本')
    assert.doesNotThrow(() => new Function(script), '控制台脚本必须能通过语法编译')
    // 管理接口走的是**真身**（DSH 面板那套 handler），不是替身
    const gate = await fetch(`http://127.0.0.1:${port}/deepseek-web-login/api/gate`).then((response) => response.json())
    assert.ok(gate.sessionCleanup !== undefined, `设置接口要回真实设置，实际：${JSON.stringify(gate).slice(0, 120)}`)
  } finally {
    await stopChild(launcher.child)
  }
})

await test('已经在跑就不起第二个（端口上是我们自己的接口 ⇒ 直接退出 0）', async () => {
  const port = await freePort()
  writeRelayConfig({ enabled: true, port, key: '' })
  const first = startLauncher()
  try {
    assert.ok(await waitForHealthz(port), '自证：第一个实例确实起来了')
    const second = startLauncher()
    const code = await new Promise((resolve) => second.child.once('exit', resolve))
    assert.equal(code, 0, `第二实例应安静退出，实际 exit=${code}\n${second.output()}`)
    assert.match(second.output(), /已经在跑/)
    assert.ok(await healthz(port), '原来那个必须还活着（不能被第二个顶掉）')
  } finally {
    await stopChild(first.child)
  }
})

await test('配置里写着关：不启动，并明确告诉用户怎么开（不静默按默认值跑）', async () => {
  const port = await freePort()
  writeRelayConfig({ enabled: false, port, key: '' })
  const launcher = startLauncher()
  try {
    const code = await new Promise((resolve) => launcher.child.once('exit', resolve))
    assert.notEqual(code, 0, '关着的时候必须以非 0 退出（否则批处理会当成成功）')
    assert.match(launcher.output(), /--enable/)
    assert.equal(await healthz(port), undefined, '不应该有任何东西在监听')
  } finally {
    await stopChild(launcher.child)
  }
})

await test('--enable：把开关写回同一个文件（面板看到的是同一份设置），然后正常启动', async () => {
  const port = await freePort()
  writeRelayConfig({ enabled: false, port, key: '' })
  const launcher = startLauncher(['--enable'])
  try {
    assert.ok(await waitForHealthz(port), `--enable 之后应当能起来。输出：\n${launcher.output()}`)
    assert.equal(readRelayConfig().enabled, true, '开关注定要落盘 —— 和面板的开关是同一份')
  } finally {
    await stopChild(launcher.child)
  }
})

await test('--token：明显不合法时**还没联网**就报错退出（不把垃圾凭证写进账号库）', async () => {
  const port = await freePort()
  writeRelayConfig({ enabled: true, port, key: '' })
  const launcher = startLauncher(['--token', '短'])
  try {
    const code = await new Promise((resolve) => launcher.child.once('exit', resolve))
    assert.notEqual(code, 0, '登录失败必须非 0 退出（批处理才不会当成功）')
    assert.match(launcher.output(), /token 太短/)
    assert.equal(await healthz(port), undefined, '登录失败就不该继续把接口跑起来')
  } finally {
    await stopChild(launcher.child)
  }
})

await test('--login：交互提示能拿到输入（管道喂一个坏 token ⇒ 同样是"联网前就报错"）', async () => {
  const port = await freePort()
  writeRelayConfig({ enabled: true, port, key: '' })
  const launcher = startLauncher(['--login'], { stdin: '短\n' })
  try {
    const code = await new Promise((resolve) => launcher.child.once('exit', resolve))
    assert.notEqual(code, 0)
    assert.match(launcher.output(), /token 太短/)
    assert.match(launcher.output(), /userToken/) // 提示语里必须告诉用户去哪取（F12 那行）
    assert.match(launcher.output(), /收到 \d+ 个字符/) // 不回显 ⇒ 必须给"收到了"的凭据
    assert.equal(await healthz(port), undefined)
  } finally {
    await stopChild(launcher.child)
  }
})

await test('--token-file：从文件读（控制台粘贴不灵时的退路），坏输入同样在联网前拦下', async () => {
  const port = await freePort()
  writeRelayConfig({ enabled: true, port, key: '' })
  const tokenPath = join(HOME, 'ds-token.txt')
  writeFileSync(tokenPath, '短\n') // 只读第一行
  const launcher = startLauncher(['--token-file', tokenPath])
  try {
    const code = await new Promise((resolve) => launcher.child.once('exit', resolve))
    assert.notEqual(code, 0)
    assert.match(launcher.output(), /读到 1 个字符/)
    assert.match(launcher.output(), /token 太短/)
    assert.equal(await healthz(port), undefined)
  } finally {
    await stopChild(launcher.child)
  }
})

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
if (failures.length) {
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
