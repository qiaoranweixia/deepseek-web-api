/**
 * 本地 OpenAI 兼容接口 —— 把「网页端登录态驱动模型」这件事借给 DSH 之外的软件用。
 *
 * 为什么放在插件进程里（而不是单独跑一个进程）：
 *  网页端的传输层（Electron `net.fetch`，指纹与真实浏览器一致）、PoW、会话复用、
 *  请求闸门、账号轮换、图片上传、失败重试全在插件里。独立进程要**再实现一遍**，
 *  而且拿不到 `net.fetch` ⇒ 传输层退化成 Node，指纹这条线白做。
 *  代价只有一个，写在这里免得忘：**DSH 不运行时接口也不在**。
 *
 * 协议面：只做 OpenAI 那一套（`GET /v1/models` + `POST /v1/chat/completions`，
 * 含 stream / 非 stream、工具调用、`reasoning_content`）。
 * Anthropic 的 `/v1/messages` **不做** —— 需要时再加，别提前造。
 *
 * 安全边界（本地接口也是信任边界）：
 *  - 只监听 `127.0.0.1`，永远不绑 `0.0.0.0`；
 *  - **不发 CORS 头** + 只收 `application/json` 请求体 ⇒ 网页里的 JS 没法拿它当枪使
 *    （跨站 simple request 只能是 text/plain 之类，会被 415 挡掉；带 JSON 头的跨站请求
 *    要先过 preflight，而没有 CORS 头就过不去）。本机普通程序不受影响。
 *  - 可选 `key`（为空 = 不校验）。凭证本来就在同一台机器的 `~/.dsh/web-login` 下，
 *    本地接口不额外扩大攻击面，所以默认不强制。
 *
 * 另注：宿主自带的 HTTP 端点（`ctx.webServer`）只有 DSH 自己的页面打得通（外部 curl 会撞同源守卫），
 * 所以这里必须自己起一个监听 —— 不能把 `/v1/*` 挂在那个前缀下。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { webLoginDir } from './paths.ts'
import { createResponsesStream, responsesResult, responsesToChatBody } from './responses.ts'

/**
 * DSH 面板那套设置接口的前缀。本地控制台**原样复用**它 ——
 * 不另写一套路由，省得"面板里改了、控制台没改"这种两边漂移。
 */
export const ADMIN_PREFIX = '/deepseek-web-login/api'

export interface RelayConfig {
  /** 是否开启本地接口（默认开）。 */
  enabled: boolean
  /** 监听端口。0 = 随机（单测用），端口被占时自动顺延最多 10 个。 */
  port: number
  /** 可选的本地 key：非空时要求 `Authorization: Bearer <key>` 或 `x-api-key: <key>`。 */
  key: string
}

/** 默认端口：与本项目其它默认值一样，挑一个不常见的号，避免和常见开发端口抢。 */
export const DEFAULT_RELAY_PORT = 8788
export const RELAY_PORT_BOUNDS = { min: 1024, max: 65535 } as const
/**
 * 默认**不开**。
 *
 * 原因有两层：① 一个从零启动的插件不该凭空多出一个监听端口（尤其它能把请求花在账号上）；
 * ② 测试装置大量用 `apply(ctx, {…})` 走一遍宿主入口，开着的端口会让那些进程**永远不退出**
 * （实测：全量用例从 40 秒变成每个文件卡满 180 秒超时）。
 * 正式交付走 bundle 装配（`cordis.patch.yml` 里显式 `apiServer: { enabled: true }`），
 * 所以用户拿到的仍是「装上就能填」；配置文件（api-server.json）与设置页的值优先级最高。
 */
export const DEFAULT_RELAY_CONFIG: RelayConfig = { enabled: false, port: DEFAULT_RELAY_PORT, key: '' }

/** 请求体上限：默认 40 万字符的转写在 JSON 里约 1~2 MB，留 8 倍余量。 */
export const RELAY_BODY_LIMIT = 16 * 1024 * 1024

/** 端口占用的顺延次数（连试 10 个都不行就放弃并报错）。 */
const PORT_FALLBACK_TRIES = 10

/** 图片输入暂时不支持 —— 明确告诉模型「这儿有张图但没给你」，别让它对着空气猜。 */
const IMAGE_PLACEHOLDER = '[image omitted: this endpoint does not forward image input]'

export function relaySettingsPath(): string {
  return join(webLoginDir(), 'api-server.json')
}

function clampPort(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RELAY_PORT
  if (n === 0) return 0 // 单测/临时用：随机端口
  return Math.min(RELAY_PORT_BOUNDS.max, Math.max(RELAY_PORT_BOUNDS.min, n))
}

/** 把任意来源的配置收敛成合法值（文件坏了也不能把服务器带崩）。 */
export function normalizeRelayConfig(partial: Partial<RelayConfig> | undefined, base = DEFAULT_RELAY_CONFIG): RelayConfig {
  return {
    enabled: typeof partial?.enabled === 'boolean' ? partial.enabled : base.enabled,
    port: partial?.port === undefined ? base.port : clampPort(partial.port),
    key: typeof partial?.key === 'string' ? partial.key.trim() : base.key,
  }
}

/** 读设置页/手工写的值；文件不存在或损坏都返回 undefined（回落 cordis config）。 */
export function readRelayConfig(): Partial<RelayConfig> | undefined {
  try {
    const file = relaySettingsPath()
    if (!existsSync(file)) return undefined
    // ⚠️ 一定要先剥 BOM：这个文件是**给人手改的**（README 就这么写的），
    // 而 Windows 记事本 / PowerShell 5.1 的 `Set-Content -Encoding UTF8` 都会写 BOM，
    // `JSON.parse` 见到 BOM 直接抛 → 整份设置被当成"文件坏了"静默回落成默认值。
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const out: Partial<RelayConfig> = {}
    if (typeof parsed?.enabled === 'boolean') out.enabled = parsed.enabled
    if (Number.isFinite(parsed?.port)) out.port = clampPort(parsed.port)
    if (typeof parsed?.key === 'string') out.key = parsed.key.trim()
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

export function writeRelayConfig(config: RelayConfig): void {
  const file = relaySettingsPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8')
}

// ── 请求翻译：OpenAI 形状 ⇄ DSH 形状 ───────────────────────────────
//
// DSH 的消息词汇见 protocol.ts 顶部的说明：role + blocks（text / reasoning /
// tool-call / tool-result / image）。这里只做**形状**翻译，prompt 怎么拼、
// 工具协议怎么写由 protocol.ts 决定 —— 那部分不能在这里再写一份。

/** 一次调用（已翻译成适配器能吃的形状）。 */
export interface RelayCall {
  /** 解析后的档位：deepseek-chat / deepseek-reasoner。 */
  model: string
  /** 喂给 adapter.stream 的 option。 */
  options: any
  /** 是否走 SSE。 */
  stream: boolean
  /** 流式时是否要末尾那条 usage（OpenAI 的 stream_options.include_usage）。 */
  includeUsage: boolean
}

/** 请求形状不合法（回 400，不落到适配器里报成 500）。 */
export class RelayRequestError extends Error {}

/**
 * 模型名归一：外部软件会写自己的模型名（哪怕是 `gpt-4o`）。
 * 认得出的按语义分流，认不出的一律落到「不思考」档 —— 报错只会让人以为接口坏了。
 */
export function resolveRelayModel(requested: unknown): string {
  const id = String(requested ?? '').trim().toLowerCase()
  if (!id) return 'deepseek-chat'
  if (/think|reason|deepseek-pro|deepseek-expert|\br1\b/.test(id)) return 'deepseek-reasoner'
  return 'deepseek-chat'
}

/** OpenAI 的 reasoning_effort → 适配器认的档位（适配器只认 off/low/high/max）。 */
const EFFORT_MAP: Record<string, string> = {
  none: 'off',
  minimal: 'off',
  off: 'off',
  low: 'low',
  medium: 'high',
  high: 'high',
  max: 'max',
  xhigh: 'max',
}

/** content 归一：字符串 / 多段数组（text、image_url…）都压成一段文本。 */
function contentToText(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text' || part?.type === 'input_text') return String(part.text ?? part.content ?? '')
      if (part?.type === 'image_url' || part?.type === 'input_image') return `\n${IMAGE_PLACEHOLDER}\n`
      return ''
    })
    .join('')
}

function toDsMessages(messages: readonly any[]): any[] {
  const out: any[] = []
  for (const message of messages) {
    const role = String(message?.role ?? '').toLowerCase()
    if (role === 'system' || role === 'developer') {
      out.push({ role: 'system', content: [{ type: 'text', text: contentToText(message?.content) }] })
      continue
    }
    if (role === 'assistant') {
      const blocks: any[] = []
      const text = contentToText(message?.content)
      if (text) blocks.push({ type: 'text', text })
      for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        const fn = call?.function ?? {}
        blocks.push({
          type: 'tool-call',
          id: String(call?.id ?? ''),
          name: String(fn.name ?? ''),
          // renderToolCalls（protocol.ts）读的是**字符串**；有些客户端把 arguments 写成对象
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        })
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (role === 'tool' || role === 'function') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: String(message?.tool_call_id ?? message?.name ?? ''),
            isError: message?.is_error === true,
            content: [{ type: 'text', text: contentToText(message?.content) }],
          },
        ],
      })
      continue
    }
    // user 与任何没见过的角色都按用户输入处理（宁可当输入，也别把整段历史丢掉）
    out.push({ role: 'user', content: [{ type: 'text', text: contentToText(message?.content) }] })
  }
  return out
}

/**
 * OpenAI 的 tools → DSH 工具定义。
 * `parameters` 直接透传：DSH 的 `schemaOf()` 也是原样透传，protocol.ts 两种写法都认
 * （标准包裹 `{properties, required}` 与 DSH 的扁平写法）。
 */
function toDsTools(tools: any): any[] | undefined {
  const list = Array.isArray(tools) ? tools : []
  const out = list
    .map((tool) => {
      const fn = tool?.function ?? tool ?? {}
      return {
        name: String(fn?.name ?? '').trim(),
        description: String(fn?.description ?? ''),
        parameters: fn?.parameters ?? {},
      }
    })
    .filter((tool) => tool.name)
  return out.length > 0 ? out : undefined
}

/** OpenAI 请求体 → 适配器调用参数。形状不合法直接抛 RelayRequestError（回 400）。 */
export function toRelayCall(body: any): RelayCall {
  if (!body || typeof body !== 'object') throw new RelayRequestError('请求体必须是 JSON 对象')
  const rawMessages = body.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new RelayRequestError('messages 必须是非空数组')
  }
  const model = resolveRelayModel(body.model)
  const tools = toDsTools(body.tools)
  const effort = EFFORT_MAP[String(body.reasoning_effort ?? '').trim().toLowerCase()]
  // keep_conversation：非标准字段，本接口特有的开关（见 README「对话留不留」）。
  // true = 这轮别删网页端会话；false = 即使全局设了「不删」，这轮也删掉。
  const keep = body.keep_conversation
  if (keep !== undefined && typeof keep !== 'boolean') {
    throw new RelayRequestError('keep_conversation 只能是 true / false')
  }
  return {
    model,
    stream: body.stream === true,
    includeUsage: body?.stream_options?.include_usage === true,
    options: {
      model,
      messages: toDsMessages(rawMessages),
      ...(tools ? { tools } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      // purpose=chat：自动续写只对这个用途生效（见 adapter.ts 的 allowsAutoContinue）
      purpose: 'chat',
      ...(keep === true ? { __keepSession: true } : {}),
      ...(keep === false ? { __deleteSession: true } : {}),
    },
  }
}

// ── HTTP 层 ────────────────────────────────────────────────────────

export interface RelayModelInfo {
  id: string
  name?: string
  description?: string
}

export interface RelayServerOptions {
  /** 真正干活的流：index.ts 传的是注册给 DSH 的那个适配器（同一套闸门/换号/清理）。 */
  stream: (options: any) => AsyncGenerator<any>
  /** 读 JSON 请求体（index.ts 的 readJsonBody，含大小上限与超时）。 */
  readBody: (req: any, limit: number) => Promise<any>
  config: RelayConfig
  models: readonly RelayModelInfo[]
  /**
   * 控制台/管理接口（路径见 ADMIN_PREFIX）：直接转发给 DSH 面板那套 host API。
   * 缺省 = 不挂（单测里只测 /v1 时用）。
   */
  admin?: (req: any, res: any) => Promise<void> | void
  /** 控制台页面（`GET /` 与 `GET /console`）；缺省时那两条路由回 404。 */
  consoleHtml?: string
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
}

export interface RelayServer {
  /** 实际监听端口；0 = 没在跑。 */
  readonly port: number
  config(): RelayConfig
  start(): Promise<number>
  stop(): Promise<void>
  reconfigure(next: Partial<RelayConfig>): Promise<number>
}

/** 错误码 → HTTP 状态（客户端据此决定"要不要重试/是不是自己写错了"）。 */
const STATUS_BY_CODE: Record<string, number> = {
  MISSING_CREDENTIAL: 503,
  AUTH: 503,
  RATE_LIMIT: 429,
  CONTEXT_WINDOW_EXCEEDED: 400,
  UNSUPPORTED_REASONING_EFFORT: 400,
}

function errorStatus(code: unknown): number {
  return STATUS_BY_CODE[String(code ?? '')] ?? 502
}

/**
 * 请求体是不是 JSON。
 * 这条同时是**跨站防线**：浏览器里的 simple request 只能带 text/plain 之类，
 * 带 application/json 的跨站请求要先过 preflight，而我们一个 CORS 头都不给。
 */
function isJsonRequest(req: any): boolean {
  const contentType = String(req?.headers?.['content-type'] ?? '')
  return /^application\/(json|[\w.+-]+\+json)/i.test(contentType.trim())
}

function sendJson(res: any, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    ...headers,
  })
  res.end(body)
}

function openAiError(message: string, code?: string): { error: { message: string; type: string; code?: string } } {
  return { error: { message, type: 'invalid_request_error', ...(code ? { code } : {}) } }
}

/**
 * 提前回错误时把请求体排干。
 * 不排干的话 Node 会直接拆连接 —— 客户端看到的是一句 `fetch failed`，
 * 而不是我们精心写的那条 4xx（实测：415 那条用例就是这么红的）。
 */
function drain(req: any): void {
  try {
    req?.resume?.()
  } catch {
    /* 排不干也不影响回包 */
  }
}

/** 把异常归一成「一句话 + 错误码」。适配器抛的是 AdapterLlmError（带 code）。 */
function failureOf(error: any): { message: string; code?: string; retryAfterMs?: number } {
  return {
    message: String(error?.message ?? error ?? '未知错误'),
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(Number.isFinite(error?.providerRetryAfterMs) ? { retryAfterMs: Number(error.providerRetryAfterMs) } : {}),
  }
}

/** 折叠一次调用的事件流（流式与非流式共用一份语义）。 */
interface Folded {
  text: string
  reasoning: string
  calls: { id: string; name: string; arguments: string }[]
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number }
  finish: 'stop' | 'tool_calls'
  failure?: { message: string; code?: string }
}

async function foldStream(
  stream: AsyncGenerator<any>,
  onDelta?: (delta: any) => void,
): Promise<Folded> {
  const folded: Folded = { text: '', reasoning: '', calls: [], finish: 'stop' }
  try {
    for await (const event of stream) {
      if (!event || typeof event !== 'object') continue
      if (event.type === 'text-delta') {
        folded.text += String(event.text ?? '')
        onDelta?.({ content: String(event.text ?? '') })
        continue
      }
      if (event.type === 'reasoning-delta') {
        folded.reasoning += String(event.text ?? '')
        onDelta?.({ reasoning_content: String(event.text ?? '') })
        continue
      }
      if (event.type === 'tool-call-delta') {
        const index = folded.calls.length
        folded.calls.push({
          id: String(event.id ?? ''),
          name: String(event.name ?? ''),
          arguments: String(event.argumentsDelta ?? ''),
        })
        onDelta?.({
          tool_calls: [
            {
              index,
              id: String(event.id ?? ''),
              type: 'function',
              function: { name: String(event.name ?? ''), arguments: String(event.argumentsDelta ?? '') },
            },
          ],
        })
        continue
      }
      if (event.type === 'usage' && event.usage) {
        folded.usage = {
          inputTokens: Number(event.usage.inputTokens) || 0,
          outputTokens: Number(event.usage.outputTokens) || 0,
          ...(Number.isFinite(event.usage.reasoningTokens)
            ? { reasoningTokens: Number(event.usage.reasoningTokens) }
            : {}),
        }
        continue
      }
      if (event.type === 'finish') {
        if (event.reason?.kind === 'tool-calls') folded.finish = 'tool_calls'
        if (event.reason?.kind === 'error') {
          folded.failure = {
            message: String(event.reason?.failure?.message ?? '网页端返回错误'),
            ...(event.reason?.failure?.code ? { code: String(event.reason.failure.code) } : {}),
          }
        }
      }
    }
  } catch (error: any) {
    // 适配器在**流中途**抛错是常态（限流、账号被限制、连接断了）。
    // 吞成 failure 而不是往外抛：这样流式那头还能补一条 error 帧 + [DONE] 收尾，
    // 非流式那头还能拿到有意义的状态码 —— 否则客户端只会看到一条被掐断的连接。
    if (!folded.failure) {
      const failure = failureOf(error)
      folded.failure = {
        message: failure.message,
        ...(failure.code ? { code: failure.code } : {}),
      }
    }
  }
  return folded
}

function usageOf(folded: Folded): any {
  const prompt = folded.usage?.inputTokens ?? 0
  const completion = folded.usage?.outputTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(folded.usage?.reasoningTokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: folded.usage.reasoningTokens } }
      : {}),
  }
}

export function createRelayServer(options: RelayServerOptions): RelayServer {
  let config = normalizeRelayConfig(options.config)
  let server: Server | undefined
  let port = 0

  function authorized(req: any): boolean {
    if (!config.key) return true
    const bearer = String(req?.headers?.authorization ?? '').replace(/^Bearer\s+/i, '')
    const apiKey = String(req?.headers?.['x-api-key'] ?? '')
    return bearer === config.key || apiKey === config.key
  }

  /**
   * 页面不能自定义请求头（浏览器导航），所以**只对控制台那两个 GET** 额外认一次 `?key=`。
   * API 一律只认请求头 —— key 出现在 URL 里会被日志/历史记下来。
   */
  function authorizedPage(req: any): boolean {
    if (!config.key) return true
    const url = new URL(String(req?.url ?? '/'), 'http://127.0.0.1')
    return url.searchParams.get('key') === config.key || authorized(req)
  }

  function sendHtml(res: any, html: string): void {
    const body = Buffer.from(html, 'utf8')
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function stop(): Promise<void> {
    const current = server
    server = undefined
    port = 0
    if (!current) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      current.close(() => finish())
      // keep-alive 连接会拖住 close()：先让**空闲**连接正常结束（FIN），
      // 客户端连接池里那条也就不再被复用 —— 直接 destroy 会在客户端留下
      // 一条"看着还活着"的死连接（实测会让下一次请求拿到 ECONNRESET）。
      ;(current as any).closeIdleConnections?.()
      const timer = setTimeout(() => {
        // 还有连接赖着（有客户端卡着半个请求）⇒ 硬掐，别让卸载流程停在半路
        ;(current as any).closeAllConnections?.()
        finish()
      }, 250)
      timer.unref?.()
    })
  }

  function listenOnce(candidate: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const next = createServer((req, res) => {
        void handle(req, res).catch((error: any) => {
          options.logger?.warn?.(`deepseek-web: 本地接口处理失败：${error?.message ?? error}`)
          if (!res.headersSent) sendJson(res, 500, openAiError('本地接口内部错误'))
          else res.end()
        })
      })
      next.on('clientError', (_error: any, socket: any) => socket?.destroy?.())
      next.once('error', reject)
      next.listen(candidate, '127.0.0.1', () => {
        next.off('error', reject)
        const address = next.address()
        server = next
        port = typeof address === 'object' && address ? address.port : candidate
        resolve(port)
      })
    })
  }

  async function start(): Promise<number> {
    if (!config.enabled) return 0
    if (server) return port
    const candidates = [config.port]
    if (config.port !== 0) {
      for (let i = 1; i < PORT_FALLBACK_TRIES; i += 1) {
        const candidate = config.port + i
        if (candidate > RELAY_PORT_BOUNDS.max) break // 别越过 65535 去 listen（那是 RangeError，不是 EADDRINUSE）
        candidates.push(candidate)
      }
    }
    let lastError: any
    for (const candidate of candidates) {
      try {
        const bound = await listenOnce(candidate)
        if (candidate !== config.port) {
          options.logger?.warn?.(
            `deepseek-web: 本地接口端口 ${config.port} 被占用，改用了 ${bound}`,
          )
        }
        return bound
      } catch (error: any) {
        lastError = error
        if (error?.code !== 'EADDRINUSE') throw error
      }
    }
    throw new Error(`本地接口无法监听 ${config.port} 起的 ${candidates.length} 个端口：${lastError?.message ?? lastError}`)
  }

  async function reconfigure(next: Partial<RelayConfig>): Promise<number> {
    const merged = normalizeRelayConfig(next, config)
    const changed = merged.enabled !== config.enabled || merged.port !== config.port || merged.key !== config.key
    config = merged
    if (!changed) return port
    await stop()
    return merged.enabled ? await start() : 0
  }

  // ── 路由 ──

  async function handle(req: any, res: any): Promise<void> {
    const url = new URL(String(req?.url ?? '/'), 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    try {
      if (req.method === 'OPTIONS') {
        // 刻意**不带** Access-Control-Allow-* —— 浏览器跨站请求就该在这里被挡住
        drain(req)
        res.writeHead(204, { allow: 'GET, POST, OPTIONS' })
        res.end()
        return
      }
      // /healthz 不校验 key：启动器靠它判断"接口是不是已经在跑"（带 key 也得能探），
      // 它只回 {ok, provider, 模型名, 是否需要 key}，没有敏感信息。
      if (req.method === 'GET' && path === '/healthz') {
        sendJson(res, 200, {
          ok: true,
          provider: 'deepseek-web',
          endpoint: '/v1/chat/completions',
          models: options.models.map((model) => model.id),
          auth: config.key ? 'bearer' : 'none',
          console: options.consoleHtml ? '/' : null,
        })
        return
      }
      // 控制台页面：一个端口就把开关都管起来（页面调的是下面那套管理接口）
      if (req.method === 'GET' && (path === '/' || path === '/console')) {
        if (!authorizedPage(req)) {
          drain(req)
          sendJson(res, 401, openAiError('控制台也需要 key：用 http://127.0.0.1:<端口>/?key=<你的key> 打开', 'unauthorized'))
          return
        }
        if (!options.consoleHtml) {
          sendJson(res, 404, openAiError('这一版没有带控制台页面（升级插件后再试）'))
          return
        }
        sendHtml(res, options.consoleHtml)
        return
      }
      if (!authorized(req)) {
        drain(req)
        sendJson(res, 401, openAiError('API key 不正确（请在客户端填 Authorization: Bearer <key>）', 'unauthorized'))
        return
      }
      // 管理接口：原样转给 DSH 面板那套 host API（同一份实现）。
      // ⚠️ 这里也要守住"只收 application/json"：否则网页里的跨站 simple request
      //    （text/plain）能绕过 CORS 直接改设置。
      if (options.admin && (path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`))) {
        if (req.method === 'POST' && !isJsonRequest(req)) {
          drain(req)
          sendJson(res, 415, openAiError('管理接口的请求体必须是 application/json'))
          return
        }
        await options.admin(req, res)
        return
      }
      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        sendJson(res, 200, {
          object: 'list',
          data: options.models.map((model) => ({
            id: model.id,
            object: 'model',
            owned_by: 'deepseek-web',
            ...(model.description ? { description: model.description } : {}),
          })),
        })
        return
      }
      if (req.method === 'GET' && path === '/v1') {
        sendJson(res, 200, {
          ok: true,
          provider: 'deepseek-web',
          endpoint: '/v1/chat/completions',
          models: options.models.map((model) => model.id),
          auth: config.key ? 'bearer' : 'none',
        })
        return
      }
      if (
        req.method === 'POST' &&
        (path === '/v1/chat/completions' || path === '/chat/completions' || path === '/v1/responses' || path === '/responses')
      ) {
        // /v1/responses 是给 Codex CLI 那类**只认 Responses** 的客户端用的（0.158 起 chat 已被禁）。
        // 两条路共用同一个处理函数：翻译层在 responses.ts，请求主流程一个字都不改。
        await handleChat(req, res, { responses: path.includes('/responses') })
        return
      }
      sendJson(res, 404, openAiError(`未知路径 ${path}（本接口提供 /v1/models 与 /v1/chat/completions）`))
    } catch (error: any) {
      drain(req)
      if (!res.headersSent) sendJson(res, error?.status ?? 500, openAiError(String(error?.message ?? error)))
      else res.end()
    }
  }

  async function handleChat(req: any, res: any, wire: { responses?: boolean } = {}): Promise<void> {
    if (!isJsonRequest(req)) {
      drain(req)
      sendJson(res, 415, openAiError('请求体必须是 application/json（这条同时挡住浏览器的跨站请求）'))
      return
    }
    let body: any
    try {
      body = await options.readBody(req, RELAY_BODY_LIMIT)
    } catch (error: any) {
      sendJson(res, error?.status ?? 400, openAiError(String(error?.message ?? '读取请求体失败')))
      return
    }
    let call: RelayCall
    try {
      // Responses 请求先翻成 chat 形状，再走同一套翻译（工具/图片占位/keep_conversation 全都复用）
      call = toRelayCall(wire.responses === true ? responsesToChatBody(body) : body)
    } catch (error: any) {
      sendJson(res, 400, openAiError(String(error?.message ?? '请求不合法'), 'invalid_request'))
      return
    }

    const controller = new AbortController()
    res.on('close', () => {
      // 客户端断开就取消上游（否则网页端那一轮还在跑，白白烧额度）
      if (!res.writableFinished) controller.abort()
    })

    const id = `${wire.responses === true ? 'resp' : 'chatcmpl'}_${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const stream = options.stream({ ...call.options, signal: controller.signal })

    // 先取第一个事件：**未登录 / 限流 / 参数错**这类失败要能用 HTTP 状态码说清楚，
    // 一旦开始写 SSE 就只剩 200 了（很多客户端对 200 里的错误几乎不显示）。
    const iterator = stream[Symbol.asyncIterator]()
    let first: IteratorResult<any>
    try {
      first = await iterator.next()
    } catch (error: any) {
      const failure = failureOf(error)
      sendJson(res, errorStatus(failure.code), openAiError(failure.message, failure.code), retryHeaders(failure))
      return
    }
    if (!first.done && first.value?.type === 'finish' && first.value?.reason?.kind === 'error') {
      const failure = {
        message: String(first.value.reason?.failure?.message ?? '网页端返回错误'),
        ...(first.value.reason?.failure?.code ? { code: String(first.value.reason.failure.code) } : {}),
      }
      sendJson(res, errorStatus(failure.code), openAiError(failure.message, failure.code))
      return
    }

    const events = prepend(first, iterator)
    if (!call.stream) {
      const folded = await foldStream(events)
      if (folded.failure) {
        sendJson(res, errorStatus(folded.failure.code), openAiError(folded.failure.message, folded.failure.code))
        return
      }
      if (wire.responses === true) {
        sendJson(res, 200, responsesResult(folded, { id, model: call.model, createdAt: created }))
        return
      }
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: call.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: folded.calls.length > 0 && !folded.text ? null : folded.text,
              ...(folded.reasoning ? { reasoning_content: folded.reasoning } : {}),
              ...(folded.calls.length > 0
                ? {
                    tool_calls: folded.calls.map((item) => ({
                      id: item.id,
                      type: 'function',
                      function: { name: item.name, arguments: item.arguments },
                    })),
                  }
                : {}),
            },
            finish_reason: folded.finish,
          },
        ],
        usage: usageOf(folded),
      })
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    if (wire.responses === true) {
      // Codex 那条：事件顺序见 responses.ts（抓包 + 实测定的），失败也走 failed 事件而不是静默断开
      const writer = createResponsesStream(res, { id, model: call.model, createdAt: created })
      const folded = await foldStream(events, (delta) => writer.onDelta(delta))
      writer.finish(folded)
      res.end()
      return
    }
    const chunk = (delta: any, finishReason: string | null): string =>
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: call.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`
    res.write(chunk({ role: 'assistant', content: '' }, null))
    const folded = await foldStream(events, (delta) => res.write(chunk(delta, null)))
    if (folded.failure) {
      res.write(`data: ${JSON.stringify({ error: { message: folded.failure.message, code: folded.failure.code ?? 'error' } })}\n\n`)
    } else {
      if (call.includeUsage && folded.usage) {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: call.model,
            choices: [],
            usage: usageOf(folded),
          })}\n\n`,
        )
      }
      res.write(chunk({}, folded.finish))
    }
    res.write('data: [DONE]\n\n')
    res.end()
  }

  function retryHeaders(failure: { retryAfterMs?: number }): Record<string, string> {
    if (!failure.retryAfterMs) return {}
    return { 'retry-after': String(Math.ceil(failure.retryAfterMs / 1000)) }
  }

  return {
    get port() {
      return port
    },
    config: () => ({ ...config }),
    start,
    stop,
    reconfigure,
  }
}

/** 把「已经取出来的第一个事件」拼回迭代器（见 handleChat 里为什么要先取一个）。 */
async function* prepend(first: IteratorResult<any>, iterator: AsyncIterator<any>): AsyncGenerator<any> {
  if (!first.done) yield first.value
  while (true) {
    const next = await iterator.next()
    if (next.done) return
    yield next.value
  }
}
