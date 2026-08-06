import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, statSync } from 'fs'
import { arch, cpus, freemem, platform } from 'os'
import { delimiter, join } from 'path'
import { app } from 'electron'
import {
  LLAMA_SERVER_HOST,
  LLAMA_SERVER_PORT,
  archSupportsVision,
  backendAppearsInDeviceList,
  buildLlamaServerArgs,
  inferReasoningFormat,
  llamaRuntimeProfileMatches,
  type LlamaBackend,
  type LlamaPlatform,
  type LlamaRuntimeStatus
} from '../shared/llama'
import { INITIAL_RUNTIME_ARTIFACTS, getRuntimeArtifact, type RuntimeArchitecture } from '../shared/runtimeManifest'
import { LocalCompletionClient, type LocalCompletion, type LocalCompletionRequest } from './localCompletionClient'
import { AgentRuntime, type AgentRunRequest, type AgentStateListener, type AgentToolEvent } from './agentRuntime'
import { developmentRuntimeDirectory, packagedRuntimeExecutable } from './runtimePaths'
import { readGgufContextLimit } from './gguf'

const HEALTH_PATH = '/health'
const HEALTH_TIMEOUT_MS = 120000
const HEALTH_POLL_INTERVAL_MS = 350
const TERMINATION_TIMEOUT_MS = 3000
const STDERR_TAIL_LENGTH = 800
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32'])
const SERVER_BINARY_NAME = platform() === 'win32' ? 'llama-server.exe' : 'llama-server'

const currentPlatform = (): LlamaPlatform => {
  const value = platform()
  if (!SUPPORTED_PLATFORMS.has(value)) throw new Error(`Unsupported platform: ${value}`)
  return value as LlamaPlatform
}

const configuredBackend = (): LlamaBackend | undefined => {
  const configured = process.env['QYROU_LLAMA_BACKEND']
  if (configured === 'metal' || configured === 'cuda' || configured === 'vulkan' || configured === 'cpu') return configured
  return undefined
}

const preferredBackends = (targetPlatform: LlamaPlatform): readonly LlamaBackend[] => {
  const configured = configuredBackend()
  if (configured) return [configured]
  if (targetPlatform === 'darwin') return ['metal', 'cpu']
  return ['cuda', 'vulkan', 'cpu']
}

const legacyBackend = (targetPlatform: LlamaPlatform): LlamaBackend => {
  const configured = configuredBackend()
  if (configured) return configured
  if (targetPlatform === 'darwin') return 'metal'
  return process.env['CUDA_PATH'] || process.env['CUDA_HOME'] ? 'cuda' : 'vulkan'
}

const currentArchitecture = (): RuntimeArchitecture => {
  const value = arch()
  if (value !== 'arm64' && value !== 'x64') throw new Error(`Unsupported architecture: ${value}`)
  return value
}

interface RuntimeCandidate {
  backend: LlamaBackend
  executablePath: string
}

const backendAvailable = (candidate: RuntimeCandidate): boolean => {
  if (candidate.backend === 'cpu') return true
  try {
    const devices = execFileSync(candidate.executablePath, ['--list-devices'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    })
    return backendAppearsInDeviceList(candidate.backend, devices)
  } catch {
    return false
  }
}

const inferredBackend = (executablePath: string, fallback: LlamaBackend): LlamaBackend => {
  try {
    const devices = execFileSync(executablePath, ['--list-devices'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    for (const backend of ['cuda', 'vulkan', 'metal'] as const) {
      if (backendAppearsInDeviceList(backend, devices)) return backend
    }
    return 'cpu'
  } catch {
    return fallback
  }
}

const findLegacyRuntime = (targetPlatform: LlamaPlatform): RuntimeCandidate | undefined => {
  const legacyDirectory = `${platform()}-${arch()}`
  const candidates = [
    ...(process.env['QYROU_LLAMA_SERVER'] ? [process.env['QYROU_LLAMA_SERVER']] : []),
    join(process.resourcesPath, 'llama.cpp', legacyDirectory, SERVER_BINARY_NAME),
    join(app.getAppPath(), 'vendor', 'llama.cpp', legacyDirectory, SERVER_BINARY_NAME),
    ...(process.env['PATH'] ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, SERVER_BINARY_NAME))
  ]
  for (const executablePath of candidates) {
    if (!executablePath || !existsSync(executablePath)) continue
    const candidate = { executablePath, backend: inferredBackend(executablePath, legacyBackend(targetPlatform)) }
    if (backendAvailable(candidate)) return candidate
  }
  return undefined
}

const findRuntime = (): RuntimeCandidate | undefined => {
  const targetPlatform = currentPlatform()
  const targetArchitecture = currentArchitecture()
  const configuredPath = process.env['QYROU_LLAMA_SERVER']
  const configured = configuredBackend()
  if (configuredPath && configured && existsSync(configuredPath)) {
    const candidate = { backend: inferredBackend(configuredPath, configured), executablePath: configuredPath }
    return backendAvailable(candidate) ? candidate : undefined
  }

  for (const backend of preferredBackends(targetPlatform)) {
    const artifact = getRuntimeArtifact(INITIAL_RUNTIME_ARTIFACTS, targetPlatform, targetArchitecture, backend)
    if (!artifact) continue
    const executableCandidates = [
      packagedRuntimeExecutable(process.resourcesPath, artifact),
      join(developmentRuntimeDirectory(app.getAppPath(), artifact), artifact.executablePath)
    ]
    for (const executablePath of executableCandidates) {
      if (!existsSync(executablePath)) continue
      const candidate = { backend, executablePath }
      if (backendAvailable(candidate)) return candidate
    }
  }
  return findLegacyRuntime(targetPlatform)
}

export class LlamaRuntime {
  private process: ChildProcessWithoutNullStreams | null = null
  private status: LlamaRuntimeStatus
  private stderrTail = ''

  constructor(private readonly port = LLAMA_SERVER_PORT) {
    const runtime = findRuntime()
    this.status = {
      state: runtime ? 'stopped' : 'unavailable',
      backend: runtime?.backend,
      executablePath: runtime?.executablePath,
      message: runtime ? undefined : 'No compatible llama-server runtime is installed'
    }
  }

  getStatus(): LlamaRuntimeStatus {
    return { ...this.status }
  }

  async streamCompletion(request: LocalCompletionRequest, onDelta: (delta: string) => void): Promise<LocalCompletion> {
    if (this.status.state !== 'ready') throw new Error('llama-server is not ready')
    return new LocalCompletionClient(`http://${LLAMA_SERVER_HOST}:${this.port}`).stream(this.withReasoningFormat(request), onDelta)
  }

  async complete(request: LocalCompletionRequest): Promise<LocalCompletion> {
    if (this.status.state !== 'ready') throw new Error('llama-server is not ready')
    return new LocalCompletionClient(`http://${LLAMA_SERVER_HOST}:${this.port}`).complete(this.withReasoningFormat(request))
  }

  async runAgent(request: AgentRunRequest, onDelta: (delta: string) => void, onState?: AgentStateListener, onToolEvent?: (event: AgentToolEvent) => void): Promise<void> {
    if (this.status.state !== 'ready') throw new Error('llama-server is not ready')
    const client = new LocalCompletionClient(`http://${LLAMA_SERVER_HOST}:${this.port}`)
    await new AgentRuntime(client).run(this.withReasoningFormat(request), onDelta, onState, onToolEvent)
  }

  private withReasoningFormat<T extends LocalCompletionRequest>(request: T): T {
    return request.reasoningFormat ? request : { ...request, reasoningFormat: inferReasoningFormat(this.status.modelPath) }
  }

  async completePrompt(prompt: string): Promise<string> {
    if (this.status.state !== 'ready') throw new Error('llama-server is not ready')
    const completion = await new LocalCompletionClient(`http://${LLAMA_SERVER_HOST}:${this.port}`).completePrompt({
      prompt,
      maxTokens: 10,
      temperature: 0.55,
      topK: 15,
      topP: 0.85,
      repetitionPenalty: 1.35
    })
    return completion.text
  }

  async start(modelPath: string, contextTokens: number, mmprojPath?: string): Promise<LlamaRuntimeStatus> {
    if (this.process && (this.status.state === 'starting' || this.status.state === 'ready')) {
      if (llamaRuntimeProfileMatches(this.status, modelPath, contextTokens, mmprojPath)) return this.getStatus()
      await this.stop()
    }
    const runtime = findRuntime()
    if (!runtime) {
      this.status = { state: 'unavailable', message: 'No compatible llama-server runtime is installed' }
      return this.getStatus()
    }
    const { backend, executablePath } = runtime
    if (!existsSync(modelPath)) throw new Error('The selected GGUF model does not exist')

    const modelContextLimit = await readGgufContextLimit(modelPath)
    const effectiveContextTokens = modelContextLimit === undefined ? contextTokens : Math.min(contextTokens, modelContextLimit)

    const targetPlatform = currentPlatform()
    const args = buildLlamaServerArgs({
      platform: targetPlatform,
      backend,
      modelPath,
      contextTokens: effectiveContextTokens,
      logicalCpuCount: cpus().length,
      availableMemoryBytes: freemem(),
      modelSizeBytes: statSync(modelPath).size,
      mmprojPath,
      port: this.port
    })

    this.status = { state: 'starting', backend, executablePath, modelPath, mmprojPath, contextTokens: effectiveContextTokens }
    const child = spawn(executablePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.process = child
    this.stderrTail = ''
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_LENGTH)
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
          message: this.stderrTail.trim() || `llama-server exited with code ${code ?? 'unknown'}`
        }
      }
    })

    try {
      await this.waitUntilHealthy()
      this.status = { ...this.status, state: 'ready', visionReady: await this.probeVisionSupport() }
    } catch (error) {
      await this.stop()
      this.status = { ...this.status, state: 'error', message: error instanceof Error ? error.message : 'Unable to start llama-server' }
    }
    return this.getStatus()
  }

  async stop(): Promise<LlamaRuntimeStatus> {
    const child = this.process
    this.status = { ...this.status, state: this.status.executablePath ? 'stopped' : 'unavailable', modelPath: undefined, mmprojPath: undefined, contextTokens: undefined }
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
        const response = await fetch(`http://${LLAMA_SERVER_HOST}:${this.port}${HEALTH_PATH}`)
        if (response.ok) return
      } catch { /* server is still loading */ }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS))
    }
    throw new Error('llama-server did not become ready in time')
  }

  private async probeVisionSupport(): Promise<boolean> {
    if (!this.status.mmprojPath) return false
    try {
      const response = await fetch(`http://${LLAMA_SERVER_HOST}:${this.port}/props`)
      if (!response.ok) return false
      const props = await response.json() as { model_archs?: unknown }
      if (Array.isArray(props.model_archs)) return archSupportsVision(props.model_archs)
    } catch { /* fall through to the stderr signal */ }
    return this.stderrTail.toLowerCase().includes('mmproj')
  }
}
