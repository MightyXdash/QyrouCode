import type { GenerationMetrics, LocalCompletion, LocalToolCall } from './localCompletionClient'

interface StreamToolCallDelta {
  index?: unknown
  id?: unknown
  function?: {
    name?: unknown
    arguments?: unknown
  }
}

interface StreamChoice {
  delta?: {
    content?: unknown
    reasoning_content?: unknown
    reasoning?: unknown
    tool_calls?: unknown
  }
  message?: {
    content?: unknown
    reasoning_content?: unknown
    reasoning?: unknown
    tool_calls?: unknown
  }
  finish_reason?: unknown
}

interface StreamChunk {
  choices?: StreamChoice[]
  usage?: {
    completion_tokens?: unknown
  }
  timings?: {
    predicted_n?: unknown
    predicted_ms?: unknown
  }
}

interface PendingToolCall {
  id: string
  name: string
  argumentsText: string
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((part) => {
    if (!part || typeof part !== 'object') return []
    const candidate = part as { type?: unknown; text?: unknown }
    return candidate.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : []
  }).join('')
}

function appendToolDeltas(value: unknown, pending: Map<number, PendingToolCall>): boolean {
  if (!Array.isArray(value)) return false
  let generated = false
  for (const [position, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object') continue
    const delta = raw as StreamToolCallDelta
    const index = Number.isInteger(delta.index) ? Number(delta.index) : position
    const current = pending.get(index) ?? { id: '', name: '', argumentsText: '' }
    if (typeof delta.id === 'string') current.id += delta.id
    if (typeof delta.function?.name === 'string') {
      current.name += delta.function.name
      generated ||= delta.function.name.length > 0
    }
    if (typeof delta.function?.arguments === 'string') {
      current.argumentsText += delta.function.arguments
      generated ||= delta.function.arguments.length > 0
    }
    pending.set(index, current)
  }
  return generated
}

function completedToolCalls(pending: ReadonlyMap<number, PendingToolCall>): LocalToolCall[] {
  return [...pending.entries()].sort(([left], [right]) => left - right).flatMap(([index, call]) => {
    if (!call.name) return []
    let argumentsValue: unknown = {}
    if (call.argumentsText) {
      try {
        argumentsValue = JSON.parse(call.argumentsText)
      } catch {
        argumentsValue = {}
      }
    }
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) argumentsValue = {}
    return [{
      id: call.id || `call_${index + 1}`,
      name: call.name,
      arguments: argumentsValue as Record<string, unknown>
    }]
  })
}

export async function consumeOpenAiCompletionStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  onGenerationMetrics?: (metrics: GenerationMetrics) => void
): Promise<LocalCompletion> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const pendingTools = new Map<number, PendingToolCall>()
  let buffer = ''
  let text = ''
  let reasoningText = ''
  let finishReason: string | undefined
  let doneEvent = false
  let firstGeneratedAt: number | undefined
  let completionTokens: number | undefined
  let generationDurationMs: number | undefined

  const processEvent = (event: string): void => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
    if (!data) return
    if (data === '[DONE]') {
      doneEvent = true
      return
    }
    let parsed: StreamChunk
    try {
      parsed = JSON.parse(data) as StreamChunk
    } catch {
      throw new Error('Completion provider returned malformed stream data')
    }
    const usageTokens = parsed.usage?.completion_tokens
    const predictedTokens = parsed.timings?.predicted_n
    const predictedDuration = parsed.timings?.predicted_ms
    if (typeof usageTokens === 'number' && Number.isFinite(usageTokens) && usageTokens >= 0) completionTokens = usageTokens
    else if (typeof predictedTokens === 'number' && Number.isFinite(predictedTokens) && predictedTokens >= 0) completionTokens = predictedTokens
    if (typeof predictedDuration === 'number' && Number.isFinite(predictedDuration) && predictedDuration > 0) generationDurationMs = predictedDuration
    const choice = parsed.choices?.[0]
    if (!choice) return
    const contentDelta = textValue(choice.delta?.content ?? choice.message?.content)
    if (contentDelta) {
      firstGeneratedAt ??= Date.now()
      text += contentDelta
      onDelta(contentDelta)
    }
    const reasoningDelta = textValue(choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? choice.message?.reasoning_content ?? choice.message?.reasoning)
    if (reasoningDelta) {
      firstGeneratedAt ??= Date.now()
      reasoningText += reasoningDelta
    }
    const generatedToolDelta = appendToolDeltas(choice.delta?.tool_calls ?? choice.message?.tool_calls, pendingTools)
    if (generatedToolDelta) firstGeneratedAt ??= Date.now()
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
  }

  while (!doneEvent) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() ?? ''
    for (const event of events) processEvent(event)
    if (done) {
      if (buffer.trim()) processEvent(buffer)
      break
    }
  }

  const toolCalls = completedToolCalls(pendingTools)
  if (!text && !reasoningText && toolCalls.length === 0) throw new Error('Completion stream did not contain assistant text, reasoning, or tool calls')
  if (completionTokens !== undefined && completionTokens > 0 && firstGeneratedAt !== undefined) {
    onGenerationMetrics?.({
      tokens: completionTokens,
      durationMs: generationDurationMs ?? Math.max(1, Date.now() - firstGeneratedAt)
    })
  }
  return { text, toolCalls, reasoningText: reasoningText || undefined, finishReason }
}
