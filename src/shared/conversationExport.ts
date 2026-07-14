export const CONVERSATION_EXPORT_SCOPES = ['thread', 'project', 'all'] as const
export const CONVERSATION_EXPORT_FORMATS = ['jsonl', 'json'] as const
export const ATTACHMENT_EXPORT_MODES = ['none', 'metadata', 'embedded'] as const

export type ConversationExportScope = typeof CONVERSATION_EXPORT_SCOPES[number]
export type ConversationExportFormat = typeof CONVERSATION_EXPORT_FORMATS[number]
export type AttachmentExportMode = typeof ATTACHMENT_EXPORT_MODES[number]

export interface ConversationExportRequest {
  scope: ConversationExportScope
  format: ConversationExportFormat
  threadId?: string
  projectPath?: string
  includeMessages: boolean
  includeToolCalls: boolean
  includeRawReasoning: boolean
  includeTimestamps: boolean
  attachments: AttachmentExportMode
  redactSensitiveData: boolean
}

export interface ConversationExportPreview {
  threadCount: number
  messageCount: number
  rawReasoningCount: number
  toolCallCount: number
}

export interface ConversationExportResult extends ConversationExportPreview {
  saved: boolean
  filePath?: string
}

const includes = <T extends string>(values: readonly T[], value: unknown): value is T =>
  values.includes(value as T)

export function validateConversationExportRequest(value: unknown): ConversationExportRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid export request')
  const request = value as Partial<ConversationExportRequest>
  if (
    !includes(CONVERSATION_EXPORT_SCOPES, request.scope) ||
    !includes(CONVERSATION_EXPORT_FORMATS, request.format) ||
    !includes(ATTACHMENT_EXPORT_MODES, request.attachments) ||
    typeof request.includeMessages !== 'boolean' ||
    typeof request.includeToolCalls !== 'boolean' ||
    typeof request.includeRawReasoning !== 'boolean' ||
    typeof request.includeTimestamps !== 'boolean' ||
    typeof request.redactSensitiveData !== 'boolean' ||
    (request.threadId !== undefined && typeof request.threadId !== 'string') ||
    (request.projectPath !== undefined && typeof request.projectPath !== 'string')
  ) throw new Error('Invalid export request')
  if (request.scope === 'thread' && !request.threadId) throw new Error('Choose a thread to export')
  if (request.scope === 'project' && !request.projectPath) throw new Error('Choose a project to export')
  return request as ConversationExportRequest
}
