export type LocalChatRole = 'system' | 'user' | 'assistant'

export interface LocalChatMessage {
  role: LocalChatRole
  content: string
}

export interface LocalCompletionRequest {
  messages: readonly LocalChatMessage[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
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

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TOKENS = 512
const DEFAULT_TEMPERATURE = 0.2
const MAX_REQUEST_MESSAGES = 64
const MAX_MESSAGE_CHARACTERS = 32_000
const MAX_COMPLETION_TOKENS = 4_096
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

const validateRequest = (request: LocalCompletionRequest): Required<Pick<LocalCompletionRequest, 'maxTokens' | 'temperature'>> => {
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
    throw new Error('Completion requests must use between 1 and 4096 output tokens')
  }
  const temperature = request.temperature ?? DEFAULT_TEMPERATURE
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error('Completion requests must use a temperature between 0 and 2')
  }
  return { maxTokens, temperature }
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
    const { maxTokens, temperature } = validateRequest(request)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Local completion timed out')), this.timeoutMs)
    const abort = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abort, { once: true })

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: request.messages, stream: false, max_tokens: maxTokens, temperature }),
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

  async stream(request: LocalCompletionRequest, onDelta: (delta: string) => void): Promise<void> {
    const { maxTokens, temperature } = validateRequest(request)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Local completion timed out')), this.timeoutMs)
    const abort = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abort, { once: true })

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: request.messages, stream: true, max_tokens: maxTokens, temperature }),
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
