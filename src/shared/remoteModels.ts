import type { ConnectionKind } from './connections'

export const REMOTE_REASONING_EFFORTS = ['Instant', 'Low', 'Medium', 'High', 'Extra high'] as const
export const NATIVE_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type RemoteReasoningEffort = typeof REMOTE_REASONING_EFFORTS[number]
export type NativeReasoningEffort = typeof NATIVE_REASONING_EFFORTS[number]
export type RemoteInputModality = 'text' | 'image' | 'file' | 'audio' | 'video'
export type RemoteOutputModality = 'text' | 'image' | 'audio'
export type CatalogConnectionKind = Exclude<ConnectionKind, 'openai-compatible'>

export interface RemoteReasoningEffortControl {
  enabled: boolean
  nativeEffort: NativeReasoningEffort | null
  promptFallback: RemoteReasoningEffort | null
}

export interface RemoteModelReasoning {
  mandatory: boolean
  defaultEnabled: boolean | null
  nativeEfforts: readonly NativeReasoningEffort[]
  effortMap: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>>
}

export interface RemoteModel {
  id: string
  displayName: string
  publisher: string
  contextWindow: number
  inputModalities: readonly RemoteInputModality[]
  outputModalities: readonly RemoteOutputModality[]
  supportsTools: boolean
  availableOn: readonly CatalogConnectionKind[]
  providerModelIds: Readonly<Partial<Record<CatalogConnectionKind, string>>>
  reasoning: RemoteModelReasoning
}

export interface RemoteModelGroup {
  publisher: string
  models: readonly RemoteModel[]
}

export interface ResolvedRemoteReasoningEffort {
  requestedEffort: RemoteReasoningEffort
  enabled: boolean
  nativeEffort: NativeReasoningEffort | null
  usesPromptFallback: boolean
  systemPrompt: string | null
}

export interface ProviderModelInfo {
  id: string
  displayName?: string
  contextWindow?: number
  inputModalities?: readonly string[]
  outputModalities?: readonly string[]
  supportedParameters?: readonly string[]
}

export type ConnectionModelsResult =
  | { ok: true; models: RemoteModel[] }
  | { ok: false; error: string }

const nativeControl = (nativeEffort: NativeReasoningEffort): RemoteReasoningEffortControl => ({
  enabled: nativeEffort !== 'none',
  nativeEffort,
  promptFallback: null
})

const disabledControl = (): RemoteReasoningEffortControl => ({
  enabled: false,
  nativeEffort: null,
  promptFallback: null
})

const fallbackControl = (
  promptFallback: RemoteReasoningEffort,
  nativeEffort: NativeReasoningEffort | null = null
): RemoteReasoningEffortControl => ({ enabled: true, nativeEffort, promptFallback })

const defineReasoning = (
  mandatory: boolean,
  defaultEnabled: boolean | null,
  nativeEfforts: readonly NativeReasoningEffort[],
  effortMap: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>>
): RemoteModelReasoning => ({
  mandatory,
  defaultEnabled,
  nativeEfforts: [...nativeEfforts],
  effortMap: Object.fromEntries(
    REMOTE_REASONING_EFFORTS.map((effort) => [effort, { ...effortMap[effort] }])
  ) as unknown as Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>>
})

const OPTIONAL_NATIVE_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: disabledControl(),
  Low: nativeControl('low'),
  Medium: nativeControl('medium'),
  High: nativeControl('high'),
  'Extra high': fallbackControl('Extra high', 'high')
}

const OPENROUTER_NATIVE_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: nativeControl('none'),
  Low: nativeControl('low'),
  Medium: nativeControl('medium'),
  High: nativeControl('high'),
  'Extra high': fallbackControl('Extra high', 'high')
}

const MINIMAL_FLOOR_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: nativeControl('minimal'),
  Low: nativeControl('low'),
  Medium: nativeControl('medium'),
  High: nativeControl('high'),
  'Extra high': fallbackControl('Extra high', 'high')
}

const PROMPT_ONLY_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: disabledControl(),
  Low: fallbackControl('Low'),
  Medium: fallbackControl('Medium'),
  High: fallbackControl('High'),
  'Extra high': fallbackControl('Extra high')
}

const promptOnlyReasoning = (defaultEnabled: boolean | null): RemoteModelReasoning =>
  defineReasoning(false, defaultEnabled, [], PROMPT_ONLY_EFFORT_MAP)

const PROVIDER_PUBLISHERS: Readonly<Record<CatalogConnectionKind, string>> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google'
}

const DEFAULT_CONTEXT_WINDOWS: Readonly<Record<CatalogConnectionKind, number>> = {
  openrouter: 128_000,
  openai: 128_000,
  anthropic: 200_000,
  gemini: 1_048_576
}

const OPENAI_NON_CHAT_PATTERN = /(whisper|tts|dall-e|embedding|moderation|realtime|transcribe|babbage|davinci|instruct|gpt-image|computer-use|^codex|-audio)/
const GEMINI_NON_CHAT_PATTERN = /(embedding|imagen|veo|tts|native-audio|-audio|image-generation|\baqa\b|live)/
const OPENAI_TEXT_ONLY_PATTERN = /^(gpt-3|o1-(mini|preview)(-|$))/
const OPENAI_LEGACY_TOOLLESS_PATTERN = /^o1-(mini|preview)(-|$)/
const DATE_SUFFIX_PATTERN = /[-_](?:\d{8}|\d{4}-\d{2}-\d{2})$/
const UPPERCASE_MODEL_TOKENS = new Set(['gpt', 'glm', 'llm', 'ai', 'vl', 'omni', 'tts'])

const modelIdNumbers = (modelId: string): number[] =>
  (modelId.match(/\d+(?:\.\d+)?/g) ?? []).map((value) => Number.parseFloat(value))

const isOpenAiReasoningModel = (modelId: string): boolean =>
  /^(?:o\d+|gpt-[5-9])/.test(modelId) && !/-chat(?:-|$)/.test(modelId)

const openAiReasoningCanBeDisabled = (modelId: string): boolean => {
  const version = modelId.match(/^gpt-(\d+(?:\.\d+)?)/)?.[1]
  return version !== undefined && Number.parseFloat(version) >= 5.1 && !/-pro(?:-|$)/.test(modelId)
}

const anthropicSupportsThinking = (modelId: string): boolean => {
  const [major = 0, minor = 0] = modelIdNumbers(modelId.replace(/^claude-/, ''))
  return major >= 4 || (major === 3 && minor >= 7)
}

const geminiSupportsThinking = (modelId: string): boolean => (modelIdNumbers(modelId)[0] ?? 0) >= 2.5

const geminiReasoningCanBeDisabled = (modelId: string): boolean =>
  /^gemini-2\.5-flash(?:-lite)?(?:-|$)/.test(modelId)

const isChatCapableModelId = (kind: CatalogConnectionKind, modelId: string): boolean => {
  const id = modelId.toLowerCase()
  if (kind === 'openai') return !OPENAI_NON_CHAT_PATTERN.test(id)
  if (kind === 'gemini') return !GEMINI_NON_CHAT_PATTERN.test(id)
  return true
}

const openAiContextWindow = (modelId: string): number => {
  if (/^gpt-[5-9]/.test(modelId)) return 400_000
  if (/^o[34]/.test(modelId)) return 200_000
  return DEFAULT_CONTEXT_WINDOWS.openai
}

export const inferRemoteReasoning = (
  kind: CatalogConnectionKind,
  modelId: string,
  supportedParameters?: readonly string[]
): RemoteModelReasoning => {
  const id = modelId.toLowerCase()
  if (kind === 'openrouter') {
    const parameters = new Set((supportedParameters ?? []).map((parameter) => parameter.toLowerCase()))
    return parameters.has('reasoning') || parameters.has('include_reasoning')
      ? defineReasoning(false, true, ['none', 'low', 'medium', 'high'], OPENROUTER_NATIVE_EFFORT_MAP)
      : promptOnlyReasoning(null)
  }
  if (kind === 'openai') {
    return isOpenAiReasoningModel(id)
      ? openAiReasoningCanBeDisabled(id)
        ? defineReasoning(false, true, ['none', 'low', 'medium', 'high'], OPENROUTER_NATIVE_EFFORT_MAP)
        : defineReasoning(true, true, ['minimal', 'low', 'medium', 'high'], MINIMAL_FLOOR_EFFORT_MAP)
      : promptOnlyReasoning(false)
  }
  if (kind === 'anthropic') {
    return anthropicSupportsThinking(id)
      ? defineReasoning(false, null, ['low', 'medium', 'high'], OPTIONAL_NATIVE_EFFORT_MAP)
      : promptOnlyReasoning(false)
  }
  return geminiSupportsThinking(id)
    ? geminiReasoningCanBeDisabled(id)
      ? defineReasoning(false, true, ['none', 'low', 'medium', 'high'], OPENROUTER_NATIVE_EFFORT_MAP)
      : defineReasoning(true, true, ['minimal', 'low', 'medium', 'high'], MINIMAL_FLOOR_EFFORT_MAP)
    : promptOnlyReasoning(false)
}

const capitalizeToken = (token: string): string => {
  if (/^\d/.test(token)) return token
  if (UPPERCASE_MODEL_TOKENS.has(token.toLowerCase())) return token.toUpperCase()
  return token.charAt(0).toUpperCase() + token.slice(1)
}

export const humanizeRemoteModelId = (modelId: string): string => {
  const tail = modelId.split('/').at(-1) ?? modelId
  const words = tail.replace(DATE_SUFFIX_PATTERN, '').split(/[-_]+/).filter(Boolean)
  const merged: string[] = []
  words.forEach((word) => {
    const previous = merged.at(-1)
    if (previous !== undefined && /^\d+$/.test(word) && /\d$/.test(previous)) {
      merged[merged.length - 1] = `${previous}.${word}`
    } else {
      merged.push(word)
    }
  })
  return merged.map(capitalizeToken).join(' ')
}

const modalityList = <T extends string>(values: readonly string[] | undefined, allowed: readonly T[], fallback: readonly T[]): T[] => {
  if (!values) return [...fallback]
  const filtered = values.filter((value): value is T => allowed.includes(value as T))
  return [...new Set(filtered.includes('text' as T) ? filtered : ['text' as T, ...filtered])]
}

const inferInputModalities = (kind: CatalogConnectionKind, modelId: string, reported?: readonly string[]): readonly RemoteInputModality[] => {
  if (reported) return modalityList(reported, ['text', 'image', 'file', 'audio', 'video'], ['text'])
  const id = modelId.toLowerCase()
  if (kind === 'openai') return OPENAI_TEXT_ONLY_PATTERN.test(id) ? ['text'] : ['text', 'image', 'file']
  if (kind === 'anthropic') return ['text', 'image', 'file']
  if (kind === 'gemini') return ['text', 'image', 'video', 'file', 'audio']
  return ['text']
}

const inferOutputModalities = (reported?: readonly string[]): readonly RemoteOutputModality[] =>
  reported ? modalityList(reported, ['text', 'image', 'audio'], ['text']) : ['text']

const inferToolSupport = (kind: CatalogConnectionKind, modelId: string, supportedParameters?: readonly string[]): boolean => {
  if (kind === 'openrouter' && supportedParameters) {
    return supportedParameters.some((parameter) => parameter.toLowerCase() === 'tools')
  }
  if (kind === 'openai') return !OPENAI_LEGACY_TOOLLESS_PATTERN.test(modelId.toLowerCase())
  return true
}

const openRouterIdentity = (info: ProviderModelInfo): { publisher: string; displayName: string } => {
  const name = info.displayName?.trim()
  if (name) {
    const separator = name.indexOf(':')
    if (separator > 0 && separator <= 40) {
      return { publisher: name.slice(0, separator).trim(), displayName: name.slice(separator + 1).trim() || name }
    }
    return { publisher: humanizeRemoteModelId(info.id.split('/')[0] ?? ''), displayName: name }
  }
  return { publisher: humanizeRemoteModelId(info.id.split('/')[0] ?? ''), displayName: humanizeRemoteModelId(info.id) }
}

export const inferRemoteModel = (kind: CatalogConnectionKind, info: ProviderModelInfo): RemoteModel => {
  const identity = kind === 'openrouter'
    ? openRouterIdentity(info)
    : { publisher: PROVIDER_PUBLISHERS[kind], displayName: info.displayName?.trim() || humanizeRemoteModelId(info.id) }
  const contextWindow = info.contextWindow && info.contextWindow > 0
    ? Math.round(info.contextWindow)
    : kind === 'openai' ? openAiContextWindow(info.id.toLowerCase()) : DEFAULT_CONTEXT_WINDOWS[kind]
  return {
    id: info.id,
    displayName: identity.displayName,
    publisher: identity.publisher,
    contextWindow,
    inputModalities: inferInputModalities(kind, info.id, info.inputModalities),
    outputModalities: inferOutputModalities(info.outputModalities),
    supportsTools: inferToolSupport(kind, info.id, info.supportedParameters),
    availableOn: [kind],
    providerModelIds: { [kind]: info.id },
    reasoning: inferRemoteReasoning(kind, info.id, info.supportedParameters)
  }
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined

export const parseProviderModelList = (kind: CatalogConnectionKind, body: unknown): ProviderModelInfo[] => {
  if (!body || typeof body !== 'object') return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const candidate = entry as Record<string, unknown>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    if (!id) return []
    if (kind === 'openrouter') {
      const architecture = candidate.architecture && typeof candidate.architecture === 'object'
        ? candidate.architecture as { input_modalities?: unknown; output_modalities?: unknown }
        : undefined
      const contextLength = Number(candidate.context_length)
      const name = typeof candidate.name === 'string' ? candidate.name : undefined
      return [{
        id,
        displayName: name,
        contextWindow: Number.isFinite(contextLength) && contextLength > 0 ? contextLength : undefined,
        inputModalities: stringList(architecture?.input_modalities),
        outputModalities: stringList(architecture?.output_modalities),
        supportedParameters: stringList(candidate.supported_parameters)
      }]
    }
    if (kind === 'anthropic') {
      return [{ id, displayName: typeof candidate.display_name === 'string' ? candidate.display_name : undefined }]
    }
    return [{ id }]
  })
}

export const buildRemoteModelCatalog = (kind: CatalogConnectionKind, body: unknown): RemoteModel[] => {
  const seen = new Set<string>()
  const models = parseProviderModelList(kind, body).flatMap((info) => {
    const identity = info.id.toLowerCase()
    if (seen.has(identity) || !isChatCapableModelId(kind, info.id)) return []
    seen.add(identity)
    return [inferRemoteModel(kind, info)]
  })
  return sortRemoteModels(models)
}

export const sortRemoteModels = (models: readonly RemoteModel[]): RemoteModel[] =>
  [...models].sort((left, right) => {
    const publisherOrder = left.publisher.localeCompare(right.publisher, 'en', { sensitivity: 'base' })
    if (publisherOrder !== 0) return publisherOrder
    return left.displayName.localeCompare(right.displayName, 'en', { numeric: true, sensitivity: 'base' })
  })

export const REASONING_EFFORT_PROMPTS: Readonly<Record<RemoteReasoningEffort, string>> = {
  Instant: 'Do not perform or emit chain-of-thought, hidden analysis, deliberation, or thinking tokens. Answer immediately from the available context. If tools are necessary, select and call them directly without a narrated planning pass. Return only tool calls or the final answer.',
  Low: 'Use a short, focused internal reasoning pass. Consider only the decisive constraints and avoid unnecessary alternatives.',
  Medium: 'Use a balanced internal reasoning pass. Check the main assumptions and important tradeoffs before answering.',
  High: 'Reason deeply, test important assumptions, compare viable approaches, and check meaningful failure modes.',
  'Extra high': 'Use the deepest useful internal analysis. Systematically examine assumptions, alternatives, edge cases, and failure modes before answering.'
}

export const groupRemoteModelsByPublisher = (models: readonly RemoteModel[]): RemoteModelGroup[] => {
  const groups = new Map<string, RemoteModel[]>()
  sortRemoteModels(models).forEach((model) => {
    const group = groups.get(model.publisher) ?? []
    group.push(model)
    groups.set(model.publisher, group)
  })
  return Array.from(groups.entries(), ([publisher, groupedModels]) => ({ publisher, models: groupedModels }))
}

export const getReasoningEffortPrompt = (effort: RemoteReasoningEffort): string =>
  effort === 'Instant'
    ? REASONING_EFFORT_PROMPTS.Instant
    : `${REASONING_EFFORT_PROMPTS[effort]} Keep private reasoning private and return only the useful final answer.`

export const buildReasoningEffortPrompt = getReasoningEffortPrompt

export const resolveRemoteReasoningEffort = (
  model: RemoteModel,
  requestedEffort: RemoteReasoningEffort
): ResolvedRemoteReasoningEffort => {
  const control = model.reasoning.effortMap[requestedEffort]
  if (!control) throw new Error(`Unsupported reasoning effort: ${requestedEffort}`)
  return {
    requestedEffort,
    enabled: control.enabled,
    nativeEffort: control.nativeEffort,
    usesPromptFallback: control.promptFallback !== null || (requestedEffort === 'Instant' && !model.reasoning.mandatory),
    systemPrompt: requestedEffort === 'Instant' && !model.reasoning.mandatory
      ? getReasoningEffortPrompt('Instant')
      : control.promptFallback === null ? null : getReasoningEffortPrompt(control.promptFallback)
  }
}

export const resolveReasoningEffort = resolveRemoteReasoningEffort

export const supportsRemoteInputModality = (
  model: RemoteModel,
  modality: RemoteInputModality
): boolean => model.inputModalities.includes(modality)

export const shouldRetainRemoteReasoning = (connectionKind: ConnectionKind): boolean =>
  connectionKind === 'openrouter' || connectionKind === 'openai-compatible'
