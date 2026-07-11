import assert from 'node:assert/strict'
import test from 'node:test'
import { MODEL_LIST } from '../src/renderer/src/modelCatalog.js'
import { reasoningProfile } from '../src/renderer/src/reasoningProfiles.js'

test('Instant disables native thinking for Qwen and Gemma models', () => {
  const models = MODEL_LIST.filter((model) => /qwen|gemma/i.test(model.base_model))

  assert.ok(models.length > 0)
  for (const model of models) {
    const profile = reasoningProfile(model, 'Instant')
    assert.equal(profile.enableThinking, false, model.name)
    assert.doesNotMatch(profile.systemPrompt, /internal reasoning|chain-of-thought|thinking tokens/i, model.name)
  }
})

test('reasoning efforts enable native thinking', () => {
  const model = MODEL_LIST[0]

  for (const effort of ['Low', 'Medium', 'High', 'Extra high'] as const) {
    assert.equal(reasoningProfile(model, effort).enableThinking, true, effort)
  }
})

test('reasoning efforts communicate their substep ranges', () => {
  const model = MODEL_LIST[0]
  const ranges = {
    Instant: '1–4',
    Low: '2–6',
    Medium: '3–8',
    High: '5–11',
    'Extra high': '8–16'
  } as const

  for (const [effort, range] of Object.entries(ranges)) {
    assert.match(reasoningProfile(model, effort as keyof typeof ranges).systemPrompt, new RegExp(range))
  }
})
