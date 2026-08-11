import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRuntime, type AgentCompletionProvider, type AgentToolEvent } from '../src/main/agentRuntime.js'
import type { LocalCompletion, LocalCompletionRequest, LocalImageContentPart, LocalMessageContent } from '../src/main/localCompletionClient.js'

const textContent = (content: LocalMessageContent | undefined): string => typeof content === 'string' ? content : ''
const uiMessage = (uim_prt: string, uim_pat: string): { uim_prt: string; uim_pat: string } => ({ uim_prt, uim_pat })
const TASK_STATE = 'I’m inspecting the relevant files before making the smallest safe and verifiable change.'

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

test('generates a title with the isolated prompt and selected model settings', async () => {
  const provider = new ScriptedProvider([{
    text: '"Debugging Postgres Connection Timeout."\nIgnored explanation',
    toolCalls: []
  }])
  const runtime = new AgentRuntime(provider)

  const title = await runtime.generateTitle({
    threadId: 'thread-title',
    projectPath: 'unused',
    messages: [
      { role: 'system', content: 'Agent instructions that must not enter title generation.' },
      { role: 'user', content: 'Why does my Postgres connection keep timing out?' }
    ],
    enableThinking: true,
    temperature: 0.7,
    topP: 0.8,
    topK: 24,
    minP: 0.1,
    presencePenalty: 0.2,
    repetitionPenalty: 1.1,
    maxTokens: 4096
  })

  assert.equal(title, 'Debugging Postgres Connection Timeout')
  assert.equal(provider.requests.length, 1)
  assert.match(textContent(provider.requests[0].messages[0].content), /title-generation engine/)
  assert.match(textContent(provider.requests[0].messages[0].content), /agentic coding platform/)
  assert.equal(provider.requests[0].messages[1].content, 'Why does my Postgres connection keep timing out?')
  assert.equal(provider.requests[0].messages.length, 2)
  assert.equal(provider.requests[0].enableThinking, false)
  assert.equal(provider.requests[0].temperature, 0.7)
  assert.equal(provider.requests[0].topP, 0.8)
  assert.equal(provider.requests[0].topK, 24)
  assert.equal(provider.requests[0].minP, 0.1)
  assert.equal(provider.requests[0].presencePenalty, 0.2)
  assert.equal(provider.requests[0].repetitionPenalty, 1.1)
  assert.equal(provider.requests[0].maxTokens, 36)
  assert.equal(provider.requests[0].tools, undefined)
  assert.equal(provider.requests[0].toolChoice, 'none')
  assert.equal(provider.requests[0].suppressReasoningPrompt, true)
  assert.equal(provider.requests[0].suppressReasoning, true)
})

test('derives a descriptive title from the request when the model returns no visible title', async () => {
  const provider = new ScriptedProvider([{ text: '', reasoningText: 'Hidden title reasoning', toolCalls: [] }])
  const title = await new AgentRuntime(provider).generateTitle({
    threadId: 'thread-title-fallback',
    projectPath: 'unused',
    messages: [{ role: 'user', content: 'inspect repository files for photosynthesis and car topics' }],
    enableThinking: true
  })

  assert.equal(title, 'Inspect Repository Files For Photosynthesis')
})

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
    assert.match(system, /cur_task_state is required/)
    assert.match(system, /12–63 useful words/)
    assert.match(system, /roughly 60 words/)
    assert.match(system, /above about 25 words/)
    assert.match(system, /Batch independent tools/)
    assert.doesNotMatch(system, /Call exactly one tool/)
    assert.doesNotMatch(system, /Qyrou-50M/)
    assert.ok(system.length + JSON.stringify(provider.requests[0].tools).length < 32_000)
    const persistedAssistant = persisted.flat().find((message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.id === 'write'))
    assert.deepEqual(persistedAssistant?.toolCalls?.map((call) => call.id), ['write', 'read'])
    assert.ok(persisted.flat().every((message) => message.name !== 'cur_task_state'))
    assert.deepEqual(events.find((event) => event.type === 'progress-update'), {
      type: 'progress-update',
      progressId: 'state',
      summary: TASK_STATE,
      source: 'model'
    })
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

test('creates stable fallback progress before a tool when the model omits task state', async () => {
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
    const progressIndex = events.findIndex((event) => event.type === 'progress-update')
    const toolIndex = events.findIndex((event) => event.type === 'tool-call')
    assert.ok(progressIndex >= 0 && progressIndex < toolIndex)
    assert.deepEqual(events[progressIndex], {
      type: 'progress-update',
      progressId: 'fallback:missing_ui',
      summary: 'I’m using write now. I’ll use that result to continue your request carefully and accurately.',
      source: 'fallback'
    })
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('rejects standalone task-state control calls and requires an associated action', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ id: 'orphan_state', name: 'cur_task_state', arguments: { message: TASK_STATE } }] },
      { text: '', toolCalls: [{ id: 'write_after_state', name: 'write', arguments: { filePath: 'associated.txt', content: 'done' } }] },
      { text: 'Created the associated result.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-orphan-task-state',
      projectPath,
      messages: [{ role: 'user', content: 'Create the associated result.' }]
    }, () => {}, undefined, (event) => events.push(event))

    assert.equal(provider.requests.length, 3)
    assert.match(textContent(provider.requests[1].messages.at(-1)?.content), /must accompany at least one action tool/)
    assert.deepEqual(events.filter((event) => event.type === 'progress-update').map((event) => event.type === 'progress-update' ? event.source : ''), ['fallback'])
    assert.equal(readFileSync(join(projectPath, 'associated.txt'), 'utf8'), 'done')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('rejects plain progress prose and repairs with structured tool calls', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    const provider = new ScriptedProvider([
      { text: 'Thinking', toolCalls: [] },
      {
        text: '',
        toolCalls: [
          { id: 'structured_state', name: 'cur_task_state', arguments: { message: TASK_STATE } },
          { id: 'structured_write', name: 'write', arguments: { filePath: 'structured.txt', content: 'done' } }
        ]
      },
      { text: 'Created the structured result.', toolCalls: [] }
    ])
    const events: AgentToolEvent[] = []
    let output = ''

    await new AgentRuntime(provider).run({
      threadId: 'thread-control-prose',
      projectPath,
      messages: [{ role: 'user', content: 'Create the structured result.' }]
    }, (delta) => { output += delta }, undefined, (event) => {
      events.push(event)
      if (event.type === 'response-reset') output = ''
    })

    assert.equal(provider.requests.length, 3)
    assert.match(textContent(provider.requests[1].messages.at(-1)?.content), /structured function-call channel/)
    assert.equal(output, 'Created the structured result.')
    assert.deepEqual(events.filter((event) => event.type === 'progress-update').map((event) => event.type === 'progress-update' ? event.progressId : ''), ['structured_state'])
    assert.equal(readFileSync(join(projectPath, 'structured.txt'), 'utf8'), 'done')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('personalizes web fallback progress with the search subject', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  const controller = new AbortController()
  try {
    const provider = new ScriptedProvider([{
      text: '',
      toolCalls: [{ id: 'search_apple', name: 'web_search', arguments: { query: 'who will become the next Apple CEO?' } }]
    }])
    const events: AgentToolEvent[] = []

    await assert.rejects(new AgentRuntime(provider).run({
      threadId: 'thread-personalized-web-fallback',
      projectPath,
      signal: controller.signal,
      messages: [{ role: 'user', content: 'Who is going to be the new Apple CEO?' }]
    }, () => {}, undefined, (event) => {
      events.push(event)
      if (event.type === 'progress-update') controller.abort(new Error('Stop before web execution'))
    }), /Stop before web execution/)

    assert.deepEqual(events.filter((event) => event.type === 'progress-update'), [{
      type: 'progress-update',
      progressId: 'fallback:search_apple',
      summary: 'Let me search the web for reliable, up-to-date information about who will become the next Apple CEO before I answer.',
      source: 'fallback'
    }])
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('guarantees fallback progress initially and again before the seventh action', async () => {
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
    assert.deepEqual(events.filter((event) => event.type === 'progress-update'), [
      { type: 'progress-update', progressId: 'fallback:write_0', summary: 'I’m writing phase file 0 now. I’ll use that result to continue your request carefully and accurately.', source: 'fallback' },
      { type: 'progress-update', progressId: 'fallback:write_6', summary: 'I’m writing phase file 6 now. I’ll use that result to continue your request carefully and accurately.', source: 'fallback' }
    ])
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('accepts only task states with at least twelve Unicode-aware words', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    const elevenWords = 'I am inspecting relevant files before making one safe verified change'
    const twelveWords = 'I am inspecting the relevant files before making one safe verified change'
    const unicodeWords = '正在检查相关文件并确认安全修改方案然后继续验证最终结果'
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: 'short_state', name: 'cur_task_state', arguments: { message: elevenWords } },
          { id: 'write_one', name: 'write', arguments: { filePath: 'one.txt', content: 'one' } }
        ]
      },
      {
        text: '',
        toolCalls: [
          { id: 'minimum_state', name: 'cur_task_state', arguments: { message: twelveWords } },
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
      'I’m using write now. I’ll use that result to continue your request carefully and accurately.',
      twelveWords,
      unicodeWords
    ])
    assert.equal(readFileSync(join(projectPath, 'three.txt'), 'utf8'), 'three')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('forwards confirmed final response deltas at provider cadence', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    const requests: LocalCompletionRequest[] = []
    const emitted: string[] = []
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
        assert.deepEqual(emitted, ['One two three four five '])
        onDelta('six seven eight nine ten eleven.')
        return { text: 'One two three four five six seven eight nine ten eleven.', toolCalls: [] }
      }
    }
    const runtime = new AgentRuntime(provider)

    await runtime.run({
      threadId: 'thread-stream',
      projectPath,
      messages: [{ role: 'user', content: 'Create the streamed result.' }]
    }, (delta) => emitted.push(delta))

    assert.equal(requests.length, 2)
    assert.deepEqual(emitted, ['One two three four five ', 'six seven eight nine ten eleven.'])
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
    const runtime = new AgentRuntime(provider)

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
    let visible = ''

    await new AgentRuntime(provider).run({
      threadId: 'thread-mixed-stream',
      projectPath,
      messages: [{ role: 'user', content: 'Create a file.' }]
    }, (delta) => { visible += delta }, (messages) => persisted.push(messages.map((message) => ({ ...message }))), (event) => {
      if (event.type === 'response-reset') visible = ''
    })

    assert.equal(requests.length, 2)
    assert.equal(visible, 'Implemented the confirmed fix.')
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
    let visible = ''
    const events: AgentToolEvent[] = []

    await new AgentRuntime(provider).run({
      threadId: 'thread-mixed-progress',
      projectPath,
      messages: [{ role: 'user', content: 'Create both files.' }]
    }, (delta) => { visible += delta }, undefined, (event) => {
      events.push(event)
      if (event.type === 'response-reset') visible = ''
    })

    assert.equal(visible, 'Completed both requested changes.')
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
    let visible = ''

    await new AgentRuntime(provider).run({
      threadId: 'thread-healed-stream',
      projectPath,
      messages: [{ role: 'user', content: 'Create the healed file.' }]
    }, (delta) => { visible += delta }, undefined, (event) => {
      if (event.type === 'response-reset') visible = ''
    })

    assert.equal(visible, 'Created the healed result.')
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
    let visible = ''

    await new AgentRuntime(provider).run({
      threadId: 'thread-streamed-intent',
      projectPath,
      messages: [{ role: 'user', content: 'Finish the work.' }]
    }, (delta) => { visible += delta }, undefined, (event) => {
      if (event.type === 'response-reset') visible = ''
    })

    assert.equal(requests.length, 2)
    assert.equal(visible, 'The work is already complete.')
    assert.match(textContent(requests[1].messages.at(-1)?.content), /only contained progress or described future actions/)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('preserves provider output emitted before cancellation', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'qyroucode-agent-'))
  try {
    const controller = new AbortController()
    const provider: AgentCompletionProvider = {
      async complete(): Promise<LocalCompletion> {
        throw new Error('Streaming provider should not use complete')
      },
      async stream(_request, onDelta): Promise<LocalCompletion> {
        onDelta('One ')
        controller.abort(new Error('Provider stream cancelled'))
        throw controller.signal.reason
      }
    }
    const deltas: string[] = []
    const runtime = new AgentRuntime(provider)

    await assert.rejects(runtime.run({
      threadId: 'thread-cancelled-playback',
      projectPath,
      signal: controller.signal,
      messages: [{ role: 'user', content: 'Respond with several words.' }]
    }, (delta) => deltas.push(delta)), /Provider stream cancelled/)

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
    let visible = ''

    await assert.rejects(new AgentRuntime(provider).run({
      threadId: 'thread-cancelled-tool-stream',
      projectPath,
      signal: controller.signal,
      messages: [{ role: 'user', content: 'Create a file.' }]
    }, (delta) => { visible += delta }, undefined, (event) => {
      if (event.type === 'response-reset') visible = ''
    }), /Provider stream cancelled/)

    assert.equal(visible, '')
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
