import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import type { LocalChatMessage, LocalCompletion, LocalCompletionRequest, LocalToolCall } from './localCompletionClient'
import type { FileChangeDisplay, TodoDisplay, ToolUiMessage } from '../shared/chat'
import type { AgentModelProvenance } from '../shared/agent'
import { DEFAULT_NATIVE_LANGUAGE, type NativeLanguage } from '../shared/settings'
import { COMPACTION_SYSTEM_PROMPT, buildAgentSystemPrompt } from './agentPrompt'
import { AgentToolbox, TASK_STATE_TOOL_NAME, type AgentTaskRequest, type ToolboxImage } from './agentTools'
import type { AgentTerminalController } from './terminalManager'
import { parseHealedToolCalls, stripToolCallMarkup } from './toolCallParser'

export interface AgentCompletionProvider {
  complete(request: LocalCompletionRequest): Promise<LocalCompletion>
  stream?(request: LocalCompletionRequest, onDelta: (delta: string) => void): Promise<LocalCompletion>
}

export interface AgentRunRequest extends Omit<LocalCompletionRequest, 'signal' | 'tools' | 'toolChoice'> {
  threadId: string
  projectPath: string
  signal?: AbortSignal
  model?: AgentModelProvenance
  nativeLanguage?: NativeLanguage
  terminalController?: AgentTerminalController
  visionAvailable?: boolean
  captureScreenshot?: () => Promise<string>
}

export type AgentStateListener = (messages: readonly LocalChatMessage[]) => void

export type AgentToolEvent =
  | { type: 'tool-call'; toolCallId: string; name: string; arguments: Record<string, unknown>; summary?: ToolUiMessage }
  | { type: 'tool-result'; toolCallId: string; result: string; filePath?: string }
  | { type: 'tool-error'; toolCallId: string; error: string }
  | { type: 'files-changed'; files: FileChangeDisplay[] }
  | { type: 'progress-update'; summary: string }
  | { type: 'todos-updated'; todos: TodoDisplay[] }

const MAX_AGENT_STEPS = 50
const MAX_SUBAGENT_DEPTH = 2
const COMPACTION_CHARACTER_THRESHOLD = 90_000
const COMPACTION_RECENT_MESSAGES = 12
const COMPACTION_MAX_TOKENS = 2_048
const FINAL_MAX_TOKENS = 8_192
const MAX_INTENT_REPROMPTS = 3
const MAX_PROVIDER_RETRIES = 3
const IMAGE_CONTEXT_CHARACTER_WEIGHT = 64
const TASK_STATE_MIN_WORDS = 8
const TASK_STATE_MAX_WORDS = 63
const TASK_STATE_MAX_CHARACTERS = 480
const TASK_STATE_ACTION_INTERVAL = 6
const TASK_STATE_SIMILARITY_THRESHOLD = 0.55
const MAX_PARALLEL_READ_TOOLS = 4
const FINAL_RESPONSE_WORDS_PER_SECOND = 200
const FINAL_RESPONSE_WORD_INTERVAL_MS = 1_000 / FINAL_RESPONSE_WORDS_PER_SECOND
const PARALLEL_TOOL_NAMES = new Set(['read', 'list', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_read', 'skill', 'terminal_list', 'terminal_read', 'terminal_status', 'view_file', 'view_text', 'view_json', 'view_yaml', 'view_csv', 'view_pdf', 'view_docx', 'view_pptx', 'view_xlsx', 'view_log', 'view_hex', 'view_archive', 'view_env', 'view_image'])
const INTENT_PATTERN = /\b(?:i(?:'|’)ll|i will|let me|i am going to|first,? i|next,? i|here(?:'|’)s (?:my|the) plan)\b/i
const TASK_STATE_REMINDER = 'Agentic work is continuing after several actions without a recent visible update. If more tools are needed, include one fresh cur_task_state of 8–63 words in this same response alongside the actions it describes. Do not call it alone, repeat an earlier update, or add one when returning the final answer.'

interface AgentRuntimeTiming {
  wait(durationMs: number, signal?: AbortSignal): Promise<void>
}

function waitFor(durationMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolvePromise()
    }, durationMs)
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const reason = signal?.reason
      rejectPromise(reason instanceof Error ? reason : new Error('Agent completion was cancelled'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

const DEFAULT_AGENT_RUNTIME_TIMING: AgentRuntimeTiming = {
  wait: waitFor
}

function messageContentCharacters(content: LocalChatMessage['content']): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((total, part) => total + (part.type === 'text' ? part.text.length : IMAGE_CONTEXT_CHARACTER_WEIGHT), 0)
}

function contentCharacters(messages: readonly LocalChatMessage[]): number {
  return messages.reduce((total, message) => total + messageContentCharacters(message.content) + (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0), 0)
}

function contentForCompaction(content: LocalChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => part.type === 'text' ? part.text : '[attached image]').join('\n')
}

function callKey(call: LocalToolCall): string {
  return `${call.name}:${JSON.stringify(call.arguments, Object.keys(call.arguments).sort())}`
}

function additionalSystemInstructions(messages: readonly LocalChatMessage[]): string[] {
  return messages.flatMap((message) => message.role === 'system' && typeof message.content === 'string' && message.content ? [message.content] : [])
}

function conversationMessages(messages: readonly LocalChatMessage[]): LocalChatMessage[] {
  return messages.filter((message) => message.role !== 'system').map((message) => ({ ...message }))
}

function isIntentWithoutAction(value: string): boolean {
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length < 2_000 && INTENT_PATTERN.test(normalized)
}

interface TaskStateWord {
  index: number
  segment: string
}

function taskStateWords(value: string): TaskStateWord[] {
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
    return [...segmenter.segment(value)].flatMap((part) => part.isWordLike ? [{ index: part.index, segment: part.segment }] : [])
  } catch {
    return [...value.matchAll(/\S+/gu)].map((match) => ({ index: match.index, segment: match[0] }))
  }
}

function finalResponseUnitEnds(value: string): number[] {
  const words = taskStateWords(value)
  return words.map((_word, index) => words[index + 1]?.index ?? value.length)
}

async function playFinalResponse(
  text: string,
  onDelta: (delta: string) => void,
  signal: AbortSignal | undefined,
  timing: AgentRuntimeTiming
): Promise<void> {
  signal?.throwIfAborted()
  const unitEnds = finalResponseUnitEnds(text)
  if (!unitEnds.length) {
    if (text) onDelta(text)
    return
  }
  let emittedEnd = 0
  for (const [index, unitEnd] of unitEnds.entries()) {
    signal?.throwIfAborted()
    if (index > 0) await timing.wait(FINAL_RESPONSE_WORD_INTERVAL_MS, signal)
    onDelta(text.slice(emittedEnd, unitEnd))
    emittedEnd = unitEnd
  }
}

function normalizedTaskState(value: unknown): string {
  if (typeof value !== 'string') return ''
  const paragraph = value.replace(/\s+/g, ' ').trim()
  if (!paragraph) return ''
  const words = taskStateWords(paragraph)
  if (words.length < TASK_STATE_MIN_WORDS) return ''
  const lastWord = words[Math.min(words.length, TASK_STATE_MAX_WORDS) - 1]
  const wordBounded = words.length <= TASK_STATE_MAX_WORDS
    ? paragraph
    : paragraph.slice(0, lastWord.index + lastWord.segment.length).trimEnd()
  if (wordBounded.length <= TASK_STATE_MAX_CHARACTERS) return wordBounded
  const shortened = wordBounded.slice(0, TASK_STATE_MAX_CHARACTERS).trimEnd()
  const boundary = shortened.lastIndexOf(' ')
  const characterBounded = boundary > TASK_STATE_MAX_CHARACTERS / 2 ? shortened.slice(0, boundary) : shortened
  return taskStateWords(characterBounded).length >= TASK_STATE_MIN_WORDS ? characterBounded : ''
}

function taskStatesAreSimilar(left: string, right: string): boolean {
  const words = (value: string): Set<string> => new Set(value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((word) => word.length > 2))
  const leftWords = words(left)
  const rightWords = words(right)
  if (!leftWords.size || !rightWords.size) return left.trim().toLowerCase() === right.trim().toLowerCase()
  let shared = 0
  for (const word of leftWords) if (rightWords.has(word)) shared += 1
  return shared / Math.min(leftWords.size, rightWords.size) >= TASK_STATE_SIMILARITY_THRESHOLD
}

function persistedMessages(messages: readonly LocalChatMessage[]): LocalChatMessage[] {
  const hiddenCallIds = new Set(messages.flatMap((message) => message.role === 'assistant'
    ? (message.toolCalls ?? []).filter((call) => call.name === TASK_STATE_TOOL_NAME).map((call) => call.id)
    : []))
  return messages.flatMap((message) => {
    if (message.role === 'tool' && message.toolCallId && hiddenCallIds.has(message.toolCallId)) return []
    if (message.role !== 'assistant' || !message.toolCalls?.some((call) => call.name === TASK_STATE_TOOL_NAME)) return [{ ...message }]
    const toolCalls = message.toolCalls.filter((call) => call.name !== TASK_STATE_TOOL_NAME)
    if (!toolCalls.length && !message.content) return []
    return [{ ...message, toolCalls: toolCalls.length ? toolCalls : undefined }]
  })
}

function requestNeedsQyrouContext(messages: readonly LocalChatMessage[]): boolean {
  return messages.some((message) => message.role === 'user' && typeof message.content === 'string' && /\b(?:qyrou\s*labs|qyrou\s*code|hugging\s*face\s+organization|qyrou-(?:50m|mini|router|vl|a2a))\b/i.test(message.content))
}

function compactUiMessage(value: unknown): string {
  return typeof value === 'string' ? value.trim().split(/\s+/).slice(0, 5).join(' ') : ''
}

function deterministicUiMessage(name: string): ToolUiMessage {
  const label = name.replaceAll('_', ' ')
  return { uim_prt: `Using ${label}`, uim_pat: `Used ${label}` }
}

function uiMessageForCall(call: LocalToolCall): ToolUiMessage | undefined {
  if (call.name === TASK_STATE_TOOL_NAME || call.name === 'web_search' || call.name === 'web_fetch') return undefined
  const supplied = call.arguments.ui_message && typeof call.arguments.ui_message === 'object' && !Array.isArray(call.arguments.ui_message)
    ? call.arguments.ui_message as Partial<ToolUiMessage>
    : undefined
  const present = compactUiMessage(supplied?.uim_prt)
  const past = compactUiMessage(supplied?.uim_pat)
  return present && past ? { uim_prt: present, uim_pat: past } : deterministicUiMessage(call.name)
}

interface ToolExecution {
  call: LocalToolCall
  result: string
  error?: string
  filePath?: string
  images?: ToolboxImage[]
}

function modelSettings(request: AgentRunRequest, enableThinking = request.enableThinking): Omit<LocalCompletionRequest, 'messages'> {
  return {
    enableThinking,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    topP: request.topP,
    topK: request.topK,
    minP: request.minP,
    presencePenalty: request.presencePenalty,
    repetitionPenalty: request.repetitionPenalty,
    signal: request.signal
  }
}

function retainedReasoning(request: AgentRunRequest, reasoningText: string | undefined): string | undefined {
  if (!reasoningText) return undefined
  if (!request.model || request.model.source === 'local') return reasoningText
  return request.model.reasoningRetention === 'retain' ? reasoningText : undefined
}

function modelProvenance(request: AgentRunRequest): { model: AgentModelProvenance } | Record<string, never> {
  return request.model ? { model: request.model } : {}
}

export class AgentRuntime {
  constructor(
    private readonly provider: AgentCompletionProvider,
    private readonly timing: AgentRuntimeTiming = DEFAULT_AGENT_RUNTIME_TIMING
  ) {}

  async run(request: AgentRunRequest, onDelta: (delta: string) => void, onState?: AgentStateListener, onToolEvent?: (event: AgentToolEvent) => void): Promise<void> {
    const startedAt = Date.now()
    const modifiedFiles = new Set<string>()
    const originalFiles = new Map<string, string | null>()
    const visibleTaskStates: string[] = []
    let filesEmitted = false
    const emitFiles = (): void => {
      if (filesEmitted) return
      filesEmitted = true
      const files = summarizeFileChanges(request.projectPath, modifiedFiles, originalFiles)
      if (files.length > 0) onToolEvent?.({ type: 'files-changed', files })
    }
    let final: { text: string; streamed: boolean } | undefined
    try {
      final = await this.runInternal(request, 0, false, onState, onToolEvent, modifiedFiles, originalFiles, visibleTaskStates, (delta) => {
        emitFiles()
        onDelta(delta)
      })
    } finally {
      emitFiles()
      if (process.env.NODE_ENV === 'development') console.debug('[AgentRuntime] run', { durationMs: Date.now() - startedAt, modifiedFiles: modifiedFiles.size })
    }
    if (final && !final.streamed && final.text) onDelta(final.text)
  }

  private async runInternal(request: AgentRunRequest, depth: number, readOnly: boolean, onState?: AgentStateListener, onToolEvent?: (event: AgentToolEvent) => void, modifiedFiles?: Set<string>, originalFiles?: Map<string, string | null>, visibleTaskStates: string[] = [], onFinalDelta?: (delta: string) => void): Promise<{ text: string; streamed: boolean }> {
    request.signal?.throwIfAborted()
    const systemPrompt = buildAgentSystemPrompt({
      projectPath: request.projectPath,
      additionalInstructions: additionalSystemInstructions(request.messages),
      nativeLanguage: request.nativeLanguage ?? DEFAULT_NATIVE_LANGUAGE,
      readOnly,
      includeQyrouContext: requestNeedsQyrouContext(request.messages)
    })
    let messages = conversationMessages(request.messages)
    const duplicateCalls = new Map<string, number>()
    let intentReprompts = 0
    let emptyCompletionRetries = 0
    let actionsSinceTaskState = 0
    let enableThinking = request.enableThinking ?? false
    const toolbox = new AgentToolbox({
      projectPath: request.projectPath,
      signal: request.signal,
      readOnly,
      captureScreenshot: request.captureScreenshot,
      terminalController: depth === 0 && !readOnly ? request.terminalController : undefined,
      runTask: !readOnly && depth < MAX_SUBAGENT_DEPTH ? (task) => this.runSubagent(request, task, depth + 1, modifiedFiles, originalFiles, onToolEvent, visibleTaskStates) : undefined,
      onTodosChanged: (todos) => onToolEvent?.({ type: 'todos-updated', todos })
    })
    const allowedNames = new Set(toolbox.definitions.map((tool) => tool.name))
    const executeAction = async (call: LocalToolCall): Promise<ToolExecution> => {
      request.signal?.throwIfAborted()
      const startedAt = Date.now()
      const uiMessage = uiMessageForCall(call)
      onToolEvent?.({ type: 'tool-call', toolCallId: call.id, name: call.name, arguments: call.arguments, summary: uiMessage })
      const candidatePaths = mutationPaths(call, request.projectPath)
      for (const candidatePath of candidatePaths) captureOriginalFile(request.projectPath, candidatePath, originalFiles)
      const key = callKey(call)
      const repeats = (duplicateCalls.get(key) ?? 0) + 1
      duplicateCalls.set(key, repeats)
      let result: string
      let error: string | undefined
      let images: ToolboxImage[] | undefined
      if (repeats >= 3) {
        result = 'Error: This exact tool call has already been attempted twice. Do not repeat it. Change approach or provide the best final answer now.'
        error = result
      } else {
        try {
          result = await toolbox.execute(call.name, call.arguments)
          if ((call.name === 'view_image' || call.name === 'view_screenshot') && request.visionAvailable !== false) {
            const image = toolbox.consumeImage()
            if (image) images = [image]
          }
        } catch (cause) {
          result = `Error: ${cause instanceof Error ? cause.message : 'Tool execution failed'}. Inspect this result and try a different approach.`
          error = result
        }
      }
      let filePath: string | undefined
      if (!error && (call.name === 'write' || call.name === 'edit')) {
        const raw = typeof call.arguments.filePath === 'string' ? call.arguments.filePath : undefined
        filePath = raw ? relative(request.projectPath, resolve(request.projectPath, raw)).replace(/\\/g, '/') : undefined
      }
      if (!error && call.name === 'apply_patch' && typeof call.arguments.patch === 'string') {
        const patchPaths = extractPatchPaths(call.arguments.patch, request.projectPath)
        for (const patchPath of patchPaths) {
          modifiedFiles?.add(patchPath)
          if (!filePath) filePath = patchPath
        }
      }
      if (filePath) modifiedFiles?.add(filePath)
      if (process.env.NODE_ENV === 'development') console.debug('[AgentRuntime] tool', { name: call.name, durationMs: Date.now() - startedAt, ok: !error })
      return { call, result, error, filePath, images }
    }
    const emitExecution = (execution: ToolExecution): void => {
      if (execution.error) onToolEvent?.({ type: 'tool-error', toolCallId: execution.call.id, error: execution.error })
      else onToolEvent?.({ type: 'tool-result', toolCallId: execution.call.id, result: execution.result, filePath: execution.filePath })
    }
    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
      request.signal?.throwIfAborted()
      if (contentCharacters(messages) > COMPACTION_CHARACTER_THRESHOLD) {
        messages = await this.compact(request, messages, onToolEvent)
        onState?.(persistedMessages(messages))
      }
      const completion = await this.completeWithRetries({
        ...modelSettings(request, enableThinking),
        messages: [{
          role: 'system',
          content: actionsSinceTaskState >= TASK_STATE_ACTION_INTERVAL ? `${systemPrompt}\n\n${TASK_STATE_REMINDER}` : systemPrompt
        }, ...messages],
        tools: toolbox.definitions,
        toolChoice: 'auto',
        signal: request.signal
      }, onToolEvent)
      const contentCalls = parseHealedToolCalls(completion.text, allowedNames)
      const reasoningCalls = parseHealedToolCalls(completion.reasoningText ?? '', allowedNames)
      const availableCalls = completion.toolCalls.length ? completion.toolCalls : contentCalls.length ? contentCalls : reasoningCalls
      if (!availableCalls.length) {
        const finalText = stripToolCallMarkup(completion.text)
        if (!finalText.trim() && completion.reasoningText && emptyCompletionRetries < MAX_INTENT_REPROMPTS) {
          emptyCompletionRetries += 1
          enableThinking = false
          messages.push({ role: 'user', content: 'Your previous turn contained only private reasoning and no visible answer or action. Continue with thinking disabled: use the available tools if needed, otherwise provide the completed final answer now.' })
          continue
        }
        if (!finalText.trim()) throw new Error('The local model completed a turn without a visible answer or usable tool call')
        if (isIntentWithoutAction(finalText) && intentReprompts < MAX_INTENT_REPROMPTS) {
          intentReprompts += 1
          messages.push({ role: 'user', content: 'Your previous internal turn only described future actions. Continue now with the appropriate tool calls, batching independent inspections when useful. If no tool is needed, provide only the completed final answer.' })
          continue
        }
        messages.push({ role: 'assistant', content: finalText, reasoningText: retainedReasoning(request, completion.reasoningText), ...modelProvenance(request) })
        onState?.(persistedMessages(messages))
        if (depth === 0 && onFinalDelta) {
          await playFinalResponse(finalText, onFinalDelta, request.signal, this.timing)
          return { text: finalText, streamed: true }
        }
        return { text: finalText, streamed: false }
      }

      intentReprompts = 0
      emptyCompletionRetries = 0
      const usedCallIds = new Set<string>()
      const calls = availableCalls.map((call) => {
        let id = call.id || randomUUID()
        while (usedCallIds.has(id)) id = randomUUID()
        usedCallIds.add(id)
        return { ...call, id }
      })
      messages.push({
        role: 'assistant',
        content: null,
        toolCalls: calls,
        reasoningText: retainedReasoning(request, completion.reasoningText),
        ...modelProvenance(request)
      })

      const results = new Map<string, ToolExecution>()
      let acceptedTaskStateId: string | undefined
      for (const call of calls.filter((candidate) => candidate.name === TASK_STATE_TOOL_NAME)) {
        const message = normalizedTaskState(call.arguments.message)
        const duplicate = !message || visibleTaskStates.some((visible) => taskStatesAreSimilar(visible, message))
        if (!acceptedTaskStateId && !duplicate) {
          acceptedTaskStateId = call.id
          visibleTaskStates.push(message)
          actionsSinceTaskState = 0
          onToolEvent?.({ type: 'progress-update', summary: message })
          if (process.env.NODE_ENV === 'development') console.debug('[AgentRuntime] progress', { source: 'model', length: message.length })
        }
        results.set(call.id, { call, result: call.id === acceptedTaskStateId ? 'Task state accepted.' : 'Task state ignored; continue without retrying.' })
      }

      const actions = calls.filter((call) => call.name !== TASK_STATE_TOOL_NAME)
      let actionIndex = 0
      while (actionIndex < actions.length) {
        request.signal?.throwIfAborted()
        const first = actions[actionIndex]
        if (PARALLEL_TOOL_NAMES.has(first.name)) {
          const batch: LocalToolCall[] = []
          while (
            actionIndex < actions.length &&
            PARALLEL_TOOL_NAMES.has(actions[actionIndex].name) &&
            batch.length < MAX_PARALLEL_READ_TOOLS
          ) {
            batch.push(actions[actionIndex])
            actionIndex += 1
          }
          const executions = await Promise.all(batch.map(executeAction))
          for (const execution of executions) {
            results.set(execution.call.id, execution)
            emitExecution(execution)
            actionsSinceTaskState += 1
          }
        } else {
          const execution = await executeAction(first)
          results.set(first.id, execution)
          emitExecution(execution)
          actionsSinceTaskState += 1
          actionIndex += 1
        }
      }
      for (const call of calls) {
        const execution = results.get(call.id)
        if (!execution) continue
        messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: execution.result, filePath: execution.filePath })
      }
      const injectedImages = [...results.values()].flatMap((execution) => execution.images ?? [])
      if (injectedImages.length) {
        messages.push({
          role: 'user',
          content: injectedImages.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } }))
        })
      }
      onState?.(persistedMessages(messages))
    }

    const completion = await this.completeWithRetries({
      ...modelSettings(request, false),
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
        { role: 'user', content: 'You have reached the tool-step limit. Do not call more tools. Provide the best accurate final response from the work completed, including any unresolved blocker.' }
      ],
      tools: toolbox.definitions,
      toolChoice: 'none',
      maxTokens: Math.min(request.maxTokens ?? FINAL_MAX_TOKENS, FINAL_MAX_TOKENS),
      signal: request.signal
    }, onToolEvent)
    const finalText = stripToolCallMarkup(completion.text)
    if (!finalText.trim()) throw new Error('The local model completed the final turn without a visible answer')
    messages.push({ role: 'assistant', content: finalText, reasoningText: retainedReasoning(request, completion.reasoningText), ...modelProvenance(request) })
    onState?.(persistedMessages(messages))
    if (depth === 0 && onFinalDelta) {
      await playFinalResponse(finalText, onFinalDelta, request.signal, this.timing)
      return { text: finalText, streamed: true }
    }
    return { text: finalText, streamed: false }
  }

  private async compact(request: AgentRunRequest, messages: LocalChatMessage[], onToolEvent?: (event: AgentToolEvent) => void): Promise<LocalChatMessage[]> {
    const boundary = Math.max(1, messages.length - COMPACTION_RECENT_MESSAGES)
    const older = messages.slice(0, boundary)
    const recent = messages.slice(boundary)
    const completion = await this.completeWithRetries({
      messages: [
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user', content: older.map((message) => `${message.role.toUpperCase()}: ${contentForCompaction(message.content) || JSON.stringify(message.toolCalls ?? [])}`).join('\n\n') }
      ],
      enableThinking: false,
      maxTokens: COMPACTION_MAX_TOKENS,
      temperature: 0,
      signal: request.signal
    }, onToolEvent)
    return [
      { role: 'user', content: `<previous-context-summary>\n${completion.text}\n</previous-context-summary>` },
      ...recent
    ]
  }

  private async completeWithRetries(request: LocalCompletionRequest, onToolEvent?: (event: AgentToolEvent) => void): Promise<LocalCompletion> {
    for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt += 1) {
      request.signal?.throwIfAborted()
      const startedAt = Date.now()
      let firstDeltaAt: number | undefined
      let emitted = false
      try {
        const completion = this.provider.stream
          ? await this.provider.stream(request, () => {
              emitted = true
              firstDeltaAt ??= Date.now()
            })
          : await this.provider.complete(request)
        if (process.env.NODE_ENV === 'development') {
          console.debug('[AgentRuntime] provider', {
            durationMs: Date.now() - startedAt,
            firstDeltaMs: firstDeltaAt ? firstDeltaAt - startedAt : undefined,
            promptCharacters: contentCharacters(request.messages),
            toolSchemaCharacters: request.tools ? JSON.stringify(request.tools).length : 0,
            toolCalls: completion.toolCalls.length,
            attempt
          })
        }
        return completion
      } catch (error) {
        if (request.signal?.aborted || emitted || attempt === MAX_PROVIDER_RETRIES) throw error
        if (process.env.NODE_ENV === 'development') console.debug('[AgentRuntime] provider retry', { attempt: attempt + 1 })
      }
    }
    throw new Error('Provider retry limit was reached')
  }

  private runSubagent(parent: AgentRunRequest, task: AgentTaskRequest, depth: number, modifiedFiles?: Set<string>, originalFiles?: Map<string, string | null>, onToolEvent?: (event: AgentToolEvent) => void, visibleTaskStates: string[] = []): Promise<string> {
    return this.runInternal({
      ...parent,
      messages: [
        { role: 'system', content: `Subagent task: ${task.description}. Return a single concise result to the parent agent. Include exact paths and evidence. Complete the requested work autonomously.` },
        { role: 'user', content: task.prompt }
      ]
    }, depth, task.subagentType === 'explore', undefined, onToolEvent, modifiedFiles, originalFiles, visibleTaskStates).then((result) => result.text)
  }
}

function extractPatchPaths(patch: string, projectPath: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const header = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    if (header) {
      const patchPath = header[1].trim()
      paths.add(relative(projectPath, resolve(projectPath, patchPath)).replace(/\\/g, '/'))
    }
  }
  return [...paths]
}

function safeRelativePath(projectPath: string, filePath: string): string | undefined {
  const normalized = relative(projectPath, resolve(projectPath, filePath))
  if (!normalized || normalized.startsWith('..') || isAbsolute(normalized)) return undefined
  return normalized.replace(/\\/g, '/')
}

function mutationPaths(call: LocalToolCall, projectPath: string): string[] {
  if ((call.name === 'write' || call.name === 'edit') && typeof call.arguments.filePath === 'string') {
    const path = safeRelativePath(projectPath, call.arguments.filePath)
    return path ? [path] : []
  }
  if (call.name === 'apply_patch' && typeof call.arguments.patch === 'string') {
    return extractPatchPaths(call.arguments.patch, projectPath).filter((path) => safeRelativePath(projectPath, path) === path)
  }
  return []
}

function captureOriginalFile(projectPath: string, filePath: string, originals?: Map<string, string | null>): void {
  if (!originals || originals.has(filePath)) return
  const absolutePath = resolve(projectPath, filePath)
  originals.set(filePath, existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null)
}

function contentLines(content: string | null): string[] {
  if (!content) return []
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function lineChangeCounts(before: string | null, after: string | null): { additions: number; deletions: number } {
  const previous = contentLines(before)
  const current = contentLines(after)
  if (previous.length === 0) return { additions: current.length, deletions: 0 }
  if (current.length === 0) return { additions: 0, deletions: previous.length }

  const maximumCells = 4_000_000
  if (previous.length * current.length > maximumCells) {
    let prefix = 0
    while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) prefix += 1
    let suffix = 0
    while (suffix < previous.length - prefix && suffix < current.length - prefix && previous[previous.length - suffix - 1] === current[current.length - suffix - 1]) suffix += 1
    return {
      additions: current.length - prefix - suffix,
      deletions: previous.length - prefix - suffix
    }
  }

  let priorRow = new Uint32Array(current.length + 1)
  for (const previousLine of previous) {
    const nextRow = new Uint32Array(current.length + 1)
    for (let index = 1; index <= current.length; index += 1) {
      nextRow[index] = previousLine === current[index - 1]
        ? priorRow[index - 1] + 1
        : Math.max(priorRow[index], nextRow[index - 1])
    }
    priorRow = nextRow
  }
  const commonLines = priorRow[current.length]
  return { additions: current.length - commonLines, deletions: previous.length - commonLines }
}

function summarizeFileChanges(projectPath: string, modifiedFiles: ReadonlySet<string>, originals: ReadonlyMap<string, string | null>): FileChangeDisplay[] {
  return [...modifiedFiles].flatMap((path) => {
    const absolutePath = resolve(projectPath, path)
    const after = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null
    const counts = lineChangeCounts(originals.get(path) ?? null, after)
    return counts.additions > 0 || counts.deletions > 0 ? [{ path, ...counts }] : []
  })
}
