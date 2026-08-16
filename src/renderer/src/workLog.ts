import type { ChatMessage } from '../../shared/chat'

export interface WorkLogPhase {
  progress?: ChatMessage
  toolMessages: ChatMessage[]
}

export interface ProgressActivityUpdate {
  progressId: string
  summary: string
  source: 'model' | 'fallback'
}

export function isProgressActivity(message: ChatMessage): boolean {
  if (message.role !== 'tool' || !message.content || message.toolCalls?.length) return false
  if (message.content.startsWith('__reasoning__') || message.content.startsWith('__progress__')) return false
  return message.messagePhase === 'commentary' || message.activityKind === 'progress' || !message.toolCalls?.length
}

export function workLogMessagesForAssistant(messages: readonly ChatMessage[], assistantIndex: number): ChatMessage[] {
  const assistant = messages[assistantIndex]
  if (!assistant || assistant.role !== 'assistant') return []
  return messages.filter((message, messageIndex) => {
    if (message.role !== 'tool') return false
    if (message.parentAssistantId) return message.parentAssistantId === assistant.id
    if (messageIndex >= assistantIndex) return false
    return messages.slice(messageIndex + 1).find((candidate) => candidate.role === 'assistant')?.id === assistant.id
  })
}

export function buildWorkLogPhases(messages: readonly ChatMessage[]): WorkLogPhase[] {
  const phases: WorkLogPhase[] = []
  let current: WorkLogPhase | undefined
  for (const message of messages) {
    if (message.content.startsWith('__reasoning__') || message.content.startsWith('__progress__')) continue
    if (isProgressActivity(message)) {
      current = { progress: message, toolMessages: [] }
      phases.push(current)
      continue
    }
    if (!message.toolCalls?.length) continue
    if (!current) {
      current = { toolMessages: [] }
      phases.push(current)
    }
    current.toolMessages.push(message)
  }
  return phases
}

export function shouldShowWorkLog(status: ChatMessage['status'], expanded: boolean): boolean {
  return status === 'pending' || expanded
}

export function shouldShowToolPhase(pending: boolean, isLast: boolean): boolean {
  return !pending || !isLast
}

export function upsertProgressActivity(
  messages: readonly ChatMessage[],
  parentAssistantId: string,
  update: ProgressActivityUpdate,
  timestamp: number,
  messageId: string
): ChatMessage[] {
  const existingIndex = messages.findIndex((message) =>
    message.role === 'tool' &&
    message.parentAssistantId === parentAssistantId &&
    message.progressId === update.progressId
  )
  if (existingIndex >= 0) return messages.map((message, index) => index === existingIndex
    ? { ...message, content: update.summary, activityKind: 'progress', messagePhase: 'commentary', progressSource: update.source }
    : message)
  const progressMessage: ChatMessage = {
    id: messageId,
    role: 'tool',
    content: update.summary,
    timestamp,
    parentAssistantId,
    activityKind: 'progress',
    messagePhase: 'commentary',
    progressId: update.progressId,
    progressSource: update.source
  }
  const assistantIndex = messages.findIndex((message) => message.id === parentAssistantId)
  if (assistantIndex < 0) return [...messages, progressMessage]
  return [...messages.slice(0, assistantIndex), progressMessage, ...messages.slice(assistantIndex)]
}
