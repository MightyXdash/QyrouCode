import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import type { LocalChatMessage, LocalCompletion, LocalCompletionRequest, LocalToolCall } from './localCompletionClient'
import type { FileChangeDisplay, TodoDisplay, ToolUiMessage } from '../shared/chat'
import type { AgentModelProvenance } from '../shared/agent'
import { DEFAULT_NATIVE_LANGUAGE, type NativeLanguage } from '../shared/settings'
import { COMPACTION_SYSTEM_PROMPT, buildAgentSystemPrompt } from './agentPrompt'
import { AgentToolbox, TASK_STATE_TOOL_NAME, type AgentTaskRequest } from './agentTools'
import type { AgentTerminalController } from './terminalManager'
import { parseHealedToolCalls, stripToolCallMarkup } from './toolCallParser'

export interface AgentCompletionProvider {
  complete(request: LocalCompletionRequest): Promise<LocalCompletion>
  stream?(request: LocalCompletionRequest, onDelta: (delta: string) => void): Promise<string>
}

export interface AgentRunRequest extends Omit<LocalCompletionRequest, 'signal' | 'tools' | 'toolChoice'> {
  threadId: string
  projectPath: string
  signal?: AbortSignal
  model?: AgentModelProvenance
  nativeLanguage?: NativeLanguage
  terminalController?: AgentTerminalController
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
const TASK_STATE_MIN_WORDS = 60
const TASK_STATE_MAX_WORDS = 65
const TASK_STATE_MAX_UPDATES = 12
const TASK_STATE_ACTION_INTERVAL = 4
const TASK_STATE_SIMILARITY_THRESHOLD = 0.42
const INTENT_PATTERN = /\b(?:i(?:'|’)ll|i will|let me|i am going to|first,? i|next,? i|here(?:'|’)s (?:my|the) plan)\b/i
const FIRST_PERSON_PATTERN = /\b(?:i|i'm|i’m|i'll|i’ll|me|my|mine|we|we're|we’re|we'll|we’ll|us|our|ours)\b/i

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

function taskStateWordCount(value: string): number {
  return value.trim() ? value.trim().split(/\s+/).length : 0
}

function taskStatesAreSimilar(left: string, right: string): boolean {
  const words = (value: string): Set<string> => new Set(value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 2))
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
  return messages.filter((message) => {
    if (message.role === 'assistant' && message.toolCalls?.some((call) => call.name === TASK_STATE_TOOL_NAME)) return false
    return message.role !== 'tool' || !message.toolCallId || !hiddenCallIds.has(message.toolCallId)
  }).map((message) => ({ ...message }))
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
  constructor(private readonly provider: AgentCompletionProvider) {}

  async run(request: AgentRunRequest, onDelta: (delta: string) => void, onState?: AgentStateListener, onToolEvent?: (event: AgentToolEvent) => void): Promise<void> {
    const modifiedFiles = new Set<string>()
    const originalFiles = new Map<string, string | null>()
    const visibleTaskStates: string[] = []
    let finalText: string | undefined
    try {
      finalText = await this.runInternal(request, 0, false, onState, onToolEvent, modifiedFiles, originalFiles, visibleTaskStates)
    } finally {
      const files = summarizeFileChanges(request.projectPath, modifiedFiles, originalFiles)
      if (files.length > 0) onToolEvent?.({ type: 'files-changed', files })
    }
    await this.emitStreamedText(finalText, onDelta)
  }

  private async runInternal(request: AgentRunRequest, depth: number, readOnly: boolean, onState?: AgentStateListener, onToolEvent?: (event: AgentToolEvent) => void, modifiedFiles?: Set<string>, originalFiles?: Map<string, string | null>, visibleTaskStates: string[] = []): Promise<string> {
    request.signal?.throwIfAborted()
    const systemPrompt = buildAgentSystemPrompt({
      projectPath: request.projectPath,
      additionalInstructions: additionalSystemInstructions(request.messages),
      nativeLanguage: request.nativeLanguage ?? DEFAULT_NATIVE_LANGUAGE,
      readOnly
    })
    let messages = conversationMessages(request.messages)
    const duplicateCalls = new Map<string, number>()
    let intentReprompts = 0
    let emptyCompletionRetries = 0
    let taskStateProtocolReprompts = 0
    let taskStateReady = false
    let completedActionCount = 0
    let actionsSinceTaskState = 0
    let enableThinking = request.enableThinking ?? false
    const toolbox = new AgentToolbox({
      projectPath: request.projectPath,
      signal: request.signal,
      readOnly,
      terminalController: depth === 0 && !readOnly ? request.terminalController : undefined,
      runTask: !readOnly && depth < MAX_SUBAGENT_DEPTH ? (task) => this.runSubagent(request, task, depth + 1, modifiedFiles, originalFiles, onToolEvent, visibleTaskStates) : undefined,
      onTodosChanged: (todos) => onToolEvent?.({ type: 'todos-updated', todos })
    })
    const allowedNames = new Set(toolbox.definitions.map((tool) => tool.name))

    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
      request.signal?.throwIfAborted()
      if (contentCharacters(messages) > COMPACTION_CHARACTER_THRESHOLD) {
        messages = await this.compact(request, messages, onToolEvent)
        onState?.(persistedMessages(messages))
      }
      const completion = await this.completeWithRetries({
        ...modelSettings(request, enableThinking),
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools: toolbox.definitions,
        toolChoice: 'auto',
        signal: request.signal
      }, onToolEvent)
      const contentCalls = parseHealedToolCalls(completion.text, allowedNames)
      const reasoningCalls = parseHealedToolCalls(completion.reasoningText ?? '', allowedNames)
      const availableCalls = completion.toolCalls.length ? completion.toolCalls : contentCalls.length ? contentCalls : reasoningCalls
      const healedCalls = availableCalls.slice(0, 1)
      if (!healedCalls.length) {
        const finalText = stripToolCallMarkup(completion.text)
        if (!finalText && completion.reasoningText && emptyCompletionRetries < MAX_INTENT_REPROMPTS) {
          emptyCompletionRetries += 1
          enableThinking = false
          messages.push({ role: 'user', content: 'Your previous turn contained only private reasoning and no visible answer or action. Continue with thinking disabled: use the available tools if needed, otherwise provide the completed final answer now.' })
          continue
        }
        if (!finalText) throw new Error('The local model completed a turn without a visible answer or usable tool call')
        if (!taskStateReady && taskStateProtocolReprompts > 0) {
          taskStateProtocolReprompts += 1
          enableThinking = false
          messages.push({ role: 'user', content: 'Protocol error: cur_task_state is still required before you may continue or provide a final response. Call cur_task_state now as the only tool call. Use one unique 60–65-word, mostly first-person paragraph describing the immediate next substep, why it matters, and what follows.' })
          continue
        }
        if (taskStateReady && completedActionCount === 0 && taskStateProtocolReprompts < MAX_INTENT_REPROMPTS) {
          taskStateProtocolReprompts += 1
          messages.push({ role: 'user', content: 'Do not generate an assistant response while agentic work is active. You announced the next substep with cur_task_state but have not performed it. Continue now with exactly one appropriate tool call and its required ui_message.' })
          continue
        }
        if (isIntentWithoutAction(finalText) && intentReprompts < MAX_INTENT_REPROMPTS) {
          intentReprompts += 1
          messages.push({ role: 'user', content: 'Your previous internal turn described future actions and was not shown to the user. Continue now using exactly one available tool. If no tool is needed, provide only the completed final answer.' })
          continue
        }
        messages.push({ role: 'assistant', content: finalText, reasoningText: retainedReasoning(request, completion.reasoningText), ...modelProvenance(request) })
        onState?.(persistedMessages(messages))
        return finalText
      }

      intentReprompts = 0
      emptyCompletionRetries = 0
      const selectedCall = healedCalls[0]
      if (!taskStateReady && selectedCall.name !== TASK_STATE_TOOL_NAME) {
        taskStateProtocolReprompts += 1
        enableThinking = false
        messages.push({ role: 'user', content: `Protocol error: ${selectedCall.name} was not executed because cur_task_state is required first. Call cur_task_state now as the only tool call. Its message must be one unique 60–65-word paragraph written mostly in first person, explaining the immediate next substep, why it matters, and what follows. Do not generate ordinary assistant prose.` })
        continue
      }
      const selectedCallId = selectedCall.id || randomUUID()
      messages.push({
        role: 'assistant',
        content: null,
        toolCalls: [{ ...selectedCall, id: selectedCallId }],
        reasoningText: retainedReasoning(request, completion.reasoningText),
        ...modelProvenance(request)
      })
      for (const call of healedCalls) {
        const callId = selectedCallId
        const isTaskState = call.name === TASK_STATE_TOOL_NAME
        const candidatePaths = mutationPaths(call, request.projectPath)
        for (const candidatePath of candidatePaths) captureOriginalFile(request.projectPath, candidatePath, originalFiles)
        const key = callKey(call)
        const repeats = (duplicateCalls.get(key) ?? 0) + 1
        duplicateCalls.set(key, repeats)
        let result: string
        let error: string | undefined
        if (repeats >= 3) {
          result = 'Error: This exact tool call has already been attempted twice. Do not repeat it. Change approach or provide the best final answer now.'
          error = result
        } else {
          try {
            if (isTaskState) {
              const message = typeof call.arguments.message === 'string' ? call.arguments.message.trim() : ''
              const wordCount = taskStateWordCount(message)
              if (wordCount < TASK_STATE_MIN_WORDS || wordCount > TASK_STATE_MAX_WORDS) throw new Error(`cur_task_state must contain 60–65 words; received ${wordCount}`)
              if (/\r?\n\s*\r?\n/.test(message)) throw new Error('cur_task_state must be one paragraph')
              if (!FIRST_PERSON_PATTERN.test(message)) throw new Error('cur_task_state must be written mostly in first person')
              if (visibleTaskStates.length >= TASK_STATE_MAX_UPDATES) throw new Error('The task already has twelve cur_task_state updates; continue the work without another')
              if (visibleTaskStates.some((visible) => taskStatesAreSimilar(visible, message))) throw new Error('This cur_task_state is substantially similar to an earlier update; continue working or report a genuinely new development')
              visibleTaskStates.push(message)
              taskStateReady = true
              actionsSinceTaskState = 0
              taskStateProtocolReprompts = 0
              onToolEvent?.({ type: 'progress-update', summary: message })
            } else {
              const uiMessage = onToolEvent ? await this.resolveUiMessage(request, messages, call, onToolEvent) : undefined
              onToolEvent?.({ type: 'tool-call', toolCallId: callId, name: call.name, arguments: call.arguments, summary: uiMessage })
            }
            result = await toolbox.execute(call.name, call.arguments)
            if (!isTaskState) {
              completedActionCount += 1
              actionsSinceTaskState += 1
              if (actionsSinceTaskState >= TASK_STATE_ACTION_INTERVAL && visibleTaskStates.length < TASK_STATE_MAX_UPDATES) taskStateReady = false
            }
          } catch (err) {
            const message = `Error: ${err instanceof Error ? err.message : 'Tool execution failed'}. Inspect this result and try a different approach.`
            result = message
            error = message
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
        if (!isTaskState) {
          if (error) onToolEvent?.({ type: 'tool-error', toolCallId: callId, error })
          else onToolEvent?.({ type: 'tool-result', toolCallId: callId, result, filePath })
        }
        messages.push({ role: 'tool', name: call.name, toolCallId: callId, content: result, filePath })
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
    messages.push({ role: 'assistant', content: finalText, reasoningText: retainedReasoning(request, completion.reasoningText), ...modelProvenance(request) })
    onState?.(persistedMessages(messages))
    return finalText
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

  private async resolveUiMessage(request: AgentRunRequest, messages: readonly LocalChatMessage[], call: LocalToolCall, onToolEvent?: (event: AgentToolEvent) => void): Promise<ToolUiMessage | undefined> {
    if (call.name === TASK_STATE_TOOL_NAME || call.name === 'web_search' || call.name === 'web_fetch') return undefined
    const supplied = call.arguments.ui_message && typeof call.arguments.ui_message === 'object' && !Array.isArray(call.arguments.ui_message)
      ? call.arguments.ui_message as Partial<ToolUiMessage>
      : undefined
    const present = typeof supplied?.uim_prt === 'string' ? supplied.uim_prt.trim() : ''
    const past = typeof supplied?.uim_pat === 'string' ? supplied.uim_pat.trim() : ''
    if (present && past) return { uim_prt: present.split(/\s+/).slice(0, 5).join(' '), uim_pat: past.split(/\s+/).slice(0, 5).join(' ') }
    const completion = await this.completeWithRetries({
      ...modelSettings(request, false),
      messages: [
        ...messages,
        {
          role: 'user',
          content: `Return only compact JSON describing the current ${call.name} tool call. Use exactly this shape: {"uim_prt":"present-tense first-person label","uim_pat":"past-tense completed label"}. Keep each value under six words. Do not add explanation or a tool call.`
        }
      ],
      tools: [],
      toolChoice: 'none',
      enableThinking: false,
      maxTokens: 64,
      signal: request.signal
    }, onToolEvent)
    try {
      const generated = JSON.parse(stripToolCallMarkup(completion.text)) as Partial<ToolUiMessage>
      if (typeof generated.uim_prt === 'string' && typeof generated.uim_pat === 'string') {
        return {
          uim_prt: generated.uim_prt.trim().split(/\s+/).slice(0, 5).join(' '),
          uim_pat: generated.uim_pat.trim().split(/\s+/).slice(0, 5).join(' ')
        }
      }
    } catch {}
    return { uim_prt: `I’m using ${call.name}`, uim_pat: `Used ${call.name}` }
  }

  private async completeWithRetries(request: LocalCompletionRequest, onToolEvent?: (event: AgentToolEvent) => void): Promise<LocalCompletion> {
    for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt += 1) {
      request.signal?.throwIfAborted()
      try {
        return await this.provider.complete(request)
      } catch (error) {
        if (request.signal?.aborted || attempt === MAX_PROVIDER_RETRIES) throw error
        onToolEvent?.({ type: 'progress-update', summary: 'Provider returned error, retrying' })
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
    }, depth, task.subagentType === 'explore', undefined, onToolEvent, modifiedFiles, originalFiles, visibleTaskStates)
  }

  private async emitStreamedText(text: string, onDelta: (delta: string) => void): Promise<void> {
    if (!text) return
    for (let i = 0; i < text.length; i += 3) {
      onDelta(text.slice(i, i + 3))
      await new Promise((resolve) => setTimeout(resolve, 8))
    }
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
