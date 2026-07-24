import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRuntime, type AgentCompletionProvider, type AgentToolEvent } from '../src/main/agentRuntime.js'
import type { LocalCompletion, LocalCompletionRequest, LocalMessageContent } from '../src/main/localCompletionClient.js'

const textContent = (content: LocalMessageContent | undefined): string => typeof content === 'string' ? content : ''
const uiMessage = (uim_prt: string, uim_pat: string): { uim_prt: string; uim_pat: string } => ({ uim_prt, uim_pat })
const TASK_STATE = 'Inspecting the relevant files before making the smallest safe change.'

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

test('retries provider errors three times and reports each retry before succeeding', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    let attempts = 0
    const events: AgentToolEvent[] = []
    const provider: AgentCompletionProvider = {
      async complete(): Promise<LocalCompletion> {
        attempts += 1
        if (attempts <= 3) throw new Error('Transient provider error')
        return { text: 'Recovered response.', toolCalls: [] }
      }
    }

    await new AgentRuntime(provider).run({
      threadId: 'thread-provider-retry',
      projectPath,
      messages: [{ role: 'user', content: 'Respond after a transient provider error.' }]
    }, () => {}, undefined, (event) => events.push(event))

    assert.equal(attempts, 4)
    assert.equal(events.filter((event) => event.type === 'progress-update').length, 3)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('co-batches progress, mutation, and verification in two provider turns', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    writeFileSync(join(projectPath, 'AGENTS.md'), 'Always create files under src.\n', 'utf8')
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: 'state', name: 'cur_task_state', arguments: { message: TASK_STATE } },
          { id: 'write', name: 'write', arguments: { ui_message: uiMessage('Creating the result module', 'Created the result module'), filePath: 'src/result.ts', content: 'export const result = 1\n' } },
          { id: 'read', name: 'read', arguments: { ui_message: uiMessage('Verifying the result module', 'Verified the result module'), filePath: 'src/result.ts' } }
        ]
      },
      { text: 'Implemented and verified the result module.', toolCalls: [] }
    ])
    const persisted: LocalCompletionRequest['messages'][] = []
    const events: AgentToolEvent[] = []
    let output = ''

    await new AgentRuntime(provider).run({
      threadId: 'thread-batch',
      projectPath,
      nativeLanguage: 'Spanish',
      messages: [
        { role: 'system', content: 'Return a concise final summary.' },
        { role: 'user', content: 'Create the result module.' }
      ]
    }, (delta) => { output += delta }, (messages) => persisted.push(messages.map((message) => ({ ...message }))), (event) => events.push(event))

    assert.equal(provider.requests.length, 2)
    assert.equal(output, 'Implemented and verified the result module.')
    assert.equal(readFileSync(join(projectPath, 'src/result.ts'), 'utf8'), 'export const result = 1\n')
    const system = textContent(provider.requests[0].messages[0].content)
    assert.match(system, /cur_task_state is optional/)
    assert.match(system, /Batch independent tools/)
    assert.doesNotMatch(system, /Call exactly one tool/)
    assert.doesNotMatch(system, /Supra-50M/)
    assert.ok(system.length + JSON.stringify(provider.requests[0].tools).length < 32_000)
    const persistedAssistant = persisted.flat().find((message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.id === 'write'))
    assert.deepEqual(persistedAssistant?.toolCalls?.map((call) => call.id), ['write', 'read'])
    assert.ok(persisted.flat().every((message) => message.name !== 'cur_task_state'))
    assert.equal(events.filter((event) => event.type === 'progress-update' && event.summary === TASK_STATE).length, 1)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('executes every tool in a returned batch and preserves result order', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: 'first', name: 'write', arguments: { ui_message: uiMessage('Creating the first fixture', 'Created the first fixture'), filePath: 'first.txt', content: 'first' } },
          { id: 'second', name: 'write', arguments: { ui_message: uiMessage('Creating second fixture', 'Created second fixture'), filePath: 'second.txt', content: 'second' } },
          { id: 'verify_first', name: 'read', arguments: { ui_message: uiMessage('Reading the first fixture', 'Read the first fixture'), filePath: 'first.txt' } },
          { id: 'verify_second', name: 'read', arguments: { ui_message: uiMessage('Reading second fixture', 'Read second fixture'), filePath: 'second.txt' } }
        ]
      },
      { text: 'Created both fixtures.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-multi-tool',
      projectPath,
      messages: [{ role: 'user', content: 'Create two fixtures.' }]
    }, () => {}, undefined, (event) => events.push(event))

    assert.equal(provider.requests.length, 2)
    assert.equal(readFileSync(join(projectPath, 'first.txt'), 'utf8'), 'first')
    assert.equal(readFileSync(join(projectPath, 'second.txt'), 'utf8'), 'second')
    assert.deepEqual(events.filter((event) => event.type === 'tool-result').map((event) => event.type === 'tool-result' ? event.toolCallId : ''), ['first', 'second', 'verify_first', 'verify_second'])
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('truncates progress, suppresses duplicates, and never reprompts for status', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const longState = Array.from({ length: 100 }, (_, index) => `word${index}`).join(' ')
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: 'state_one', name: 'cur_task_state', arguments: { message: longState } },
          { id: 'state_two', name: 'cur_task_state', arguments: { message: longState } },
          { id: 'write', name: 'write', arguments: { filePath: 'result.txt', content: 'done' } }
        ]
      },
      { text: 'Created the result.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-progress',
      projectPath,
      messages: [{ role: 'user', content: 'Create the result.' }]
    }, () => {}, undefined, (event) => events.push(event))

    const progress = events.filter((event): event is Extract<AgentToolEvent, { type: 'progress-update' }> => event.type === 'progress-update')
    assert.equal(provider.requests.length, 2)
    assert.equal(progress.length, 1)
    assert.equal(progress[0].summary.split(/\s+/).length, 63)
    assert.equal(readFileSync(join(projectPath, 'result.txt'), 'utf8'), 'done')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('uses local progress and UI fallbacks without a label-only provider call', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ id: 'missing_ui', name: 'write', arguments: { filePath: 'generated.txt', content: 'done' } }] },
      { text: 'Created the requested file.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-local-fallback',
      projectPath,
      messages: [{ role: 'user', content: 'Create the file.' }]
    }, () => {}, undefined, (event) => events.push(event))

    assert.equal(provider.requests.length, 2)
    const toolCall = events.find((event) => event.type === 'tool-call' && event.toolCallId === 'missing_ui')
    assert.deepEqual(toolCall?.type === 'tool-call' ? toolCall.summary : undefined, uiMessage('Using write', 'Used write'))
    assert.ok(events.some((event) => event.type === 'progress-update' && event.summary === 'Using write'))
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('adds a local milestone after six actions without blocking the seventh', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const writes = Array.from({ length: 7 }, (_, index) => ({
      id: `write_${index}`,
      name: 'write',
      arguments: {
        ui_message: uiMessage(`Writing phase file ${index}`, `Wrote phase file ${index}`),
        filePath: `phase-${index}.txt`,
        content: `${index}`
      }
    }))
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ id: 'state', name: 'cur_task_state', arguments: { message: 'Working through the implementation phase.' } }, ...writes] },
      { text: 'Completed every phase.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-milestone',
      projectPath,
      messages: [{ role: 'user', content: 'Complete all phases.' }]
    }, () => {}, undefined, (event) => events.push(event))

    assert.equal(provider.requests.length, 2)
    assert.equal(readFileSync(join(projectPath, 'phase-6.txt'), 'utf8'), '6')
    assert.deepEqual(events.filter((event) => event.type === 'progress-update').map((event) => event.type === 'progress-update' ? event.summary : ''), [
      'Working through the implementation phase.',
      'Writing phase file 6'
    ])
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('streams final provider deltas directly through the runtime', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const requests: LocalCompletionRequest[] = []
    let index = 0
    const provider: AgentCompletionProvider = {
      async complete(): Promise<LocalCompletion> {
        throw new Error('Streaming provider should not use complete')
      },
      async stream(request, onDelta): Promise<LocalCompletion> {
        requests.push(request)
        index += 1
        if (index === 1) return { text: '', toolCalls: [{ id: 'write', name: 'write', arguments: { filePath: 'streamed.txt', content: 'done' } }] }
        onDelta('Fast ')
        onDelta('answer')
        return { text: 'Fast answer', toolCalls: [] }
      }
    }
    const deltas: string[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-stream',
      projectPath,
      messages: [{ role: 'user', content: 'Create the streamed result.' }]
    }, (delta) => deltas.push(delta))

    assert.equal(requests.length, 2)
    assert.deepEqual(deltas, ['Fast ', 'answer'])
    assert.equal(readFileSync(join(projectPath, 'streamed.txt'), 'utf8'), 'done')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('rejects a streamed response that later introduces tool calls before side effects run', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider: AgentCompletionProvider = {
      async complete(): Promise<LocalCompletion> {
        throw new Error('Streaming provider should not use complete')
      },
      async stream(_request, onDelta): Promise<LocalCompletion> {
        onDelta('Speculative text')
        return {
          text: 'Speculative text',
          toolCalls: [{ id: 'late_write', name: 'write', arguments: { filePath: 'unsafe.txt', content: 'must not run' } }]
        }
      }
    }

    await assert.rejects(
      new AgentRuntime(provider).run({
        threadId: 'thread-mixed-stream',
        projectPath,
        messages: [{ role: 'user', content: 'Create a file.' }]
      }, () => {}),
      /mixed visible assistant text with tool calls/
    )
    assert.equal(existsSync(join(projectPath, 'unsafe.txt')), false)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('exploration subagents cannot receive file mutation tools', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: 'state', name: 'cur_task_state', arguments: { message: TASK_STATE } },
          { id: 'task', name: 'task', arguments: { description: 'Inspect', prompt: 'Find files', subagentType: 'explore' } }
        ]
      },
      { text: 'Found the relevant files.', toolCalls: [] },
      { text: 'Exploration complete.', toolCalls: [] }
    ])

    await new AgentRuntime(provider).run({
      threadId: 'thread-subagent',
      projectPath,
      messages: [{ role: 'user', content: 'Explore this project.' }]
    }, () => {})

    const subagentRequest = provider.requests[1]
    assert.ok(!subagentRequest.tools?.some((tool) => ['write', 'edit', 'apply_patch', 'task'].includes(tool.name)))
    assert.equal(existsSync(join(projectPath, 'unexpected.txt')), false)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('keeps large image payloads out of text compaction and sends them to the model', async () => {
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
    assert.equal(output, 'Repository exploration is complete.')
    assert.ok(persisted.flat().every((message) => message.content !== 'private reasoning without a final answer'))
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('executes healed tool calls emitted in hidden reasoning without persisting reasoning markup', async () => {
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
