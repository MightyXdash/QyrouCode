export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
}

export interface ChatThread {
  id: string
  projectPath: string
  title: string
  messages: ChatMessage[]
  updatedAt: number
}

