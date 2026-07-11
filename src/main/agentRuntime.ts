import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import type { LocalChatMessage, LocalCompletion, LocalCompletionRequest, LocalToolCall, LocalToolDefinition } from './localCompletionClient'
import type { FileChangeDisplay } from '../shared/chat'
import { COMPACTION_SYSTEM_PROMPT, buildAgentSystemPrompt } from './agentPrompt'
import { AgentToolbox, type AgentTaskRequest } from './agentTools'
import { parseHealedToolCalls, stripToolCallMarkup } from './toolCallParser'

export interface AgentCompletionProvider {
  complete(request: LocalCompletionRequest): Promise<LocalCompletion>
  stream?(request: LocalCompletionRequest, onDelta: (delta: string) => void): Promise<string>
}

export interface AgentRunRequest extends Omit<LocalCompletionRequest, 'signal' | 'tools' | 'toolChoice'> {
  threadId: string
  projectPath: string
  signal?: AbortSignal
}

export type AgentStateListener = (messages: readonly LocalChatMessage[]) => void

export type AgentToolEvent =
  | { type: 'tool-call'; toolCallId: string; name: string; arguments: Record<string, unknown>; summary?: string }
  | { type: 'tool-result'; toolCallId: string; result: string; filePath?: string }
  | { type: 'tool-error'; toolCallId: string; error: string }
  | { type: 'files-changed'; files: FileChangeDisplay[] }
  | { type: 'progress-update'; summary: string }
  | { type: 'reasoning-summary'; summary: string }

const MAX_AGENT_STEPS = 50
const MAX_SUBAGENT_DEPTH = 2
const COMPACTION_CHARACTER_THRESHOLD = 90_000
const COMPACTION_RECENT_MESSAGES = 12
const COMPACTION_MAX_TOKENS = 2_048
const FINAL_MAX_TOKENS = 8_192
const MAX_INTENT_REPROMPTS = 3
const IMAGE_CONTEXT_CHARACTER_WEIGHT = 64
const TASK_STATE_TOOL_NAME = 'cur_task_state'
const INTENT_PATTERN = /\b(?:i(?:'|’)ll|i will|let me|i am going to|first,? i|next,? i|here(?:'|’)s (?:my|the) plan)\b/i

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

export class AgentRuntime {
  constructor(private readonly provider: AgentCompletionProvider) {}

  async run(request: AgentRunRequest, onDelta: (delta: string) => void, onState?: AgentStateListener, onToolEvent?: (event: AgentToolEvent) => void): Promise<void> {
    const modifiedFiles = new Set<string>()
    const originalFiles = new Map<string, string | null>()
    try {
      await this.runInternal(request, 0, false, onDelta, onState, onToolEvent, modifiedFiles, originalFiles)
    } finally {
      const files = summarizeFileChanges(request.projectPath, modifiedFiles, originalFiles)
      if (files.length > 0) onToolEvent?.({ type: 'files-changed', files })
    }
  }

  private async runInternal(request: AgentRunRequest, depth: number, readOnly: boolean, onDelta: (delta: string) => void, onState?: AgentStateListener, onToolEvent?: (event: AgentToolEvent) => void, modifiedFiles?: Set<string>, originalFiles?: Map<string, string | null>): Promise<string> {
    request.signal?.throwIfAborted()
    const systemPrompt = buildAgentSystemPrompt({
      projectPath: request.projectPath,
      additionalInstructions: additionalSystemInstructions(request.messages),
      readOnly
    })
    let messages = conversationMessages(request.messages)
    const duplicateCalls = new Map<string, number>()
    let intentReprompts = 0
    let emptyCompletionRetries = 0
    let enableThinking = request.enableThinking ?? false
    let taskStateReady = false
    let currentTaskState = ''
    const toolbox = new AgentToolbox({
      projectPath: request.projectPath,
      signal: request.signal,
      readOnly,
      runTask: !readOnly && depth < MAX_SUBAGENT_DEPTH ? (task) => this.runSubagent(request, task, depth + 1, modifiedFiles, originalFiles, onToolEvent) : undefined
    })
    const allowedNames = new Set(toolbox.definitions.map((tool) => tool.name))

    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
      request.signal?.throwIfAborted()
      if (contentCharacters(messages) > COMPACTION_CHARACTER_THRESHOLD) {
        messages = await this.compact(request, messages)
        onState?.(messages)
      }
      const completion = await this.provider.complete({
        ...modelSettings(request, enableThinking),
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools: toolbox.definitions,
        toolChoice: 'auto',
        signal: request.signal
      })
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
        if (isIntentWithoutAction(finalText) && intentReprompts < MAX_INTENT_REPROMPTS) {
          intentReprompts += 1
          messages.push({ role: 'assistant', content: finalText })
          messages.push({ role: 'user', content: 'Continue now using the available tools. If no tool is needed, provide the completed final answer instead of describing future actions.' })
          continue
        }
        if (completion.reasoningText && onToolEvent) {
          onToolEvent({ type: 'reasoning-summary', summary: completion.reasoningText })
        }
        messages.push({ role: 'assistant', content: finalText, reasoningText: completion.reasoningText })
        onState?.(messages)
        await this.emitStreamedText(finalText, onDelta)
        return finalText
      }

      intentReprompts = 0
      emptyCompletionRetries = 0
      const selectedCall = healedCalls[0]
      if (onToolEvent && selectedCall.name !== TASK_STATE_TOOL_NAME && !taskStateReady) {
        const definition = toolbox.definitions.find((tool) => tool.name === TASK_STATE_TOOL_NAME)
        if (definition) {
          const stateCall = await this.requestTaskState(request, messages, definition, selectedCall.name)
          const stateMessage = typeof stateCall.arguments.message === 'string' ? stateCall.arguments.message.trim() : ''
          onToolEvent({ type: 'tool-call', toolCallId: stateCall.id, name: stateCall.name, arguments: stateCall.arguments, summary: 'I’m sharing current progress' })
          if (stateMessage) await this.emitProgressUpdate(stateMessage, onToolEvent)
          const stateResult = await toolbox.execute(stateCall.name, stateCall.arguments)
          onToolEvent({ type: 'tool-result', toolCallId: stateCall.id, result: stateResult })
          messages.push({ role: 'assistant', content: null, toolCalls: [stateCall] })
          messages.push({ role: 'tool', name: stateCall.name, toolCallId: stateCall.id, content: stateResult })
          taskStateReady = true
          currentTaskState = stateMessage
          onState?.(messages)
        }
      }
      if (completion.reasoningText && onToolEvent) {
        onToolEvent({ type: 'reasoning-summary', summary: completion.reasoningText })
      }
      messages.push({
        role: 'assistant',
        content: stripToolCallMarkup(completion.text) || null,
        toolCalls: healedCalls,
        reasoningText: completion.reasoningText
      })
      for (const call of healedCalls) {
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
            const isTaskState = call.name === TASK_STATE_TOOL_NAME
            const taskStateMessage = isTaskState && typeof call.arguments.message === 'string' ? call.arguments.message.trim() : ''
            const uiMessage = isTaskState
              ? 'I’m sharing current progress'
              : onToolEvent ? await this.resolveUiMessage(request, messages, call, currentTaskState) : undefined
            onToolEvent?.({ type: 'tool-call', toolCallId: call.id || randomUUID(), name: call.name, arguments: call.arguments, summary: uiMessage })
            if (isTaskState && taskStateMessage && onToolEvent) await this.emitProgressUpdate(taskStateMessage, onToolEvent)
            result = await toolbox.execute(call.name, call.arguments)
            if (isTaskState) {
              taskStateReady = true
              currentTaskState = taskStateMessage
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
        if (error) {
          onToolEvent?.({ type: 'tool-error', toolCallId: call.id || randomUUID(), error })
        } else {
          onToolEvent?.({ type: 'tool-result', toolCallId: call.id || randomUUID(), result, filePath })
        }
        messages.push({ role: 'tool', name: call.name, toolCallId: call.id || randomUUID(), content: result, filePath })
        if (call.name !== TASK_STATE_TOOL_NAME) {
          taskStateReady = false
          currentTaskState = ''
        }
      }
      onState?.(messages)
    }

    const completion = await this.provider.complete({
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
    })
    const finalText = stripToolCallMarkup(completion.text)
    if (completion.reasoningText && onToolEvent) {
      onToolEvent({ type: 'reasoning-summary', summary: completion.reasoningText })
    }
    messages.push({ role: 'assistant', content: finalText, reasoningText: completion.reasoningText })
    onState?.(messages)
    await this.emitStreamedText(finalText, onDelta)
    return finalText
  }

  private async compact(request: AgentRunRequest, messages: LocalChatMessage[]): Promise<LocalChatMessage[]> {
    const boundary = Math.max(1, messages.length - COMPACTION_RECENT_MESSAGES)
    const older = messages.slice(0, boundary)
    const recent = messages.slice(boundary)
    const completion = await this.provider.complete({
      messages: [
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user', content: older.map((message) => `${message.role.toUpperCase()}: ${contentForCompaction(message.content) || JSON.stringify(message.toolCalls ?? [])}`).join('\n\n') }
      ],
      enableThinking: false,
      maxTokens: COMPACTION_MAX_TOKENS,
      temperature: 0,
      signal: request.signal
    })
    return [
      { role: 'user', content: `<previous-context-summary>\n${completion.text}\n</previous-context-summary>` },
      ...recent
    ]
  }

  private async requestTaskState(request: AgentRunRequest, messages: readonly LocalChatMessage[], definition: LocalToolDefinition, nextToolName: string): Promise<LocalToolCall> {
    const completion = await this.provider.complete({
      ...modelSettings(request, false),
      messages: [
        ...messages,
        {
          role: 'user',
          content: `Call cur_task_state now before the ${nextToolName} tool. Put a natural roughly 60–65-word user-facing update in its message argument explaining what you are about to do or what the current subtask established. Do not call any other tool.`
        }
      ],
      tools: [definition],
      toolChoice: 'auto',
      enableThinking: false,
      maxTokens: 180,
      signal: request.signal
    })
    const calls = completion.toolCalls.length
      ? completion.toolCalls
      : parseHealedToolCalls(completion.text, new Set([TASK_STATE_TOOL_NAME]))
    const call = calls.find((candidate) => candidate.name === TASK_STATE_TOOL_NAME)
    if (call && typeof call.arguments.message === 'string' && call.arguments.message.trim()) return call
    return {
      id: randomUUID(),
      name: TASK_STATE_TOOL_NAME,
      arguments: {
        message: stripToolCallMarkup(completion.text).trim() || `I’m preparing the next ${nextToolName} step now. I’ll use it to gather the concrete information needed for this task, review the result carefully, and then share what changed or what I found before moving forward. This keeps the work visible, makes the current direction clear, and helps each action follow naturally from the evidence already available.`
      }
    }
  }

  private async resolveUiMessage(request: AgentRunRequest, messages: readonly LocalChatMessage[], call: LocalToolCall, progress: string): Promise<string | undefined> {
    if (call.name === 'web_search' || call.name === 'web_fetch') return undefined
    const supplied = typeof call.arguments.ui_message === 'string' ? call.arguments.ui_message.trim() : ''
    if (supplied) return supplied.split(/\s+/).slice(0, 5).join(' ')
    const completion = await this.provider.complete({
      ...modelSettings(request, false),
      messages: [
        ...messages,
        {
          role: 'user',
          content: `Write only a natural first-person UI activity message for the ${call.name} tool call described by this progress update: ${progress}. Use fewer than six words. Do not add punctuation, quotes, a heading, explanation, or a tool call.`
        }
      ],
      tools: [],
      toolChoice: 'none',
      enableThinking: false,
      maxTokens: 24,
      signal: request.signal
    })
    const generated = stripToolCallMarkup(completion.text).replace(/^["'“”]+|["'“”.!]+$/g, '').trim()
    return generated ? generated.split(/\s+/).slice(0, 5).join(' ') : `I’m using ${call.name}`
  }

  private async emitProgressUpdate(progress: string, onToolEvent: (event: AgentToolEvent) => void): Promise<void> {
    for (let index = 0; index < progress.length; index += 3) {
      onToolEvent({ type: 'progress-update', summary: progress.slice(0, index + 3) })
      await new Promise((resolve) => setTimeout(resolve, 8))
    }
  }

  private runSubagent(parent: AgentRunRequest, task: AgentTaskRequest, depth: number, modifiedFiles?: Set<string>, originalFiles?: Map<string, string | null>, onToolEvent?: (event: AgentToolEvent) => void): Promise<string> {
    return this.runInternal({
      ...parent,
      messages: [
        { role: 'system', content: `Subagent task: ${task.description}. Return a single concise result to the parent agent. Include exact paths and evidence. Complete the requested work autonomously.` },
        { role: 'user', content: task.prompt }
      ]
    }, depth, task.subagentType === 'explore', () => undefined, undefined, onToolEvent, modifiedFiles, originalFiles)
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
