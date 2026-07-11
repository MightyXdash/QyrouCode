export type LocalChatRole = 'system' | 'user' | 'assistant'

export interface LocalChatMessage {
  role: LocalChatRole
  content: string
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
}

export interface LocalCompletionStart {
  requestId: string
}

export type LocalCompletionEvent =
  | { requestId: string; type: 'delta'; delta: string }
  | { requestId: string; type: 'complete' }
  | { requestId: string; type: 'cancelled' }
  | { requestId: string; type: 'error'; message: string }

interface CompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown
    }
    delta?: {
      content?: unknown
    }
  }>
}

interface PromptCompletionResponse {
  content?: unknown
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_TEMPERATURE = 0.2
const MAX_REQUEST_MESSAGES = 64
const MAX_MESSAGE_CHARACTERS = 32_000
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
    throw new Error('Completion requests must include between 1 and 64 messages')
  }
  for (const message of request.messages) {
    if (!['system', 'user', 'assistant'].includes(message.role) || message.content.length === 0 || message.content.length > MAX_MESSAGE_CHARACTERS) {
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

const completionBody = (messages: readonly LocalChatMessage[], settings: CompletionSettings, stream: boolean): Record<string, unknown> => ({
  messages,
  stream,
  max_tokens: settings.maxTokens,
  temperature: settings.temperature,
  top_p: settings.topP,
  top_k: settings.topK,
  min_p: settings.minP,
  presence_penalty: settings.presencePenalty,
  repeat_penalty: settings.repetitionPenalty,
  chat_template_kwargs: { enable_thinking: settings.enableThinking },
  reasoning_format: 'deepseek'
})

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
        body: JSON.stringify(completionBody(request.messages, settings, false)),
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
      const text = parsed.choices?.[0]?.message?.content
      if (typeof text !== 'string' || text.length === 0) throw new Error('Local completion response did not contain assistant text')
      return { text }
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
    return { text: parsed.content.trim() }
  }

  async stream(request: LocalCompletionRequest, onDelta: (delta: string) => void): Promise<void> {
    const settings = validateRequest(request)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Local completion timed out')), this.timeoutMs)
    const abort = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abort, { once: true })

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(completionBody(request.messages, settings, true)),
        signal: controller.signal
      })
      if (!response.ok) {
        const detail = describeResponseBody(await response.text())
        throw new Error(`Local completion request failed with ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      if (!response.body) throw new Error('Local completion did not return a response stream')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const event = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
          if (!data) continue
          if (data === '[DONE]') return
          let parsed: CompletionResponse
          try {
            parsed = JSON.parse(data) as CompletionResponse
          } catch {
            throw new Error('Local completion returned malformed stream data')
          }
          const delta = parsed.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) onDelta(delta)
        }
        if (done) return
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
}
