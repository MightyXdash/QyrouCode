import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CUSTOM_RESPONSE_STYLE_LENGTH,
  validateOnboardingPreferences,
  validateResponseStylePreference,
  validateThemePreference
} from '../src/shared/settings.js'
import {
  orderPromptRefinementModels,
  validatePromptRefinementPreferences
} from '../src/shared/promptRefinement.js'

const validPreferences = {
  selectedRoles: ['Coding & Software Engineering'],
  selectedModelIds: ['supra-code'],
  theme: 'system',
  contextWindowTokens: 72000,
  mathModelTier: 'medium',
  codingModelTier: 'large',
  autoModelRouting: false,
  defaultReasoningEffort: 'medium',
  executionApproval: 'high-risk',
  responseStyle: 'pragmatic',
  customResponseInstruction: ''
}

test('accepts a complete preference payload', () => {
  assert.deepEqual(validateOnboardingPreferences(validPreferences), validPreferences)
})

test('requires an instruction for the custom response style', () => {
  assert.throws(
    () => validateOnboardingPreferences({ ...validPreferences, responseStyle: 'custom' }),
    /Invalid custom response instruction/
  )
})

test('trims a valid custom response instruction', () => {
  const result = validateOnboardingPreferences({
    ...validPreferences,
    responseStyle: 'custom',
    customResponseInstruction: '  Keep explanations practical.  '
  })

  assert.equal(result.customResponseInstruction, 'Keep explanations practical.')
})

test('rejects unsupported preference values and oversized custom instructions', () => {
  assert.throws(
    () => validateOnboardingPreferences({ ...validPreferences, theme: 'violet' }),
    /Invalid onboarding preference value/
  )
  assert.throws(
    () => validateOnboardingPreferences({
      ...validPreferences,
      responseStyle: 'custom',
      customResponseInstruction: 'a'.repeat(MAX_CUSTOM_RESPONSE_STYLE_LENGTH + 1)
    }),
    /Invalid custom response instruction/
  )
})

test('validates supported standalone theme preferences', () => {
  assert.equal(validateThemePreference('dark'), 'dark')
  assert.throws(() => validateThemePreference('midnight'), /Invalid theme preference/)
})

test('validates response style updates from settings', () => {
  assert.deepEqual(validateResponseStylePreference({ style: 'warm', customInstruction: 'ignored' }), { style: 'warm', customInstruction: '' })
  assert.deepEqual(validateResponseStylePreference({ style: 'custom', customInstruction: '  Keep it direct.  ' }), { style: 'custom', customInstruction: 'Keep it direct.' })
  assert.throws(() => validateResponseStylePreference({ style: 'custom', customInstruction: '' }), /Invalid custom response instruction/)
})

test('validates prompt refinement preferences', () => {
  assert.deepEqual(validatePromptRefinementPreferences({
    primaryModelId: 'remote:openai:gpt',
    preferProviderModels: true,
    backupModelIds: ['local:qwen', 'remote:anthropic:claude']
  }), {
    primaryModelId: 'remote:openai:gpt',
    preferProviderModels: true,
    backupModelIds: ['local:qwen', 'remote:anthropic:claude']
  })
  assert.throws(() => validatePromptRefinementPreferences({
    primaryModelId: 'local:qwen',
    preferProviderModels: false,
    backupModelIds: ['local:qwen']
  }), /must be unique/)
  assert.throws(() => validatePromptRefinementPreferences({
    primaryModelId: '',
    preferProviderModels: true,
    backupModelIds: ['one', 'two', 'three', 'four']
  }), /backup models/)
})

test('automatically orders prompt refinement models by provider preference', () => {
  const models = [
    { id: 'local:qwen', source: 'local' as const },
    { id: 'remote:openai:gpt', source: 'remote' as const },
    { id: 'remote:anthropic:claude', source: 'remote' as const }
  ]
  assert.deepEqual(orderPromptRefinementModels(models, {
    primaryModelId: '',
    preferProviderModels: true,
    backupModelIds: ['local:qwen']
  }).map((model) => model.id), ['remote:openai:gpt', 'local:qwen'])
  assert.deepEqual(orderPromptRefinementModels(models, {
    primaryModelId: '',
    preferProviderModels: false,
    backupModelIds: []
  }).map((model) => model.id), ['local:qwen'])
})

test('uses configured backups before automatic selection when the primary model is unavailable', () => {
  const models = [
    { id: 'local:qwen', source: 'local' as const },
    { id: 'remote:openai:gpt', source: 'remote' as const }
  ]
  assert.deepEqual(orderPromptRefinementModels(models, {
    primaryModelId: 'remote:missing:model',
    preferProviderModels: true,
    backupModelIds: ['local:qwen']
  }).map((model) => model.id), ['local:qwen', 'remote:openai:gpt'])
})
