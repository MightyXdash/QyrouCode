import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRuntime, type AgentCompletionProvider, type AgentToolEvent } from '../src/main/agentRuntime.js'
import type { LocalCompletion, LocalCompletionRequest, LocalMessageContent } from '../src/main/localCompletionClient.js'

const textContent = (content: LocalMessageContent | undefined): string => typeof content === 'string' ? content : ''
const uiMessage = (uim_prt: string, uim_pat: string): { uim_prt: string; uim_pat: string } => ({ uim_prt, uim_pat })
const REQUIRED_TASK_STATE = 'I’m inspecting the smallest relevant surface first so I can confirm how the current behavior is wired before changing anything. This matters because the agent loop, visible task state, and tool activity must stay synchronized without exposing intermediate assistant prose. After I understand the existing path, I’ll carefully perform the requested action, inspect its result, and verify the final behavior.'
const taskStateCompletion = (id = 'task_state', message = REQUIRED_TASK_STATE): LocalCompletion => ({
  text: '',
  toolCalls: [{ id, name: 'cur_task_state', arguments: { message } }]
})
const distinctTaskState = (index: number): string => `I ${Array.from({ length: 59 }, (_, word) => `state${index}word${word}`).join(' ')}`

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
        if (attempts <= 3) throw new Error('Remote completion did not contain assistant text, reasoning, or tool calls')
        return { text: 'Recovered response.', toolCalls: [] }
      }
    }

    await new AgentRuntime(provider).run({
      threadId: 'thread-provider-retry',
      projectPath,
      messages: [{ role: 'user', content: 'Respond after a transient provider error.' }]
    }, () => {}, undefined, (event) => events.push(event))

    assert.equal(attempts, 4)
    assert.deepEqual(events.filter((event) => event.type === 'progress-update'), [
      { type: 'progress-update', summary: 'Provider returned error, retrying' },
      { type: 'progress-update', summary: 'Provider returned error, retrying' },
      { type: 'progress-update', summary: 'Provider returned error, retrying' }
    ])
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('runs native and healed local-model tools end to end before returning a final answer', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    writeFileSync(join(projectPath, 'AGENTS.md'), 'Always create files under src.\n', 'utf8')
    const provider = new ScriptedProvider([
      taskStateCompletion(),
      { text: 'I will now write the file.', toolCalls: [{ id: 'call_1', name: 'write', arguments: { ui_message: uiMessage('I’m creating the result module', 'Created the result module'), filePath: 'src/result.ts', content: 'export const result = 1\n' } }] },
      { text: '<tool_call>{"name":"read","arguments":{"ui_message":{"uim_prt":"I’m verifying the result module","uim_pat":"Verified the result module"},"filePath":"src/result.ts"}}</tool_call>', toolCalls: [] },
      { text: 'Implemented the requested file and verified its contents.', toolCalls: [] }
    ])
    let output = ''
    const persistedStates: LocalCompletionRequest['messages'][] = []
    const toolEvents: AgentToolEvent[] = []
    const lifecycle: string[] = []
    await new AgentRuntime(provider).run({
      threadId: 'thread-1',
      projectPath,
      messages: [
        { role: 'system', content: 'Use a high reasoning effort internally and return a concise final summary.' },
        { role: 'user', content: 'Create the result module.' }
      ],
      enableThinking: true,
      temperature: 0.8
    }, (delta) => { lifecycle.push('delta'); output += delta }, (messages) => { persistedStates.push(messages.map((message) => ({ ...message }))) }, (event) => { lifecycle.push(event.type); toolEvents.push(event) })

    assert.equal(readFileSync(join(projectPath, 'src', 'result.ts'), 'utf8'), 'export const result = 1\n')
    assert.equal(output, 'Implemented the requested file and verified its contents.')
    const system = textContent(provider.requests[0].messages[0].content)
    assert.match(system, /You are SupraCode/)
    assert.match(system, /Use a high reasoning effort internally/)
    assert.match(system, /Always create files under src/)
    assert.match(system, /Treat the open workspace as the project/)
    assert.match(system, /every final response, every cur_task_state message, and both ui_message values entirely in that language/)
    assert.match(system, /romanized or transliterated form.*native script/)
    assert.match(system, /Never default to English merely because the system prompt, tool schema, examples, protocol reminders/)
    assert.match(system, /Immediately before emitting any final response, cur_task_state, or ui_message, verify/)
    assert.match(system, /Write it in the latest actual user prompt's language and native script/)
    assert.match(system, /The English grammatical descriptions here are structural guidance, not permission to output English/)
    assert.doesNotMatch(system, /\bOpenCode\b/i)
    assert.equal(provider.requests[0].toolChoice, 'auto')
    assert.ok(provider.requests[0].tools?.some((tool) => tool.name === 'web_search'))
    assert.match(system, /first tool call.*cur_task_state/i)
    assert.match(system, /1–2 for easy tasks, 2–6 for somewhat hard tasks, 3–8 for hard tasks, 4–12 for actually hard tasks/i)
    assert.match(system, /more than 6, up to 12, for very hard tasks/i)
    assert.equal(provider.requests.length, 4)
    assert.deepEqual(provider.requests[0].tools?.find((tool) => tool.name === 'cur_task_state')?.parameters, {
      type: 'object',
      additionalProperties: false,
      properties: { message: { type: 'string', description: 'One natural 60–65-word paragraph, written mostly in first person, describing the immediate next substep, why it matters, and what follows. Later updates must contain unique information about the new work phase; the runtime requires another after every four completed agent tools while work continues, up to twelve total.' } },
      required: ['message']
    })
    assert.ok(provider.requests[3].messages.some((message) => message.role === 'tool' && message.name === 'read'))
    assert.ok(persistedStates.some((messages) => messages.some((message) => message.role === 'tool' && message.name === 'write')))
    assert.ok(persistedStates.flat().every((message) => message.name !== 'cur_task_state'))
    assert.ok(persistedStates.flat().every((message) => message.content !== 'I will now write the file.'))
    assert.equal(persistedStates.at(-1)?.at(-1)?.content, 'Implemented the requested file and verified its contents.')
    assert.deepEqual(toolEvents.find((event) => event.type === 'files-changed'), {
      type: 'files-changed',
      files: [{ path: 'src/result.ts', additions: 1, deletions: 0 }]
    })
    assert.ok(lifecycle.indexOf('files-changed') < lifecycle.indexOf('delta'))
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('emits todo updates when the agent replaces its task list', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const todos = [
      { content: 'Inspect the task surface', status: 'completed' as const, priority: 'medium' as const },
      { content: 'Implement the todo dock', status: 'in_progress' as const, priority: 'high' as const }
    ]
    const provider = new ScriptedProvider([
      taskStateCompletion(),
      { text: '', toolCalls: [{ id: 'todo_write', name: 'todo_write', arguments: { ui_message: uiMessage('I’m updating the task list', 'Updated the task list'), todos } }] },
      { text: 'The task list is ready.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-todos',
      projectPath,
      messages: [{ role: 'user', content: 'Plan this work.' }]
    }, () => {}, undefined, (event) => events.push(event))

    assert.deepEqual(events.find((event) => event.type === 'todos-updated'), { type: 'todos-updated', todos })
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('executes one tool per model turn and emits its UI message', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      taskStateCompletion(),
      {
        text: '',
        toolCalls: [
          { id: 'call_first', name: 'write', arguments: { ui_message: uiMessage('I’m creating the fixture', 'Created the fixture'), filePath: 'first.txt', content: 'first' } },
          { id: 'call_second', name: 'write', arguments: { ui_message: uiMessage('I’m creating another fixture', 'Created another fixture'), filePath: 'second.txt', content: 'second' } }
        ]
      },
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
    assert.deepEqual(events.find((event) => event.type === 'tool-call' && event.toolCallId === 'call_first'), {
      type: 'tool-call',
      toolCallId: 'call_first',
      name: 'write',
      arguments: { ui_message: uiMessage('I’m creating the fixture', 'Created the fixture'), filePath: 'first.txt', content: 'first' },
      summary: uiMessage('I’m creating the fixture', 'Created the fixture')
    })
    assert.match(textContent(provider.requests[0].messages[0].content), /Call exactly one tool at a time/)
    assert.equal(provider.requests[2].messages.filter((message) => message.role === 'assistant').at(-1)?.toolCalls?.length, 1)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('enforces cur_task_state before tools and suppresses repeated updates', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      { text: 'I will skip the status.', toolCalls: [{ id: 'premature_write', name: 'write', arguments: { ui_message: uiMessage('I’m writing too early', 'Wrote too early'), filePath: 'result.txt', content: 'wrong' } }] },
      taskStateCompletion('initial_state'),
      taskStateCompletion('duplicate_state'),
      { text: 'This intermediate prose must stay hidden.', toolCalls: [{ id: 'accepted_write', name: 'write', arguments: { ui_message: uiMessage('I’m writing the result', 'Wrote the result'), filePath: 'result.txt', content: 'right' } }] },
      { text: 'Created the verified result.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []
    const persisted: LocalCompletionRequest['messages'][] = []
    let output = ''

    await new AgentRuntime(provider).run({
      threadId: 'thread-task-state-protocol',
      projectPath,
      messages: [{ role: 'user', content: 'Create the result.' }]
    }, (delta) => { output += delta }, (messages) => persisted.push(messages.map((message) => ({ ...message }))), (event) => events.push(event))

    assert.equal(readFileSync(join(projectPath, 'result.txt'), 'utf8'), 'right')
    assert.match(textContent(provider.requests[1].messages.at(-1)?.content), /cur_task_state is required first/i)
    assert.equal(events.filter((event) => event.type === 'progress-update' && event.summary === REQUIRED_TASK_STATE).length, 1)
    assert.ok(!events.some((event) => event.type === 'tool-call' && event.toolCallId === 'premature_write'))
    assert.ok(persisted.flat().every((message) => message.content !== 'This intermediate prose must stay hidden.'))
    assert.equal(output, 'Created the verified result.')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('keeps correcting missing cur_task_state without surfacing a protocol failure', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const prematureCalls = Array.from({ length: 5 }, (_, index): LocalCompletion => ({
      text: '',
      toolCalls: [{ id: `premature_${index}`, name: 'write', arguments: { ui_message: uiMessage('I’m writing too early', 'Wrote too early'), filePath: 'wrong.txt', content: 'wrong' } }]
    }))
    const provider = new ScriptedProvider([
      ...prematureCalls,
      taskStateCompletion(),
      { text: '', toolCalls: [{ id: 'accepted_write', name: 'write', arguments: { ui_message: uiMessage('I’m writing the result', 'Wrote the result'), filePath: 'result.txt', content: 'right' } }] },
      { text: 'Created the result.', toolCalls: [] }
    ])

    await new AgentRuntime(provider).run({
      threadId: 'thread-task-state-recovery',
      projectPath,
      messages: [{ role: 'user', content: 'Create the result.' }]
    }, () => {})

    assert.equal(existsSync(join(projectPath, 'wrong.txt')), false)
    assert.equal(readFileSync(join(projectPath, 'result.txt'), 'utf8'), 'right')
    assert.match(textContent(provider.requests[5].messages.at(-1)?.content), /cur_task_state is required first/i)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('requires a fresh cur_task_state after four completed agent tools', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const completedWrites = Array.from({ length: 4 }, (_, index): LocalCompletion => ({
      text: '',
      toolCalls: [{ id: `write_${index}`, name: 'write', arguments: { ui_message: uiMessage('I’m writing a phase file', 'Wrote a phase file'), filePath: `phase-${index}.txt`, content: `${index}` } }]
    }))
    const provider = new ScriptedProvider([
      taskStateCompletion('initial_state'),
      ...completedWrites,
      { text: '', toolCalls: [{ id: 'premature_fifth', name: 'write', arguments: { ui_message: uiMessage('I’m skipping the milestone', 'Skipped the milestone'), filePath: 'wrong.txt', content: 'wrong' } }] },
      taskStateCompletion('milestone_state', distinctTaskState(20)),
      { text: '', toolCalls: [{ id: 'accepted_fifth', name: 'write', arguments: { ui_message: uiMessage('I’m finishing the phase', 'Finished the phase'), filePath: 'final.txt', content: 'done' } }] },
      { text: 'Completed all phases.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-task-state-interval',
      projectPath,
      messages: [{ role: 'user', content: 'Complete a long multi-phase task.' }]
    }, () => {}, undefined, (event) => events.push(event))

    assert.equal(events.filter((event) => event.type === 'progress-update').length, 2)
    assert.equal(existsSync(join(projectPath, 'wrong.txt')), false)
    assert.equal(readFileSync(join(projectPath, 'final.txt'), 'utf8'), 'done')
    assert.match(textContent(provider.requests[6].messages.at(-1)?.content), /cur_task_state is required first/i)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('accepts up to twelve distinct cur_task_state tool calls and rejects a thirteenth', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      ...Array.from({ length: 13 }, (_, index) => taskStateCompletion(`state_${index}`, distinctTaskState(index))),
      { text: '', toolCalls: [{ id: 'accepted_write', name: 'write', arguments: { ui_message: uiMessage('I’m writing the result', 'Wrote the result'), filePath: 'result.txt', content: 'done' } }] },
      { text: 'Completed the difficult task.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-task-state-limit',
      projectPath,
      messages: [{ role: 'user', content: 'Complete a very difficult task.' }]
    }, () => {}, undefined, (event) => events.push(event))

    assert.equal(events.filter((event) => event.type === 'progress-update').length, 12)
    assert.match(textContent(provider.requests[13].messages.at(-1)?.content), /already has twelve cur_task_state updates/i)
    assert.equal(readFileSync(join(projectPath, 'result.txt'), 'utf8'), 'done')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('generates a UI message when a non-web tool omits one', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      taskStateCompletion(),
      { text: '', toolCalls: [{ id: 'missing_ui', name: 'write', arguments: { filePath: 'generated.txt', content: 'done' } }] },
      { text: '{"uim_prt":"I’m creating the requested file","uim_pat":"Created the requested file"}', toolCalls: [] },
      { text: 'Created the requested file.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-generated-ui',
      projectPath,
      messages: [{ role: 'user', content: 'Create the file.' }]
    }, () => {}, undefined, (event) => events.push(event))

    const toolCall = events.find((event) => event.type === 'tool-call' && event.toolCallId === 'missing_ui')
    assert.deepEqual(toolCall?.type === 'tool-call' ? toolCall.summary : undefined, uiMessage('I’m creating the requested file', 'Created the requested file'))
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('exploration subagents cannot receive file mutation tools', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-agent-'))
  try {
    const provider = new ScriptedProvider([
      taskStateCompletion(),
      { text: '', toolCalls: [{ id: 'task_1', name: 'task', arguments: { description: 'Inspect', prompt: 'Find files', subagentType: 'explore' } }] },
      { text: 'Found the relevant files.', toolCalls: [] },
      { text: 'Exploration complete.', toolCalls: [] }
    ])
    await new AgentRuntime(provider).run({ threadId: 'thread-2', projectPath, messages: [{ role: 'user', content: 'Explore this project.' }] }, () => {})
    const subagentRequest = provider.requests[2]
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
      taskStateCompletion(),
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
