import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHealedToolCalls, stripToolCallMarkup } from '../src/main/toolCallParser.js'

const allowed = new Set(['read', 'write', 'web_search'])

test('heals Qwen and Hermes JSON tool calls', () => {
  assert.deepEqual(parseHealedToolCalls('<tool_call>{"name":"read","arguments":{"filePath":"src/app.ts"}}</tool_call>', allowed), [
    { id: 'healed_call_1', name: 'read', arguments: { filePath: 'src/app.ts' } }
  ])
})

test('heals Qwen XML parameter tool calls', () => {
  assert.deepEqual(parseHealedToolCalls('<function=web_search><parameter=query>latest TypeScript</parameter></function>', allowed), [
    { id: 'healed_call_1', name: 'web_search', arguments: { query: 'latest TypeScript' } }
  ])
})

test('heals Mistral and Gemma tool calls', () => {
  assert.deepEqual(parseHealedToolCalls('[TOOL_CALLS]write[ARGS]{"filePath":"a.txt","content":"hello"}', allowed)[0], {
    id: 'healed_call_1', name: 'write', arguments: { filePath: 'a.txt', content: 'hello' }
  })
  assert.deepEqual(parseHealedToolCalls('<|tool_call>call:read{filePath:<|"|>a.txt<|"|>}<tool_call|>', allowed)[0], {
    id: 'healed_call_1', name: 'read', arguments: { filePath: 'a.txt' }
  })
})

test('heals GLM, Llama, DeepSeek, and Kimi tool calls', () => {
  assert.equal(parseHealedToolCalls('<tool_call>read<arg_key>filePath</arg_key><arg_value>a.txt</arg_value></tool_call>', allowed)[0]?.arguments.filePath, 'a.txt')
  assert.equal(parseHealedToolCalls('<|python_tag|>read.call(filePath="a.txt")', allowed)[0]?.name, 'read')
  assert.equal(parseHealedToolCalls('<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>read<｜tool▁sep｜>{"filePath":"a.txt"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>', allowed)[0]?.arguments.filePath, 'a.txt')
  assert.equal(parseHealedToolCalls('<|tool_calls_section_begin|><|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"filePath":"a.txt"}<|tool_call_end|><|tool_calls_section_end|>', allowed)[0]?.name, 'read')
})

test('filters unknown healed tools and strips hidden tool markup', () => {
  assert.deepEqual(parseHealedToolCalls('<tool_call>{"name":"unknown","arguments":{}}</tool_call>', allowed), [])
  assert.equal(stripToolCallMarkup('Checking now.\n<tool_call>{"name":"read","arguments":{}}</tool_call>'), 'Checking now.')
})
