export const MAX_PROMPT_REFINEMENT_BACKUPS = 3
export const MAX_PROMPT_REFINEMENT_CHARACTERS = 64_000
export const MAX_PROMPT_REFINEMENT_MODEL_ID_CHARACTERS = 1_024

export interface PromptRefinementPreferences {
  primaryModelId: string
  preferProviderModels: boolean
  backupModelIds: string[]
}

export interface PromptRefinementModelOption {
  id: string
  source: 'local' | 'remote'
  displayName: string
  providerName: string
}

export type PromptRefinementTarget =
  | PromptRefinementModelOption & {
      source: 'local'
      modelId: string
      repository: string
      filename: string
    }
  | PromptRefinementModelOption & {
      source: 'remote'
      modelId: string
      connectionId: string
    }

export interface PromptRefinementResult {
  prompt: string
  modelId: string
  modelName: string
  outcome: 'refined' | 'ambiguous' | 'harm'
}

export const DEFAULT_PROMPT_REFINEMENT_PREFERENCES: PromptRefinementPreferences = {
  primaryModelId: '',
  preferProviderModels: true,
  backupModelIds: []
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const validatePromptRefinementPreferences = (value: unknown): PromptRefinementPreferences => {
  if (
    !isRecord(value) ||
    typeof value.primaryModelId !== 'string' ||
    value.primaryModelId.length > MAX_PROMPT_REFINEMENT_MODEL_ID_CHARACTERS ||
    typeof value.preferProviderModels !== 'boolean'
  ) {
    throw new Error('Invalid prompt refinement preferences')
  }
  if (
    !Array.isArray(value.backupModelIds) ||
    value.backupModelIds.length > MAX_PROMPT_REFINEMENT_BACKUPS ||
    !value.backupModelIds.every((modelId) => (
      typeof modelId === 'string' &&
      modelId.length > 0 &&
      modelId.length <= MAX_PROMPT_REFINEMENT_MODEL_ID_CHARACTERS
    ))
  ) {
    throw new Error('Invalid prompt refinement backup models')
  }
  const primaryModelId = value.primaryModelId.trim()
  const backupModelIds = value.backupModelIds.map((modelId) => modelId.trim())
  if (new Set(backupModelIds).size !== backupModelIds.length || backupModelIds.includes(primaryModelId)) {
    throw new Error('Prompt refinement models must be unique')
  }
  return { primaryModelId, preferProviderModels: value.preferProviderModels, backupModelIds }
}

export const orderPromptRefinementModels = <T extends Pick<PromptRefinementModelOption, 'id' | 'source'>>(
  models: readonly T[],
  preferences: PromptRefinementPreferences
): T[] => {
  const modelsById = new Map(models.map((model) => [model.id, model]))
  const ordered: T[] = []
  const add = (model: T | undefined): void => {
    if (model && !ordered.some((candidate) => candidate.id === model.id)) ordered.push(model)
  }
  const automaticModel = [...models].sort((left, right) => {
    if (left.source === right.source) return 0
    const preferredSource = preferences.preferProviderModels ? 'remote' : 'local'
    return left.source === preferredSource ? -1 : 1
  })[0]
  const primaryModel = modelsById.get(preferences.primaryModelId)
  if (preferences.primaryModelId && !primaryModel) {
    preferences.backupModelIds.forEach((modelId) => add(modelsById.get(modelId)))
    add(automaticModel)
    return ordered
  }
  add(primaryModel ?? automaticModel)
  preferences.backupModelIds.forEach((modelId) => add(modelsById.get(modelId)))
  return ordered
}
