export interface TerminalSessionInfo {
  id: string
  title: string
  shell: string
}

export interface TerminalOutputEvent {
  sessionId: string
  data: string
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
}
