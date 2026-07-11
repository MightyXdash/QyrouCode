export type ChatRole = 'user' | 'assistant' | 'tool'

export const MAX_CHAT_ATTACHMENTS = 4
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const CHAT_ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ChatAttachmentMimeType = typeof CHAT_ATTACHMENT_MIME_TYPES[number]

export interface ChatAttachment {
  id: string
  name: string
  mimeType: ChatAttachmentMimeType
  dataUrl: string
  size: number
}

export type AssistantMessageStatus = 'pending' | 'completed' | 'cancelled' | 'error'

export interface FileChangeDisplay {
  path: string
  additions: number
  deletions: number
}

export interface ToolCallDisplay {
  id: string
  name: string
  arguments: Record<string, unknown>
  result?: string
  filePath?: string
  error?: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  timestamp?: number
  toolCalls?: ToolCallDisplay[]
  reasoningSummary?: string
  filesChanged?: string[]
  fileChanges?: FileChangeDisplay[]
  attachments?: ChatAttachment[]
  parentAssistantId?: string
  status?: AssistantMessageStatus
  startedAt?: number
  completedAt?: number
  durationMs?: number
}

export interface ChatThread {
  id: string
  projectPath: string
  title: string
  messages: ChatMessage[]
  updatedAt: number
  duration?: number
}

