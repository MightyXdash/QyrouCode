export const LLAMA_SERVER_PORT = 39281
export const LLAMA_TITLE_SERVER_PORT = 39282
export const LLAMA_SERVER_HOST = '127.0.0.1'
export const FIRST_LOAD_CONTEXT_TOKENS = 8192

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
  message?: string
}

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
