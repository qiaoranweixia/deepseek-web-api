/**
 * 手动粘贴 token 的 fail-closed 判据（R8，0.1.84）。
 *
 * 背景：旧写法 `unwrapStoredToken(token) || String(token).trim()` 是 fail-open ——
 * 用户把 localStorage 原文（包装 JSON）粘进来、unwrap 解出空时，**整段 JSON 被当 token**：
 * 一个 >8 字符的 JSON 文本轻松过长度检查，垃圾凭证入库（标着 unverified，界面显示一个永远
 * 校验不过的"账号"）。
 *
 * 现在：输入是包装 JSON（以 `{` 开头）但 unwrap 解出空 ⇒ 明确拒绝，提示怎么改。
 * 裸 token 行为完全不变。
 *
 * ⚠️ 这三个用例都**不会发出网络请求**：fail-closed 与长度检查都在 validateAuth 之前返回。
 *
 * 用法: node tests/check-login-token.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-token-'))
process.env.DSH_HOME = HOME

const { loginWithToken } = await import('../src/login.ts')

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

console.log('手动粘贴 token（R8 fail-closed）：')

await test('包装 JSON 但 value 为 null ⇒ 拒绝（不把 JSON 当 token 落盘）', async () => {
  const r = await loginWithToken('{"value":null,"expires":1234567890}')
  assert.equal(r.ok, false, '必须拒绝')
  assert.ok(String(r.error).includes('包装 JSON'), `error 应提示包装 JSON，实际: ${r.error}`)
})

await test('坏 JSON（截断的包装）⇒ 同样拒绝', async () => {
  const r = await loginWithToken('{"value":"abc')
  assert.equal(r.ok, false, '必须拒绝')
  assert.ok(String(r.error).includes('包装 JSON'), `error 应提示包装 JSON，实际: ${r.error}`)
})

await test('裸短串（非 JSON）⇒ 走原路径报「太短」，不 fail-closed', async () => {
  const r = await loginWithToken('short')
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('太短'), `裸 token 应报「太短」，实际: ${r.error}`)
})

await test('包装 JSON 且 value 非空 ⇒ unwrap 出真 token（fail-closed 只拦解出空的）', async () => {
  // unwrap 语义本身不变：解得出值的包装 JSON 与裸 token 走同一条旧路径。
  const { unwrapStoredToken } = await import('../src/auth.ts')
  assert.equal(unwrapStoredToken('{"value":"real-token-123","x":1}'), 'real-token-123')
  assert.equal(unwrapStoredToken('bare-token-abc'), 'bare-token-abc')
})

await test('带引号的复制粘贴要能自动剥掉（2026-09-28 用户现场：多了两个引号就被判 invalid token）', async () => {
  // ⚠️ 反向验证：把 auth.ts unwrapStoredToken 里那段成对引号剥离删掉 → 这条红。
  //    现场：用户把 'Ljvo…QIs1' 存进 ds-token.txt（66 字符 = 64 + 两个引号），
  //    服务端回 `Authorization Failed (invalid token)`，看起来跟"过期"一模一样，
  //    于是白折腾一轮"重新登录"。
  const { unwrapStoredToken } = await import('../src/auth.ts')
  const token = 'A'.repeat(64)
  assert.equal(unwrapStoredToken(`'${token}'`), token, '单引号（控制台复制最常见）')
  assert.equal(unwrapStoredToken(`"${token}"`), token, '双引号（JSON 里复制）')
  assert.equal(unwrapStoredToken(` \`${token}\` `), token, '反引号 + 首尾空白')
  assert.equal(unwrapStoredToken(`"{"value":"${token}"}"`), token, '连引号一起包住的包装 JSON 也要解出来')
  // 只有半边引号（括号/引号漏了一半）：现在会被"唯一一段长 token"那条兜底救回来 ——
  // 它本来就是想帮这种情况，能救就救，救不了才报错。
  assert.equal(unwrapStoredToken(`'${token}`), token, '半边引号也能救回来')
})

await test('整句提示文案也认：从「…getItem(\'userToken\')).value）」里抠出唯一那段 token', async () => {
  // ⚠️ 反向验证：把 auth.ts 里那段 `const runs = text.match(...)` 删掉 → 这条红。
  //    现场：用户复制的是我写在输入框提示里的一整句（末尾还带中文右括号），
  //    Chrome 控制台里报 SyntaxError，粘进插件则被判 invalid token。
  const { unwrapStoredToken } = await import('../src/auth.ts')
  const token = 'LjvogicZvUaIQgvqCV8Gz4yy1hIP4b3BJY4wz1uAN7whMDEA5yILLiqgwDB6QIs1'
  assert.equal(unwrapStoredToken(`${token}）`), token, 'token + 中文右括号')
  assert.equal(unwrapStoredToken(`粘贴 userToken（在浏览器 F12 → Console 执行：JSON.parse(localStorage.getItem('userToken')).value）\n${token}\n`), token)
  assert.equal(unwrapStoredToken(`${token}\n${token}`), `${token}\n${token}`, '两段候选 ⇒ 不乱猜，按原样交出去报错')
})

await test('把「命令本身」当 token 粘进来 ⇒ 明确拒绝，不落垃圾账号（也不联网）', async () => {
  // ⚠️ 反向验证：去掉 login.ts 里那条 `/^[\\x21-\\x7E]+$/` 校验 → 这条红
  //    （会落一条永远校验不过的账号，用户账号库里已经因此堆过 3 条）。
  const r = await loginWithToken(`JSON.parse(localStorage.getItem('userToken')).value）`)
  assert.equal(r.ok, false, '命令整行不是 token')
  assert.match(String(r.error), /不像是 token|空白|中文/, `错误要告诉用户「那是命令、输出才是 token」，实际：${r.error}`)
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
