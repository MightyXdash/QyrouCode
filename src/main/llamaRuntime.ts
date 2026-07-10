import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, statSync } from 'fs'
import { arch, cpus, freemem, platform } from 'os'
import { delimiter, join } from 'path'
import { app } from 'electron'
import {
  LLAMA_SERVER_HOST,
  LLAMA_SERVER_PORT,
  buildLlamaServerArgs,
  type LlamaBackend,
  type LlamaPlatform,
  type LlamaRuntimeStatus
} from '../shared/llama'

const SERVER_BINARY_NAME = platform() === 'win32' ? 'llama-server.exe' : 'llama-server'
const HEALTH_PATH = '/health'
const HEALTH_TIMEOUT_MS = 120000
const HEALTH_POLL_INTERVAL_MS = 350
const TERMINATION_TIMEOUT_MS = 3000
const STDERR_TAIL_LENGTH = 800
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32'])

const currentPlatform = (): LlamaPlatform => {
  const value = platform()
  if (!SUPPORTED_PLATFORMS.has(value)) throw new Error(`Unsupported platform: ${value}`)
  return value as LlamaPlatform
}

const preferredBackend = (targetPlatform: LlamaPlatform): LlamaBackend => {
  const configured = process.env['SUPRACODE_LLAMA_BACKEND']
  if (configured === 'metal' || configured === 'cuda' || configured === 'vulkan' || configured === 'cpu') return configured
  if (targetPlatform === 'darwin') return 'metal'
  return process.env['CUDA_PATH'] || process.env['CUDA_HOME'] ? 'cuda' : 'vulkan'
}

const executableCandidates = (): string[] => {
  const configuredPath = process.env['SUPRACODE_LLAMA_SERVER']
  const pathDirectories = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  const bundledDirectory = join(process.resourcesPath, 'llama.cpp', `${platform()}-${arch()}`)
  const developmentDirectory = join(app.getAppPath(), 'vendor', 'llama.cpp', `${platform()}-${arch()}`)
  return [
    ...(configuredPath ? [configuredPath] : []),
    join(bundledDirectory, SERVER_BINARY_NAME),
    join(developmentDirectory, SERVER_BINARY_NAME),
    ...pathDirectories.map((directory) => join(directory, SERVER_BINARY_NAME))
  ]
}

const findExecutable = (): string | undefined => executableCandidates().find((candidate) => existsSync(candidate))

export class LlamaRuntime {
  private process: ChildProcessWithoutNullStreams | null = null
  private status: LlamaRuntimeStatus

  constructor() {
    const targetPlatform = currentPlatform()
    const executablePath = findExecutable()
    this.status = {
      state: executablePath ? 'stopped' : 'unavailable',
      backend: preferredBackend(targetPlatform),
      executablePath,
      message: executablePath ? undefined : 'llama-server is not installed'
    }
  }

  getStatus(): LlamaRuntimeStatus {
    return { ...this.status }
  }

  async start(modelPath: string, contextTokens: number, mmprojPath?: string): Promise<LlamaRuntimeStatus> {
    if (this.process && (this.status.state === 'starting' || this.status.state === 'ready')) return this.getStatus()
    const executablePath = this.status.executablePath ?? findExecutable()
    if (!executablePath) return this.getStatus()
    if (!existsSync(modelPath)) throw new Error('The selected GGUF model does not exist')

    const targetPlatform = currentPlatform()
    const backend = preferredBackend(targetPlatform)
    const args = buildLlamaServerArgs({
      platform: targetPlatform,
      backend,
      modelPath,
      contextTokens,
      logicalCpuCount: cpus().length,
      availableMemoryBytes: freemem(),
      modelSizeBytes: statSync(modelPath).size,
      mmprojPath
    })

    this.status = { state: 'starting', backend, executablePath, modelPath }
    const child = spawn(executablePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.process = child
    let stderrTail = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LENGTH)
    })
    child.once('error', (error) => {
      this.process = null
      this.status = { ...this.status, state: 'error', message: error.message }
    })
    child.once('exit', (code) => {
      if (this.process !== child) return
      this.process = null
      if (this.status.state !== 'stopped') {
        this.status = {
          ...this.status,
          state: 'error',
          message: stderrTail.trim() || `llama-server exited with code ${code ?? 'unknown'}`
        }
      }
    })

    try {
      await this.waitUntilHealthy()
      this.status = { ...this.status, state: 'ready' }
    } catch (error) {
      await this.stop()
      this.status = { ...this.status, state: 'error', message: error instanceof Error ? error.message : 'Unable to start llama-server' }
    }
    return this.getStatus()
  }

  async stop(): Promise<LlamaRuntimeStatus> {
    const child = this.process
    this.status = { ...this.status, state: this.status.executablePath ? 'stopped' : 'unavailable', modelPath: undefined }
    if (!child) return this.getStatus()
    this.process = null
    child.kill()
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, TERMINATION_TIMEOUT_MS)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
    })
    return this.getStatus()
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!this.process) throw new Error(this.status.message ?? 'llama-server stopped during startup')
      try {
        const response = await fetch(`http://${LLAMA_SERVER_HOST}:${LLAMA_SERVER_PORT}${HEALTH_PATH}`)
        if (response.ok) return
      } catch { /* server is still loading */ }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS))
    }
    throw new Error('llama-server did not become ready in time')
  }
}
