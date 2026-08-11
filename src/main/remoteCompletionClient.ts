import type { ConnectionKind } from '../shared/connections'
import type { GenerationMetrics, LocalChatMessage, LocalCompletion, LocalCompletionRequest, LocalToolCall } from './localCompletionClient'
import type { AgentCompletionProvider } from './agentRuntime'
import { consumeOpenAiCompletionStream } from './openAiCompletionStream'

export interface RemoteReasoningConfiguration {
  enabled?: boolean
  nativeEffort?: string
  maxTokens?: number
  fallbackPrompt?: string
}

export interface RemoteCompletionConfiguration {
  kind: ConnectionKind
  baseUrl: string
  apiKey: string
  modelId: string
  retainReasoning: boolean
  reasoning: RemoteReasoningConfiguration
}

interface RemoteCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown
      reasoning_content?: unknown
      reasoning?: unknown
      tool_calls?: unknown
    }
    finish_reason?: unknown
  }>
  error?: { message?: unknown }
}

const DEFAULT_REMOTE_TIMEOUT_MS = 10 * 60_000
const CHAT_COMPLETIONS_PATH = 'chat/completions'
const JSON_CONTENT_TYPE = 'application/json'

function completionEndpoint(baseUrl: string): URL {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(CHAT_COMPLETIONS_PATH, normalized)
}

function serializeMessage(message: LocalChatMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    name: message.name,
    tool_call_id: message.toolCallId,
    tool_calls: message.toolCalls?.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
    }))
  }
}

function parseToolCalls(value: unknown): LocalToolCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const candidate = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    if (!candidate.function || typeof candidate.function.name !== 'string') return []
    let argumentsValue: unknown = candidate.function.arguments
    if (typeof argumentsValue === 'string') {
      try {
        argumentsValue = JSON.parse(argumentsValue)
      } catch {
        return []
      }
    }
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) argumentsValue = {}
    return [{
      id: typeof candidate.id === 'string' && candidate.id ? candidate.id : `call_${index + 1}`,
      name: candidate.function.name,
      arguments: argumentsValue as Record<string, unknown>
    }]
  })
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((part) => {
    if (!part || typeof part !== 'object') return []
    const candidate = part as { type?: unknown; text?: unknown }
    return candidate.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : []
  }).join('')
}

function reasoningFields(kind: ConnectionKind, configuration: RemoteReasoningConfiguration, retainReasoning: boolean): Record<string, unknown> {
  const effort = configuration.nativeEffort
  if (kind === 'openrouter') {
    return {
      reasoning: {
        enabled: configuration.enabled,
        effort,
        max_tokens: configuration.maxTokens,
        exclude: !retainReasoning
      }
    }
  }
  if (kind === 'anthropic') {
    const disabled = configuration.enabled === false || effort === 'none' || effort === 'disabled'
    return {
      thinking: disabled ? { type: 'disabled' } : { type: 'adaptive', display: 'omitted' },
      output_config: disabled || !effort ? undefined : { effort }
    }
  }
  if ((kind === 'openai' || kind === 'gemini') && effort) return { reasoning_effort: effort }
  return {}
}

function completionBody(request: LocalCompletionRequest, configuration: RemoteCompletionConfiguration, stream = false): Record<string, unknown> {
  const reasoning = request.suppressReasoning ? { enabled: false } : configuration.reasoning
  const messages: readonly LocalChatMessage[] = reasoning.fallbackPrompt && !request.suppressReasoningPrompt
    ? [{ role: 'system', content: reasoning.fallbackPrompt }, ...request.messages]
    : request.messages
  const usesNativeReasoning = Boolean(reasoning.nativeEffort || reasoning.enabled)
  return {
    model: configuration.modelId,
    messages: messages.map(serializeMessage),
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    max_tokens: request.maxTokens,
    temperature: usesNativeReasoning ? undefined : request.temperature,
    top_p: usesNativeReasoning ? undefined : request.topP,
    tools: request.tools?.map((definition) => ({ type: 'function', function: definition })),
    tool_choice: request.tools?.length ? request.toolChoice ?? 'auto' : undefined,
    chat_template_kwargs: configuration.kind === 'openai-compatible' && request.enableThinking !== undefined
      ? { enable_thinking: request.enableThinking }
      : undefined,
    store: configuration.kind === 'openai' ? false : undefined,
    ...reasoningFields(configuration.kind, reasoning, configuration.retainReasoning)
  }
}

function responseDetail(body: string, apiKey: string): string {
  let detail = body.trim()
  try {
    const parsed = JSON.parse(body) as RemoteCompletionResponse
    if (typeof parsed.error?.message === 'string') detail = parsed.error.message
  } catch {}
  if (apiKey) detail = detail.replaceAll(apiKey, '[REDACTED]')
  return detail.slice(0, 1_000)
}

export class RemoteCompletionClient implements AgentCompletionProvider {
  private readonly endpoint: URL

  constructor(private readonly configuration: RemoteCompletionConfiguration, private readonly timeoutMs = DEFAULT_REMOTE_TIMEOUT_MS) {
    this.endpoint = completionEndpoint(configuration.baseUrl)
  }

  async complete(request: LocalCompletionRequest): Promise<LocalCompletion> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Remote completion timed out')), this.timeoutMs)
    const abort = (): void => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.configuration.apiKey}`,
          'content-type': JSON_CONTENT_TYPE
        },
        body: JSON.stringify(completionBody(request, this.configuration)),
        signal: controller.signal
      })
      const body = await response.text()
      if (!response.ok) {
        const detail = responseDetail(body, this.configuration.apiKey)
        throw new Error(`Remote completion request failed with ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      let parsed: RemoteCompletionResponse
      try {
        parsed = JSON.parse(body) as RemoteCompletionResponse
      } catch {
        throw new Error('Remote completion returned malformed JSON')
      }
      const choice = parsed.choices?.[0]
      const text = messageText(choice?.message?.content)
      const toolCalls = parseToolCalls(choice?.message?.tool_calls)
      const reasoningText = this.configuration.retainReasoning
        ? typeof choice?.message?.reasoning_content === 'string'
          ? choice.message.reasoning_content
          : typeof choice?.message?.reasoning === 'string' ? choice.message.reasoning : undefined
        : undefined
      if (!text && !reasoningText && toolCalls.length === 0) throw new Error('Remote completion did not contain assistant text, reasoning, or tool calls')
      return {
        text,
        toolCalls,
        reasoningText,
        finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof Error) throw reason
        throw new Error('Remote completion was cancelled')
      }
      throw error
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abort)
    }
  }

  async stream(request: LocalCompletionRequest, onDelta: (delta: string) => void, onGenerationMetrics?: (metrics: GenerationMetrics) => void): Promise<LocalCompletion> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Remote completion timed out')), this.timeoutMs)
    const abort = (): void => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.configuration.apiKey}`,
          'content-type': JSON_CONTENT_TYPE
        },
        body: JSON.stringify(completionBody(request, this.configuration, true)),
        signal: controller.signal
      })
      if (!response.ok) {
        const detail = responseDetail(await response.text(), this.configuration.apiKey)
        throw new Error(`Remote completion request failed with ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      if (!response.body) throw new Error('Remote completion did not return a response stream')
      const completion = await consumeOpenAiCompletionStream(response.body, onDelta, onGenerationMetrics)
      return this.configuration.retainReasoning ? completion : { ...completion, reasoningText: undefined }
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof Error) throw reason
        throw new Error('Remote completion was cancelled')
      }
      throw error
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abort)
    }
  }
}
