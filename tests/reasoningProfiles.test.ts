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

test('lower efforts explicitly minimize reassurance and research calls', () => {
  const model = MODEL_LIST[0]
  const instant = reasoningProfile(model, 'Instant').systemPrompt
  const low = reasoningProfile(model, 'Low').systemPrompt

  assert.match(instant, /absolute least possible number of tool calls/i)
  assert.match(instant, /call no tool/i)
  assert.match(instant, /never call the same or a substantially similar tool again merely to reassure yourself/i)
  assert.match(low, /minimize tool calls aggressively/i)
  assert.match(low, /do not call the same or a substantially similar observation.*merely to reassure yourself/i)
})
