export interface ModelTreeEntry {
  path: string
  size: number
}

export interface ModelProjectorSource {
  repository: string
  path: string
}

const GGUF_FILE_EXTENSION = '.gguf'
const MODEL_PROJECTOR_MARKERS = ['mmproj', 'projector']
const EXTERNAL_PROJECTOR_SOURCES: Readonly<Record<string, ModelProjectorSource>> = {
  'hinny/Qwen3.5-4B-GGUF-Q4_K_M': {
    repository: 'unsloth/Qwen3.5-4B-GGUF',
    path: 'mmproj-BF16.gguf'
  },
  'jc-builds/Qwen3.5-9B-Q4_K_M-GGUF': {
    repository: 'jc-builds/Qwen3.5-9B-VLM-Q4_K_M-GGUF',
    path: 'mmproj-F16.gguf'
  },
  'sm54/Qwen3.6-27B-Q4_K_M-GGUF': {
    repository: 'unsloth/Qwen3.6-27B-GGUF',
    path: 'mmproj-BF16.gguf'
  }
}

export const isModelWeightsFile = (path: string): boolean => {
  const normalizedName = path.toLowerCase()
  return normalizedName.endsWith(GGUF_FILE_EXTENSION) &&
    !MODEL_PROJECTOR_MARKERS.some((marker) => normalizedName.includes(marker))
}

export const isModelProjectorFile = (path: string): boolean => {
  const normalizedName = path.toLowerCase()
  return normalizedName.endsWith(GGUF_FILE_EXTENSION) &&
    MODEL_PROJECTOR_MARKERS.some((marker) => normalizedName.includes(marker))
}

const projectorPreferenceRank = (path: string): number => {
  const normalizedName = path.toLowerCase()
  if (/(^|[-_.])f16($|[-_.])/.test(normalizedName)) return 1
  if (/(^|[-_.])bf16($|[-_.])/.test(normalizedName)) return 2
  if (/(^|[-_.])f32($|[-_.])/.test(normalizedName)) return 3
  return 4
}

export const selectModelProjectorFile = (entries: readonly ModelTreeEntry[]): string | undefined => {
  const projectors = entries.filter((entry) => isModelProjectorFile(entry.path))
  if (projectors.length === 0) return undefined
  return [...projectors].sort((a, b) => projectorPreferenceRank(a.path) - projectorPreferenceRank(b.path))[0].path
}

export const getExternalProjectorSource = (repository: string): ModelProjectorSource | undefined =>
  EXTERNAL_PROJECTOR_SOURCES[repository]
