import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DIRECT_PROVIDER_MODEL_IDS,
  NATIVE_REASONING_EFFORTS,
  OPENROUTER_MODELS,
  REMOTE_REASONING_EFFORTS,
  getRemoteModel,
  getRemoteModelsForConnectionKind,
  groupRemoteModelsByPublisher,
  resolveRemoteReasoningEffort,
  shouldRetainRemoteReasoning,
  sortRemoteModels,
  supportsRemoteInputModality
} from '../src/shared/remoteModels.js'

const EXPECTED_OPENROUTER_IDS = [
  'openai/gpt-5.6-luna-pro',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-terra-pro',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-sol-pro',
  'openai/gpt-5.6-sol',
  'x-ai/grok-4.5',
  'tencent/hy3:free',
  'tencent/hy3',
  'poolside/laguna-xs-2.1:free',
  'poolside/laguna-xs-2.1',
  'anthropic/claude-sonnet-5',
  'cohere/north-mini-code:free',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k2.7-code',
  'anthropic/claude-fable-5',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'qwen/qwen3.7-plus',
  'minimax/minimax-m3',
  'anthropic/claude-opus-4.8-fast',
  'anthropic/claude-opus-4.8',
  'qwen/qwen3.7-max',
  'google/gemini-3.5-flash',
  'anthropic/claude-opus-4.7-fast',
  'google/gemini-3.1-flash-lite',
  'poolside/laguna-m.1',
  'qwen/qwen3.5-plus-20260420',
  'qwen/qwen3.6-flash',
  'qwen/qwen3.6-35b-a3b',
  'qwen/qwen3.6-max-preview',
  'qwen/qwen3.6-27b',
  'openai/gpt-5.5-pro',
  'openai/gpt-5.5',
  'openai/gpt-5.4-nano',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'xiaomi/mimo-v2.5-pro',
  'xiaomi/mimo-v2.5',
  'moonshotai/kimi-k2.6',
  'anthropic/claude-opus-4.7',
  'z-ai/glm-5.1'
] as const

test('the OpenRouter catalog contains every requested model exactly once', () => {
  assert.equal(OPENROUTER_MODELS.length, 42)
  assert.equal(new Set(OPENROUTER_MODELS.map((model) => model.id)).size, 42)
  assert.deepEqual(
    [...OPENROUTER_MODELS.map((model) => model.id)].sort(),
    [...EXPECTED_OPENROUTER_IDS].sort()
  )
  OPENROUTER_MODELS.forEach((model) => {
    assert.ok(model.displayName)
    assert.ok(model.publisher)
    assert.ok(model.contextWindow > 0)
    assert.ok(model.inputModalities.includes('text'))
    assert.ok(model.outputModalities.includes('text'))
    assert.equal(model.supportsTools, true)
    assert.ok(model.availableOn.includes('openrouter'))
  })
})

test('direct providers expose only their applicable API models', () => {
  assert.deepEqual([...DIRECT_PROVIDER_MODEL_IDS.openai].sort(), [
    'openai/gpt-5.4-nano',
    'openai/gpt-5.5',
    'openai/gpt-5.5-pro',
    'openai/gpt-5.6-luna',
    'openai/gpt-5.6-sol',
    'openai/gpt-5.6-terra'
  ])
  assert.deepEqual([...DIRECT_PROVIDER_MODEL_IDS.anthropic].sort(), [
    'anthropic/claude-fable-5',
    'anthropic/claude-opus-4.7',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-sonnet-5'
  ])
  assert.deepEqual([...DIRECT_PROVIDER_MODEL_IDS.gemini].sort(), [
    'google/gemini-3.1-flash-lite',
    'google/gemini-3.5-flash'
  ])
  assert.equal(getRemoteModelsForConnectionKind('openrouter').length, 42)
  assert.equal(getRemoteModelsForConnectionKind('openai-compatible').length, 0)
})

test('Anthropic direct model IDs use official hyphenated version segments', () => {
  assert.equal(getRemoteModel('anthropic/claude-opus-4.8')?.providerModelIds.anthropic, 'claude-opus-4-8')
  assert.equal(getRemoteModel('anthropic/claude-opus-4.7')?.providerModelIds.anthropic, 'claude-opus-4-7')
  assert.equal(getRemoteModel('anthropic/claude-fable-5')?.providerModelIds.anthropic, 'claude-fable-5')
})

test('every model has an explicit valid mapping for every UI reasoning effort', () => {
  const nativeEfforts = new Set(NATIVE_REASONING_EFFORTS)
  OPENROUTER_MODELS.forEach((model) => {
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

test('effort resolution uses native controls and prompt fallbacks at the closest level', () => {
  assert.deepEqual(resolveRemoteReasoningEffort('openai/gpt-5.5', 'Instant'), {
    requestedEffort: 'Instant',
    enabled: false,
    nativeEffort: 'none',
    usesPromptFallback: false,
    systemPrompt: null
  })
  const geminiInstant = resolveRemoteReasoningEffort('google/gemini-3.5-flash', 'Instant')
  assert.equal(geminiInstant.nativeEffort, 'minimal')
  assert.equal(geminiInstant.usesPromptFallback, true)
  assert.match(geminiInstant.systemPrompt ?? '', /shortest viable internal reasoning path/i)
  assert.equal(resolveRemoteReasoningEffort('google/gemini-3.1-flash-lite', 'Instant').nativeEffort, 'minimal')
  const promptOnly = resolveRemoteReasoningEffort('qwen/qwen3.7-plus', 'High')
  assert.equal(promptOnly.nativeEffort, null)
  assert.equal(promptOnly.usesPromptFallback, true)
})

test('remote reasoning retention follows the connection route', () => {
  assert.equal(shouldRetainRemoteReasoning('openrouter'), true)
  assert.equal(shouldRetainRemoteReasoning('openai-compatible'), true)
  assert.equal(shouldRetainRemoteReasoning('openai'), false)
  assert.equal(shouldRetainRemoteReasoning('anthropic'), false)
  assert.equal(shouldRetainRemoteReasoning('gemini'), false)
})

test('modality and provider grouping helpers preserve catalog capabilities', () => {
  assert.equal(supportsRemoteInputModality('google/gemini-3.5-flash', 'image'), true)
  assert.equal(supportsRemoteInputModality('google/gemini-3.5-flash', 'audio'), true)
  assert.equal(supportsRemoteInputModality('x-ai/grok-4.5', 'video'), false)
  assert.deepEqual(sortRemoteModels(OPENROUTER_MODELS), OPENROUTER_MODELS)
  const groups = groupRemoteModelsByPublisher(OPENROUTER_MODELS)
  assert.deepEqual(groups.flatMap((group) => group.models), OPENROUTER_MODELS)
  assert.equal(groups.find((group) => group.publisher === 'Qwen')?.models.length, 7)
})
