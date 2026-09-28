/**
 * OpenAI **Responses API**（`POST /v1/responses`）—— 给 Codex CLI 这类只认 Responses 的客户端用。
 *
 * 为什么必须做：Codex CLI 0.158 起 **`wire_api = "chat"` 已不再支持**（加载配置时直接报错），
 * 只认 Responses；而网页端我们本来只有 chat/completions。不做这一层，Codex 连不进来。
 *
 * 做法上刻意**只加一层翻译**，不碰请求主流程：
 *   请求：Responses 的 `instructions` + `input[]` → 转成 chat 形状，
 *         直接喂给 api-server.ts 里那套已经跑熟的 `toRelayCall`（工具、图片占位、keep_conversation 全都复用）；
 *   响应：把适配器吐出的 text / tool-call 事件，翻译成 Responses 的 SSE 事件流。
 * 真实请求形状是**抓包确认过**的（Codex 0.158 发来：instructions + input[] + tools 里混着
 * `function` 与 `namespace` 两种类型），不是照记忆写的。
 */
import { randomUUID } from 'node:crypto'

/** 把 Responses 请求体翻成 chat/completions 形状（供 toRelayCall 消费）。 */
export function responsesToChatBody(body: any): any {
  const messages: any[] = []
  if (typeof body?.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions })
  }
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    const type = String(item?.type ?? 'message')
    if (type === 'message') {
      const role = item?.role === 'developer' ? 'system' : String(item?.role ?? 'user')
      const text = (Array.isArray(item?.content) ? item.content : [])
        .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
      messages.push({ role, content: text })
      continue
    }
    if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: String(item?.call_id ?? item?.id ?? ''),
            type: 'function',
            function: { name: String(item?.name ?? ''), arguments: String(item?.arguments ?? '{}') },
          },
        ],
      })
      continue
    }
    if (type === 'function_call_output') {
      const output = item?.output
      messages.push({
        role: 'tool',
        tool_call_id: String(item?.call_id ?? ''),
        content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
      })
      continue
    }
    // `reasoning` 之类：不回灌（网页端没有原生思考块，塞回去只会污染转写）
  }
  // 工具：Responses 是**拍平**的 `{type:'function', name, description, parameters}`；
  // `namespace`（Codex 的分组工具）暂不支持 —— 直接跳过，模型就调不到它们，但不会报错。
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .filter((tool: any) => tool?.type === 'function' && tool?.name)
    .map((tool: any) => ({
      type: 'function',
      function: { name: String(tool.name), description: String(tool.description ?? ''), parameters: tool.parameters ?? {} },
    }))
  return {
    model: body?.model,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    stream: body?.stream === true,
    ...(body?.reasoning?.effort ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(body?.keep_conversation !== undefined ? { keep_conversation: body.keep_conversation } : {}),
  }
}

/** 折叠后的一次调用结果（与 api-server.ts 的 Folded 同形；这里只描述用到的字段）。 */
interface Folded {
  text: string
  reasoning: string
  calls: { id: string; name: string; arguments: string }[]
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number }
  finish: 'stop' | 'tool_calls'
  failure?: { message: string; code?: string }
}

interface ResponsesStreamOptions {
  id: string
  model: string
  createdAt: number
}

/**
 * Responses 的 SSE 写出器。
 *
 * 事件顺序是**抓包 + 实测**定下来的（Codex 0.158 完整跑通）：created →
 * output_item.added / content_part.added / output_text.delta* / done → output_item.done → completed。
 * 少任何一个 Codex 都可能卡住或丢内容，所以这里按顺序来，不做"精简"。
 */
export function createResponsesStream(res: any, options: ResponsesStreamOptions) {
  const output: any[] = []
  let textItem: { id: string; text: string; index: number } | undefined
  let callIndex = 0

  const send = (type: string, payload: any): void => {
    if (res.writableEnded) return
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
  }

  send('response.created', {
    response: {
      id: options.id,
      object: 'response',
      created_at: options.createdAt,
      status: 'in_progress',
      model: options.model,
      output: [],
    },
  })

  const closeText = (): void => {
    if (!textItem) return
    const item = {
      id: textItem.id,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textItem.text, annotations: [] }],
    }
    send('response.output_text.done', {
      item_id: textItem.id,
      output_index: textItem.index,
      content_index: 0,
      text: textItem.text,
    })
    send('response.content_part.done', {
      item_id: textItem.id,
      output_index: textItem.index,
      content_index: 0,
      part: { type: 'output_text', text: textItem.text, annotations: [] },
    })
    send('response.output_item.done', { output_index: textItem.index, item })
    output.push(item)
    textItem = undefined
  }

  return {
    /** 适配器的 text-delta → Responses 的 output_text.delta。 */
    onDelta(delta: any): void {
      if (typeof delta?.content === 'string' && delta.content) {
        if (!textItem) {
          const index = output.length
          textItem = { id: `msg_${randomUUID()}`, text: '', index }
          send('response.output_item.added', {
            output_index: index,
            item: { id: textItem.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          })
          send('response.content_part.added', {
            item_id: textItem.id,
            output_index: index,
            content_index: 0,
            part: { type: 'output_text', text: '' },
          })
        }
        textItem.text += delta.content
        send('response.output_text.delta', {
          item_id: textItem.id,
          output_index: textItem.index,
          content_index: 0,
          delta: delta.content,
        })
        return
      }
      // 工具调用：我们的适配器一次给全（id/name/arguments），这里就一次性发完三个事件。
      const call = Array.isArray(delta?.tool_calls) ? delta.tool_calls[0] : undefined
      if (call) {
        closeText()
        const index = output.length + callIndex
        callIndex += 1
        const itemId = `fc_${randomUUID()}`
        const callId = String(call?.id ?? '') || `call_${randomUUID()}`
        const name = String(call?.function?.name ?? '')
        const args = String(call?.function?.arguments ?? '{}')
        send('response.output_item.added', {
          output_index: index,
          item: { id: itemId, type: 'function_call', status: 'in_progress', call_id: callId, name, arguments: '' },
        })
        send('response.function_call_arguments.delta', {
          item_id: itemId,
          output_index: index,
          delta: args,
        })
        send('response.function_call_arguments.done', { item_id: itemId, output_index: index, arguments: args })
        const item = { id: itemId, type: 'function_call', status: 'completed', call_id: callId, name, arguments: args }
        send('response.output_item.done', { output_index: index, item })
        output.push(item)
      }
      // reasoning-delta 不翻译：网页端的思考内容没有对应的 Responses 事件，
      // 硬塞会给 Codex 制造无法解析的输入（它只认 output_text / function_call）。
    },

    /** 收尾：completed（带完整 output 与 usage）。失败则发 failed 让 Codex 明确报错。 */
    finish(folded: Folded): void {
      closeText()
      if (folded.failure) {
        send('response.failed', {
          response: {
            id: options.id,
            object: 'response',
            created_at: options.createdAt,
            status: 'failed',
            model: options.model,
            output,
            error: { code: folded.failure.code ?? 'provider_error', message: folded.failure.message },
          },
        })
        return
      }
      const usage = folded.usage
      send('response.completed', {
        response: {
          id: options.id,
          object: 'response',
          created_at: options.createdAt,
          status: 'completed',
          model: options.model,
          output,
          usage: {
            input_tokens: usage?.inputTokens ?? 0,
            output_tokens: usage?.outputTokens ?? 0,
            total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
            ...(usage?.reasoningTokens !== undefined
              ? { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
              : {}),
          },
        },
      })
    },
  }
}

/** 非流式的 Responses 响应体（Codex 一般走流式，这里给不传 stream 的客户端备一份）。 */
export function responsesResult(folded: Folded, options: ResponsesStreamOptions): any {
  const output: any[] = []
  if (folded.text) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: folded.text, annotations: [] }],
    })
  }
  for (const call of folded.calls) {
    output.push({
      id: `fc_${randomUUID()}`,
      type: 'function_call',
      status: 'completed',
      call_id: call.id || `call_${randomUUID()}`,
      name: call.name,
      arguments: call.arguments,
    })
  }
  return {
    id: options.id,
    object: 'response',
    created_at: options.createdAt,
    status: 'completed',
    model: options.model,
    output,
    usage: {
      input_tokens: folded.usage?.inputTokens ?? 0,
      output_tokens: folded.usage?.outputTokens ?? 0,
      total_tokens: (folded.usage?.inputTokens ?? 0) + (folded.usage?.outputTokens ?? 0),
    },
  }
}
