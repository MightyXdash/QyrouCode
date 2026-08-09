import type { PromptRefinementPreferences } from './promptRefinement'

export const SETTINGS_VERSION = 6
export const DEFAULT_SPEED_COUNTER_ENABLED = false
export const MAX_CUSTOM_RESPONSE_STYLE_LENGTH = 600

export const CONTEXT_WINDOW_MIN_TOKENS = 32000
export const CONTEXT_WINDOW_MAX_TOKENS = 256000
export const CONTEXT_WINDOW_STEP_TOKENS = 8000
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 48000
export const CONTEXT_WINDOW_PRESET_TOKENS = [32000, 48000, 64000, 96000, 128000, 160000, 192000, 200000, 256000] as const
export const THEMES = ['light', 'dark', 'system'] as const
export const MODEL_TIERS = ['large', 'medium', 'small'] as const
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'extra-high'] as const
export const EXECUTION_APPROVAL_POLICIES = ['always', 'high-risk', 'full'] as const
export const RESPONSE_STYLES = ['warm', 'gen-z', 'sarcastic', 'pragmatic', 'custom'] as const
export const DEFAULT_RESPONSE_STYLE: ResponseStyle = 'pragmatic'
export const NATIVE_LANGUAGES = [
  'Abkhazian',
  'Afar',
  'Afrikaans',
  'Akan',
  'Albanian',
  'Amharic',
  'Arabic',
  'Aragonese',
  'Armenian',
  'Assamese',
  'Avaric',
  'Avestan',
  'Aymara',
  'Azerbaijani',
  'Bambara',
  'Bashkir',
  'Basque',
  'Belarusian',
  'Bengali',
  'Bihari',
  'Bislama',
  'Bosnian',
  'Breton',
  'Bulgarian',
  'Burmese',
  'Catalan',
  'Chamorro',
  'Chechen',
  'Chichewa',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Church Slavonic',
  'Chuvash',
  'Cornish',
  'Corsican',
  'Cree',
  'Croatian',
  'Czech',
  'Danish',
  'Divehi',
  'Dutch',
  'Dzongkha',
  'English',
  'Esperanto',
  'Estonian',
  'Ewe',
  'Faroese',
  'Fijian',
  'Finnish',
  'French',
  'Fulah',
  'Galician',
  'Ganda',
  'Georgian',
  'German',
  'Greek',
  'Guarani',
  'Gujarati',
  'Haitian Creole',
  'Hausa',
  'Hebrew',
  'Herero',
  'Hindi',
  'Hiri Motu',
  'Hungarian',
  'Icelandic',
  'Ido',
  'Igbo',
  'Indonesian',
  'Interlingua',
  'Interlingue',
  'Inuktitut',
  'Inupiaq',
  'Irish',
  'Italian',
  'Japanese',
  'Javanese',
  'Kalaallisut',
  'Kannada',
  'Kanuri',
  'Kashmiri',
  'Kazakh',
  'Khmer',
  'Kikuyu',
  'Kinyarwanda',
  'Komi',
  'Kongo',
  'Korean',
  'Kurdish',
  'Kwanyama',
  'Kyrgyz',
  'Lao',
  'Latin',
  'Latvian',
  'Limburgish',
  'Lingala',
  'Lithuanian',
  'Luba-Katanga',
  'Luxembourgish',
  'Macedonian',
  'Malagasy',
  'Malay',
  'Malayalam',
  'Maltese',
  'Manx',
  'Maori',
  'Marathi',
  'Marshallese',
  'Mongolian',
  'Nauru',
  'Navajo',
  'Ndonga',
  'Nepali',
  'North Ndebele',
  'Northern Sami',
  'Norwegian',
  'Norwegian Bokmal',
  'Norwegian Nynorsk',
  'Occitan',
  'Ojibwe',
  'Odia',
  'Oromo',
  'Ossetian',
  'Pali',
  'Pashto',
  'Persian',
  'Polish',
  'Portuguese',
  'Punjabi',
  'Quechua',
  'Romanian',
  'Romansh',
  'Rundi',
  'Russian',
  'Samoan',
  'Sango',
  'Sanskrit',
  'Sardinian',
  'Scottish Gaelic',
  'Serbian',
  'Shona',
  'Sichuan Yi',
  'Sindhi',
  'Sinhala',
  'Slovak',
  'Slovenian',
  'Somali',
  'Sotho',
  'South Ndebele',
  'Spanish',
  'Sundanese',
  'Swahili',
  'Swati',
  'Swedish',
  'Tagalog',
  'Tahitian',
  'Tajik',
  'Tamil',
  'Tatar',
  'Telugu',
  'Thai',
  'Tibetan',
  'Tigrinya',
  'Tonga',
  'Tsonga',
  'Tswana',
  'Turkish',
  'Turkmen',
  'Twi',
  'Uighur',
  'Ukrainian',
  'Urdu',
  'Uzbek',
  'Venda',
  'Vietnamese',
  'Volapuk',
  'Walloon',
  'Welsh',
  'Western Frisian',
  'Wolof',
  'Xhosa',
  'Yiddish',
  'Yoruba',
  'Zhuang',
  'Zulu'
] as const
export const DEFAULT_NATIVE_LANGUAGE: NativeLanguage = 'English'

export type ThemePreference = typeof THEMES[number]
export type ContextWindowTokens = number
export type ModelTier = typeof MODEL_TIERS[number]
export type ReasoningEffort = typeof REASONING_EFFORTS[number]
export type ExecutionApprovalPolicy = typeof EXECUTION_APPROVAL_POLICIES[number]
export type ResponseStyle = typeof RESPONSE_STYLES[number]
export type NativeLanguage = typeof NATIVE_LANGUAGES[number]

export interface OnboardingPreferences {
  selectedRoles: string[]
  selectedModelIds: string[]
  theme: ThemePreference
  contextWindowTokens: ContextWindowTokens
  mathModelTier: ModelTier
  codingModelTier: ModelTier
  autoModelRouting: boolean
  defaultReasoningEffort: ReasoningEffort
  executionApproval: ExecutionApprovalPolicy
  responseStyle: ResponseStyle
  customResponseInstruction: string
}

export interface SettingsStoreData {
  settingsVersion: number
  onboardingCompleted: boolean
  onboardingPreferences?: OnboardingPreferences
  projects?: import('./projects').Project[]
  expandedProjectPaths?: string[]
  chatThreads?: import('./chat').ChatThread[]
  agentSessions?: Record<string, import('./agent').PersistedAgentSession>
  workspaceViewState?: import('./agent').WorkspaceViewState
  browserState?: import('./browser').PersistedBrowserState
  promptRefinementPreferences?: PromptRefinementPreferences
  nativeLanguage?: NativeLanguage
  speedCounterEnabled?: boolean
}

export interface OnboardingState {
  completed: boolean
}

export interface ResponseStylePreference {
  style: ResponseStyle
  customInstruction: string
}

export const validateThemePreference = (value: unknown): ThemePreference => {
  if (!includes(THEMES, value)) throw new Error('Invalid theme preference')
  return value
}

export const validateSpeedCounterEnabled = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('Invalid speed counter preference')
  return value
}

export const normalizeContextWindowTokens = (value: unknown): ContextWindowTokens => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return DEFAULT_CONTEXT_WINDOW_TOKENS
  const snapped = Math.round(value / CONTEXT_WINDOW_STEP_TOKENS) * CONTEXT_WINDOW_STEP_TOKENS
  return Math.min(CONTEXT_WINDOW_MAX_TOKENS, Math.max(CONTEXT_WINDOW_MIN_TOKENS, snapped))
}

export const validateContextWindowTokens = (value: unknown): ContextWindowTokens => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < CONTEXT_WINDOW_MIN_TOKENS || value > CONTEXT_WINDOW_MAX_TOKENS) {
    throw new Error('Invalid context window preference')
  }
  return value
}

export const validateResponseStylePreference = (value: unknown): ResponseStylePreference => {
  if (!isRecord(value) || !includes(RESPONSE_STYLES, value.style)) throw new Error('Invalid response style preference')
  const customInstruction = typeof value.customInstruction === 'string' ? value.customInstruction.trim() : ''
  if (
    customInstruction.length > MAX_CUSTOM_RESPONSE_STYLE_LENGTH ||
    (value.style === 'custom' && customInstruction.length === 0)
  ) throw new Error('Invalid custom response instruction')
  return {
    style: value.style,
    customInstruction: value.style === 'custom' ? customInstruction : ''
  }
}

export const validateNativeLanguage = (value: unknown): NativeLanguage => {
  if (!includes(NATIVE_LANGUAGES, value)) throw new Error('Invalid native language')
  return value
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const includes = <T extends string | number>(values: readonly T[], value: unknown): value is T =>
  values.includes(value as T)

export const validateOnboardingPreferences = (value: unknown): OnboardingPreferences => {
  if (!isRecord(value)) throw new Error('Invalid onboarding preferences')

  const customResponseInstruction = typeof value.customResponseInstruction === 'string'
    ? value.customResponseInstruction.trim()
    : ''

  if (
    !isStringArray(value.selectedRoles) ||
    !isStringArray(value.selectedModelIds) ||
    !includes(THEMES, value.theme) ||
    (typeof value.contextWindowTokens !== 'number' || value.contextWindowTokens < CONTEXT_WINDOW_MIN_TOKENS || value.contextWindowTokens > CONTEXT_WINDOW_MAX_TOKENS) ||
    !includes(MODEL_TIERS, value.mathModelTier) ||
    !includes(MODEL_TIERS, value.codingModelTier) ||
    typeof value.autoModelRouting !== 'boolean' ||
    !includes(REASONING_EFFORTS, value.defaultReasoningEffort) ||
    !includes(EXECUTION_APPROVAL_POLICIES, value.executionApproval) ||
    !includes(RESPONSE_STYLES, value.responseStyle)
  ) {
    throw new Error('Invalid onboarding preference value')
  }

  if (
    customResponseInstruction.length > MAX_CUSTOM_RESPONSE_STYLE_LENGTH ||
    (value.responseStyle === 'custom' && customResponseInstruction.length === 0)
  ) {
    throw new Error('Invalid custom response instruction')
  }

  return {
    selectedRoles: value.selectedRoles,
    selectedModelIds: value.selectedModelIds,
    theme: value.theme,
    contextWindowTokens: value.contextWindowTokens,
    mathModelTier: value.mathModelTier,
    codingModelTier: value.codingModelTier,
    autoModelRouting: value.autoModelRouting,
    defaultReasoningEffort: value.defaultReasoningEffort,
    executionApproval: value.executionApproval,
    responseStyle: value.responseStyle,
    customResponseInstruction: value.responseStyle === 'custom' ? customResponseInstruction : ''
  }
}
