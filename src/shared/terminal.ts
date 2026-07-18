export type TerminalCreator = 'user' | 'agent'
export type TerminalState = 'idle' | 'busy' | 'exited'
export type TerminalInterventionKind = 'approval' | 'busy-close' | 'user-input'

export interface TerminalSessionInfo {
  id: string
  title: string
  shell: string
  cwd: string
  projectPath: string
  threadId?: string
  creator: TerminalCreator
  state: TerminalState
  currentCommand?: string
  transcriptCursor: number
  panelVisible: boolean
  active: boolean
}

export interface TerminalOutputEvent {
  sessionId: string
  data: string
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
}

export interface TerminalSessionEvent {
  type: 'created' | 'updated' | 'closed'
  session: TerminalSessionInfo
}

export interface TerminalRevealEvent {
  sessionId: string
}

export interface TerminalTranscriptResult {
  sessionId: string
  output: string
  cursor: number
  truncated: boolean
  closed: boolean
}

export interface TerminalWaitResult extends TerminalTranscriptResult {
  reason: 'output' | 'pattern' | 'idle' | 'exit' | 'timeout' | 'closed'
  state: TerminalState
}

export interface TerminalUserMessage {
  reason: string
  instruction?: string
}

export interface TerminalInterventionRequest {
  id: string
  kind: TerminalInterventionKind
  terminalId?: string
  title: string
  reason: string
  instruction?: string
  impact?: string
  approveLabel: string
  cancelLabel: string
  waitsForResolution: boolean
}

export interface TerminalInterventionResolution {
  id: string
  approved: boolean
}
