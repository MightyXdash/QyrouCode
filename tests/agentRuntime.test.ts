import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRuntime, type AgentCompletionProvider, type AgentToolEvent } from '../src/main/agentRuntime.js'
import type { LocalCompletion, LocalCompletionRequest, LocalMessageContent } from '../src/main/localCompletionClient.js'

const textContent = (content: LocalMessageContent | undefined): string => typeof content === 'string' ? content : ''
const REQUIRED_PROGRESS = 'I’ll inspect the smallest relevant surface first, confirm how the current behavior is wired, and use that evidence to make the next change safely. This keeps the work focused while ensuring the visible activity message, tool execution order, and user-facing history all remain synchronized as the task moves from exploration into implementation and verification across every supported reasoning effort without skipping ahead.'
const taskStateCompletion = (id: string, message = REQUIRED_PROGRESS): LocalCompletion => ({
  text: '',
  toolCalls: [{ id, name: 'cur_task_state', arguments: { message } }]
})

class ScriptedProvider implements AgentCompletionProvider {
  readonly requests: LocalCompletionRequest[] = []
  private index = 0

  constructor(private readonly responses: LocalCompletion[]) {}

  async complete(request: LocalCompletionRequest): Promise<LocalCompletion> {
    this.requests.push(request)
    const response = this.responses[this.index]
    this.index += 1
    if (!response) throw new Error('Unexpected completion request')
    return response
  }
}

test('runs native and healed local-model tools end to end before returning a final answer', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    writeFileSync(join(projectPath, 'AGENTS.md'), 'Always create files under src.\n', 'utf8')
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ id: 'call_1', name: 'write', arguments: { ui_message: 'I’m creating the result module', filePath: 'src/result.ts', content: 'export const result = 1\n' } }] },
      taskStateCompletion('state_write'),
      { text: '<tool_call>{"name":"read","arguments":{"ui_message":"I’m verifying the result module","filePath":"src/result.ts"}}</tool_call>', toolCalls: [] },
      taskStateCompletion('state_read'),
      { text: 'Implemented the requested file and verified its contents.', toolCalls: [] }
    ])
    let output = ''
    const persistedStates: LocalCompletionRequest['messages'][] = []
    const toolEvents: AgentToolEvent[] = []
    await new AgentRuntime(provider).run({
      threadId: 'thread-1',
      projectPath,
      messages: [
        { role: 'system', content: 'Use a high reasoning effort internally and return a concise final summary.' },
        { role: 'user', content: 'Create the result module.' }
      ],
      enableThinking: true,
      temperature: 0.8
    }, (delta) => { output += delta }, (messages) => { persistedStates.push(messages.map((message) => ({ ...message }))) }, (event) => { toolEvents.push(event) })

    assert.equal(readFileSync(join(projectPath, 'src', 'result.ts'), 'utf8'), 'export const result = 1\n')
    assert.equal(output, 'Implemented the requested file and verified its contents.')
    const system = textContent(provider.requests[0].messages[0].content)
    assert.match(system, /You are SupraCode/)
    assert.match(system, /Use a high reasoning effort internally/)
    assert.match(system, /Always create files under src/)
    assert.doesNotMatch(system, /\bOpenCode\b/i)
    assert.equal(provider.requests[0].toolChoice, 'auto')
    assert.ok(provider.requests[0].tools?.some((tool) => tool.name === 'web_search'))
    assert.equal(provider.requests[1].toolChoice, 'auto')
    assert.equal(provider.requests[1].enableThinking, false)
    assert.deepEqual(provider.requests[1].tools?.map((tool) => tool.name), ['cur_task_state'])
    assert.ok(provider.requests[4].messages.some((message) => message.role === 'tool' && message.name === 'read'))
    assert.ok(persistedStates.some((messages) => messages.some((message) => message.role === 'tool' && message.name === 'write')))
    assert.equal(persistedStates.at(-1)?.at(-1)?.content, 'Implemented the requested file and verified its contents.')
    assert.deepEqual(toolEvents.find((event) => event.type === 'files-changed'), {
      type: 'files-changed',
      files: [{ path: 'src/result.ts', additions: 1, deletions: 0 }]
    })
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('executes one tool per model turn and emits authored progress and UI messages', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const progress = REQUIRED_PROGRESS
    const provider = new ScriptedProvider([
      {
        text: progress,
        toolCalls: [
          { id: 'call_first', name: 'write', arguments: { ui_message: 'I’m creating the fixture', filePath: 'first.txt', content: 'first' } },
          { id: 'call_second', name: 'write', arguments: { ui_message: 'I’m creating another fixture', filePath: 'second.txt', content: 'second' } }
        ]
      },
      taskStateCompletion('state_single', progress),
      { text: 'Created the first fixture and stopped before executing another tool from the same model turn.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-single-tool',
      projectPath,
      messages: [{ role: 'user', content: 'Create one fixture.' }]
    }, () => {}, undefined, (event) => events.push(event))

    assert.equal(readFileSync(join(projectPath, 'first.txt'), 'utf8'), 'first')
    assert.equal(existsSync(join(projectPath, 'second.txt')), false)
    const progressEvents = events.filter((event) => event.type === 'progress-update')
    const toolCallIndex = events.findIndex((event) => event.type === 'tool-call' && event.toolCallId === 'call_first')
    const completedProgressIndex = events.findIndex((event) => event.type === 'progress-update' && event.summary === progress)
    assert.ok(progressEvents.length > 1)
    assert.ok(completedProgressIndex >= 0 && completedProgressIndex < toolCallIndex)
    assert.deepEqual(events.find((event) => event.type === 'tool-call' && event.toolCallId === 'call_first'), {
      type: 'tool-call',
      toolCallId: 'call_first',
      name: 'write',
      arguments: { ui_message: 'I’m creating the fixture', filePath: 'first.txt', content: 'first' },
      summary: 'I’m creating the fixture'
    })
    assert.match(textContent(provider.requests[0].messages[0].content), /Call exactly one tool at a time/)
    assert.equal(provider.requests[2].messages.find((message) => message.role === 'assistant')?.toolCalls?.length, 1)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('does not block a tool when the model writes a shorter progress message', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ id: 'short_progress', name: 'write', arguments: { ui_message: 'I’m writing the fixture', filePath: 'short.txt', content: 'done' } }] },
      taskStateCompletion('state_short', 'I’ll create the requested fixture now, verify that the write succeeds, and then report the result.'),
      { text: 'Created the fixture successfully.', toolCalls: [] }
    ])

    await new AgentRuntime(provider).run({
      threadId: 'thread-short-progress',
      projectPath,
      messages: [{ role: 'user', content: 'Create the fixture.' }]
    }, () => {}, undefined, () => {})

    assert.equal(readFileSync(join(projectPath, 'short.txt'), 'utf8'), 'done')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('generates a UI message when a non-web tool omits one', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ id: 'missing_ui', name: 'write', arguments: { filePath: 'generated.txt', content: 'done' } }] },
      taskStateCompletion('state_missing_ui'),
      { text: 'I’m creating the requested file', toolCalls: [] },
      { text: 'Created the requested file.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-generated-ui',
      projectPath,
      messages: [{ role: 'user', content: 'Create the file.' }]
    }, () => {}, undefined, (event) => events.push(event))

    const toolCall = events.find((event) => event.type === 'tool-call' && event.toolCallId === 'missing_ui')
    assert.equal(toolCall?.type === 'tool-call' ? toolCall.summary : undefined, 'I’m creating the requested file')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('exploration subagents cannot receive file mutation tools', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ id: 'task_1', name: 'task', arguments: { description: 'Inspect', prompt: 'Find files', subagentType: 'explore' } }] },
      { text: 'Found the relevant files.', toolCalls: [] },
      { text: 'Exploration complete.', toolCalls: [] }
    ])
    await new AgentRuntime(provider).run({ threadId: 'thread-2', projectPath, messages: [{ role: 'user', content: 'Explore this project.' }] }, () => {})
    const subagentRequest = provider.requests[1]
    assert.ok(!subagentRequest.tools?.some((tool) => ['write', 'edit', 'apply_patch', 'task'].includes(tool.name)))
    assert.equal(existsSync(join(projectPath, 'unexpected.txt')), false)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('keeps large image payloads out of text compaction and sends them to the vision model', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([{ text: 'The image contains a document.', toolCalls: [] }])
    const imageUrl = `data:image/png;base64,${'a'.repeat(180_000)}`

    await new AgentRuntime(provider).run({
      threadId: 'thread-image',
      projectPath,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is shown here?' },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }]
    }, () => {})

    assert.equal(provider.requests.length, 1)
    const userMessage = provider.requests[0].messages.find((message) => message.role === 'user')
    assert.ok(Array.isArray(userMessage?.content))
    assert.equal(userMessage.content[1].type, 'image_url')
    assert.equal(userMessage.content[1].image_url.url, imageUrl)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('retries a reasoning-only turn with thinking disabled and keeps reasoning hidden', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      { text: '', reasoningText: 'private reasoning without a final answer', toolCalls: [], finishReason: 'stop' },
      { text: 'Repository exploration is complete.', toolCalls: [], finishReason: 'stop' }
    ])
    const persisted: LocalCompletionRequest['messages'][] = []
    let output = ''
    await new AgentRuntime(provider).run({
      threadId: 'thread-reasoning-retry',
      projectPath,
      messages: [{ role: 'user', content: 'Explore the repository.' }],
      enableThinking: true
    }, (delta) => { output += delta }, (messages) => persisted.push(messages.map((message) => ({ ...message }))))

    assert.equal(provider.requests[0].enableThinking, true)
    assert.equal(provider.requests[1].enableThinking, false)
    assert.match(textContent(provider.requests[1].messages.at(-1)?.content), /only private reasoning/)
    assert.equal(output, 'Repository exploration is complete.')
    assert.ok(persisted.flat().every((message) => message.content !== 'private reasoning without a final answer'))
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('executes healed tool calls emitted in hidden reasoning without persisting the reasoning', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      {
        text: '',
        reasoningText: '<tool_call>{"name":"write","arguments":{"filePath":"result.txt","content":"done"}}</tool_call>',
        toolCalls: [],
        finishReason: 'stop'
      },
      { text: 'Created result.txt.', toolCalls: [], finishReason: 'stop' }
    ])
    const persisted: LocalCompletionRequest['messages'][] = []
    await new AgentRuntime(provider).run({
      threadId: 'thread-reasoning-tool',
      projectPath,
      messages: [{ role: 'user', content: 'Create the result file.' }],
      enableThinking: true
    }, () => {}, (messages) => persisted.push(messages.map((message) => ({ ...message }))))

    assert.equal(readFileSync(join(projectPath, 'result.txt'), 'utf8'), 'done')
    assert.ok(persisted.flat().every((message) => !textContent(message.content).includes('<tool_call>')))
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})
