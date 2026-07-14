import type { ChatAttachment, ChatMessage, ChatThread } from '../shared/chat'
import type { AgentModelProvenance, PersistedAgentMessage, PersistedAgentSession, PersistedMessageContent } from '../shared/agent'
import type { ConversationExportPreview, ConversationExportRequest } from '../shared/conversationExport'

interface OpenAIExportToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAIExportMessage {
  role: 'user' | 'assistant' | 'tool'
  content: PersistedMessageContent
  name?: string
  tool_call_id?: string
  tool_calls?: OpenAIExportToolCall[]
  reasoning_content?: string
  metadata?: Record<string, unknown>
}

interface ConversationExportRecord {
  id: string
  messages: OpenAIExportMessage[]
  metadata: Record<string, unknown>
}

export interface BuiltConversationExport {
  content: string
  preview: ConversationExportPreview
  records: ConversationExportRecord[]
}

const REDACTED_VALUE = '[REDACTED]'
const SENSITIVE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{12,}\b/g, REDACTED_VALUE],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED_VALUE],
  [/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED_VALUE],
  [/(authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s"']+/gi, `$1${REDACTED_VALUE}`],
  [/((?:api[_-]?key|access[_-]?token|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, `$1${REDACTED_VALUE}`]
]

function canRetainReasoning(model: AgentModelProvenance | undefined): boolean {
  if (!model) return true
  if (model.source === 'local') return true
  return model.reasoningRetention === 'retain'
}

function redactString(value: string): string {
  return SENSITIVE_REPLACEMENTS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value)
}

function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)])) as T
}

function filteredContent(content: PersistedMessageContent, attachments: ConversationExportRequest['attachments']): PersistedMessageContent {
  if (!Array.isArray(content)) return content
  const parts = content.filter((part) => part.type === 'text' || attachments === 'embedded')
  if (parts.length === 0) return ''
  return parts
}

function modelMetadata(model: AgentModelProvenance | undefined): Record<string, unknown> | undefined {
  if (!model) return undefined
  return {
    source: model.source,
    connection_id: model.connectionId,
    provider: model.provider,
    model_id: model.modelId,
    display_name: model.displayName
  }
}

function persistedMessageToOpenAI(message: PersistedAgentMessage, request: ConversationExportRequest): OpenAIExportMessage | undefined {
  if (!request.includeToolCalls && message.role === 'tool') return undefined
  const toolCalls = request.includeToolCalls ? message.toolCalls ?? [] : []
  const hasToolCalls = toolCalls.length > 0
  const hasEligibleReasoning = Boolean(request.includeRawReasoning && message.reasoningText && canRetainReasoning(message.model))
  if (!request.includeMessages && message.role !== 'tool' && !hasToolCalls && !hasEligibleReasoning) return undefined
  const exported: OpenAIExportMessage = {
    role: message.role,
    content: request.includeMessages || message.role === 'tool' ? filteredContent(message.content, request.attachments) : null,
    name: message.role === 'tool' ? message.name : undefined,
    tool_call_id: message.role === 'tool' ? message.toolCallId : undefined,
    tool_calls: hasToolCalls
      ? toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
      : undefined,
    reasoning_content: hasEligibleReasoning
      ? message.reasoningText
      : undefined,
    metadata: modelMetadata(message.model)
  }
  return request.redactSensitiveData ? redactValue(exported) : exported
}

function attachmentMetadata(attachments: readonly ChatAttachment[] | undefined): Array<Record<string, unknown>> {
  return attachments?.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mime_type: attachment.mimeType,
    size: attachment.size
  })) ?? []
}

function fallbackMessages(thread: ChatThread, request: ConversationExportRequest): OpenAIExportMessage[] {
  return thread.messages.flatMap((message): OpenAIExportMessage[] => {
    if (message.role === 'tool' && !request.includeToolCalls) return []
    if (message.role !== 'tool' && !request.includeMessages) return []
    const metadata: Record<string, unknown> = {
      ...modelMetadata(message.model),
      ...(request.includeTimestamps && message.timestamp ? { timestamp: message.timestamp } : {}),
      ...(request.attachments === 'metadata' && message.attachments?.length ? { attachments: attachmentMetadata(message.attachments) } : {})
    }
    const exported: OpenAIExportMessage = {
      role: message.role,
      content: message.attachments?.length && request.attachments === 'embedded'
        ? [
            { type: 'text', text: message.content },
            ...message.attachments.map((attachment) => ({ type: 'image_url' as const, image_url: { url: attachment.dataUrl } }))
          ]
        : message.content,
      metadata: Object.keys(metadata).length ? metadata : undefined
    }
    return [request.redactSensitiveData ? redactValue(exported) : exported]
  })
}

function threadRecord(thread: ChatThread, session: PersistedAgentSession | undefined, request: ConversationExportRequest): ConversationExportRecord {
  const messages = session
    ? session.messages.flatMap((message) => {
        const exported = persistedMessageToOpenAI(message, request)
        return exported ? [exported] : []
      })
    : fallbackMessages(thread, request)
  const models = [...new Map([
    ...thread.messages.flatMap((message) => message.model ? [[`${message.model.connectionId ?? 'local'}:${message.model.modelId}`, modelMetadata(message.model)] as const] : []),
    ...(session?.messages.flatMap((message) => message.model ? [[`${message.model.connectionId ?? 'local'}:${message.model.modelId}`, modelMetadata(message.model)] as const] : []) ?? [])
  ]).values()]
  return {
    id: thread.id,
    messages,
    metadata: {
      title: thread.title,
      project_path: thread.projectPath,
      models,
      ...(request.includeTimestamps ? { updated_at: thread.updatedAt, duration_ms: thread.duration } : {})
    }
  }
}

function selectedThreads(threads: readonly ChatThread[], request: ConversationExportRequest): ChatThread[] {
  if (request.scope === 'thread') return threads.filter((thread) => thread.id === request.threadId)
  if (request.scope === 'project') return threads.filter((thread) => thread.projectPath === request.projectPath)
  return [...threads]
}

export function buildConversationExport(
  request: ConversationExportRequest,
  threads: readonly ChatThread[],
  sessions: Readonly<Record<string, PersistedAgentSession>>
): BuiltConversationExport {
  const records = selectedThreads(threads, request)
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .map((thread) => threadRecord(thread, sessions[thread.id], request))
  const preview = records.reduce<ConversationExportPreview>((summary, record) => ({
    threadCount: summary.threadCount + 1,
    messageCount: summary.messageCount + record.messages.length,
    rawReasoningCount: summary.rawReasoningCount + record.messages.filter((message) => message.reasoning_content).length,
    toolCallCount: summary.toolCallCount + record.messages.reduce((count, message) => count + (message.tool_calls?.length ?? 0), 0)
  }), { threadCount: 0, messageCount: 0, rawReasoningCount: 0, toolCallCount: 0 })
  return {
    records,
    preview,
    content: request.format === 'jsonl'
      ? records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')
      : JSON.stringify({ version: 1, conversations: records }, null, 2)
  }
}

export function exportFilename(request: ConversationExportRequest, now = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  return `supracode-conversations-${date}.${request.format}`
}
