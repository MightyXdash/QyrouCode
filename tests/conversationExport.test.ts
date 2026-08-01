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

test('retains reasoning from OpenRouter routes regardless of model publisher', () => {
  for (const [provider, modelId] of [
    ['OpenAI', 'openai/gpt-5.6-sol'],
    ['Anthropic', 'anthropic/claude-sonnet-5'],
    ['Google', 'google/gemini-3.5-flash'],
    ['xAI', 'x-ai/grok-4.5']
  ]) {
    const result = buildConversationExport(baseRequest, threads, { 'thread-1': session(provider, modelId, 'retain') })
    assert.equal(result.preview.rawReasoningCount, 1)
    assert.match(result.content, /private analysis/)
  }
})

test('discards reasoning from official direct API routes', () => {
  for (const [provider, modelId] of [
    ['OpenAI', 'openai/gpt-5.6-sol'],
    ['Anthropic', 'anthropic/claude-sonnet-5'],
    ['Google', 'google/gemini-3.5-flash']
  ]) {
    const result = buildConversationExport(baseRequest, threads, { 'thread-1': session(provider, modelId, 'discard') })
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

test('exports attachment metadata with kinds for file attachments', () => {
  const attachmentThread: ChatThread = {
    ...threads[0],
    messages: [{
      id: 'message-1',
      role: 'user',
      content: 'Review these files',
      attachments: [
        { id: 'attachment-1', name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA', size: 4 },
        { id: 'attachment-2', name: 'notes.txt', mimeType: 'application/txt', dataUrl: 'data:application/txt;base64,AAAA', size: 4, kind: 'file' }
      ]
    }]
  }
  const request: ConversationExportRequest = { ...baseRequest, attachments: 'metadata' }
  const result = buildConversationExport(request, [attachmentThread], {})
  const record = JSON.parse(result.content.trim()) as { messages: Array<Record<string, unknown>> }
  const attachments = record.messages[0].metadata as { attachments: Array<Record<string, unknown>> }
  assert.deepEqual(attachments.attachments.map((entry) => entry.kind), ['image', 'file'])
  assert.equal((attachments.attachments[1] as Record<string, unknown>).name, 'notes.txt')
})

test('embeds file attachment data URLs when configured', () => {
  const attachmentThread: ChatThread = {
    ...threads[0],
    messages: [{
      id: 'message-1',
      role: 'user',
      content: 'Review these files',
      attachments: [
        { id: 'attachment-1', name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA', size: 4 },
        { id: 'attachment-2', name: 'notes.txt', mimeType: 'application/txt', dataUrl: 'data:application/txt;base64,BBBB', size: 4, kind: 'file' }
      ]
    }]
  }
  const request: ConversationExportRequest = { ...baseRequest, attachments: 'embedded' }
  const result = buildConversationExport(request, [attachmentThread], {})
  const record = JSON.parse(result.content.trim()) as { messages: Array<{ content: Array<{ type: string; image_url: { url: string } }> }> }
  const content = record.messages[0].content
  assert.equal(content.length, 3)
  assert.ok(content.some((part) => part.type === 'image_url' && part.image_url.url.includes('AAAA')))
  assert.ok(content.some((part) => part.type === 'image_url' && part.image_url.url.includes('BBBB')))
})
