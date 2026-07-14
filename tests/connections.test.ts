import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONNECTION_KINDS,
  CONNECTION_PROVIDERS,
  MAX_CUSTOM_MODELS_PER_CONNECTION,
  MAX_SELECTED_MODELS_PER_CONNECTION,
  normalizeConnectionBaseUrl,
  normalizeProviderName,
  validateAvailableModelIds,
  validateConnectionInput,
  validateModelSelection,
  type ConnectionSummary
} from '../src/shared/connections.js'

const summary = (overrides: Partial<ConnectionSummary> = {}): ConnectionSummary => ({
  id: 'connection-1',
  kind: 'openrouter',
  providerName: 'OpenRouter',
  modelIds: [],
  selectedModelIds: [],
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
  hasCredential: true,
  ...overrides
})

test('connection provider metadata preserves the supported provider order', () => {
  assert.deepEqual(CONNECTION_KINDS, ['openrouter', 'openai', 'gemini', 'anthropic', 'openai-compatible'])
  assert.deepEqual(CONNECTION_PROVIDERS.map((provider) => provider.kind), CONNECTION_KINDS)
  assert.equal(CONNECTION_PROVIDERS.filter((provider) => provider.allowsMultiple).length, 1)
  assert.equal(CONNECTION_PROVIDERS.at(-1)?.supportsCustomModels, true)
})

test('provider names and connection URLs are normalized safely', () => {
  assert.equal(normalizeProviderName('  My   Provider  '), 'My Provider')
  assert.equal(normalizeConnectionBaseUrl('https://API.EXAMPLE.com/v1///'), 'https://api.example.com/v1')
  assert.equal(normalizeConnectionBaseUrl('http://localhost:11434/v1/'), 'http://localhost:11434/v1')
  assert.equal(normalizeConnectionBaseUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1')
  assert.equal(normalizeConnectionBaseUrl('http://[::1]:8080/v1'), 'http://[::1]:8080/v1')
  assert.throws(() => normalizeConnectionBaseUrl('http://api.example.com/v1'), /loopback/i)
  assert.throws(() => normalizeConnectionBaseUrl('https://user:secret@example.com/v1'), /without credentials/i)
  assert.throws(() => normalizeConnectionBaseUrl('https://example.com/v1?token=secret'), /query parameters/i)
})

test('built-in providers allow one connection and custom provider names stay unique', () => {
  const existing = [summary()]
  assert.throws(() => validateConnectionInput({
    kind: 'openrouter',
    apiKey: 'second-key',
    modelIds: [],
    selectedModelIds: []
  }, existing), /already has a connection/i)

  const custom = summary({
    id: 'custom-1',
    kind: 'openai-compatible',
    providerName: 'Acme Models',
    baseUrl: 'https://models.acme.test/v1',
    modelIds: ['acme/code'],
    selectedModelIds: ['acme/code']
  })
  assert.throws(() => validateConnectionInput({
    kind: 'openai-compatible',
    apiKey: '',
    providerName: '  acme   models ',
    baseUrl: 'https://other.acme.test/v1',
    modelIds: ['other/code'],
    selectedModelIds: []
  }, [custom]), /already has a connection/i)
  assert.throws(() => validateConnectionInput({
    kind: 'openai-compatible',
    apiKey: '',
    providerName: 'OpenAI',
    baseUrl: 'https://models.example.com/v1',
    modelIds: [],
    selectedModelIds: []
  }), /reserved/i)
})

test('custom catalogs and composer selections use distinct limits', () => {
  const available = Array.from({ length: MAX_CUSTOM_MODELS_PER_CONNECTION }, (_, index) => `model-${index}`)
  const selected = available.slice(0, MAX_SELECTED_MODELS_PER_CONNECTION)
  assert.deepEqual(validateAvailableModelIds(available), available)
  assert.deepEqual(validateModelSelection(selected, available), selected)
  assert.throws(
    () => validateAvailableModelIds([...available, 'one-too-many']),
    new RegExp(`${MAX_CUSTOM_MODELS_PER_CONNECTION}`)
  )
  assert.throws(
    () => validateModelSelection([...selected, 'model-14'], available),
    new RegExp(`${MAX_SELECTED_MODELS_PER_CONNECTION}`)
  )
  assert.throws(() => validateAvailableModelIds(['model-a', ' MODEL-A ']), /duplicate/i)
  assert.throws(() => validateModelSelection(['missing'], available), /not available/i)
})

test('connection validation keeps the custom catalog after models are deselected', () => {
  const validated = validateConnectionInput({
    kind: 'openai-compatible',
    apiKey: '',
    providerName: 'Local Lab',
    baseUrl: 'http://localhost:8000/v1/',
    modelIds: ['lab/chat', 'lab/vision'],
    selectedModelIds: ['lab/chat']
  })
  assert.deepEqual(validated.modelIds, ['lab/chat', 'lab/vision'])
  assert.deepEqual(validated.selectedModelIds, ['lab/chat'])
  assert.equal(validated.baseUrl, 'http://localhost:8000/v1')
})
