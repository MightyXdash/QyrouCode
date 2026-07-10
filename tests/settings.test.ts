import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CUSTOM_RESPONSE_STYLE_LENGTH,
  validateOnboardingPreferences,
  validateThemePreference
} from '../src/shared/settings.js'

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
