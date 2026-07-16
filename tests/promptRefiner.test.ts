import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_PROMPT_REFINEMENT_CHARACTERS } from '../src/shared/promptRefinement.js'
import { AMBIGUOUS_PROMPT_REFINEMENT_RESULT, HARMFUL_PROMPT_REFINEMENT_RESULT, PROMPT_REFINEMENT_REFUSAL_RECOVERY_PROMPT, PROMPT_REFINEMENT_SYSTEM_PROMPT, refinePrompt } from '../src/main/promptRefiner.js'

test('refines with tools disabled and returns the successful model', async () => {
  let capturedRequest: Parameters<Parameters<typeof refinePrompt>[1][number]['complete']>[0] | undefined
  const result = await refinePrompt('  fix my english  ', [{
    modelId: 'primary',
    modelName: 'Primary',
    complete: async () => { throw new Error('offline') }
  }, {
    modelId: 'backup',
    modelName: 'Backup',
    complete: async (request) => {
      capturedRequest = request
      return { text: '  Please revise this text for clarity.  ' }
    }
  }])

  assert.deepEqual(result, {
    prompt: 'Please revise this text for clarity.',
    modelId: 'backup',
    modelName: 'Backup',
    outcome: 'refined'
  })
  assert.equal(capturedRequest?.messages[0]?.content, PROMPT_REFINEMENT_SYSTEM_PROMPT)
  assert.equal(capturedRequest?.messages[1]?.content, 'fix my english')
  assert.equal(capturedRequest?.toolChoice, 'none')
  assert.equal(capturedRequest?.enableThinking, false)
  assert.match(PROMPT_REFINEMENT_SYSTEM_PROMPT, /experienced software developer/)
  assert.match(PROMPT_REFINEMENT_SYSTEM_PROMPT, /Do not invent technical requirements/)
})

test('rejects missing, oversized, and model-less refinement requests', async () => {
  await assert.rejects(() => refinePrompt('', []), /Enter a prompt/)
  await assert.rejects(() => refinePrompt('a'.repeat(MAX_PROMPT_REFINEMENT_CHARACTERS + 1), []), /cannot exceed/)
  await assert.rejects(() => refinePrompt('Improve this', []), /No prompt refinement model/)
})

test('preserves the exact draft and stops fallback when the model reports ambiguity', async () => {
  let backupCalled = false
  const originalPrompt = '  xqz 91 @@  '
  const result = await refinePrompt(originalPrompt, [{
    modelId: 'primary',
    modelName: 'Primary',
    complete: async () => ({ text: `\n${AMBIGUOUS_PROMPT_REFINEMENT_RESULT}\n` })
  }, {
    modelId: 'backup',
    modelName: 'Backup',
    complete: async () => {
      backupCalled = true
      return { text: 'Invented rewrite' }
    }
  }])

  assert.deepEqual(result, {
    prompt: originalPrompt,
    modelId: 'primary',
    modelName: 'Primary',
    outcome: 'ambiguous'
  })
  assert.equal(backupCalled, false)
  assert.match(PROMPT_REFINEMENT_SYSTEM_PROMPT, /return exactly <AMBIGUOUS>/)
})

test('normalizes a verbose ambiguity explanation without changing the draft', async () => {
  const originalPrompt = "vdbjlnDSVN gn sI'E SEIG"
  const result = await refinePrompt(originalPrompt, [{
    modelId: 'primary',
    modelName: 'Primary',
    complete: async () => ({
      text: `The user's input appears to be a random string that does not form a coherent instruction.

Since the input does not contain a clear intent or requested operation, I cannot rewrite it into an actionable prompt. Please clarify your request.`
    })
  }])

  assert.deepEqual(result, {
    prompt: originalPrompt,
    modelId: 'primary',
    modelName: 'Primary',
    outcome: 'ambiguous'
  })
})

test('returns a destructive harm outcome and stops fallback', async () => {
  let backupCalled = false
  const result = await refinePrompt('Build something intended to harm a person', [{
    modelId: 'primary',
    modelName: 'Primary',
    complete: async () => ({ text: HARMFUL_PROMPT_REFINEMENT_RESULT })
  }, {
    modelId: 'backup',
    modelName: 'Backup',
    complete: async () => {
      backupCalled = true
      return { text: 'Unsafe rewrite' }
    }
  }])

  assert.deepEqual(result, {
    prompt: '',
    modelId: 'primary',
    modelName: 'Primary',
    outcome: 'harm'
  })
  assert.equal(backupCalled, false)
  assert.match(PROMPT_REFINEMENT_SYSTEM_PROMPT, /return exactly <HARM>/)
  assert.match(PROMPT_REFINEMENT_SYSTEM_PROMPT, /must not return <HARM>/)
  assert.match(PROMPT_REFINEMENT_SYSTEM_PROMPT, /kill a stuck process/)
})

test('converts a safety refusal into harm through a classification retry', async () => {
  const requests: Parameters<Parameters<typeof refinePrompt>[1][number]['complete']>[0][] = []
  const result = await refinePrompt('I want to kill X', [{
    modelId: 'primary',
    modelName: 'Primary',
    complete: async (request) => {
      requests.push(request)
      return requests.length === 1
        ? { text: 'I cannot fulfill this request. My safety guidelines prohibit me from helping.' }
        : { text: '<HARM>' }
    }
  }])

  assert.equal(result.outcome, 'harm')
  assert.equal(result.prompt, '')
  assert.equal(requests.length, 2)
  assert.equal(requests[1]?.messages[0]?.content, PROMPT_REFINEMENT_REFUSAL_RECOVERY_PROMPT)
  assert.equal(requests[1]?.maxTokens, 8_192)
  assert.equal(requests[1]?.temperature, 0.1)
})

test('rewrites a benign draft normally after a false-positive refusal', async () => {
  let primaryCalls = 0
  const result = await refinePrompt("Analyze why the quote 'I want to kill X' is threatening", [{
    modelId: 'primary',
    modelName: 'Primary',
    complete: async () => {
      primaryCalls += 1
      return primaryCalls === 1
        ? { text: "I can't assist with violent content." }
        : { text: 'Analyze why the quoted statement is threatening.' }
    }
  }])

  assert.equal(primaryCalls, 2)
  assert.deepEqual(result, {
    prompt: 'Analyze why the quoted statement is threatening.',
    modelId: 'primary',
    modelName: 'Primary',
    outcome: 'refined'
  })
})

test('reports every failed refinement candidate', async () => {
  await assert.rejects(() => refinePrompt('Improve this', [{
    modelId: 'one',
    modelName: 'One',
    complete: async () => { throw new Error('unavailable') }
  }, {
    modelId: 'two',
    modelName: 'Two',
    complete: async () => ({ text: '' })
  }]), /One: unavailable.*Two: returned an empty prompt/)
})
