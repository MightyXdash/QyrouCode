import assert from 'node:assert/strict'
import test from 'node:test'
import { buildConversationExport, exportFilename } from '../src/main/conversationExport.js'
import type { PersistedAgentSession } from '../src/shared/agent.js'
import type { ChatThread } from '../src/shared/chat.js'
import type { ConversationExportRequest } from '../src/shared/conversationExport.js'

const baseRequest: ConversationExportRequest = {
  scope: 'all',
  format: 'jsonl',
  includeMessages: true,
  includeToolCalls: true,
  includeReasoningSummaries: true,
  includeRawReasoning: true,
  includeTimestamps: true,
  attachments: 'none',
  redactSensitiveData: true
}

const threads: ChatThread[] = [{
  id: 'thread-1',
  projectPath: '/project',
  title: 'Export test',
  updatedAt: 20,
  messages: []
}]

function session(provider: string, modelId: string, reasoningRetention: 'retain' | 'discard'): PersistedAgentSession {
  return {
    threadId: 'thread-1',
    projectPath: '/project',
    updatedAt: 20,
    messages: [
      { role: 'user', content: 'Inspect this project' },
      {
        role: 'assistant',
        content: null,
        reasoningText: 'private analysis',
        model: { source: 'remote', connectionId: 'connection-1', provider, modelId, displayName: modelId, reasoningRetention },
        toolCalls: [{ id: 'call-1', name: 'read', arguments: { filePath: 'src/index.ts', token: 'sk-ant-secretvalue123456789' } }]
      },
      { role: 'tool', name: 'read', toolCallId: 'call-1', content: 'file contents' },
      {
        role: 'assistant',
        content: 'Done',
        model: { source: 'remote', connectionId: 'connection-1', provider, modelId, displayName: modelId, reasoningRetention }
      }
    ]
  }
}

test('exports OpenAI-shaped tool calls and redacts credentials', () => {
  const result = buildConversationExport(baseRequest, threads, { 'thread-1': session('Qwen', 'qwen/qwen3.7-plus', 'retain') })
  const record = JSON.parse(result.content.trim()) as { messages: Array<Record<string, unknown>> }

  assert.equal(result.preview.threadCount, 1)
  assert.equal(result.preview.toolCallCount, 1)
  assert.equal(result.preview.rawReasoningCount, 1)
  assert.equal(record.messages[1].reasoning_content, 'private analysis')
  assert.match(result.content, /\[REDACTED\]/)
  assert.doesNotMatch(result.content, /sk-ant-secret/)
})

test('fails closed for hosted reasoning outside Qwen and DeepSeek', () => {
  for (const [provider, modelId] of [
    ['OpenAI', 'openai/gpt-5.6-sol'],
    ['Anthropic', 'anthropic/claude-sonnet-5'],
    ['Google', 'google/gemini-3.5-flash'],
    ['xAI', 'x-ai/grok-4.5']
  ]) {
    const result = buildConversationExport(baseRequest, threads, { 'thread-1': session(provider, modelId, 'retain') })
    assert.equal(result.preview.rawReasoningCount, 0)
    assert.doesNotMatch(result.content, /private analysis/)
  }
})

test('keeps legacy local reasoning and filters tool messages when requested', () => {
  const legacy = session('Local', 'local/model', 'retain')
  legacy.messages[1].model = undefined
  const result = buildConversationExport({ ...baseRequest, includeToolCalls: false }, threads, { 'thread-1': legacy })

  assert.equal(result.preview.rawReasoningCount, 1)
  assert.equal(result.preview.toolCallCount, 0)
  assert.equal(result.preview.messageCount, 3)
})

test('uses stable dated filenames', () => {
  assert.equal(exportFilename(baseRequest, new Date('2026-07-12T10:00:00.000Z')), 'supracode-conversations-2026-07-12.jsonl')
})
