export const CONNECTION_KINDS = [
  'openrouter',
  'openai',
  'gemini',
  'anthropic',
  'openai-compatible'
] as const

export const MAX_SELECTED_MODELS_PER_CONNECTION = 14
export const MAX_CUSTOM_MODELS_PER_CONNECTION = 100
export const MAX_PROVIDER_NAME_LENGTH = 80
export const MAX_CONNECTION_URL_LENGTH = 2048
export const MAX_CONNECTION_API_KEY_LENGTH = 8192
export const MAX_MODEL_ID_LENGTH = 512

export type ConnectionKind = typeof CONNECTION_KINDS[number]

export interface ConnectionProviderMetadata {
  kind: ConnectionKind
  displayName: string
  description: string
  allowsMultiple: boolean
  requiresBaseUrl: boolean
  supportsCustomModels: boolean
  defaultBaseUrl: string
}

export interface ConnectionInput {
  kind: ConnectionKind
  apiKey: string
  providerName?: string
  baseUrl?: string
  modelIds: string[]
  selectedModelIds: string[]
}

export interface NormalizedConnectionInput {
  kind: ConnectionKind
  apiKey: string
  providerName: string
  baseUrl: string
  modelIds: string[]
  selectedModelIds: string[]
}

export interface ConnectionSummary {
  id: string
  kind: ConnectionKind
  providerName: string
  baseUrl?: string
  modelIds: string[]
  selectedModelIds: string[]
  createdAt: string
  updatedAt: string
  hasCredential: boolean
}

export type ConnectionMutationResult =
  | { ok: true; connection: ConnectionSummary }
  | { ok: false; error: string }

export type ConnectionTestResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

export const CONNECTION_PROVIDERS: readonly ConnectionProviderMetadata[] = [
  {
    kind: 'openrouter',
    displayName: 'OpenRouter',
    description: 'Use one API key to access the curated OpenRouter model catalog.',
    allowsMultiple: false,
    requiresBaseUrl: false,
    supportsCustomModels: false,
    defaultBaseUrl: 'https://openrouter.ai/api/v1'
  },
  {
    kind: 'openai',
    displayName: 'OpenAI',
    description: 'Connect directly to supported OpenAI models.',
    allowsMultiple: false,
    requiresBaseUrl: false,
    supportsCustomModels: false,
    defaultBaseUrl: 'https://api.openai.com/v1'
  },
  {
    kind: 'gemini',
    displayName: 'Gemini',
    description: 'Connect directly to supported Google Gemini models.',
    allowsMultiple: false,
    requiresBaseUrl: false,
    supportsCustomModels: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai'
  },
  {
    kind: 'anthropic',
    displayName: 'Anthropic',
    description: 'Connect directly to supported Anthropic Claude models.',
    allowsMultiple: false,
    requiresBaseUrl: false,
    supportsCustomModels: false,
    defaultBaseUrl: 'https://api.anthropic.com/v1'
  },
  {
    kind: 'openai-compatible',
    displayName: 'OpenAI Compatible',
    description: 'Connect a uniquely named provider that implements the OpenAI API.',
    allowsMultiple: true,
    requiresBaseUrl: true,
    supportsCustomModels: true,
    defaultBaseUrl: ''
  }
]

const PROVIDERS_BY_KIND = new Map(CONNECTION_PROVIDERS.map((provider) => [provider.kind, provider]))
const RESERVED_PROVIDER_NAMES = new Set(CONNECTION_PROVIDERS.map((provider) => provider.displayName.toLowerCase()))
const HTTP_PROTOCOLS = new Set(['http:', 'https:'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

const isConnectionKind = (value: unknown): value is ConnectionKind =>
  typeof value === 'string' && CONNECTION_KINDS.includes(value as ConnectionKind)

const normalizeModelIds = (modelIds: readonly string[], limit: number, fieldName: string): string[] => {
  if (!Array.isArray(modelIds)) throw new Error(`${fieldName} must be an array`)
  if (modelIds.length > limit) throw new Error(`${fieldName} cannot contain more than ${limit} models`)

  const normalized = modelIds.map((modelId) => {
    if (typeof modelId !== 'string' || modelId.trim().length === 0) {
      throw new Error(`${fieldName} must contain non-empty model IDs`)
    }
    const normalizedModelId = modelId.trim()
    if (normalizedModelId.length > MAX_MODEL_ID_LENGTH) {
      throw new Error(`Model IDs cannot exceed ${MAX_MODEL_ID_LENGTH} characters`)
    }
    return normalizedModelId
  })
  const identities = new Set<string>()
  normalized.forEach((modelId) => {
    const identity = modelId.toLowerCase()
    if (identities.has(identity)) throw new Error(`${fieldName} cannot contain duplicate model IDs`)
    identities.add(identity)
  })
  return normalized
}

export const getConnectionProvider = (kind: ConnectionKind): ConnectionProviderMetadata => {
  const provider = PROVIDERS_BY_KIND.get(kind)
  if (!provider) throw new Error('Unknown connection provider')
  return provider
}

export const normalizeProviderName = (value: string): string => {
  if (typeof value !== 'string') throw new Error('Provider name is required')
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length === 0) throw new Error('Provider name is required')
  if (normalized.length > MAX_PROVIDER_NAME_LENGTH) {
    throw new Error(`Provider name cannot exceed ${MAX_PROVIDER_NAME_LENGTH} characters`)
  }
  return normalized
}

export const normalizeConnectionBaseUrl = (value: string): string => {
  if (typeof value !== 'string') throw new Error('Base URL is required')
  const candidate = value.trim()
  if (candidate.length === 0) throw new Error('Base URL is required')
  if (candidate.length > MAX_CONNECTION_URL_LENGTH) {
    throw new Error(`Base URL cannot exceed ${MAX_CONNECTION_URL_LENGTH} characters`)
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('Base URL must be a valid HTTP or HTTPS URL')
  }
  if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL must be an HTTP or HTTPS URL without credentials, query parameters, or a fragment')
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Unencrypted HTTP connections are only allowed for loopback hosts')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

export const validateAvailableModelIds = (modelIds: readonly string[]): string[] =>
  normalizeModelIds(modelIds, MAX_CUSTOM_MODELS_PER_CONNECTION, 'Available models')

export const validateModelSelection = (
  selectedModelIds: readonly string[],
  availableModelIds?: readonly string[]
): string[] => {
  const normalized = normalizeModelIds(
    selectedModelIds,
    MAX_SELECTED_MODELS_PER_CONNECTION,
    'Selected models'
  )
  if (availableModelIds) {
    const available = new Set(validateAvailableModelIds(availableModelIds).map((modelId) => modelId.toLowerCase()))
    normalized.forEach((modelId) => {
      if (!available.has(modelId.toLowerCase())) {
        throw new Error(`Selected model is not available from this connection: ${modelId}`)
      }
    })
  }
  return normalized
}

export const validateConnectionInput = (
  input: ConnectionInput,
  existingConnections: readonly ConnectionSummary[] = [],
  currentConnectionId?: string
): NormalizedConnectionInput => {
  if (!input || !isConnectionKind(input.kind)) throw new Error('Invalid connection provider')
  if (typeof input.apiKey !== 'string') throw new Error('API key must be a string')

  const provider = getConnectionProvider(input.kind)
  const apiKey = input.apiKey.trim()
  if (input.kind !== 'openai-compatible' && apiKey.length === 0) throw new Error('API key is required')
  if (apiKey.length > MAX_CONNECTION_API_KEY_LENGTH) {
    throw new Error(`API key cannot exceed ${MAX_CONNECTION_API_KEY_LENGTH} characters`)
  }

  const otherConnections = existingConnections.filter((connection) => connection.id !== currentConnectionId)
  if (!provider.allowsMultiple && otherConnections.some((connection) => connection.kind === input.kind)) {
    throw new Error(`${provider.displayName} already has a connection`)
  }

  const providerName = input.kind === 'openai-compatible'
    ? normalizeProviderName(input.providerName ?? '')
    : provider.displayName
  const providerIdentity = providerName.toLowerCase()
  if (input.kind === 'openai-compatible' && RESERVED_PROVIDER_NAMES.has(providerIdentity)) {
    throw new Error('Provider name is reserved for a built-in connection')
  }
  if (otherConnections.some((connection) => connection.providerName.trim().toLowerCase() === providerIdentity)) {
    throw new Error(`${providerName} already has a connection`)
  }

  const baseUrl = provider.requiresBaseUrl
    ? normalizeConnectionBaseUrl(input.baseUrl ?? '')
    : provider.defaultBaseUrl
  const modelIds = provider.supportsCustomModels ? validateAvailableModelIds(input.modelIds) : []
  const selectedModelIds = validateModelSelection(
    input.selectedModelIds,
    provider.supportsCustomModels ? modelIds : undefined
  )

  return { kind: input.kind, apiKey, providerName, baseUrl, modelIds, selectedModelIds }
}
