import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRuntime, type AgentCompletionProvider, type AgentToolEvent } from '../src/main/agentRuntime.js'
import type { LocalCompletion, LocalCompletionRequest, LocalImageContentPart, LocalMessageContent } from '../src/main/localCompletionClient.js'

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

test('retries provider errors without placing hardcoded text in the task-state slot', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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
    assert.equal(events.filter((event) => event.type === 'progress-update').length, 0)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('co-batches progress, mutation, and verification in two provider turns', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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
    assert.match(system, /8–63 useful words/)
    assert.match(system, /Batch independent tools/)
    assert.doesNotMatch(system, /Call exactly one tool/)
    assert.doesNotMatch(system, /Qyrou-50M/)
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
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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

test('keeps local UI fallbacks inside tool rows without creating task-state progress', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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
    assert.equal(events.filter((event) => event.type === 'progress-update').length, 0)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('adds a transient cadence reminder without creating hardcoded progress or another request', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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
      { text: '', toolCalls: writes },
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
    assert.equal(events.filter((event) => event.type === 'progress-update').length, 0)
    assert.match(textContent(provider.requests[1].messages[0].content), /continuing after several actions without a recent visible update/)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('accepts only task states with at least eight Unicode-aware words', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    const sevenWords = 'Inspecting relevant files before making safe changes'
    const eightWords = 'Inspecting relevant files before making one safe change'
    const unicodeWords = '正在检查相关文件并确认安全修改方案然后继续验证最终结果'
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: 'short_state', name: 'cur_task_state', arguments: { message: sevenWords } },
          { id: 'write_one', name: 'write', arguments: { filePath: 'one.txt', content: 'one' } }
        ]
      },
      {
        text: '',
        toolCalls: [
          { id: 'minimum_state', name: 'cur_task_state', arguments: { message: eightWords } },
          { id: 'write_two', name: 'write', arguments: { filePath: 'two.txt', content: 'two' } }
        ]
      },
      {
        text: '',
        toolCalls: [
          { id: 'unicode_state', name: 'cur_task_state', arguments: { message: unicodeWords } },
          { id: 'write_three', name: 'write', arguments: { filePath: 'three.txt', content: 'three' } }
        ]
      },
      { text: 'Completed all work.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-minimum-state',
      projectPath,
      messages: [{ role: 'user', content: 'Complete the files.' }]
    }, () => {}, undefined, (event) => events.push(event))

    assert.deepEqual(events.filter((event) => event.type === 'progress-update').map((event) => event.type === 'progress-update' ? event.summary : ''), [
      eightWords,
      unicodeWords
    ])
    assert.equal(readFileSync(join(projectPath, 'three.txt'), 'utf8'), 'three')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('buffers provider deltas and paces only the confirmed final response', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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
        onDelta('One two three four five ')
        onDelta('six seven eight nine ten eleven.')
        return { text: 'One two three four five six seven eight nine ten eleven.', toolCalls: [] }
      }
    }
    let now = 0
    const emitted: Array<{ delta: string; at: number }> = []
    const waits: number[] = []
    const runtime = new AgentRuntime(provider, {
      wait: async (durationMs) => {
        waits.push(durationMs)
        now += durationMs
      }
    })

    await runtime.run({
      threadId: 'thread-stream',
      projectPath,
      messages: [{ role: 'user', content: 'Create the streamed result.' }]
    }, (delta) => emitted.push({ delta, at: now }))

    assert.equal(requests.length, 2)
    assert.equal(emitted.map((event) => event.delta).join(''), 'One two three four five six seven eight nine ten eleven.')
    assert.equal(emitted.length, 11)
    assert.equal(emitted[0]?.at, 0)
    assert.equal(emitted.at(-1)?.at, 50)
    assert.deepEqual(waits, Array.from({ length: 10 }, () => 5))
    assert.equal(readFileSync(join(projectPath, 'streamed.txt'), 'utf8'), 'done')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('preserves Unicode, Markdown, code, and whitespace during final playback', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    const finalText = '完成了 世界。\n\n**Result:**\n\n```ts\nconst value = 1\n```\n'
    const provider = new ScriptedProvider([{ text: finalText, toolCalls: [] }])
    const deltas: string[] = []
    const runtime = new AgentRuntime(provider, {
      wait: async () => {}
    })

    await runtime.run({
      threadId: 'thread-playback-content',
      projectPath,
      messages: [{ role: 'user', content: 'Return formatted output.' }]
    }, (delta) => deltas.push(delta))

    assert.equal(deltas.join(''), finalText)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('discards streamed prose from a mixed tool turn and executes its side effects', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    const requests: LocalCompletionRequest[] = []
    const persisted: LocalCompletionRequest['messages'][] = []
    let index = 0
    const provider: AgentCompletionProvider = {
      async complete(): Promise<LocalCompletion> {
        throw new Error('Streaming provider should not use complete')
      },
      async stream(request, onDelta): Promise<LocalCompletion> {
        requests.push(request)
        index += 1
        if (index === 1) {
          onDelta('I found the issue. Let me fix it now.')
          return {
            text: 'I found the issue. Let me fix it now.',
            toolCalls: [{ id: 'late_write', name: 'write', arguments: { filePath: 'fixed.txt', content: 'fixed' } }]
          }
        }
        onDelta('Implemented the confirmed fix.')
        return { text: 'Implemented the confirmed fix.', toolCalls: [] }
      }
    }
    const deltas: string[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-mixed-stream',
      projectPath,
      messages: [{ role: 'user', content: 'Create a file.' }]
    }, (delta) => deltas.push(delta), (messages) => persisted.push(messages.map((message) => ({ ...message }))))

    assert.equal(requests.length, 2)
    assert.equal(deltas.join(''), 'Implemented the confirmed fix.')
    assert.equal(readFileSync(join(projectPath, 'fixed.txt'), 'utf8'), 'fixed')
    assert.ok(persisted.flat().every((message) => message.content !== 'I found the issue. Let me fix it now.'))
    const mixedTurn = persisted.flat().find((message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.id === 'late_write'))
    assert.equal(mixedTurn?.content, null)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('keeps cur_task_state as the only progress source in a mixed tool turn', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    let index = 0
    const provider: AgentCompletionProvider = {
      async complete(): Promise<LocalCompletion> {
        throw new Error('Streaming provider should not use complete')
      },
      async stream(_request, onDelta): Promise<LocalCompletion> {
        index += 1
        if (index === 1) {
          onDelta('Here is my final answer before I make changes.')
          return {
            text: 'Here is my final answer before I make changes.',
            toolCalls: [
              { id: 'state', name: 'cur_task_state', arguments: { message: TASK_STATE } },
              { id: 'first_write', name: 'write', arguments: { filePath: 'first.txt', content: 'first' } },
              { id: 'second_write', name: 'write', arguments: { filePath: 'second.txt', content: 'second' } }
            ]
          }
        }
        return { text: 'Completed both requested changes.', toolCalls: [] }
      }
    }
    const deltas: string[] = []
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-mixed-progress',
      projectPath,
      messages: [{ role: 'user', content: 'Create both files.' }]
    }, (delta) => deltas.push(delta), undefined, (event) => events.push(event))

    assert.equal(deltas.join(''), 'Completed both requested changes.')
    assert.deepEqual(events.filter((event) => event.type === 'progress-update').map((event) => event.type === 'progress-update' ? event.summary : ''), [TASK_STATE])
    assert.equal(readFileSync(join(projectPath, 'first.txt'), 'utf8'), 'first')
    assert.equal(readFileSync(join(projectPath, 'second.txt'), 'utf8'), 'second')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('discards streamed prose when healed tool markup supplies the action', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    let index = 0
    const mixedText = 'I will create it now. <tool_call>{"name":"write","arguments":{"filePath":"healed.txt","content":"healed"}}</tool_call>'
    const provider: AgentCompletionProvider = {
      async complete(): Promise<LocalCompletion> {
        throw new Error('Streaming provider should not use complete')
      },
      async stream(_request, onDelta): Promise<LocalCompletion> {
        index += 1
        if (index === 1) {
          onDelta(mixedText)
          return { text: mixedText, toolCalls: [] }
        }
        return { text: 'Created the healed result.', toolCalls: [] }
      }
    }
    const deltas: string[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-healed-stream',
      projectPath,
      messages: [{ role: 'user', content: 'Create the healed file.' }]
    }, (delta) => deltas.push(delta))

    assert.equal(deltas.join(''), 'Created the healed result.')
    assert.equal(readFileSync(join(projectPath, 'healed.txt'), 'utf8'), 'healed')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('does not display a streamed intent-only response before recovery', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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
        if (index === 1) {
          onDelta('Let me fix that now.')
          return { text: 'Let me fix that now.', toolCalls: [] }
        }
        return { text: 'The work is already complete.', toolCalls: [] }
      }
    }
    const deltas: string[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-streamed-intent',
      projectPath,
      messages: [{ role: 'user', content: 'Finish the work.' }]
    }, (delta) => deltas.push(delta))

    assert.equal(requests.length, 2)
    assert.equal(deltas.join(''), 'The work is already complete.')
    assert.match(textContent(requests[1].messages.at(-1)?.content), /only described future actions/)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('cancels final-answer playback without emitting later deltas', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    const controller = new AbortController()
    const provider: AgentCompletionProvider = {
      async complete(): Promise<LocalCompletion> {
        throw new Error('Streaming provider should not use complete')
      },
      async stream(_request, onDelta): Promise<LocalCompletion> {
        onDelta('One two three four five.')
        return { text: 'One two three four five.', toolCalls: [] }
      }
    }
    const deltas: string[] = []
    const runtime = new AgentRuntime(provider, {
      wait: async (_durationMs, signal) => {
        controller.abort(new Error('Playback cancelled'))
        signal?.throwIfAborted()
      }
    })

    await assert.rejects(runtime.run({
      threadId: 'thread-cancelled-playback',
      projectPath,
      signal: controller.signal,
      messages: [{ role: 'user', content: 'Respond with several words.' }]
    }, (delta) => deltas.push(delta)), /Playback cancelled/)

    assert.deepEqual(deltas, ['One '])
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('cancellation during a buffered tool response prevents side effects', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    const controller = new AbortController()
    const provider: AgentCompletionProvider = {
      async complete(): Promise<LocalCompletion> {
        throw new Error('Streaming provider should not use complete')
      },
      async stream(_request, onDelta): Promise<LocalCompletion> {
        onDelta('I will write this file now.')
        controller.abort(new Error('Provider stream cancelled'))
        return {
          text: 'I will write this file now.',
          toolCalls: [{ id: 'cancelled_write', name: 'write', arguments: { filePath: 'cancelled.txt', content: 'unsafe' } }]
        }
      }
    }
    const deltas: string[] = []

    await assert.rejects(new AgentRuntime(provider).run({
      threadId: 'thread-cancelled-tool-stream',
      projectPath,
      signal: controller.signal,
      messages: [{ role: 'user', content: 'Create a file.' }]
    }, (delta) => deltas.push(delta)), /Provider stream cancelled/)

    assert.deepEqual(deltas, [])
    assert.equal(existsSync(join(projectPath, 'cancelled.txt')), false)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('exploration subagents cannot receive file mutation tools', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
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

test('injects a view_image result as an image message when vision is available', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    writeFileSync(join(projectPath, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]))
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: 'view', name: 'view_image', arguments: { ui_message: uiMessage('Inspecting the screenshot', 'Inspected the screenshot'), path: 'shot.png' } }
        ]
      },
      { text: 'The screenshot was inspected.', toolCalls: [] }
    ])
    const persisted: LocalCompletionRequest['messages'][] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-vision',
      projectPath,
      visionAvailable: true,
      messages: [{ role: 'user', content: 'Look at the screenshot.' }]
    }, () => {}, (messages) => persisted.push(messages.map((message) => ({ ...message }))))

    const imageRequest = provider.requests[1]
    const imageUser = imageRequest.messages.find((message) =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url')
    )
    assert.ok(imageUser, 'expected an injected image user message')
    const parts = imageUser.content as LocalImageContentPart[]
    assert.equal(parts.length, 1)
    assert.ok(parts[0].image_url.url.startsWith('data:image/png;base64,'))
    const persistedImage = persisted.flat().find((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'))
    assert.ok(persistedImage, 'expected the injected image message in persisted state')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('skips image injection when vision is unavailable', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    writeFileSync(join(projectPath, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]))
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: 'view', name: 'view_image', arguments: { ui_message: uiMessage('Inspecting the screenshot', 'Inspected the screenshot'), path: 'shot.png' } }
        ]
      },
      { text: 'The screenshot was inspected.', toolCalls: [] }
    ])

    await new AgentRuntime(provider).run({
      threadId: 'thread-no-vision',
      projectPath,
      visionAvailable: false,
      messages: [{ role: 'user', content: 'Look at the screenshot.' }]
    }, () => {}, undefined, () => {})

    const toolMessages = provider.requests[1].messages.filter((message) => message.role === 'tool')
    assert.equal(toolMessages.length, 1)
    assert.match(textContent(toolMessages[0].content), /Loaded image for review/)
    assert.ok(provider.requests[1].messages.every((message) =>
      message.role !== 'user' ||
      !Array.isArray(message.content) ||
      !message.content.some((part) => part.type === 'image_url')
    ))
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('injects a view_screenshot result as an image message', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: 'capture', name: 'view_screenshot', arguments: { ui_message: uiMessage('Capturing the browser', 'Captured the browser') } }
        ]
      },
      { text: 'The page renders correctly.', toolCalls: [] }
    ])

    await new AgentRuntime(provider).run({
      threadId: 'thread-screenshot',
      projectPath,
      visionAvailable: true,
      captureScreenshot: async () => 'data:image/png;base64,U0NST1Q=',
      messages: [{ role: 'user', content: 'Check the browser page.' }]
    }, () => {}, undefined, () => {})

    const imageRequest = provider.requests[1]
    const imageUser = imageRequest.messages.find((message) =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url')
    )
    assert.ok(imageUser, 'expected an injected screenshot message')
    const parts = imageUser.content as LocalImageContentPart[]
    assert.equal(parts[0].image_url.url, 'data:image/png;base64,U0NST1Q=')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})
