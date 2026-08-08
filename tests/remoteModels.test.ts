import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NATIVE_REASONING_EFFORTS,
  REMOTE_REASONING_EFFORTS,
  buildReasoningEffortPrompt,
  buildRemoteModelCatalog,
  groupRemoteModelsByPublisher,
  humanizeRemoteModelId,
  inferRemoteReasoning,
  parseProviderModelList,
  resolveRemoteReasoningEffort,
  shouldRetainRemoteReasoning,
  sortRemoteModels,
  supportsRemoteInputModality,
  type RemoteModel
} from '../src/shared/remoteModels.js'

const OPENROUTER_BODY = {
  data: [
    {
      id: 'openai/gpt-5.5',
      name: 'OpenAI: GPT-5.5',
      context_length: 400000,
      architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'reasoning', 'temperature']
    },
    {
      id: 'qwen/qwen3.7-plus',
      name: 'Qwen: Qwen3.7 Plus',
      context_length: 1000000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'temperature']
    },
    {
      id: 'moonshotai/kimi-k2.7-code',
      name: 'MoonshotAI: Kimi K2.7 Code',
      context_length: 262144,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools']
    }
  ]
}

const OPENAI_BODY = {
  data: [
    { id: 'gpt-5.5' },
    { id: 'gpt-4o' },
    { id: 'o4-mini' },
    { id: 'gpt-5.1-chat-latest' },
    { id: 'whisper-1' },
    { id: 'text-embedding-3-large' },
    { id: 'gpt-3.5-turbo-instruct' },
    { id: 'dall-e-3' },
    { id: 'gpt-4o-realtime-preview' },
    { id: 'gpt-4o-audio-preview' },
    { id: 'gpt-image-1' }
  ]
}

const ANTHROPIC_BODY = {
  data: [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', type: 'model' },
    { id: 'claude-3-7-sonnet-20250224', display_name: 'Claude 3.7 Sonnet', type: 'model' },
    { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet', type: 'model' }
  ]
}

const GEMINI_BODY = {
  data: [
    { id: 'gemini-3.5-flash' },
    { id: 'gemini-2.5-pro' },
    { id: 'gemini-2.5-flash' },
    { id: 'gemini-2.0-flash' },
    { id: 'gemini-embedding-001' },
    { id: 'imagen-3.0-generate-002' },
    { id: 'gemini-2.5-flash-preview-tts' }
  ]
}

const openRouterCatalog = buildRemoteModelCatalog('openrouter', OPENROUTER_BODY)
const openAiCatalog = buildRemoteModelCatalog('openai', OPENAI_BODY)
const anthropicCatalog = buildRemoteModelCatalog('anthropic', ANTHROPIC_BODY)
const geminiCatalog = buildRemoteModelCatalog('gemini', GEMINI_BODY)

const catalogModel = (models: readonly RemoteModel[], id: string): RemoteModel => {
  const model = models.find((candidate) => candidate.id === id)
  assert.ok(model, `expected ${id} in catalog`)
  return model
}

test('OpenRouter models are parsed with provider-reported metadata', () => {
  assert.deepEqual(openRouterCatalog.map((model) => model.id), [
    'moonshotai/kimi-k2.7-code',
    'openai/gpt-5.5',
    'qwen/qwen3.7-plus'
  ])
  const gpt = catalogModel(openRouterCatalog, 'openai/gpt-5.5')
  assert.equal(gpt.publisher, 'OpenAI')
  assert.equal(gpt.displayName, 'GPT-5.5')
  assert.equal(gpt.contextWindow, 400000)
  assert.deepEqual(gpt.inputModalities, ['text', 'image', 'file'])
  assert.equal(gpt.supportsTools, true)
  assert.ok(gpt.availableOn.includes('openrouter'))
  const qwen = catalogModel(openRouterCatalog, 'qwen/qwen3.7-plus')
  assert.equal(qwen.publisher, 'Qwen')
  assert.equal(qwen.displayName, 'Qwen3.7 Plus')
  assert.equal(qwen.contextWindow, 1000000)
})

test('OpenAI model lists filter out non-chat models', () => {
  assert.deepEqual(openAiCatalog.map((model) => model.id).sort(), [
    'gpt-4o',
    'gpt-5.1-chat-latest',
    'gpt-5.5',
    'o4-mini'
  ])
})

test('OpenAI models infer capabilities from model ID patterns', () => {
  const gpt = catalogModel(openAiCatalog, 'gpt-5.5')
  assert.equal(gpt.publisher, 'OpenAI')
  assert.equal(gpt.displayName, 'GPT 5.5')
  assert.equal(gpt.contextWindow, 400000)
  assert.equal(gpt.inputModalities.includes('image'), true)
  assert.equal(gpt.reasoning.mandatory, false)
  assert.ok(gpt.reasoning.nativeEfforts.includes('none'))
  const legacy = catalogModel(openAiCatalog, 'gpt-4o')
  assert.equal(legacy.contextWindow, 128000)
  assert.equal(legacy.reasoning.nativeEfforts.length, 0)
  const mini = catalogModel(openAiCatalog, 'o4-mini')
  assert.equal(mini.contextWindow, 200000)
  assert.equal(mini.reasoning.mandatory, true)
  const chatVariant = catalogModel(openAiCatalog, 'gpt-5.1-chat-latest')
  assert.equal(chatVariant.reasoning.nativeEfforts.length, 0)
})

test('Anthropic models use display names and infer thinking support', () => {
  const opus = catalogModel(anthropicCatalog, 'claude-opus-4-8')
  assert.equal(opus.publisher, 'Anthropic')
  assert.equal(opus.displayName, 'Claude Opus 4.8')
  assert.equal(opus.contextWindow, 200000)
  assert.deepEqual(opus.inputModalities, ['text', 'image', 'file'])
  assert.equal(opus.reasoning.mandatory, false)
  const sonnet37 = catalogModel(anthropicCatalog, 'claude-3-7-sonnet-20250224')
  assert.ok(sonnet37.reasoning.nativeEfforts.length > 0)
  const sonnet35 = catalogModel(anthropicCatalog, 'claude-3-5-sonnet-20241022')
  assert.equal(sonnet35.reasoning.nativeEfforts.length, 0)
})

test('Gemini models infer thinking from version and filter non-chat models', () => {
  assert.deepEqual(geminiCatalog.map((model) => model.id).sort(), [
    'gemini-2.0-flash',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-3.5-flash'
  ])
  const flash = catalogModel(geminiCatalog, 'gemini-3.5-flash')
  assert.equal(flash.publisher, 'Google')
  assert.equal(flash.contextWindow, 1048576)
  assert.deepEqual(flash.inputModalities, ['text', 'image', 'video', 'file', 'audio'])
  assert.equal(flash.reasoning.mandatory, true)
  const legacy = catalogModel(geminiCatalog, 'gemini-2.0-flash')
  assert.equal(legacy.reasoning.nativeEfforts.length, 0)
})

test('every inferred model has a valid control for every UI reasoning effort', () => {
  const nativeEfforts = new Set(NATIVE_REASONING_EFFORTS)
  const catalogs = [openRouterCatalog, openAiCatalog, anthropicCatalog, geminiCatalog]
  catalogs.flat().forEach((model) => {
    REMOTE_REASONING_EFFORTS.forEach((effort) => {
      const control = model.reasoning.effortMap[effort]
      assert.ok(control, `${model.id}: ${effort}`)
      if (control.nativeEffort) {
        assert.ok(nativeEfforts.has(control.nativeEffort), `${model.id}: ${control.nativeEffort}`)
        assert.ok(model.reasoning.nativeEfforts.includes(control.nativeEffort), `${model.id}: ${control.nativeEffort}`)
      }
      if (model.reasoning.mandatory) assert.equal(control.enabled, true, `${model.id}: ${effort}`)
    })
  })
})

test('effort resolution disables reasoning when providers expose a no-reasoning mode', () => {
  const openAiInstant = resolveRemoteReasoningEffort(catalogModel(openAiCatalog, 'gpt-5.5'), 'Instant')
  assert.deepEqual(openAiInstant, {
    requestedEffort: 'Instant',
    enabled: false,
    nativeEffort: 'none',
    usesPromptFallback: true,
    systemPrompt: buildReasoningEffortPrompt('Instant')
  })
  const anthropicInstant = resolveRemoteReasoningEffort(catalogModel(anthropicCatalog, 'claude-opus-4-8'), 'Instant')
  assert.equal(anthropicInstant.enabled, false)
  assert.equal(anthropicInstant.nativeEffort, null)
  assert.match(anthropicInstant.systemPrompt ?? '', /do not perform or emit chain-of-thought/i)
  const openRouterInstant = resolveRemoteReasoningEffort(catalogModel(openRouterCatalog, 'openai/gpt-5.5'), 'Instant')
  assert.equal(openRouterInstant.enabled, false)
  assert.equal(openRouterInstant.nativeEffort, 'none')
  const geminiFlashInstant = resolveRemoteReasoningEffort(catalogModel(geminiCatalog, 'gemini-2.5-flash'), 'Instant')
  assert.equal(geminiFlashInstant.enabled, false)
  assert.equal(geminiFlashInstant.nativeEffort, 'none')
  const geminiProInstant = resolveRemoteReasoningEffort(catalogModel(geminiCatalog, 'gemini-2.5-pro'), 'Instant')
  assert.equal(geminiProInstant.enabled, true)
  assert.equal(geminiProInstant.nativeEffort, 'minimal')
  const geminiExtraHigh = resolveRemoteReasoningEffort(catalogModel(geminiCatalog, 'gemini-3.5-flash'), 'Extra high')
  assert.equal(geminiExtraHigh.nativeEffort, 'high')
  assert.equal(geminiExtraHigh.usesPromptFallback, true)
  const promptOnly = resolveRemoteReasoningEffort(catalogModel(openRouterCatalog, 'qwen/qwen3.7-plus'), 'High')
  assert.equal(promptOnly.nativeEffort, null)
  assert.equal(promptOnly.usesPromptFallback, true)
  assert.match(promptOnly.systemPrompt ?? '', /Reason deeply/i)
  const promptOnlyInstant = resolveRemoteReasoningEffort(catalogModel(openRouterCatalog, 'qwen/qwen3.7-plus'), 'Instant')
  assert.equal(promptOnlyInstant.enabled, false)
  assert.equal(promptOnlyInstant.usesPromptFallback, true)
  assert.match(promptOnlyInstant.systemPrompt ?? '', /do not perform or emit chain-of-thought/i)
})

test('reasoning inference uses OpenRouter supported parameters', () => {
  const native = inferRemoteReasoning('openrouter', 'openai/gpt-5.5', ['tools', 'reasoning'])
  assert.ok(native.nativeEfforts.length > 0)
  const promptOnly = inferRemoteReasoning('openrouter', 'qwen/qwen3.7-plus', ['tools', 'temperature'])
  assert.equal(promptOnly.nativeEfforts.length, 0)
})

test('remote reasoning retention follows the connection route', () => {
  assert.equal(shouldRetainRemoteReasoning('openrouter'), true)
  assert.equal(shouldRetainRemoteReasoning('openai-compatible'), true)
  assert.equal(shouldRetainRemoteReasoning('openai'), false)
  assert.equal(shouldRetainRemoteReasoning('anthropic'), false)
  assert.equal(shouldRetainRemoteReasoning('gemini'), false)
})

test('model IDs humanize into readable display names', () => {
  assert.equal(humanizeRemoteModelId('claude-opus-4-8'), 'Claude Opus 4.8')
  assert.equal(humanizeRemoteModelId('gpt-5.5'), 'GPT 5.5')
  assert.equal(humanizeRemoteModelId('anthropic/claude-sonnet-4-5-20250929'), 'Claude Sonnet 4.5')
  assert.equal(humanizeRemoteModelId('gemini-2.0-flash'), 'Gemini 2.0 Flash')
})

test('modality and grouping helpers work on runtime catalogs', () => {
  const flash = catalogModel(geminiCatalog, 'gemini-3.5-flash')
  assert.equal(supportsRemoteInputModality(flash, 'image'), true)
  assert.equal(supportsRemoteInputModality(flash, 'audio'), true)
  assert.equal(supportsRemoteInputModality(catalogModel(openAiCatalog, 'gpt-4o'), 'video'), false)
  assert.deepEqual(sortRemoteModels(openRouterCatalog), openRouterCatalog)
  const groups = groupRemoteModelsByPublisher(openRouterCatalog)
  assert.deepEqual(groups.flatMap((group) => group.models), [...openRouterCatalog])
  assert.equal(groups.find((group) => group.publisher === 'Qwen')?.models.length, 1)
})

test('parser tolerates malformed payloads', () => {
  assert.deepEqual(parseProviderModelList('openai', null), [])
  assert.deepEqual(parseProviderModelList('openai', {}), [])
  assert.deepEqual(parseProviderModelList('openai', { data: [{}, { id: 42 }, { id: ' ' }] }), [])
  assert.deepEqual(buildRemoteModelCatalog('openrouter', { data: [{ id: 'openai/gpt-5.5' }] }).map((model) => model.id), ['openai/gpt-5.5'])
})

test('duplicate model IDs are deduplicated', () => {
  const catalog = buildRemoteModelCatalog('openai', { data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5' }] })
  assert.equal(catalog.length, 1)
})
