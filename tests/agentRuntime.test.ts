import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRuntime, type AgentCompletionProvider } from '../src/main/agentRuntime.js'
import type { LocalCompletion, LocalCompletionRequest, LocalMessageContent } from '../src/main/localCompletionClient.js'

const textContent = (content: LocalMessageContent | undefined): string => typeof content === 'string' ? content : ''

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
      { text: '', toolCalls: [{ id: 'call_1', name: 'write', arguments: { filePath: 'src/result.ts', content: 'export const result = 1\n' } }] },
      { text: '<tool_call>{"name":"read","arguments":{"filePath":"src/result.ts"}}</tool_call>', toolCalls: [] },
      { text: 'Implemented the requested file and verified its contents.', toolCalls: [] }
    ])
    let output = ''
    const persistedStates: LocalCompletionRequest['messages'][] = []
    await new AgentRuntime(provider).run({
      threadId: 'thread-1',
      projectPath,
      messages: [
        { role: 'system', content: 'Use a high reasoning effort internally and return a concise final summary.' },
        { role: 'user', content: 'Create the result module.' }
      ],
      enableThinking: true,
      temperature: 0.8
    }, (delta) => { output += delta }, (messages) => { persistedStates.push(messages.map((message) => ({ ...message }))) })

    assert.equal(readFileSync(join(projectPath, 'src', 'result.ts'), 'utf8'), 'export const result = 1\n')
    assert.equal(output, 'Implemented the requested file and verified its contents.')
    const system = textContent(provider.requests[0].messages[0].content)
    assert.match(system, /You are SupraCode/)
    assert.match(system, /Use a high reasoning effort internally/)
    assert.match(system, /Always create files under src/)
    assert.doesNotMatch(system, /\bOpenCode\b/i)
    assert.equal(provider.requests[0].toolChoice, 'auto')
    assert.ok(provider.requests[0].tools?.some((tool) => tool.name === 'web_search'))
    assert.ok(provider.requests[2].messages.some((message) => message.role === 'tool' && message.name === 'read'))
    assert.ok(persistedStates.some((messages) => messages.some((message) => message.role === 'tool' && message.name === 'write')))
    assert.equal(persistedStates.at(-1)?.at(-1)?.content, 'Implemented the requested file and verified its contents.')
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
