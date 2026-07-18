import { randomUUID } from 'crypto'
import { chmodSync, existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { createRequire } from 'module'
import { execFile, spawn as spawnProcess } from 'child_process'
import { ipcMain, shell as electronShell, type WebContents } from 'electron'
import { spawn, type IPty } from 'node-pty'
import type {
  TerminalCreator,
  TerminalInterventionRequest,
  TerminalInterventionResolution,
  TerminalSessionEvent,
  TerminalSessionInfo,
  TerminalState,
  TerminalTranscriptResult,
  TerminalUserMessage,
  TerminalWaitResult
} from '../shared/terminal'
import { TerminalTranscript } from './terminalTranscript'

const DEFAULT_COLUMNS = 80
const DEFAULT_ROWS = 24
const MIN_TERMINAL_DIMENSION = 1
const MAX_TERMINAL_DIMENSION = 1000
const MAX_TRANSCRIPT_CHARACTERS = 1024 * 1024
const MAX_AGENT_READ_CHARACTERS = 48_000
const MAX_TITLE_CHARACTERS = 48
const MAX_USER_MESSAGE_CHARACTERS = 240
const TERMINAL_POLL_INTERVAL_MS = 100
const TERMINAL_STATE_REFRESH_INTERVAL_MS = 500
const COMMAND_START_GRACE_MS = 750
const UNIX_EXECUTABLE_MODE = 0o755
const UNIX_EXECUTABLE_BITS = 0o111
const CATASTROPHIC_COMMAND = /(?:\brm\s+-rf\s+(?:\/|~)|\bRemove-Item\b[^\r\n]*-Recurse[^\r\n]*(?:[A-Za-z]:\\|\s\/)|\b(?:shutdown|reboot|format)\b|\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f))/i
const nodeRequire = createRequire(__filename)

interface ManagedTerminal {
  owner: WebContents
  process: IPty
  info: TerminalSessionInfo
  transcript: TerminalTranscript
  commandStartedAt?: number
  inputBuffer: string
  stateRefreshTimer?: ReturnType<typeof setTimeout>
}

interface CreateTerminalInput {
  cwd?: string
  projectPath: string
  threadId?: string
  creator: TerminalCreator
  title?: string
  reveal?: boolean
}

export interface AgentTerminalController {
  create(title?: string): TerminalSessionInfo
  list(): Promise<TerminalSessionInfo[]>
  setTitle(sessionId: string, title: string): TerminalSessionInfo
  run(sessionId: string, command: string): Promise<TerminalSessionInfo>
  write(sessionId: string, data: string): Promise<void>
  sendKey(sessionId: string, key: string): Promise<void>
  read(sessionId: string, cursor?: number, limit?: number): TerminalTranscriptResult
  wait(sessionId: string, cursor: number, until: 'output' | 'pattern' | 'idle' | 'exit', timeoutMs: number, pattern?: string): Promise<TerminalWaitResult>
  status(sessionId: string): Promise<TerminalSessionInfo>
  interrupt(sessionId: string): Promise<void>
  clear(sessionId: string): Promise<void>
  close(sessionId: string, userMessage: TerminalUserMessage): Promise<'closed' | 'denied'>
  requestUserInput(sessionId: string, userMessage: TerminalUserMessage, mode: 'pause' | 'continue'): Promise<'completed' | 'cancelled' | 'continuing'>
  openUrl(url: string, userMessage: TerminalUserMessage, sessionId?: string): Promise<void>
  openPath(path: string, userMessage: TerminalUserMessage, sessionId?: string): Promise<void>
  revealPath(path: string, userMessage: TerminalUserMessage, sessionId?: string): Promise<void>
  launchApp(target: string, userMessage: TerminalUserMessage, sessionId?: string): Promise<void>
}

const terminals = new Map<string, ManagedTerminal>()
const pendingInterventions = new Map<string, { ownerId: number; request: TerminalInterventionRequest; resolve?: (approved: boolean) => void }>()

function shellCommand(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env['SHELL'] || '/bin/bash'
}

function ensureUnixPtyHelperExecutable(): void {
  if (process.platform === 'win32') return
  const nodePtyRoot = dirname(dirname(nodeRequire.resolve('node-pty')))
  const helperPaths = [
    join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(nodePtyRoot, 'build', 'Release', 'spawn-helper')
  ].map((helperPath) => helperPath.replace('app.asar', 'app.asar.unpacked').replace('node_modules.asar', 'node_modules.asar.unpacked'))
  const helperPath = helperPaths.find((candidate) => existsSync(candidate))
  if (helperPath && !(statSync(helperPath).mode & UNIX_EXECUTABLE_BITS)) chmodSync(helperPath, UNIX_EXECUTABLE_MODE)
}

function safeText(value: unknown, fallback: string, maximum = MAX_USER_MESSAGE_CHARACTERS): string {
  if (typeof value !== 'string') return fallback
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return sanitized ? sanitized.slice(0, maximum) : fallback
}

function commandSummary(command: string): string {
  return safeText(command, 'the active command', 180)
}

function workingDirectory(value: unknown, fallback = homedir()): string {
  return typeof value === 'string' && existsSync(value) && statSync(value).isDirectory() ? resolve(value) : fallback
}

function sessionFor(ownerId: number, sessionId: unknown): ManagedTerminal | undefined {
  if (typeof sessionId !== 'string') return undefined
  const terminal = terminals.get(sessionId)
  return terminal?.owner.id === ownerId ? terminal : undefined
}

function requireSession(ownerId: number, sessionId: string): ManagedTerminal {
  const terminal = sessionFor(ownerId, sessionId)
  if (!terminal) throw new Error('Terminal session is unavailable or has been closed')
  return terminal
}

function requireProjectSession(ownerId: number, projectPath: string, sessionId: string): ManagedTerminal {
  const terminal = requireSession(ownerId, sessionId)
  if (terminal.info.projectPath !== projectPath) throw new Error('Terminal session belongs to a different project')
  return terminal
}

function requireWritableSession(ownerId: number, projectPath: string, sessionId: string): ManagedTerminal {
  const terminal = requireProjectSession(ownerId, projectPath, sessionId)
  if (terminal.info.state === 'exited') throw new Error('Terminal process has exited')
  return terminal
}

function emitSession(terminal: ManagedTerminal, type: TerminalSessionEvent['type']): void {
  if (!terminal.owner.isDestroyed()) terminal.owner.send('terminal-session-event', { type, session: { ...terminal.info } } satisfies TerminalSessionEvent)
}

function appendOutput(terminal: ManagedTerminal, data: string): void {
  terminal.transcript.append(data)
  terminal.info.transcriptCursor = terminal.transcript.cursor
  if (!terminal.owner.isDestroyed()) terminal.owner.send('terminal-output', { sessionId: terminal.info.id, data })
}

function systemOutput(terminal: ManagedTerminal, message: string): void {
  appendOutput(terminal, `\r\n\u001b[2m[SupraCode] ${message}\u001b[0m\r\n`)
}

function hasChildProcess(pid: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    if (process.platform === 'win32') {
      const command = `if (Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}") { exit 0 } else { exit 1 }`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (error) => resolvePromise(!error))
      return
    }
    execFile('/bin/ps', ['-axo', 'ppid='], { windowsHide: true }, (error, stdout) => {
      resolvePromise(!error && stdout.split(/\r?\n/u).some((parentPid) => Number(parentPid.trim()) === pid))
    })
  })
}

async function refreshState(terminal: ManagedTerminal): Promise<TerminalState> {
  if (terminal.info.state === 'exited') return 'exited'
  const starting = terminal.commandStartedAt !== undefined && Date.now() - terminal.commandStartedAt < COMMAND_START_GRACE_MS
  const nextState: TerminalState = starting || await hasChildProcess(terminal.process.pid) ? 'busy' : 'idle'
  if (nextState !== terminal.info.state || (nextState === 'idle' && terminal.info.currentCommand)) {
    terminal.info.state = nextState
    if (nextState === 'idle') terminal.info.currentCommand = undefined
    if (nextState === 'idle') terminal.commandStartedAt = undefined
    emitSession(terminal, 'updated')
  }
  return nextState
}

function monitorState(terminal: ManagedTerminal): void {
  if (terminal.stateRefreshTimer || terminal.info.state !== 'busy') return
  terminal.stateRefreshTimer = setTimeout(() => {
    terminal.stateRefreshTimer = undefined
    if (terminals.get(terminal.info.id) !== terminal) return
    void refreshState(terminal).then(() => monitorState(terminal))
  }, TERMINAL_STATE_REFRESH_INTERVAL_MS)
}

function transcript(terminal: ManagedTerminal, cursor?: number, limit?: number): TerminalTranscriptResult {
  const read = terminal.transcript.read(cursor, limit)
  return {
    sessionId: terminal.info.id,
    ...read,
    closed: terminal.info.state === 'exited'
  }
}

function keyData(key: string): string {
  const keys: Record<string, string> = {
    ENTER: '\r', TAB: '\t', ESCAPE: '\u001b', ARROW_UP: '\u001b[A', ARROW_DOWN: '\u001b[B', ARROW_RIGHT: '\u001b[C', ARROW_LEFT: '\u001b[D',
    HOME: '\u001b[H', END: '\u001b[F', PAGE_UP: '\u001b[5~', PAGE_DOWN: '\u001b[6~', BACKSPACE: '\u007f', DELETE: '\u001b[3~',
    CTRL_C: '\u0003', CTRL_D: '\u0004', CTRL_Z: '\u001a', CTRL_L: '\u000c'
  }
  const data = keys[key]
  if (!data) throw new Error('Unsupported terminal key')
  return data
}

function recordUserInput(terminal: ManagedTerminal, data: string): void {
  if (terminal.info.state === 'busy') {
    if (data.includes('\u0003')) void refreshState(terminal)
    return
  }
  for (const character of data) {
    if (character === '\r' || character === '\n') {
      const command = terminal.inputBuffer.trim()
      terminal.inputBuffer = ''
      if (!command) continue
      terminal.info.currentCommand = command.slice(0, 500)
      terminal.info.state = 'busy'
      terminal.commandStartedAt = Date.now()
      emitSession(terminal, 'updated')
      monitorState(terminal)
    } else if (character === '\u007f' || character === '\b') {
      terminal.inputBuffer = terminal.inputBuffer.slice(0, -1)
    } else if (character === '\u0015' || character === '\u0003') {
      terminal.inputBuffer = ''
    } else if (character >= ' ' && character !== '\u007f') {
      terminal.inputBuffer = `${terminal.inputBuffer}${character}`.slice(-500)
    }
  }
}

function requestIntervention(owner: WebContents, request: Omit<TerminalInterventionRequest, 'id'>, signal?: AbortSignal): Promise<boolean> {
  const id = randomUUID()
  if (owner.isDestroyed() || signal?.aborted) return Promise.resolve(false)
  const intervention = { ...request, id } satisfies TerminalInterventionRequest
  owner.send('terminal-intervention', intervention)
  if (!request.waitsForResolution) {
    pendingInterventions.set(id, { ownerId: owner.id, request: intervention })
    return Promise.resolve(true)
  }
  return new Promise((resolvePromise) => {
    const finish = (approved: boolean): void => {
      signal?.removeEventListener('abort', abort)
      resolvePromise(approved)
    }
    const abort = (): void => {
      pendingInterventions.delete(id)
      if (!owner.isDestroyed()) owner.send('terminal-intervention-dismissed', id)
      finish(false)
    }
    signal?.addEventListener('abort', abort, { once: true })
    pendingInterventions.set(id, { ownerId: owner.id, request: intervention, resolve: finish })
  })
}

function workspacePath(projectPath: string, value: string): string {
  const target = resolve(projectPath, value)
  const relation = relative(projectPath, target)
  if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation)) throw new Error('Path is outside the workspace')
  return target
}

function createTerminal(owner: WebContents, input: CreateTerminalInput): ManagedTerminal {
  const id = randomUUID()
  const shell = shellCommand()
  const cwd = workingDirectory(input.cwd, workingDirectory(input.projectPath))
  ensureUnixPtyHelperExecutable()
  const process = spawn(shell, [], {
    name: 'xterm-256color', cols: DEFAULT_COLUMNS, rows: DEFAULT_ROWS, cwd,
    env: { ...globalThis.process.env, TERM: 'xterm-256color' }
  })
  const terminal: ManagedTerminal = {
    owner,
    process,
    transcript: new TerminalTranscript(MAX_TRANSCRIPT_CHARACTERS, MAX_AGENT_READ_CHARACTERS),
    inputBuffer: '',
    info: {
      id,
      title: safeText(input.title, basename(shell), MAX_TITLE_CHARACTERS),
      shell,
      cwd,
      projectPath: input.projectPath,
      threadId: input.threadId,
      creator: input.creator,
      state: 'idle',
      transcriptCursor: 0,
      panelVisible: false,
      active: false
    }
  }
  terminals.set(id, terminal)
  process.onData((data) => appendOutput(terminal, data))
  process.onExit(({ exitCode }) => {
    if (terminals.get(id) !== terminal) return
    if (terminal.stateRefreshTimer) clearTimeout(terminal.stateRefreshTimer)
    terminal.info.state = 'exited'
    terminal.info.currentCommand = undefined
    emitSession(terminal, 'updated')
    if (!owner.isDestroyed()) owner.send('terminal-exit', { sessionId: id, exitCode })
  })
  emitSession(terminal, 'created')
  if (input.reveal && !owner.isDestroyed()) owner.send('terminal-reveal', { sessionId: id })
  return terminal
}

function terminateProcessTree(terminal: ManagedTerminal): void {
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/pid', String(terminal.process.pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    return
  }
  try {
    process.kill(-terminal.process.pid, 'SIGTERM')
  } catch {
    try { terminal.process.kill() } catch { return }
  }
}

function closeTerminal(terminal: ManagedTerminal): void {
  if (terminals.get(terminal.info.id) !== terminal) return
  terminals.delete(terminal.info.id)
  if (terminal.stateRefreshTimer) clearTimeout(terminal.stateRefreshTimer)
  for (const [id, pending] of pendingInterventions) {
    if (pending.request.terminalId !== terminal.info.id) continue
    pendingInterventions.delete(id)
    if (!terminal.owner.isDestroyed()) terminal.owner.send('terminal-intervention-dismissed', id)
    pending.resolve?.(false)
  }
  terminateProcessTree(terminal)
  terminal.info.state = 'exited'
  emitSession(terminal, 'closed')
}

function closeOwnedTerminals(ownerId: number): void {
  for (const terminal of [...terminals.values()]) if (terminal.owner.id === ownerId) closeTerminal(terminal)
  for (const [id, pending] of pendingInterventions) {
    if (pending.ownerId !== ownerId) continue
    pendingInterventions.delete(id)
    pending.resolve?.(false)
  }
}

function createNoticeTerminal(owner: WebContents, projectPath: string, threadId: string, sessionId?: string): ManagedTerminal {
  return sessionId ? requireProjectSession(owner.id, projectPath, sessionId) : createTerminal(owner, { projectPath, threadId, creator: 'agent', title: 'Activity', reveal: false })
}

export function createAgentTerminalController(owner: WebContents, projectPath: string, threadId: string, signal?: AbortSignal): AgentTerminalController {
  const ensureActive = (): void => signal?.throwIfAborted()
  return {
    create: (title) => ({ ...createTerminal(owner, { projectPath, threadId, creator: 'agent', title, reveal: false }).info }),
    list: async () => {
      const matches = [...terminals.values()].filter((terminal) => terminal.owner.id === owner.id && terminal.info.projectPath === projectPath)
      await Promise.all(matches.map(refreshState))
      return matches.map((terminal) => ({ ...terminal.info }))
    },
    setTitle: (sessionId, title) => {
      const terminal = requireProjectSession(owner.id, projectPath, sessionId)
      terminal.info.title = safeText(title, terminal.info.title, MAX_TITLE_CHARACTERS)
      emitSession(terminal, 'updated')
      return { ...terminal.info }
    },
    run: async (sessionId, command) => {
      ensureActive()
      const terminal = requireWritableSession(owner.id, projectPath, sessionId)
      if (!command.trim() || command.includes('\0')) throw new Error('Command must be non-empty text')
      if (CATASTROPHIC_COMMAND.test(command)) throw new Error('Command is blocked because it could destructively remove system or repository data')
      if (await refreshState(terminal) === 'busy') throw new Error('A command is already running in this terminal; use terminal_write or create another terminal')
      if (terminal.inputBuffer) throw new Error('The user is currently typing in this terminal; inspect it before sending another command')
      terminal.info.currentCommand = command.trim().slice(0, 500)
      terminal.commandStartedAt = Date.now()
      terminal.info.state = 'busy'
      emitSession(terminal, 'updated')
      monitorState(terminal)
      terminal.process.write(`${command}\r`)
      return { ...terminal.info }
    },
    write: async (sessionId, data) => {
      ensureActive()
      const terminal = requireWritableSession(owner.id, projectPath, sessionId)
      recordUserInput(terminal, data)
      terminal.process.write(data)
    },
    sendKey: async (sessionId, key) => {
      ensureActive()
      const terminal = requireWritableSession(owner.id, projectPath, sessionId)
      const data = keyData(key)
      recordUserInput(terminal, data)
      terminal.process.write(data)
    },
    read: (sessionId, cursor, limit) => transcript(requireProjectSession(owner.id, projectPath, sessionId), cursor, limit),
    wait: async (sessionId, cursor, until, timeoutMs, pattern) => {
      ensureActive()
      if (!['output', 'pattern', 'idle', 'exit'].includes(until)) throw new Error('Unsupported terminal wait condition')
      if (until === 'pattern' && !pattern) throw new Error('A pattern is required for a pattern wait')
      if (pattern && pattern.length > 512) throw new Error('Terminal wait patterns must be 512 characters or fewer')
      const startedAt = Date.now()
      requireProjectSession(owner.id, projectPath, sessionId)
      return new Promise<TerminalWaitResult>((resolvePromise, reject) => {
        const finish = async (): Promise<void> => {
          try {
            ensureActive()
            const current = terminals.get(sessionId)
            if (!current || current.owner.id !== owner.id) {
              clearInterval(timer)
              resolvePromise({ sessionId, output: '', cursor, truncated: false, closed: true, reason: 'closed', state: 'exited' })
              return
            }
            const read = transcript(current, cursor)
            const state = await refreshState(current)
            const matched = until === 'pattern' && pattern ? read.output.includes(pattern) : false
            const reason = matched ? 'pattern' : until === 'output' && read.cursor > cursor ? 'output' : until === 'idle' && state === 'idle' ? 'idle' : until === 'exit' && state === 'exited' ? 'exit' : Date.now() - startedAt >= timeoutMs ? 'timeout' : undefined
            if (!reason) return
            clearInterval(timer)
            signal?.removeEventListener('abort', abort)
            resolvePromise({ ...read, reason, state })
          } catch (error) {
            clearInterval(timer)
            reject(error)
          }
        }
        const abort = () => { clearInterval(timer); reject(new Error('Terminal wait was cancelled')) }
        signal?.addEventListener('abort', abort, { once: true })
        const timer = setInterval(() => { void finish() }, TERMINAL_POLL_INTERVAL_MS)
        void finish()
      })
    },
    status: async (sessionId) => {
      const terminal = requireProjectSession(owner.id, projectPath, sessionId)
      await refreshState(terminal)
      return { ...terminal.info }
    },
    interrupt: async (sessionId) => {
      const terminal = requireWritableSession(owner.id, projectPath, sessionId)
      if (await refreshState(terminal) !== 'busy') throw new Error('This terminal does not have a running command to interrupt')
      terminal.process.write('\u0003')
    },
    clear: async (sessionId) => {
      const terminal = requireProjectSession(owner.id, projectPath, sessionId)
      appendOutput(terminal, '\u001b[2J\u001b[H')
    },
    close: async (sessionId, userMessage) => {
      const terminal = requireProjectSession(owner.id, projectPath, sessionId)
      const busy = await refreshState(terminal) === 'busy'
      const allowed = busy
        ? await requestIntervention(owner, {
            kind: 'busy-close', terminalId: sessionId, title: `Close ${terminal.info.title}?`,
            reason: safeText(userMessage.reason, 'This terminal is no longer needed.'),
            impact: terminal.info.currentCommand ? `Closing will stop “${commandSummary(terminal.info.currentCommand)}”.` : 'Closing will stop the command currently running.',
            approveLabel: 'Stop & Close', cancelLabel: 'Keep Running', waitsForResolution: true
          }, signal)
        : true
      if (!allowed) return 'denied'
      closeTerminal(terminal)
      return 'closed'
    },
    requestUserInput: async (sessionId, userMessage, mode) => {
      const terminal = requireProjectSession(owner.id, projectPath, sessionId)
      if (!owner.isDestroyed()) owner.send('terminal-reveal', { sessionId })
      const approved = await requestIntervention(owner, {
        kind: 'user-input', terminalId: sessionId, title: 'Your input is needed',
        reason: safeText(userMessage.reason, 'The terminal needs information only you can provide.'),
        instruction: safeText(userMessage.instruction, 'Complete the requested step in the terminal.'),
        approveLabel: 'Done', cancelLabel: 'Cancel', waitsForResolution: mode === 'pause'
      }, signal)
      return mode === 'continue' ? 'continuing' : approved ? 'completed' : 'cancelled'
    },
    openUrl: async (url, userMessage, sessionId) => {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs can be opened')
      const terminal = createNoticeTerminal(owner, projectPath, threadId, sessionId)
      systemOutput(terminal, `${safeText(userMessage.reason, 'The requested website is being opened.')} Opening ${parsed.hostname} in the default browser.`)
      await electronShell.openExternal(parsed.toString())
    },
    openPath: async (path, userMessage, sessionId) => {
      const target = workspacePath(projectPath, path)
      if (!existsSync(target)) throw new Error('The requested path does not exist')
      const terminal = createNoticeTerminal(owner, projectPath, threadId, sessionId)
      systemOutput(terminal, `${safeText(userMessage.reason, 'The requested item is being opened.')} Opening ${basename(target)}.`)
      const error = await electronShell.openPath(target)
      if (error) throw new Error(error)
    },
    revealPath: async (path, userMessage, sessionId) => {
      const target = workspacePath(projectPath, path)
      if (!existsSync(target)) throw new Error('The requested path does not exist')
      const terminal = createNoticeTerminal(owner, projectPath, threadId, sessionId)
      systemOutput(terminal, `${safeText(userMessage.reason, 'The requested item is being revealed.')} Revealing ${basename(target)} in the file manager.`)
      electronShell.showItemInFolder(target)
    },
    launchApp: async (target, userMessage, sessionId) => {
      const application = safeText(target, '', 160)
      if (!application) throw new Error('An application name or executable is required')
      const terminal = createNoticeTerminal(owner, projectPath, threadId, sessionId)
      systemOutput(terminal, `${safeText(userMessage.reason, 'The requested application is being launched.')} Launching ${application}.`)
      if (process.platform === 'darwin') await new Promise<void>((resolvePromise, reject) => execFile('/usr/bin/open', ['-a', application], (error) => error ? reject(error) : resolvePromise()))
      else if (process.platform === 'linux' && existsSync('/usr/bin/gtk-launch')) await new Promise<void>((resolvePromise, reject) => execFile('/usr/bin/gtk-launch', [application], (error) => error ? reject(error) : resolvePromise()))
      else {
        const child = spawnProcess(application, [], { detached: true, stdio: 'ignore', windowsHide: false })
        child.unref()
      }
    }
  }
}

export function registerTerminalIpc(): void {
  ipcMain.handle('terminal-list', (event): TerminalSessionInfo[] => [...terminals.values()].filter((terminal) => terminal.owner.id === event.sender.id).map((terminal) => ({ ...terminal.info })))
  ipcMain.handle('terminal-list-interventions', (event): TerminalInterventionRequest[] => [...pendingInterventions.values()].filter((pending) => pending.ownerId === event.sender.id).map((pending) => pending.request))
  ipcMain.handle('terminal-create', (event, cwd: unknown, projectPath: unknown = cwd): TerminalSessionInfo => ({ ...createTerminal(event.sender, {
    cwd: typeof cwd === 'string' ? cwd : undefined,
    projectPath: workingDirectory(projectPath), creator: 'user', reveal: false
  }).info }))
  ipcMain.on('terminal-input', (event, sessionId: unknown, data: unknown) => {
    if (typeof data !== 'string') return
    const terminal = sessionFor(event.sender.id, sessionId)
    if (!terminal || terminal.info.state === 'exited') return
    recordUserInput(terminal, data)
    terminal.process.write(data)
  })
  ipcMain.on('terminal-ready', (event, sessionId: unknown) => {
    const terminal = sessionFor(event.sender.id, sessionId)
    const replay = terminal?.transcript.replay()
    if (replay && !event.sender.isDestroyed()) event.sender.send('terminal-output', { sessionId, data: replay })
  })
  ipcMain.on('terminal-resize', (event, sessionId: unknown, columns: unknown, rows: unknown) => {
    if (typeof columns !== 'number' || typeof rows !== 'number') return
    const cols = Math.min(MAX_TERMINAL_DIMENSION, Math.max(MIN_TERMINAL_DIMENSION, Math.floor(columns)))
    const safeRows = Math.min(MAX_TERMINAL_DIMENSION, Math.max(MIN_TERMINAL_DIMENSION, Math.floor(rows)))
    const terminal = sessionFor(event.sender.id, sessionId)
    if (terminal?.info.state !== 'exited') terminal?.process.resize(cols, safeRows)
  })
  ipcMain.handle('terminal-close', async (event, sessionId: unknown): Promise<boolean> => {
    const terminal = sessionFor(event.sender.id, sessionId)
    if (!terminal) return false
    if (await refreshState(terminal) === 'busy') {
      const allowed = await requestIntervention(event.sender, {
        kind: 'busy-close', terminalId: terminal.info.id, title: `Close ${terminal.info.title}?`,
        reason: 'You asked to close this terminal.',
        impact: terminal.info.currentCommand ? `Closing will stop “${commandSummary(terminal.info.currentCommand)}”.` : 'Closing will stop the command currently running.',
        approveLabel: 'Stop & Close', cancelLabel: 'Keep Running', waitsForResolution: true
      })
      if (!allowed) return false
    }
    closeTerminal(terminal)
    return true
  })
  ipcMain.handle('terminal-busy', async (event, sessionId: unknown): Promise<boolean> => {
    const terminal = sessionFor(event.sender.id, sessionId)
    return terminal ? refreshState(terminal).then((state) => state === 'busy') : false
  })
  ipcMain.on('terminal-ui-state', (event, visible: unknown, activeId: unknown) => {
    if (typeof visible !== 'boolean' || typeof activeId !== 'string') return
    for (const terminal of terminals.values()) {
      if (terminal.owner.id !== event.sender.id) continue
      const active = terminal.info.id === activeId
      if (terminal.info.panelVisible === visible && terminal.info.active === active) continue
      terminal.info.panelVisible = visible
      terminal.info.active = active
      emitSession(terminal, 'updated')
    }
  })
  ipcMain.handle('terminal-resolve-intervention', (event, resolution: TerminalInterventionResolution): boolean => {
    if (!resolution || typeof resolution.id !== 'string' || typeof resolution.approved !== 'boolean') return false
    const pending = pendingInterventions.get(resolution.id)
    if (!pending || pending.ownerId !== event.sender.id) return false
    pendingInterventions.delete(resolution.id)
    pending.resolve?.(resolution.approved)
    return true
  })
  ipcMain.on('terminal-dispose-all', (event) => closeOwnedTerminals(event.sender.id))
}

export function disposeTerminals(): void {
  for (const terminal of [...terminals.values()]) closeTerminal(terminal)
}
