export interface PersistedTextContentPart {
  type: 'text'
  text: string
}

export interface PersistedImageContentPart {
  type: 'image_url'
  image_url: { url: string }
}

export type PersistedMessageContent = string | Array<PersistedTextContentPart | PersistedImageContentPart> | null

export interface PersistedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type AgentModelSource = 'local' | 'remote'
export type ReasoningRetention = 'retain' | 'discard'

export interface AgentModelProvenance {
  source: AgentModelSource
  connectionId?: string
  provider: string
  modelId: string
  displayName: string
  reasoningRetention: ReasoningRetention
}

export type AgentExecutionTarget =
  | { source: 'local'; modelId: string; displayName: string }
  | { source: 'remote'; connectionId: string; modelId: string; reasoningEffort: ViewReasoningEffort }

export interface PersistedAgentMessage {
  role: 'user' | 'assistant' | 'tool'
  content: PersistedMessageContent
  name?: string
  toolCallId?: string
  toolCalls?: PersistedToolCall[]
  reasoningText?: string
  filePath?: string
  model?: AgentModelProvenance
}

export interface PersistedAgentSession {
  threadId: string
  projectPath: string
  messages: PersistedAgentMessage[]
  updatedAt: number
  duration?: number
}

export const VIEW_REASONING_EFFORTS = ['Instant', 'Low', 'Medium', 'High', 'Extra high'] as const
export type ViewReasoningEffort = typeof VIEW_REASONING_EFFORTS[number]

export interface WorkspaceViewState {
  selectedProjectPath: string
  activeThreadId: string
  selectedModelId: string
  reasoningEffort: ViewReasoningEffort
  sidebarOpen: boolean
  promptDraft: string
  expandedWorkIds: string[]
}

export const DEFAULT_WORKSPACE_VIEW_STATE: WorkspaceViewState = {
  selectedProjectPath: '',
  activeThreadId: '',
  selectedModelId: '',
  reasoningEffort: 'Medium',
  sidebarOpen: true,
  promptDraft: '',
  expandedWorkIds: []
}
