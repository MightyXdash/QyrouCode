export const LLAMA_SERVER_PORT = 39281
export const LLAMA_TITLE_SERVER_PORT = 39282
export const LLAMA_SERVER_HOST = '127.0.0.1'

export type LlamaPlatform = 'darwin' | 'linux' | 'win32'
export type LlamaBackend = 'metal' | 'cuda' | 'vulkan' | 'cpu'
export type LlamaServerState = 'unavailable' | 'stopped' | 'starting' | 'ready' | 'error'

export interface LlamaRuntimeStatus {
  state: LlamaServerState
  backend?: LlamaBackend
  executablePath?: string
  modelPath?: string
  mmprojPath?: string
  contextTokens?: number
  visionReady?: boolean
  message?: string
}

export interface LlamaRuntimeLoadProgress {
  phase: 'preparing' | 'loading'
  stages?: string[]
  current?: string
  value?: number
}

export interface LlamaModelLoadProgress extends LlamaRuntimeLoadProgress {
  loadId: string
  modelName: string
}

interface LlamaChildStateMessage {
  state?: unknown
  payload?: {
    stages?: unknown
    current?: unknown
    value?: unknown
  }
}

const LLAMA_CHILD_STATE_PREFIX = 'cmd_child_to_router:state:'
const LLAMA_PROGRESS_BUFFER_LIMIT = 64 * 1024
const LLAMA_LOAD_STAGE_LABELS: Readonly<Record<string, string>> = {
  text_model: 'Loading model weights',
  spec_model: 'Loading draft model',
  mmproj_model: 'Loading vision projector'
}

export const llamaLoadStageLabel = (stage: string | undefined): string =>
  stage ? LLAMA_LOAD_STAGE_LABELS[stage] ?? 'Loading local model' : 'Preparing local model'

export const parseLlamaLoadProgressLine = (line: string): LlamaRuntimeLoadProgress | undefined => {
  const prefixIndex = line.indexOf(LLAMA_CHILD_STATE_PREFIX)
  if (prefixIndex === -1) return undefined
  const serialized = line.slice(prefixIndex + LLAMA_CHILD_STATE_PREFIX.length).trim()
  if (!serialized) return undefined

  let message: LlamaChildStateMessage
  try {
    message = JSON.parse(serialized) as LlamaChildStateMessage
  } catch {
    return undefined
  }

  if (message.state !== 'loading' || !message.payload) return undefined
  const stages = Array.isArray(message.payload.stages)
    ? message.payload.stages.filter((stage): stage is string => typeof stage === 'string' && stage.length > 0)
    : undefined
  const current = typeof message.payload.current === 'string' && message.payload.current.length > 0
    ? message.payload.current
    : undefined
  const value = typeof message.payload.value === 'number' && Number.isFinite(message.payload.value)
    ? Math.max(0, Math.min(1, message.payload.value))
    : undefined
  return { phase: 'loading', stages, current, value }
}

export class LlamaLoadProgressParser {
  private buffer = ''

  push(chunk: string): LlamaRuntimeLoadProgress[] {
    this.buffer = (this.buffer + chunk).slice(-LLAMA_PROGRESS_BUFFER_LIMIT)
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    return lines.flatMap((line) => {
      const progress = parseLlamaLoadProgressLine(line)
      return progress ? [progress] : []
    })
  }

  flush(): LlamaRuntimeLoadProgress[] {
    const progress = parseLlamaLoadProgressLine(this.buffer)
    this.buffer = ''
    return progress ? [progress] : []
  }
}

const VISION_ARCH_MARKERS = ['clip', 'llava', 'vl', 'minicpm', 'moondream', 'florence', 'siglip', 'pixtral', 'mllama', 'gemma3'] as const

export const archSupportsVision = (modelArchs: readonly string[] | undefined): boolean =>
  (modelArchs ?? []).some((arch) => VISION_ARCH_MARKERS.some((marker) => arch.toLowerCase().includes(marker)))

export interface LlamaLaunchProfile {
  platform: LlamaPlatform
  backend: LlamaBackend
  modelPath: string
  contextTokens: number
  logicalCpuCount: number
  availableMemoryBytes: number
  modelSizeBytes?: number
  mmprojPath?: string
  port?: number
}

const MINIMUM_THREAD_COUNT = 1
const MAXIMUM_GENERATION_THREADS = 16
const MAXIMUM_BATCH_THREADS = 32
const MEMORY_HEADROOM_RATIO = 0.82
const DEFAULT_BATCH_SIZE = 2048
const CONSERVATIVE_BATCH_SIZE = 1024
const DEFAULT_MICRO_BATCH_SIZE = 512
const CONSERVATIVE_MICRO_BATCH_SIZE = 256

export const backendAppearsInDeviceList = (backend: LlamaBackend, devices: string): boolean =>
  new RegExp(`\\b${backend}(?:\\d+)?\\s*:`, 'i').test(devices)

export const llamaRuntimeProfileMatches = (
  status: LlamaRuntimeStatus,
  modelPath: string,
  contextTokens: number,
  mmprojPath?: string
): boolean =>
  status.modelPath === modelPath &&
  status.contextTokens === contextTokens &&
  status.mmprojPath === mmprojPath

export const resolveLlamaContextTokens = (
  modelContextLimit: number | undefined,
  fallbackContextTokens: number
): number => modelContextLimit ?? fallbackContextTokens

const boundedThreadCount = (logicalCpuCount: number, maximum: number): number =>
  Math.max(MINIMUM_THREAD_COUNT, Math.min(maximum, Math.floor(logicalCpuCount)))

export const buildLlamaServerArgs = (profile: LlamaLaunchProfile): string[] => {
  const memoryDemand = (profile.modelSizeBytes ?? 0) + (profile.contextTokens * 32768)
  const constrainedMemory = memoryDemand > profile.availableMemoryBytes * MEMORY_HEADROOM_RATIO
  const generationThreads = boundedThreadCount(Math.ceil(profile.logicalCpuCount / 2), MAXIMUM_GENERATION_THREADS)
  const batchThreads = boundedThreadCount(profile.logicalCpuCount, MAXIMUM_BATCH_THREADS)
  const batchSize = constrainedMemory ? CONSERVATIVE_BATCH_SIZE : DEFAULT_BATCH_SIZE
  const microBatchSize = constrainedMemory ? CONSERVATIVE_MICRO_BATCH_SIZE : DEFAULT_MICRO_BATCH_SIZE
  const args = [
    '--model', profile.modelPath,
    '--host', LLAMA_SERVER_HOST,
    '--port', String(profile.port ?? LLAMA_SERVER_PORT),
    '--ctx-size', String(profile.contextTokens),
    '--threads', String(generationThreads),
    '--threads-batch', String(batchThreads),
    '--batch-size', String(batchSize),
    '--ubatch-size', String(microBatchSize),
    '--parallel', '1',
    '--n-gpu-layers', profile.backend === 'cpu' ? '0' : 'auto',
    '--flash-attn', 'auto',
    '--fit', 'on',
    '--cache-type-k', 'q8_0',
    '--cache-type-v', 'q8_0',
    '--jinja',
    '--cont-batching'
  ]

  if (profile.platform === 'linux' && profile.backend === 'cpu') args.push('--numa', 'distribute')
  if (profile.mmprojPath) args.push('--mmproj', profile.mmprojPath)
  return args
}
