export type ChatRole = 'user' | 'assistant' | 'tool'

export const MAX_CHAT_ATTACHMENTS = 4
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_FILE_PREVIEW_CHARACTERS = 30_000
export const CHAT_ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ChatAttachmentMimeType = typeof CHAT_ATTACHMENT_MIME_TYPES[number]
export type ChatAttachmentKind = 'image' | 'file'

export interface ChatAttachment {
  id: string
  name: string
  mimeType: string
  dataUrl: string
  size: number
  kind?: ChatAttachmentKind
  preview?: string
}

export interface StoredChatFile {
  attachment: ChatAttachment
  preview: string
}

export type AssistantMessageStatus = 'pending' | 'completed' | 'cancelled' | 'error'

export interface FileChangeDisplay {
  path: string
  additions: number
  deletions: number
}

export interface ToolUiMessage {
  uim_prt: string
  uim_pat: string
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type TodoPriority = 'low' | 'medium' | 'high'

export interface TodoDisplay {
  content: string
  status: TodoStatus
  priority: TodoPriority
}

export interface ToolCallDisplay {
  id: string
  name: string
  arguments: Record<string, unknown>
  uiMessage?: ToolUiMessage
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
  filesChanged?: string[]
  fileChanges?: FileChangeDisplay[]
  attachments?: ChatAttachment[]
  parentAssistantId?: string
  activityKind?: 'progress'
  progressId?: string
  progressSource?: 'model' | 'fallback'
  status?: AssistantMessageStatus
  startedAt?: number
  completedAt?: number
  durationMs?: number
  model?: import('./agent').AgentModelProvenance
}

export interface ChatThread {
  id: string
  projectPath: string
  title: string
  messages: ChatMessage[]
  updatedAt: number
  duration?: number
  todos?: TodoDisplay[]
}
