import type { ConnectionKind } from './connections'

export const REMOTE_REASONING_EFFORTS = ['Instant', 'Low', 'Medium', 'High', 'Extra high'] as const
export const NATIVE_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type RemoteReasoningEffort = typeof REMOTE_REASONING_EFFORTS[number]
export type NativeReasoningEffort = typeof NATIVE_REASONING_EFFORTS[number]
export type RemoteInputModality = 'text' | 'image' | 'file' | 'audio' | 'video'
export type RemoteOutputModality = 'text' | 'image' | 'audio'
export type RemoteRawReasoningPolicy = 'retain' | 'discard'
export type CatalogConnectionKind = Exclude<ConnectionKind, 'openai-compatible'>
export type DirectConnectionKind = Exclude<CatalogConnectionKind, 'openrouter'>

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
  rawReasoningPolicy: RemoteRawReasoningPolicy
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

interface RemoteModelSeed {
  id: string
  displayName: string
  publisher: string
  contextWindow: number
  inputModalities: readonly RemoteInputModality[]
  outputModalities: readonly RemoteOutputModality[]
  supportsTools: boolean
  directProvider?: DirectConnectionKind
  reasoning: RemoteModelReasoning
}

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

const FULL_NATIVE_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: nativeControl('none'),
  Low: nativeControl('low'),
  Medium: nativeControl('medium'),
  High: nativeControl('high'),
  'Extra high': nativeControl('xhigh')
}

const MANDATORY_MEDIUM_TO_XHIGH_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: fallbackControl('Instant', 'medium'),
  Low: fallbackControl('Low', 'medium'),
  Medium: nativeControl('medium'),
  High: nativeControl('high'),
  'Extra high': nativeControl('xhigh')
}

const MANDATORY_LOW_TO_HIGH_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: fallbackControl('Instant', 'low'),
  Low: nativeControl('low'),
  Medium: nativeControl('medium'),
  High: nativeControl('high'),
  'Extra high': fallbackControl('Extra high', 'high')
}

const OPTIONAL_NONE_LOW_HIGH_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: nativeControl('none'),
  Low: nativeControl('low'),
  Medium: fallbackControl('Medium', 'low'),
  High: nativeControl('high'),
  'Extra high': fallbackControl('Extra high', 'high')
}

const OPTIONAL_PROMPT_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: disabledControl(),
  Low: fallbackControl('Low'),
  Medium: fallbackControl('Medium'),
  High: fallbackControl('High'),
  'Extra high': fallbackControl('Extra high')
}

const MANDATORY_PROMPT_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: fallbackControl('Instant'),
  Low: fallbackControl('Low'),
  Medium: fallbackControl('Medium'),
  High: fallbackControl('High'),
  'Extra high': fallbackControl('Extra high')
}

const OPTIONAL_LOW_TO_MAX_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: disabledControl(),
  Low: nativeControl('low'),
  Medium: nativeControl('medium'),
  High: nativeControl('high'),
  'Extra high': nativeControl('xhigh')
}

const MANDATORY_LOW_TO_MAX_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: fallbackControl('Instant', 'low'),
  Low: nativeControl('low'),
  Medium: nativeControl('medium'),
  High: nativeControl('high'),
  'Extra high': nativeControl('xhigh')
}

const OPTIONAL_HIGH_XHIGH_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: disabledControl(),
  Low: fallbackControl('Low', 'high'),
  Medium: fallbackControl('Medium', 'high'),
  High: nativeControl('high'),
  'Extra high': nativeControl('xhigh')
}

const OPTIONAL_MEDIUM_HIGH_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: disabledControl(),
  Low: fallbackControl('Low', 'medium'),
  Medium: nativeControl('medium'),
  High: nativeControl('high'),
  'Extra high': fallbackControl('Extra high', 'high')
}

const MANDATORY_MINIMAL_HIGH_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: fallbackControl('Instant', 'minimal'),
  Low: nativeControl('low'),
  Medium: nativeControl('medium'),
  High: nativeControl('high'),
  'Extra high': fallbackControl('Extra high', 'high')
}

const OPTIONAL_MINIMAL_HIGH_EFFORT_MAP: Readonly<Record<RemoteReasoningEffort, RemoteReasoningEffortControl>> = {
  Instant: fallbackControl('Instant', 'minimal'),
  Low: nativeControl('low'),
  Medium: nativeControl('medium'),
  High: nativeControl('high'),
  'Extra high': fallbackControl('Extra high', 'high')
}

const fullNativeReasoning = (defaultEnabled: boolean): RemoteModelReasoning =>
  defineReasoning(false, defaultEnabled, ['max', 'xhigh', 'high', 'medium', 'low', 'none'], FULL_NATIVE_EFFORT_MAP)

const optionalPromptReasoning = (defaultEnabled: boolean | null): RemoteModelReasoning =>
  defineReasoning(false, defaultEnabled, [], OPTIONAL_PROMPT_EFFORT_MAP)

const defineRemoteModel = (seed: RemoteModelSeed): RemoteModel => {
  const directProvider = seed.directProvider
  const catalogModelId = seed.id.slice(seed.id.indexOf('/') + 1)
  const directModelId = directProvider === 'anthropic' ? catalogModelId.replace(/\./g, '-') : catalogModelId
  return {
    id: seed.id,
    displayName: seed.displayName,
    publisher: seed.publisher,
    contextWindow: seed.contextWindow,
    inputModalities: [...seed.inputModalities],
    outputModalities: [...seed.outputModalities],
    supportsTools: seed.supportsTools,
    availableOn: directProvider ? ['openrouter', directProvider] : ['openrouter'],
    providerModelIds: directProvider
      ? { openrouter: seed.id, [directProvider]: directModelId }
      : { openrouter: seed.id },
    reasoning: seed.reasoning,
    rawReasoningPolicy: seed.id.startsWith('qwen/') || seed.id.startsWith('deepseek/') ? 'retain' : 'discard'
  }
}

const MODEL_SEEDS: readonly RemoteModelSeed[] = [
  {
    id: 'openai/gpt-5.6-luna-pro',
    displayName: 'GPT-5.6 Luna Pro',
    publisher: 'OpenAI',
    contextWindow: 1050000,
    inputModalities: ['file', 'image', 'text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: fullNativeReasoning(true)
  },
  {
    id: 'openai/gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    publisher: 'OpenAI',
    contextWindow: 1050000,
    inputModalities: ['file', 'image', 'text'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'openai',
    reasoning: fullNativeReasoning(true)
  },
  {
    id: 'openai/gpt-5.6-terra-pro',
    displayName: 'GPT-5.6 Terra Pro',
    publisher: 'OpenAI',
    contextWindow: 1050000,
    inputModalities: ['file', 'image', 'text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: fullNativeReasoning(true)
  },
  {
    id: 'openai/gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    publisher: 'OpenAI',
    contextWindow: 1050000,
    inputModalities: ['file', 'image', 'text'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'openai',
    reasoning: fullNativeReasoning(true)
  },
  {
    id: 'openai/gpt-5.6-sol-pro',
    displayName: 'GPT-5.6 Sol Pro',
    publisher: 'OpenAI',
    contextWindow: 1050000,
    inputModalities: ['file', 'image', 'text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: fullNativeReasoning(true)
  },
  {
    id: 'openai/gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    publisher: 'OpenAI',
    contextWindow: 1050000,
    inputModalities: ['file', 'image', 'text'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'openai',
    reasoning: fullNativeReasoning(true)
  },
  {
    id: 'x-ai/grok-4.5',
    displayName: 'Grok 4.5',
    publisher: 'xAI',
    contextWindow: 500000,
    inputModalities: ['text', 'image', 'file'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: defineReasoning(true, true, ['high', 'medium', 'low'], MANDATORY_LOW_TO_HIGH_EFFORT_MAP)
  },
  {
    id: 'tencent/hy3:free',
    displayName: 'Hy3 (free)',
    publisher: 'Tencent',
    contextWindow: 262144,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: defineReasoning(false, false, ['high', 'low', 'none'], OPTIONAL_NONE_LOW_HIGH_EFFORT_MAP)
  },
  {
    id: 'tencent/hy3',
    displayName: 'Hy3',
    publisher: 'Tencent',
    contextWindow: 262144,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: defineReasoning(false, false, ['high', 'low', 'none'], OPTIONAL_NONE_LOW_HIGH_EFFORT_MAP)
  },
  {
    id: 'poolside/laguna-xs-2.1:free',
    displayName: 'Laguna XS 2.1 (free)',
    publisher: 'Poolside',
    contextWindow: 262144,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(true)
  },
  {
    id: 'poolside/laguna-xs-2.1',
    displayName: 'Laguna XS 2.1',
    publisher: 'Poolside',
    contextWindow: 262144,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(true)
  },
  {
    id: 'anthropic/claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    publisher: 'Anthropic',
    contextWindow: 1000000,
    inputModalities: ['text', 'image', 'file'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'anthropic',
    reasoning: defineReasoning(false, null, ['max', 'xhigh', 'high', 'medium', 'low'], OPTIONAL_LOW_TO_MAX_EFFORT_MAP)
  },
  {
    id: 'cohere/north-mini-code:free',
    displayName: 'North Mini Code (free)',
    publisher: 'Cohere',
    contextWindow: 256000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(null)
  },
  {
    id: 'z-ai/glm-5.2',
    displayName: 'GLM 5.2',
    publisher: 'Z.ai',
    contextWindow: 1048576,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: defineReasoning(false, true, ['xhigh', 'high'], OPTIONAL_HIGH_XHIGH_EFFORT_MAP)
  },
  {
    id: 'moonshotai/kimi-k2.7-code',
    displayName: 'Kimi K2.7 Code',
    publisher: 'MoonshotAI',
    contextWindow: 262144,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: defineReasoning(true, true, [], MANDATORY_PROMPT_EFFORT_MAP)
  },
  {
    id: 'anthropic/claude-fable-5',
    displayName: 'Claude Fable 5',
    publisher: 'Anthropic',
    contextWindow: 1000000,
    inputModalities: ['text', 'image', 'file'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'anthropic',
    reasoning: defineReasoning(true, null, ['max', 'xhigh', 'high', 'medium', 'low'], MANDATORY_LOW_TO_MAX_EFFORT_MAP)
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    displayName: 'Nemotron 3 Ultra',
    publisher: 'NVIDIA',
    contextWindow: 1000000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: defineReasoning(false, true, ['high', 'medium'], OPTIONAL_MEDIUM_HIGH_EFFORT_MAP)
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    displayName: 'Nemotron 3 Ultra (free)',
    publisher: 'NVIDIA',
    contextWindow: 1000000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: defineReasoning(false, true, ['high', 'medium'], OPTIONAL_MEDIUM_HIGH_EFFORT_MAP)
  },
  {
    id: 'qwen/qwen3.7-plus',
    displayName: 'Qwen3.7 Plus',
    publisher: 'Qwen',
    contextWindow: 1000000,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(true)
  },
  {
    id: 'minimax/minimax-m3',
    displayName: 'MiniMax M3',
    publisher: 'MiniMax',
    contextWindow: 1048576,
    inputModalities: ['text', 'image', 'video'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(null)
  },
  {
    id: 'anthropic/claude-opus-4.8-fast',
    displayName: 'Claude Opus 4.8 (Fast)',
    publisher: 'Anthropic',
    contextWindow: 1000000,
    inputModalities: ['text', 'image', 'file'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: defineReasoning(false, null, ['max', 'xhigh', 'high', 'medium', 'low'], OPTIONAL_LOW_TO_MAX_EFFORT_MAP)
  },
  {
    id: 'anthropic/claude-opus-4.8',
    displayName: 'Claude Opus 4.8',
    publisher: 'Anthropic',
    contextWindow: 1000000,
    inputModalities: ['text', 'image', 'file'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'anthropic',
    reasoning: defineReasoning(false, null, ['max', 'xhigh', 'high', 'medium', 'low'], OPTIONAL_LOW_TO_MAX_EFFORT_MAP)
  },
  {
    id: 'qwen/qwen3.7-max',
    displayName: 'Qwen3.7 Max',
    publisher: 'Qwen',
    contextWindow: 1000000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(true)
  },
  {
    id: 'google/gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    publisher: 'Google',
    contextWindow: 1048576,
    inputModalities: ['text', 'image', 'video', 'file', 'audio'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'gemini',
    reasoning: defineReasoning(true, true, ['high', 'medium', 'low', 'minimal'], MANDATORY_MINIMAL_HIGH_EFFORT_MAP)
  },
  {
    id: 'anthropic/claude-opus-4.7-fast',
    displayName: 'Claude Opus 4.7 (Fast)',
    publisher: 'Anthropic',
    contextWindow: 1000000,
    inputModalities: ['text', 'image', 'file'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: defineReasoning(false, null, ['max', 'xhigh', 'high', 'medium', 'low'], OPTIONAL_LOW_TO_MAX_EFFORT_MAP)
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash Lite',
    publisher: 'Google',
    contextWindow: 1048576,
    inputModalities: ['text', 'image', 'video', 'file', 'audio'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'gemini',
    reasoning: defineReasoning(false, true, ['high', 'medium', 'low', 'minimal'], OPTIONAL_MINIMAL_HIGH_EFFORT_MAP)
  },
  {
    id: 'poolside/laguna-m.1',
    displayName: 'Laguna M.1',
    publisher: 'Poolside',
    contextWindow: 262144,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(true)
  },
  {
    id: 'qwen/qwen3.5-plus-20260420',
    displayName: 'Qwen3.5 Plus 2026-04-20',
    publisher: 'Qwen',
    contextWindow: 1000000,
    inputModalities: ['text', 'image', 'video'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(null)
  },
  {
    id: 'qwen/qwen3.6-flash',
    displayName: 'Qwen3.6 Flash',
    publisher: 'Qwen',
    contextWindow: 1000000,
    inputModalities: ['text', 'image', 'video'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(null)
  },
  {
    id: 'qwen/qwen3.6-35b-a3b',
    displayName: 'Qwen3.6 35B A3B',
    publisher: 'Qwen',
    contextWindow: 262144,
    inputModalities: ['text', 'image', 'video'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(true)
  },
  {
    id: 'qwen/qwen3.6-max-preview',
    displayName: 'Qwen3.6 Max Preview',
    publisher: 'Qwen',
    contextWindow: 262144,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(true)
  },
  {
    id: 'qwen/qwen3.6-27b',
    displayName: 'Qwen3.6 27B',
    publisher: 'Qwen',
    contextWindow: 262144,
    inputModalities: ['text', 'image', 'video'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(true)
  },
  {
    id: 'openai/gpt-5.5-pro',
    displayName: 'GPT-5.5 Pro',
    publisher: 'OpenAI',
    contextWindow: 1050000,
    inputModalities: ['file', 'image', 'text'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'openai',
    reasoning: defineReasoning(true, null, ['xhigh', 'high', 'medium'], MANDATORY_MEDIUM_TO_XHIGH_EFFORT_MAP)
  },
  {
    id: 'openai/gpt-5.5',
    displayName: 'GPT-5.5',
    publisher: 'OpenAI',
    contextWindow: 1050000,
    inputModalities: ['file', 'image', 'text'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'openai',
    reasoning: defineReasoning(false, true, ['xhigh', 'high', 'medium', 'low', 'none'], FULL_NATIVE_EFFORT_MAP)
  },
  {
    id: 'openai/gpt-5.4-nano',
    displayName: 'GPT-5.4 Nano',
    publisher: 'OpenAI',
    contextWindow: 400000,
    inputModalities: ['file', 'image', 'text'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'openai',
    reasoning: defineReasoning(false, false, ['xhigh', 'high', 'medium', 'low', 'none'], FULL_NATIVE_EFFORT_MAP)
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    publisher: 'DeepSeek',
    contextWindow: 1048576,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: defineReasoning(false, null, ['xhigh', 'high'], OPTIONAL_HIGH_XHIGH_EFFORT_MAP)
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    publisher: 'DeepSeek',
    contextWindow: 1048576,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: defineReasoning(false, null, ['xhigh', 'high'], OPTIONAL_HIGH_XHIGH_EFFORT_MAP)
  },
  {
    id: 'xiaomi/mimo-v2.5-pro',
    displayName: 'MiMo-V2.5-Pro',
    publisher: 'Xiaomi',
    contextWindow: 1048576,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(null)
  },
  {
    id: 'xiaomi/mimo-v2.5',
    displayName: 'MiMo-V2.5',
    publisher: 'Xiaomi',
    contextWindow: 1048576,
    inputModalities: ['text', 'audio', 'image', 'video'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(null)
  },
  {
    id: 'moonshotai/kimi-k2.6',
    displayName: 'Kimi K2.6',
    publisher: 'MoonshotAI',
    contextWindow: 262144,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(true)
  },
  {
    id: 'anthropic/claude-opus-4.7',
    displayName: 'Claude Opus 4.7',
    publisher: 'Anthropic',
    contextWindow: 1000000,
    inputModalities: ['text', 'image', 'file'],
    outputModalities: ['text'],
    supportsTools: true,
    directProvider: 'anthropic',
    reasoning: defineReasoning(false, null, ['max', 'xhigh', 'high', 'medium', 'low'], OPTIONAL_LOW_TO_MAX_EFFORT_MAP)
  },
  {
    id: 'z-ai/glm-5.1',
    displayName: 'GLM 5.1',
    publisher: 'Z.ai',
    contextWindow: 202752,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    reasoning: optionalPromptReasoning(true)
  }
]

export const sortRemoteModels = (models: readonly RemoteModel[]): RemoteModel[] =>
  [...models].sort((left, right) => {
    const publisherOrder = left.publisher.localeCompare(right.publisher, 'en', { sensitivity: 'base' })
    if (publisherOrder !== 0) return publisherOrder
    return left.displayName.localeCompare(right.displayName, 'en', { numeric: true, sensitivity: 'base' })
  })

export const OPENROUTER_MODELS: readonly RemoteModel[] = sortRemoteModels(MODEL_SEEDS.map(defineRemoteModel))
export const REMOTE_MODEL_CATALOG = OPENROUTER_MODELS

export const DIRECT_PROVIDER_MODEL_IDS: Readonly<Record<DirectConnectionKind, readonly string[]>> = {
  openai: OPENROUTER_MODELS.filter((model) => model.availableOn.includes('openai')).map((model) => model.id),
  anthropic: OPENROUTER_MODELS.filter((model) => model.availableOn.includes('anthropic')).map((model) => model.id),
  gemini: OPENROUTER_MODELS.filter((model) => model.availableOn.includes('gemini')).map((model) => model.id)
}

export const REASONING_EFFORT_PROMPTS: Readonly<Record<RemoteReasoningEffort, string>> = {
  Instant: 'Use the shortest viable internal reasoning path and the fewest steps needed for a reliable answer.',
  Low: 'Use a short, focused internal reasoning pass. Consider only the decisive constraints and avoid unnecessary alternatives.',
  Medium: 'Use a balanced internal reasoning pass. Check the main assumptions and important tradeoffs before answering.',
  High: 'Reason deeply, test important assumptions, compare viable approaches, and check meaningful failure modes.',
  'Extra high': 'Use the deepest useful internal analysis. Systematically examine assumptions, alternatives, edge cases, and failure modes before answering.'
}

export const getRemoteModel = (
  modelId: string,
  models: readonly RemoteModel[] = OPENROUTER_MODELS
): RemoteModel | undefined => models.find((model) => model.id === modelId)

export const getRemoteModelsForConnectionKind = (kind: ConnectionKind): readonly RemoteModel[] =>
  kind === 'openai-compatible' ? [] : OPENROUTER_MODELS.filter((model) => model.availableOn.includes(kind))

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
  `${REASONING_EFFORT_PROMPTS[effort]} Keep private reasoning private and return only the useful final answer.`

export const buildReasoningEffortPrompt = getReasoningEffortPrompt

const resolveModelReference = (model: RemoteModel | string): RemoteModel => {
  if (typeof model !== 'string') return model
  const resolved = getRemoteModel(model)
  if (!resolved) throw new Error(`Unknown remote model: ${model}`)
  return resolved
}

export const resolveRemoteReasoningEffort = (
  model: RemoteModel | string,
  requestedEffort: RemoteReasoningEffort
): ResolvedRemoteReasoningEffort => {
  const resolvedModel = resolveModelReference(model)
  const control = resolvedModel.reasoning.effortMap[requestedEffort]
  if (!control) throw new Error(`Unsupported reasoning effort: ${requestedEffort}`)
  return {
    requestedEffort,
    enabled: control.enabled,
    nativeEffort: control.nativeEffort,
    usesPromptFallback: control.promptFallback !== null,
    systemPrompt: control.promptFallback === null ? null : getReasoningEffortPrompt(control.promptFallback)
  }
}

export const resolveReasoningEffort = resolveRemoteReasoningEffort

export const supportsRemoteInputModality = (
  model: RemoteModel | string,
  modality: RemoteInputModality
): boolean => resolveModelReference(model).inputModalities.includes(modality)

export const shouldRetainRawReasoning = (model: RemoteModel | string): boolean => {
  if (typeof model !== 'string') return model.rawReasoningPolicy === 'retain'
  const resolved = getRemoteModel(model)
  if (resolved) return resolved.rawReasoningPolicy === 'retain'
  return model.startsWith('qwen/') || model.startsWith('deepseek/')
}
