import { consumeOpenAiCompletionStream } from './openAiCompletionStream'

export type LocalChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface LocalToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface LocalToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface LocalTextContentPart {
  type: 'text'
  text: string
}

export interface LocalImageContentPart {
  type: 'image_url'
  image_url: { url: string }
}

export type LocalMessageContent = string | readonly (LocalTextContentPart | LocalImageContentPart)[] | null

export interface LocalChatMessage {
  role: LocalChatRole
  content: LocalMessageContent
  name?: string
  toolCallId?: string
  toolCalls?: readonly LocalToolCall[]
  reasoningText?: string
  filePath?: string
  model?: import('../shared/agent').AgentModelProvenance
}

export interface LocalCompletionRequest {
  messages: readonly LocalChatMessage[]
  enableThinking?: boolean
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  minP?: number
  presencePenalty?: number
  repetitionPenalty?: number
  tools?: readonly LocalToolDefinition[]
  toolChoice?: 'auto' | 'none'
  signal?: AbortSignal
}

export interface LocalPromptRequest {
  prompt: string
  maxTokens: number
  temperature: number
  topK: number
  topP: number
  repetitionPenalty: number
}

export interface LocalCompletion {
  text: string
  toolCalls: LocalToolCall[]
  reasoningText?: string
  finishReason?: string
}

export interface LocalCompletionStart {
  requestId: string
}

export type LocalCompletionEvent =
  | { requestId: string; threadId?: string; type: 'delta'; delta: string }
  | { requestId: string; threadId?: string; type: 'tool-call'; toolCallId: string; name: string; arguments: Record<string, unknown>; summary?: import('../shared/chat').ToolUiMessage }
  | { requestId: string; threadId?: string; type: 'tool-result'; toolCallId: string; result: string; filePath?: string }
  | { requestId: string; threadId?: string; type: 'tool-error'; toolCallId: string; error: string }
  | { requestId: string; threadId?: string; type: 'files-changed'; files: import('../shared/chat').FileChangeDisplay[] }
  | { requestId: string; threadId?: string; type: 'progress-update'; summary: string }
  | { requestId: string; threadId?: string; type: 'todos-updated'; todos: import('../shared/chat').TodoDisplay[] }
  | { requestId: string; threadId?: string; type: 'complete' }
  | { requestId: string; threadId?: string; type: 'cancelled' }
  | { requestId: string; threadId?: string; type: 'error'; message: string }

interface CompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown
      reasoning_content?: unknown
      reasoning?: unknown
      tool_calls?: unknown
    }
    delta?: {
      content?: unknown
    }
    finish_reason?: unknown
  }>
}

interface PromptCompletionResponse {
  content?: unknown
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_TEMPERATURE = 0.2
const MAX_REQUEST_MESSAGES = 256
const MAX_MESSAGE_CHARACTERS = 128_000
const MAX_COMPLETION_TOKENS = 8_192
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

const describeResponseBody = (body: string): string => {
  try {
    const value: unknown = JSON.parse(body)
    if (
      typeof value === 'object' &&
      value !== null &&
      'error' in value &&
      typeof value.error === 'object' &&
      value.error !== null &&
      'message' in value.error &&
      typeof value.error.message === 'string'
    ) return value.error.message
  } catch {
    return body.trim()
  }
  return body.trim()
}

interface CompletionSettings {
  enableThinking: boolean
  maxTokens: number
  temperature: number
  topP?: number
  topK?: number
  minP?: number
  presencePenalty?: number
  repetitionPenalty?: number
}

const optionalNumber = (value: number | undefined, minimum: number, maximum: number, name: string): number | undefined => {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} is outside its supported range`)
  return value
}

const validateRequest = (request: LocalCompletionRequest): CompletionSettings => {
  if (request.messages.length === 0 || request.messages.length > MAX_REQUEST_MESSAGES) {
    throw new Error(`Completion requests must include between 1 and ${MAX_REQUEST_MESSAGES} messages`)
  }
  for (const message of request.messages) {
    const validContent = message.content === null ||
      (typeof message.content === 'string' && message.content.length <= MAX_MESSAGE_CHARACTERS) ||
      (Array.isArray(message.content) && message.content.length > 0 && message.content.every((part) => {
        if (!part || typeof part !== 'object' || !('type' in part)) return false
        if (part.type === 'text') return typeof part.text === 'string' && part.text.length <= MAX_MESSAGE_CHARACTERS
        return part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:image/')
      }))
    const hasAssistantTools = message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0
    const hasToolResult = message.role === 'tool' && typeof message.toolCallId === 'string' && typeof message.content === 'string'
    const hasContent = typeof message.content === 'string' ? message.content.length > 0 : Array.isArray(message.content) && message.content.length > 0
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role) || !validContent || (!hasContent && !hasAssistantTools && !hasToolResult)) {
      throw new Error('Completion requests contain an invalid message')
    }
  }
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_COMPLETION_TOKENS) {
    throw new Error('Completion requests must use between 1 and 8192 output tokens')
  }
  const temperature = request.temperature ?? DEFAULT_TEMPERATURE
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error('Completion requests must use a temperature between 0 and 2')
  }
  if (request.enableThinking !== undefined && typeof request.enableThinking !== 'boolean') throw new Error('Invalid thinking mode')
  const topK = optionalNumber(request.topK, 0, 1000, 'Top K')
  if (topK !== undefined && !Number.isInteger(topK)) throw new Error('Top K must be an integer')
  return {
    enableThinking: request.enableThinking ?? false,
    maxTokens,
    temperature,
    topP: optionalNumber(request.topP, 0, 1, 'Top P'),
    topK,
    minP: optionalNumber(request.minP, 0, 1, 'Min P'),
    presencePenalty: optionalNumber(request.presencePenalty, 0, 2, 'Presence penalty'),
    repetitionPenalty: optionalNumber(request.repetitionPenalty, 0, 2, 'Repetition penalty')
  }
}

const serializeMessage = (message: LocalChatMessage): Record<string, unknown> => ({
  role: message.role,
  content: message.content,
  name: message.name,
  tool_call_id: message.toolCallId,
  tool_calls: message.toolCalls?.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) }
  }))
})

const completionBody = (request: LocalCompletionRequest, settings: CompletionSettings, stream: boolean): Record<string, unknown> => ({
  messages: request.messages.map(serializeMessage),
  stream,
  max_tokens: settings.maxTokens,
  temperature: settings.temperature,
  top_p: settings.topP,
  top_k: settings.topK,
  min_p: settings.minP,
  presence_penalty: settings.presencePenalty,
  repeat_penalty: settings.repetitionPenalty,
  chat_template_kwargs: { enable_thinking: settings.enableThinking },
  reasoning_format: 'deepseek',
  tools: request.tools?.map((definition) => ({
    type: 'function',
    function: definition
  })),
  tool_choice: request.tools?.length ? request.toolChoice ?? 'auto' : undefined
})

const parseToolCalls = (value: unknown): LocalToolCall[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const candidate = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    if (!candidate.function || typeof candidate.function.name !== 'string') return []
    let args: unknown = candidate.function.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { return [] }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
    return [{
      id: typeof candidate.id === 'string' && candidate.id ? candidate.id : `call_${index + 1}`,
      name: candidate.function.name,
      arguments: args as Record<string, unknown>
    }]
  })
}

export class LocalCompletionClient {
  private readonly endpoint: URL

  constructor(baseUrl: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.endpoint = new URL('/v1/chat/completions', baseUrl)
    if (this.endpoint.protocol !== 'http:' || !LOOPBACK_HOSTS.has(this.endpoint.hostname)) {
      throw new Error('Local completion endpoints must use loopback HTTP')
    }
  }

  async complete(request: LocalCompletionRequest): Promise<LocalCompletion> {
    const settings = validateRequest(request)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Local completion timed out')), this.timeoutMs)
    const abort = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abort, { once: true })

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(completionBody(request, settings, false)),
        signal: controller.signal
      })
      const body = await response.text()
      if (!response.ok) {
        const detail = describeResponseBody(body)
        throw new Error(`Local completion request failed with ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      let parsed: CompletionResponse
      try {
        parsed = JSON.parse(body) as CompletionResponse
      } catch {
        throw new Error('Local completion returned malformed JSON')
      }
      const choice = parsed.choices?.[0]
      const text = typeof choice?.message?.content === 'string' ? choice.message.content : ''
      const reasoningText = typeof choice?.message?.reasoning_content === 'string'
        ? choice.message.reasoning_content
        : typeof choice?.message?.reasoning === 'string' ? choice.message.reasoning : ''
      const toolCalls = parseToolCalls(choice?.message?.tool_calls)
      if (!text && !reasoningText && toolCalls.length === 0) throw new Error('Local completion response did not contain assistant text, reasoning, or tool calls')
      return {
        text,
        toolCalls,
        reasoningText: reasoningText || undefined,
        finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof Error) throw reason
        throw new Error('Local completion was cancelled')
      }
      throw error
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abort)
    }
  }

  async completePrompt(request: LocalPromptRequest): Promise<LocalCompletion> {
    const endpoint = new URL('/completion', this.endpoint)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: request.prompt,
        n_predict: request.maxTokens,
        temperature: request.temperature,
        top_k: request.topK,
        top_p: request.topP,
        repeat_penalty: request.repetitionPenalty,
        stream: false
      })
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Local title request failed with ${response.status}${body ? `: ${describeResponseBody(body)}` : ''}`)
    const parsed = JSON.parse(body) as PromptCompletionResponse
    if (typeof parsed.content !== 'string' || !parsed.content.trim()) throw new Error('Local title model returned an empty title')
    return { text: parsed.content.trim(), toolCalls: [] }
  }

  async stream(request: LocalCompletionRequest, onDelta: (delta: string) => void): Promise<LocalCompletion> {
    const settings = validateRequest(request)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Local completion timed out')), this.timeoutMs)
    const abort = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abort, { once: true })

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(completionBody(request, settings, true)),
        signal: controller.signal
      })
      if (!response.ok) {
        const detail = describeResponseBody(await response.text())
        throw new Error(`Local completion request failed with ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      if (!response.body) throw new Error('Local completion did not return a response stream')
      return await consumeOpenAiCompletionStream(response.body, onDelta)
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof Error) throw reason
        throw new Error('Local completion was cancelled')
      }
      throw error
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abort)
    }
  }
}
