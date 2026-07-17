import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { basename } from 'path'
import { ipcMain, type WebContents } from 'electron'
import { spawn, type IPty } from 'node-pty'
import type { TerminalSessionInfo } from '../shared/terminal'

const DEFAULT_COLUMNS = 80
const DEFAULT_ROWS = 24
const MIN_TERMINAL_DIMENSION = 1
const MAX_TERMINAL_DIMENSION = 1000

interface ManagedTerminal {
  ownerId: number
  process: IPty
  ready: boolean
  bufferedOutput: string
}

const terminals = new Map<string, ManagedTerminal>()

function shellCommand(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env['SHELL'] || '/bin/bash'
}

function workingDirectory(value: unknown): string {
  return typeof value === 'string' && existsSync(value) ? value : homedir()
}

function terminalFor(sender: WebContents, sessionId: unknown): ManagedTerminal | undefined {
  if (typeof sessionId !== 'string') return undefined
  const terminal = terminals.get(sessionId)
  return terminal?.ownerId === sender.id ? terminal : undefined
}

function closeOwnedTerminals(ownerId: number): void {
  for (const [id, terminal] of terminals) {
    if (terminal.ownerId !== ownerId) continue
    terminals.delete(id)
    terminal.process.kill()
  }
}

export function registerTerminalIpc(): void {
  ipcMain.handle('terminal-create', (event, cwd: unknown): TerminalSessionInfo => {
    const id = randomUUID()
    const shell = shellCommand()
    const terminal = spawn(shell, [], {
      name: 'xterm-256color',
      cols: DEFAULT_COLUMNS,
      rows: DEFAULT_ROWS,
      cwd: workingDirectory(cwd),
      env: { ...process.env, TERM: 'xterm-256color' }
    })
    terminals.set(id, { ownerId: event.sender.id, process: terminal, ready: false, bufferedOutput: '' })
    terminal.onData((data) => {
      const managed = terminals.get(id)
      if (!managed) return
      if (!managed.ready) {
        managed.bufferedOutput += data
        return
      }
      if (!event.sender.isDestroyed()) event.sender.send('terminal-output', { sessionId: id, data })
    })
    terminal.onExit(({ exitCode }) => {
      terminals.delete(id)
      if (!event.sender.isDestroyed()) event.sender.send('terminal-exit', { sessionId: id, exitCode })
    })
    return { id, title: basename(shell), shell }
  })
  ipcMain.on('terminal-input', (event, sessionId: unknown, data: unknown) => {
    if (typeof data === 'string') terminalFor(event.sender, sessionId)?.process.write(data)
  })
  ipcMain.on('terminal-ready', (event, sessionId: unknown) => {
    const terminal = terminalFor(event.sender, sessionId)
    if (!terminal || typeof sessionId !== 'string') return
    terminal.ready = true
    if (!terminal.bufferedOutput) return
    event.sender.send('terminal-output', { sessionId, data: terminal.bufferedOutput })
    terminal.bufferedOutput = ''
  })
  ipcMain.on('terminal-resize', (event, sessionId: unknown, columns: unknown, rows: unknown) => {
    if (typeof columns !== 'number' || typeof rows !== 'number') return
    const safeColumns = Math.min(MAX_TERMINAL_DIMENSION, Math.max(MIN_TERMINAL_DIMENSION, Math.floor(columns)))
    const safeRows = Math.min(MAX_TERMINAL_DIMENSION, Math.max(MIN_TERMINAL_DIMENSION, Math.floor(rows)))
    terminalFor(event.sender, sessionId)?.process.resize(safeColumns, safeRows)
  })
  ipcMain.handle('terminal-close', (event, sessionId: unknown): boolean => {
    const terminal = terminalFor(event.sender, sessionId)
    if (!terminal || typeof sessionId !== 'string') return false
    terminals.delete(sessionId)
    terminal.process.kill()
    return true
  })
  ipcMain.on('terminal-dispose-all', (event) => closeOwnedTerminals(event.sender.id))
}

export function disposeTerminals(): void {
  for (const terminal of terminals.values()) terminal.process.kill()
  terminals.clear()
}
