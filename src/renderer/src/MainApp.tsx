import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MODEL_LIST } from './modelCatalog'
import { DEFAULT_RESPONSE_STYLE, type ResponseStylePreference, type ThemePreference } from '../../shared/settings'
import { WINDOW_COMMANDS } from '../../shared/windowCommands'
import type { Project } from '../../shared/projects'
import { MAX_CHAT_ATTACHMENT_BYTES, MAX_CHAT_ATTACHMENTS, type ChatAttachment, type ChatMessage, type ChatThread, type ToolCallDisplay } from '../../shared/chat'
import WindowControls from './WindowControls'
import MarkdownMessage from './MarkdownMessage'
import { REASONING_EFFORTS, reasoningProfile, type ReasoningEffort } from './reasoningProfiles'
import { responseStylePrompt } from './responseStylePrompts'
import { Search, Plus, ChevronDown, ArrowUp, PanelLeft, ChevronLeft, ChevronRight, Square, ArrowDown, FolderPlus, Folder, FolderOpen, Check, X, Clock, CheckCircle, XCircle, Terminal, FileEdit, FilePlus, Globe, Code, List, Eye, Braces, PenLine, RefreshCw, SquarePen, Trash2, Copy, Settings2 } from 'lucide-react'
import type { AgentExecutionTarget, AgentModelProvenance } from '../../shared/agent'
import type { ConnectionSummary } from '../../shared/connections'
import { REMOTE_MODEL_CATALOG, getRemoteModel, shouldRetainRawReasoning, type RemoteModel } from '../../shared/remoteModels'
import type { ConversationExportRequest } from '../../shared/conversationExport'
import SettingsPage, {
  type SettingsConnectionRequest,
  type SettingsConnectionTestResult,
  type SettingsExportOptions,
  type SettingsExportState
} from './settings/SettingsPage'
import './MainApp.css'

const AUTO_SCROLL_THRESHOLD = 72
const MAX_ACTIVITY_COMMAND_CHARACTERS = 40
const WEB_SEARCH_REVEAL_CHARACTERS_PER_SECOND = 150
const DEFAULT_ACTIVITY_SWEEP_DURATION_MS = 1_800
const PROJECT_THREAD_STAGGER_MS = 45
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch'])
const DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW = 128_000
const DEFAULT_AGENT_MAX_TOKENS = 8_192

type MainView = 'chat' | 'settings'

interface ComposerModel {
  id: string
  source: 'local' | 'remote'
  modelId: string
  displayName: string
  providerName: string
  context_length: number
  vision: boolean
  connectionId?: string
  localModel?: (typeof MODEL_LIST)[number]
  remoteModel?: RemoteModel
}

const DEFAULT_EXPORT_OPTIONS: SettingsExportOptions = {
  scope: 'thread',
  format: 'jsonl',
  includeMessages: true,
  includeToolCalls: true,
  includeTimestamps: true,
  includeReasoningSummaries: true,
  includeRawReasoning: false,
  attachments: 'metadata',
  redactSensitiveData: true
}

const DEFAULT_EXPORT_STATE: SettingsExportState = { busy: false }

type ProjectThreadAnimationStyle = CSSProperties & {
  '--thread-collapse-delay': string
  '--thread-expand-delay': string
}

const projectThreadAnimationStyle = (index: number, count: number): ProjectThreadAnimationStyle => ({
  '--thread-collapse-delay': `${(count - index - 1) * PROJECT_THREAD_STAGGER_MS}ms`,
  '--thread-expand-delay': `${index * PROJECT_THREAD_STAGGER_MS}ms`
})

const toolIconMap: Record<string, typeof Terminal> = {
  cur_task_state: Clock,
  bash: Terminal,
  write: FilePlus,
  edit: FileEdit,
  apply_patch: Code,
  read: Eye,
  grep: Search,
  glob: List,
  web_search: Search,
  web_fetch: Globe,
  list: Folder,
  default: Braces,
}

type OpenMenu = 'advanced' | 'model' | null
type TitlebarMenuId = 'file' | 'edit' | 'view' | 'theme' | 'help'
type TitlebarAction = 'new-thread' | 'close-window' | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'select-all' | 'reload' | 'toggle-dev-tools' | 'toggle-fullscreen'

interface TitlebarMenuItem {
  action?: TitlebarAction
  disabled?: boolean
  label?: string
  separator?: boolean
  shortcut?: string
  theme?: ThemePreference
}

const TITLEBAR_MENUS: Record<TitlebarMenuId, TitlebarMenuItem[]> = {
  file: [
    { label: 'New thread', shortcut: 'Ctrl N', action: 'new-thread' },
    { separator: true },
    { label: 'Close window', shortcut: 'Alt F4', action: 'close-window' }
  ],
  edit: [
    { label: 'Undo', shortcut: 'Ctrl Z', action: 'undo' },
    { label: 'Redo', shortcut: 'Ctrl Y', action: 'redo' },
    { separator: true },
    { label: 'Cut', shortcut: 'Ctrl X', action: 'cut' },
    { label: 'Copy', shortcut: 'Ctrl C', action: 'copy' },
    { label: 'Paste', shortcut: 'Ctrl V', action: 'paste' },
    { label: 'Select all', shortcut: 'Ctrl A', action: 'select-all' }
  ],
  view: [
    { label: 'Reload', shortcut: 'Ctrl R', action: 'reload' },
    { label: 'Toggle developer tools', shortcut: 'Ctrl Shift I', action: 'toggle-dev-tools' },
    { separator: true },
    { label: 'Toggle full screen', shortcut: 'F11', action: 'toggle-fullscreen' }
  ],
  theme: [
    { label: 'System', theme: 'system' },
    { label: 'Dark', theme: 'dark' },
    { label: 'Light', theme: 'light' }
  ],
  help: [
    { label: 'SupraCode', disabled: true },
    { label: 'Local coding model runner', disabled: true }
  ]
}

function modelDisplayName(modelName: string): string {
  return modelName.split('/').at(-1) ?? modelName
}

function truncateCommand(command: string): string {
  const normalized = command.replace(/\s+/g, ' ').trim()
  return normalized.length <= MAX_ACTIVITY_COMMAND_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_ACTIVITY_COMMAND_CHARACTERS - 1)}…`
}

function activitySweepDurationMs(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--activity-sweep-duration').trim()
  if (value.endsWith('ms')) return Number.parseFloat(value) || DEFAULT_ACTIVITY_SWEEP_DURATION_MS
  if (value.endsWith('s')) return (Number.parseFloat(value) || DEFAULT_ACTIVITY_SWEEP_DURATION_MS / 1_000) * 1_000
  return DEFAULT_ACTIVITY_SWEEP_DURATION_MS
}

function runningToolLabel(toolCall: ToolCallDisplay): string {
  if (toolCall.name === 'cur_task_state') return 'Sharing current task state'
  if (WEB_TOOL_NAMES.has(toolCall.name)) return 'Searching the web'
  if (toolCall.uiMessage?.uim_prt) return toolCall.uiMessage.uim_prt
  if (toolCall.name === 'bash') {
    const command = typeof toolCall.arguments.command === 'string' ? truncateCommand(toolCall.arguments.command) : 'command'
    return `Running ${command}`
  }
  if (['write', 'edit', 'apply_patch'].includes(toolCall.name)) {
    const filePath = typeof toolCall.arguments.filePath === 'string' ? toolCall.arguments.filePath : ''
    return filePath ? `Editing ${filePath}` : 'Editing'
  }
  return 'Thinking'
}

function completedToolLabel(toolCall: ToolCallDisplay): string {
  if (toolCall.name === 'cur_task_state') return 'Shared current task state'
  if (WEB_TOOL_NAMES.has(toolCall.name)) return 'Searched the web'
  if (toolCall.uiMessage?.uim_pat) return toolCall.uiMessage.uim_pat
  if (toolCall.name === 'read') return 'Viewed a file'
  if (toolCall.name === 'grep' || toolCall.name === 'glob' || toolCall.name === 'list') return 'Looked through the project'
  if (toolCall.name === 'write' || toolCall.name === 'edit') return 'Edited one file'
  if (toolCall.name === 'apply_patch') {
    const patch = typeof toolCall.arguments.patch === 'string' ? toolCall.arguments.patch : ''
    const changedFiles = patch.match(/^\*\*\* (?:Add|Update|Delete) File:/gm)?.length ?? 0
    return changedFiles > 1 ? 'Edited multiple files' : 'Edited one file'
  }
  if (toolCall.name === 'bash') return 'Ran a command'
  if (toolCall.name === 'task') return 'Completed delegated work'
  return 'Completed a tool call'
}

function webSearchDetail(toolCall: ToolCallDisplay): string | undefined {
  if (toolCall.name !== 'web_search') return undefined
  return typeof toolCall.arguments.query === 'string' ? toolCall.arguments.query.trim() || undefined : undefined
}

function messageText(content: import('../../main/localCompletionClient').LocalMessageContent): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}

function sourceLineCount(content: string): number {
  if (!content) return 0
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  return lines.at(-1) === '' ? lines.length - 1 : lines.length
}

const blobDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read the pasted image'))
  reader.onerror = () => reject(reader.error ?? new Error('Could not read the pasted image'))
  reader.readAsDataURL(blob)
})

async function pastedImageAttachment(file: File): Promise<ChatAttachment> {
  if (!file.type.startsWith('image/')) throw new Error('Only image files can be attached')
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) throw new Error('Each image must be 10 MB or smaller')
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not prepare the pasted image')
    context.drawImage(bitmap, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not prepare the pasted image')), 'image/png'))
    if (blob.size > MAX_CHAT_ATTACHMENT_BYTES) throw new Error('The converted image must be 10 MB or smaller')
    return {
      id: crypto.randomUUID(),
      name: file.name || 'Pasted image.png',
      mimeType: 'image/png',
      dataUrl: await blobDataUrl(blob),
      size: blob.size
    }
  } finally {
    bitmap.close()
  }
}

function normalizedDisplayPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function legacyFileChangeCounts(path: string, toolCalls: readonly ToolCallDisplay[]): { additions: number; deletions: number } {
  const normalizedPath = normalizedDisplayPath(path)
  let additions = 0
  let deletions = 0

  for (const toolCall of toolCalls) {
    if (toolCall.name === 'write' && typeof toolCall.arguments.filePath === 'string' && normalizedDisplayPath(toolCall.arguments.filePath) === normalizedPath) {
      additions = typeof toolCall.arguments.content === 'string' ? sourceLineCount(toolCall.arguments.content) : additions
      deletions = 0
      continue
    }
    if (toolCall.name === 'edit' && typeof toolCall.arguments.filePath === 'string' && normalizedDisplayPath(toolCall.arguments.filePath) === normalizedPath) {
      additions += typeof toolCall.arguments.newString === 'string' ? sourceLineCount(toolCall.arguments.newString) : 0
      deletions += typeof toolCall.arguments.oldString === 'string' ? sourceLineCount(toolCall.arguments.oldString) : 0
      continue
    }
    if (toolCall.name === 'apply_patch' && typeof toolCall.arguments.patch === 'string') {
      let currentPath = ''
      for (const line of toolCall.arguments.patch.split('\n')) {
        const header = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
        if (header) {
          currentPath = normalizedDisplayPath(header[1].trim())
          continue
        }
        if (currentPath !== normalizedPath) continue
        if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
        if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
      }
    }
  }
  return { additions, deletions }
}

function normalizeRestoredThread(thread: ChatThread): ChatThread {
  const normalized: ChatMessage[] = []
  for (let index = 0; index < thread.messages.length;) {
    const message = thread.messages[index]
    if (message.role !== 'user') {
      index += 1
      continue
    }
    normalized.push(message)
    index += 1
    const turnMessages: ChatMessage[] = []
    while (index < thread.messages.length && thread.messages[index].role !== 'user') {
      turnMessages.push(thread.messages[index])
      index += 1
    }
    const placeholder = [...turnMessages].reverse().find((candidate) => candidate.role === 'assistant')
    const finalAssistant = placeholder?.content ? placeholder : undefined
    const assistantId = finalAssistant?.id ?? placeholder?.id ?? crypto.randomUUID()
    for (const turnMessage of turnMessages) {
      if (turnMessage.role === 'tool') {
        normalized.push({ ...turnMessage, parentAssistantId: assistantId })
        continue
      }
      if (turnMessage.role === 'assistant' && turnMessage.content && turnMessage.id !== finalAssistant?.id) {
        normalized.push({
          id: turnMessage.id,
          role: 'tool',
          content: '__reasoning__',
          reasoningSummary: turnMessage.content,
          parentAssistantId: assistantId,
          timestamp: turnMessage.timestamp
        })
      }
    }
    if (finalAssistant) {
      normalized.push({ ...finalAssistant, id: assistantId, status: 'completed' })
    } else {
      normalized.push({
        ...(placeholder ?? { id: assistantId, role: 'assistant' as const, content: '' }),
        id: assistantId,
        content: '',
        status: 'cancelled'
      })
    }
  }
  return { ...thread, messages: normalized }
}

export default function MainApp(): JSX.Element {
  const [activeView, setActiveView] = useState<MainView>('chat')
  const [prompt, setPrompt] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [downloadedModelIds, setDownloadedModelIds] = useState<Set<string> | null>(null)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('Medium')
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [openTitlebarMenu, setOpenTitlebarMenu] = useState<TitlebarMenuId | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [theme, setTheme] = useState<ThemePreference>('system')
  const [responseStylePreference, setResponseStylePreference] = useState<ResponseStylePreference>({ style: DEFAULT_RESPONSE_STYLE, customInstruction: '' })
  const [projects, setProjects] = useState<Project[]>([])
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectError, setProjectError] = useState('')
  const [projectSaving, setProjectSaving] = useState(false)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [fullyExpandedProjects, setFullyExpandedProjects] = useState<Set<string>>(new Set())
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null)
  const [selectedProjectPath, setSelectedProjectPath] = useState('')
  const [completionState, setCompletionState] = useState<'idle' | 'starting' | 'streaming'>('idle')
  const [completionError, setCompletionError] = useState('')
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)
  const [expandedWorkIds, setExpandedWorkIds] = useState<Set<string>>(new Set())
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [heldActivity, setHeldActivity] = useState<{ assistantId: string; toolCallId: string; label: string; until: number } | null>(null)
  const [presentTenseToolIds, setPresentTenseToolIds] = useState<Set<string>>(new Set())
  const [webSearchActivity, setWebSearchActivity] = useState<{ assistantId: string; text: string; revealedCharacters: number } | null>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const titlebarMenuRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null)
  const promptComposerRef = useRef<HTMLFormElement>(null)
  const projectMenuRef = useRef<HTMLDivElement>(null)
  const projectNameRef = useRef<HTMLInputElement>(null)
  const activeThreadRef = useRef<ChatThread | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const conversationEndRef = useRef<HTMLDivElement>(null)
  const conversationRef = useRef<HTMLDivElement>(null)
  const projectExpansionLoadedRef = useRef(false)
  const viewStateLoadedRef = useRef(false)
  const modelMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startTimeRef = useRef(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activityHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const webSearchRevealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const toolCallStartedAtRef = useRef<Map<string, number>>(new Map())
  const toolTenseTimerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [contextMenu, setContextMenu] = useState<{ thread: ChatThread; x: number; y: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirmThread, setDeleteConfirmThread] = useState<ChatThread | null>(null)
  const [regeneratingThreadId, setRegeneratingThreadId] = useState<string | null>(null)
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null)
  const [exportOptions, setExportOptions] = useState<SettingsExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const [exportState, setExportState] = useState<SettingsExportState>(DEFAULT_EXPORT_STATE)
  const downloadedModels = downloadedModelIds
    ? MODEL_LIST.filter((model) => downloadedModelIds.has(model.id))
    : []
  const composerModels = useMemo<ComposerModel[]>(() => {
    const localModels = downloadedModels.map((model): ComposerModel => ({
      id: model.id,
      source: 'local',
      modelId: model.id,
      displayName: modelDisplayName(model.base_model),
      providerName: 'Local',
      context_length: model.context_length,
      vision: model.vision,
      localModel: model
    }))
    const remoteModels = (connections ?? []).flatMap((connection): ComposerModel[] =>
      connection.selectedModelIds.flatMap((modelId) => {
        const remoteModel = getRemoteModel(modelId)
        if (connection.kind !== 'openai-compatible' && (!remoteModel || !remoteModel.availableOn.includes(connection.kind))) return []
        return [{
          id: `remote:${connection.id}:${modelId}`,
          source: 'remote',
          connectionId: connection.id,
          modelId,
          displayName: remoteModel?.displayName ?? modelDisplayName(modelId),
          providerName: connection.providerName,
          context_length: remoteModel?.contextWindow ?? DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW,
          vision: remoteModel?.inputModalities.includes('image') ?? false,
          remoteModel
        }]
      }))
    return [...localModels, ...remoteModels]
  }, [connections, downloadedModels])
  const selectedModel = composerModels.find((model) => model.id === selectedModelId)

  const contextTokens = useMemo(() => {
    if (!activeThread || !selectedModel) return null
    const totalChars = activeThread.messages.reduce((sum, msg) => sum + msg.content.length, 0)
    const used = Math.max(Math.round(totalChars / 4), 0)
    const total = selectedModel.context_length
    return { used, total, percent: Math.min(Math.round((used / total) * 100), 100) }
  }, [activeThread, selectedModel])

  const clearHeldActivity = (preserveActiveTool = false): void => {
    if (activityHoldTimerRef.current) clearTimeout(activityHoldTimerRef.current)
    activityHoldTimerRef.current = null
    if (webSearchRevealTimerRef.current) clearInterval(webSearchRevealTimerRef.current)
    webSearchRevealTimerRef.current = null
    setHeldActivity((current) => preserveActiveTool && current?.toolCallId && toolCallStartedAtRef.current.has(current.toolCallId) ? current : null)
    if (!preserveActiveTool) setWebSearchActivity(null)
  }

  const revealWebSearchDetail = (assistantId: string, text: string): void => {
    if (webSearchRevealTimerRef.current) clearInterval(webSearchRevealTimerRef.current)
    const startedAt = Date.now()
    const update = (): void => {
      const revealedCharacters = Math.min(text.length, Math.floor(((Date.now() - startedAt) * WEB_SEARCH_REVEAL_CHARACTERS_PER_SECOND) / 1_000))
      setWebSearchActivity({ assistantId, text, revealedCharacters })
      if (revealedCharacters >= text.length && webSearchRevealTimerRef.current) {
        clearInterval(webSearchRevealTimerRef.current)
        webSearchRevealTimerRef.current = null
      }
    }
    update()
    webSearchRevealTimerRef.current = setInterval(update, 16)
  }

  const holdWebActivity = (assistantId: string, toolCallId: string): void => {
    if (activityHoldTimerRef.current) clearTimeout(activityHoldTimerRef.current)
    activityHoldTimerRef.current = null
    setHeldActivity({ assistantId, toolCallId, label: 'Searching the web', until: Number.POSITIVE_INFINITY })
  }

  const holdCompletedActivity = (assistantId: string, toolCallId: string, label: string): void => {
    if (activityHoldTimerRef.current) clearTimeout(activityHoldTimerRef.current)
    activityHoldTimerRef.current = null
    setHeldActivity({ assistantId, toolCallId, label, until: Number.POSITIVE_INFINITY })
  }

  const schedulePastTense = (toolCallId: string, assistantId: string, pastLabel: string): void => {
    const duration = activitySweepDurationMs()
    const startedAt = toolCallStartedAtRef.current.get(toolCallId) ?? Date.now()
    const elapsed = Math.max(0, Date.now() - startedAt)
    const delay = duration - (elapsed % duration)
    const existingTimer = toolTenseTimerRefs.current.get(toolCallId)
    if (existingTimer) clearTimeout(existingTimer)
    const timer = setTimeout(() => {
      toolTenseTimerRefs.current.delete(toolCallId)
      toolCallStartedAtRef.current.delete(toolCallId)
      setPresentTenseToolIds((current) => {
        const next = new Set(current)
        next.delete(toolCallId)
        return next
      })
      setHeldActivity((current) => current?.assistantId === assistantId && current.toolCallId === toolCallId ? { ...current, label: pastLabel } : current)
    }, delay)
    toolTenseTimerRefs.current.set(toolCallId, timer)
  }

  useEffect(() => {
    void window.api.getTheme().then(setTheme)
    void window.api.getResponseStylePreference().then(setResponseStylePreference)
    void window.api.getConnections().then(setConnections).catch(() => setConnections([]))
    void Promise.all([window.api.getProjects(), window.api.getExpandedProjectPaths(), window.api.getChatThreads(), window.api.getWorkspaceViewState()]).then(async ([storedProjects, storedExpandedPaths, storedThreads, storedViewState]) => {
      const projectPaths = new Set(storedProjects.map((project) => project.path))
      const reconciledThreads = await Promise.all(storedThreads.map(async (thread) => {
        const lastMsg = thread.messages.at(-1)
        if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.content || lastMsg.status === 'cancelled' || lastMsg.status === 'error') return normalizeRestoredThread(thread)
        try {
          const session = await window.api.getAgentSession(thread.id, thread.projectPath)
          if (!session) return normalizeRestoredThread(thread)
          const sessionMsgs: ChatMessage[] = []
          const storedUsers = thread.messages.filter((message) => message.role === 'user')
          let userIndex = 0
          for (const m of session.messages) {
            if (m.role === 'user') {
              const content = messageText(m.content)
              if (content.includes('<previous-context-summary>')) continue
              const storedUser = storedUsers[userIndex]
              userIndex += 1
              sessionMsgs.push(storedUser ?? { id: crypto.randomUUID(), role: 'user', content })
            } else if (m.role === 'assistant') {
              const assistantId = crypto.randomUUID()
              const pendingToolCalls = m.toolCalls?.map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                uiMessage: (() => {
                  const value = tc.arguments.ui_message
                  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
                  const candidate = value as { uim_prt?: unknown; uim_pat?: unknown }
                  return typeof candidate.uim_prt === 'string' && typeof candidate.uim_pat === 'string'
                    ? { uim_prt: candidate.uim_prt, uim_pat: candidate.uim_pat }
                    : undefined
                })(),
                result: undefined,
                filePath: undefined
              }))
              if (pendingToolCalls && pendingToolCalls.length > 0) {
                for (const tc of pendingToolCalls) {
                  sessionMsgs.push({ id: crypto.randomUUID(), role: 'tool', content: '', parentAssistantId: assistantId, toolCalls: [tc] })
                }
              }
              const content = messageText(m.content)
              sessionMsgs.push({
                id: assistantId,
                role: 'assistant',
                content,
                status: content ? 'completed' : 'cancelled',
                startedAt: thread.messages.find((message) => message.role === 'assistant')?.startedAt
              })
            } else if (m.role === 'tool' && m.name && m.toolCallId) {
              for (let i = sessionMsgs.length - 1; i >= 0; i--) {
                const tm = sessionMsgs[i]
                if (tm.role === 'tool' && tm.toolCalls) {
                  const tc = tm.toolCalls.find((t) => t.id === m.toolCallId)
                  if (tc) {
                    tc.result = m.content ?? undefined
                    tc.filePath = (m as any).filePath
                    break
                  }
                }
              }
            }
          }
          if (sessionMsgs.length === 0) return thread
          return normalizeRestoredThread({ ...thread, messages: sessionMsgs })
        } catch {
          return normalizeRestoredThread(thread)
        }
      }))
      const restoredThread = reconciledThreads.find((t) => t.id === storedViewState.activeThreadId) ?? null
      setProjects(storedProjects)
      setThreads(reconciledThreads)
      setSelectedProjectPath(projectPaths.has(storedViewState.selectedProjectPath) ? storedViewState.selectedProjectPath : restoredThread?.projectPath ?? storedProjects[0]?.path ?? '')
      setExpandedProjects(new Set(storedExpandedPaths.filter((path) => projectPaths.has(path))))
      setActiveThread(restoredThread)
      activeThreadRef.current = restoredThread
      setSelectedModelId(storedViewState.selectedModelId)
      setReasoningEffort(storedViewState.reasoningEffort)
      setSidebarOpen(storedViewState.sidebarOpen)
      setPrompt(storedViewState.promptDraft)
      setExpandedWorkIds(new Set(storedViewState.expandedWorkIds))
      projectExpansionLoadedRef.current = true
      viewStateLoadedRef.current = true
    })
    void window.api.getDownloadedModels(MODEL_LIST.map((model) => model.hf_repo)).then((downloadedRepos) => {
      const repoSet = new Set(downloadedRepos)
      setDownloadedModelIds(new Set(MODEL_LIST.filter((model) => repoSet.has(model.hf_repo)).map((model) => model.id)))
    }).catch(() => setDownloadedModelIds(new Set()))
  }, [])

  useEffect(() => {
    if (!downloadedModelIds || connections === null || composerModels.some((model) => model.id === selectedModelId)) return
    setSelectedModelId(composerModels[0]?.id ?? '')
  }, [composerModels, connections, downloadedModelIds, selectedModelId])

  useEffect(() => {
    const closeMenus = (event: MouseEvent): void => {
      if (!controlsRef.current?.contains(event.target as Node)) {
        if (modelMenuTimerRef.current) clearTimeout(modelMenuTimerRef.current)
        setOpenMenu(null)
      }
      if (!titlebarMenuRef.current?.contains(event.target as Node)) setOpenTitlebarMenu(null)
      if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false)
      if (contextMenu && !contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null)
    }
    const closeOnKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setContextMenu(null)
        setDeleteConfirmThread(null)
      }
    }
    window.addEventListener('mousedown', closeMenus)
    window.addEventListener('keydown', closeOnKey)
    return () => {
      window.removeEventListener('mousedown', closeMenus)
      window.removeEventListener('keydown', closeOnKey)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!projectExpansionLoadedRef.current) return
    void window.api.setExpandedProjectPaths([...expandedProjects])
  }, [expandedProjects])

  useEffect(() => {
    if (!viewStateLoadedRef.current) return
    const timeout = window.setTimeout(() => {
      void window.api.saveWorkspaceViewState({
        selectedProjectPath,
        activeThreadId: activeThread?.id ?? '',
        selectedModelId,
        reasoningEffort,
        sidebarOpen,
        promptDraft: prompt,
        expandedWorkIds: [...expandedWorkIds]
      })
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [activeThread?.id, expandedWorkIds, prompt, reasoningEffort, selectedModelId, selectedProjectPath, sidebarOpen])

  useEffect(() => window.api.onLocalCompletionEvent((event) => {
    if (event.requestId !== activeRequestIdRef.current) return
    if (event.type === 'delta') {
      const current = activeThreadRef.current
      if (!current) return
      const messages = current.messages.map((message, index) => index === current.messages.length - 1
        ? { ...message, content: message.content + event.delta }
        : message)
      const updated = { ...current, messages, updatedAt: Date.now() }
      activeThreadRef.current = updated
      setActiveThread(updated)
      saveThreadDebounced()
      return
    }
    if (event.type === 'tool-call') {
      const current = activeThreadRef.current
      if (!current) return
      const assistantId = current.messages.at(-1)?.role === 'assistant' ? current.messages.at(-1)?.id : undefined
      toolCallStartedAtRef.current.set(event.toolCallId, Date.now())
      setPresentTenseToolIds((current) => new Set(current).add(event.toolCallId))
      if (assistantId) {
        if (WEB_TOOL_NAMES.has(event.name)) {
          holdWebActivity(assistantId, event.toolCallId)
          const detail = webSearchDetail({ id: event.toolCallId, name: event.name, arguments: event.arguments })
          if (detail) revealWebSearchDetail(assistantId, detail)
        }
        else clearHeldActivity()
      }
      const toolMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'tool',
        content: '',
        timestamp: Date.now(),
        parentAssistantId: assistantId,
        toolCalls: [{ id: event.toolCallId, name: event.name, arguments: event.arguments, uiMessage: event.summary }]
      }
      const lastIdx = current.messages.length - 1
      const messages = [
        ...current.messages.slice(0, lastIdx),
        toolMessage,
        current.messages[lastIdx]
      ]
      const updated = { ...current, messages, updatedAt: Date.now() }
      activeThreadRef.current = updated
      setActiveThread(updated)
      saveThreadImmediate()
      return
    }
    if (event.type === 'tool-result') {
      const current = activeThreadRef.current
      if (!current) return
      const completedToolMessage = current.messages.find((message) => message.role === 'tool' && message.toolCalls?.some((toolCall) => toolCall.id === event.toolCallId))
      const completedToolCall = completedToolMessage?.toolCalls?.find((toolCall) => toolCall.id === event.toolCallId)
      if (completedToolCall && WEB_TOOL_NAMES.has(completedToolCall.name) && completedToolMessage?.parentAssistantId) {
        holdWebActivity(completedToolMessage.parentAssistantId, event.toolCallId)
        schedulePastTense(event.toolCallId, completedToolMessage.parentAssistantId, completedToolLabel(completedToolCall))
      } else if (completedToolCall && completedToolMessage?.parentAssistantId) {
        holdCompletedActivity(completedToolMessage.parentAssistantId, event.toolCallId, runningToolLabel(completedToolCall))
        schedulePastTense(event.toolCallId, completedToolMessage.parentAssistantId, completedToolLabel(completedToolCall))
      }
      const messages = current.messages.map((message) =>
        message.role === 'tool' && message.toolCalls?.some((tc) => tc.id === event.toolCallId)
          ? {
              ...message,
              content: event.result,
              toolCalls: message.toolCalls.map((tc) =>
                tc.id === event.toolCallId ? { ...tc, result: event.result, filePath: event.filePath } : tc
              )
            }
          : message
      )
      const updated = { ...current, messages, updatedAt: Date.now() }
      activeThreadRef.current = updated
      setActiveThread(updated)
      saveThreadDebounced()
      return
    }
    if (event.type === 'progress-update') {
      const current = activeThreadRef.current
      if (!current) return
      clearHeldActivity(true)
      const pendingAssistant = [...current.messages].reverse().find((message) => message.role === 'assistant' && message.status === 'pending')
      if (!pendingAssistant) return
      const lastProgressIndex = current.messages.findLastIndex((message) =>
        message.role === 'tool' && message.content === '__progress__' && message.parentAssistantId === pendingAssistant.id
      )
      const lastToolCallIndex = current.messages.findLastIndex((message) =>
        message.role === 'tool' && message.parentAssistantId === pendingAssistant.id && (message.toolCalls?.length ?? 0) > 0
      )
      const existingProgress = lastProgressIndex > lastToolCallIndex ? current.messages[lastProgressIndex] : undefined
      if (existingProgress) {
        const messages = current.messages.map((message) => message.id === existingProgress.id
          ? { ...message, reasoningSummary: event.summary }
          : message)
        const updated = { ...current, messages, updatedAt: Date.now() }
        activeThreadRef.current = updated
        setActiveThread(updated)
        saveThreadDebounced()
        return
      }
      const progressMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'tool',
        content: '__progress__',
        timestamp: Date.now(),
        parentAssistantId: pendingAssistant.id,
        reasoningSummary: event.summary
      }
      const lastIdx = current.messages.length - 1
      const messages = [...current.messages.slice(0, lastIdx), progressMessage, current.messages[lastIdx]]
      const updated = { ...current, messages, updatedAt: Date.now() }
      activeThreadRef.current = updated
      setActiveThread(updated)
      saveThreadImmediate()
      return
    }
    if (event.type === 'tool-error') {
      const current = activeThreadRef.current
      if (!current) return
      const failedToolMessage = current.messages.find((message) => message.role === 'tool' && message.toolCalls?.some((toolCall) => toolCall.id === event.toolCallId))
      const failedToolCall = failedToolMessage?.toolCalls?.find((toolCall) => toolCall.id === event.toolCallId)
      if (failedToolCall && WEB_TOOL_NAMES.has(failedToolCall.name) && failedToolMessage?.parentAssistantId) {
        holdWebActivity(failedToolMessage.parentAssistantId, event.toolCallId)
        schedulePastTense(event.toolCallId, failedToolMessage.parentAssistantId, completedToolLabel(failedToolCall))
      } else if (failedToolCall && failedToolMessage?.parentAssistantId) {
        holdCompletedActivity(failedToolMessage.parentAssistantId, event.toolCallId, runningToolLabel(failedToolCall))
        schedulePastTense(event.toolCallId, failedToolMessage.parentAssistantId, completedToolLabel(failedToolCall))
      }
      const messages = current.messages.map((message) =>
        message.role === 'tool' && message.toolCalls?.some((tc) => tc.id === event.toolCallId)
          ? {
              ...message,
              content: '',
              toolCalls: message.toolCalls.map((tc) =>
                tc.id === event.toolCallId ? { ...tc, error: event.error } : tc
              )
            }
          : message
      )
      const updated = { ...current, messages, updatedAt: Date.now() }
      activeThreadRef.current = updated
      setActiveThread(updated)
      saveThreadImmediate()
      return
    }
    if (event.type === 'reasoning-summary') {
      const current = activeThreadRef.current
      if (!current) return
      const pendingAssistant = [...current.messages].reverse().find((message) => message.role === 'assistant' && message.status === 'pending')
      const existingSummary = current.messages.find((m) => m.role === 'tool' && m.content === '__reasoning__' && m.parentAssistantId === pendingAssistant?.id)
      if (existingSummary) {
        const messages = current.messages.map((m) =>
          m.id === existingSummary.id ? { ...m, content: '__reasoning__', reasoningSummary: event.summary } : m
        )
        const updated = { ...current, messages, updatedAt: Date.now() }
        activeThreadRef.current = updated
        setActiveThread(updated)
        saveThreadImmediate()
        return
      }
      const firstToolIdx = current.messages.findIndex((m) => m.role === 'tool')
      const reasoningMsg: ChatMessage = { id: crypto.randomUUID(), role: 'tool', content: '__reasoning__', timestamp: Date.now(), parentAssistantId: pendingAssistant?.id, reasoningSummary: event.summary }
      let messages: ChatMessage[]
      if (firstToolIdx >= 0) {
        messages = [...current.messages.slice(0, firstToolIdx), reasoningMsg, ...current.messages.slice(firstToolIdx)]
      } else {
        const lastIdx = current.messages.length - 1
        messages = [...current.messages.slice(0, lastIdx), reasoningMsg, current.messages[lastIdx]]
      }
      const updated = { ...current, messages, updatedAt: Date.now() }
      activeThreadRef.current = updated
      setActiveThread(updated)
      saveThreadDebounced()
      return
    }
    if (event.type === 'files-changed') {
      const current = activeThreadRef.current
      if (!current) return
      const messages = current.messages.map((message, index) =>
        index === current.messages.length - 1 && message.role === 'assistant'
          ? { ...message, fileChanges: event.files }
          : message
      )
      const updated = { ...current, messages, updatedAt: Date.now() }
      activeThreadRef.current = updated
      setActiveThread(updated)
      saveThreadImmediate()
      return
    }
    if (event.type === 'error') {
      const current = activeThreadRef.current
      if (current) {
        const messages = current.messages.map((message, index) => index === current.messages.length - 1 && !message.content
          ? { ...message, status: 'error' as const }
          : message)
        const updated = { ...current, messages, updatedAt: Date.now() }
        activeThreadRef.current = updated
        setActiveThread(updated)
      }
      setCompletionError(event.message)
    }
    const completed = activeThreadRef.current
    if (completed) {
      const completedAt = Date.now()
      const status = event.type === 'cancelled' ? 'cancelled' as const : event.type === 'error' ? 'error' as const : 'completed' as const
      const messages = completed.messages.map((message, index) => index === completed.messages.length - 1 && message.role === 'assistant'
        ? {
            ...message,
            status,
            completedAt,
            durationMs: Math.max(0, completedAt - (message.startedAt ?? startTimeRef.current ?? completedAt))
          }
        : message)
      const finalThread = { ...completed, messages, updatedAt: completedAt }
      const completedAssistantId = completed.messages.at(-1)?.role === 'assistant' ? completed.messages.at(-1)?.id : undefined
      if (completedAssistantId) setExpandedWorkIds((current) => {
        const next = new Set(current)
        next.delete(completedAssistantId)
        return next
      })
      activeThreadRef.current = finalThread
      setActiveThread(finalThread)
      setThreads((current) => [finalThread, ...current.filter((thread) => thread.id !== finalThread.id)])
      void window.api.saveChatThread(finalThread)
    }
    activeRequestIdRef.current = null
    setCompletionState('idle')
  }), [])

  useEffect(() => () => {
    if (activityHoldTimerRef.current) clearTimeout(activityHoldTimerRef.current)
    if (webSearchRevealTimerRef.current) clearInterval(webSearchRevealTimerRef.current)
    for (const timer of toolTenseTimerRefs.current.values()) clearTimeout(timer)
  }, [])

  useLayoutEffect(() => {
    const target = conversationRef.current
    if (!target) return
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    setAutoScrollEnabled(distanceFromBottom <= AUTO_SCROLL_THRESHOLD)
  }, [activeThread])

  useEffect(() => {
    if (!projectDialogOpen) return
    projectNameRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !projectSaving) setProjectDialogOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [projectDialogOpen, projectSaving])

  useEffect(() => {
    if (!renamingThreadId) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renamingThreadId])

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      event.preventDefault()
      const currentIndex = REASONING_EFFORTS.indexOf(reasoningEffort)
      if (event.key === 'ArrowRight') {
        const next = (currentIndex + 1) % REASONING_EFFORTS.length
        setReasoningEffort(REASONING_EFFORTS[next])
      } else {
        const prev = (currentIndex - 1 + REASONING_EFFORTS.length) % REASONING_EFFORTS.length
        setReasoningEffort(REASONING_EFFORTS[prev])
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [reasoningEffort])

  useLayoutEffect(() => {
    const textarea = promptTextareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [prompt])

  const runTitlebarAction = (action: TitlebarAction): void => {
    setOpenTitlebarMenu(null)
    if (action === 'new-thread') startNewThread()
    if (action === 'close-window') window.api.close()
    if (action === 'reload') window.api.runWindowCommand(WINDOW_COMMANDS.reload)
    if (action === 'toggle-dev-tools') window.api.runWindowCommand(WINDOW_COMMANDS.toggleDevTools)
    if (action === 'toggle-fullscreen') window.api.runWindowCommand(WINDOW_COMMANDS.toggleFullscreen)
    const editCommands: Partial<Record<TitlebarAction, string>> = {
      undo: 'undo',
      redo: 'redo',
      cut: 'cut',
      copy: 'copy',
      paste: 'paste',
      'select-all': 'selectAll'
    }
    const editCommand = editCommands[action]
    if (!editCommand) return
    previousFocusRef.current?.focus()
    document.execCommand(editCommand)
  }

  const selectTheme = (nextTheme: ThemePreference): void => {
    setTheme(nextTheme)
    setOpenTitlebarMenu(null)
    void window.api.setTheme(nextTheme).catch(() => {
      void window.api.getTheme().then(setTheme)
    })
  }

  const openCreateProjectDialog = (): void => {
    setProjectMenuOpen(false)
    setProjectName('')
    setProjectError('')
    setProjectDialogOpen(true)
  }

  const chooseProjectFolder = async (): Promise<void> => {
    setProjectMenuOpen(false)
    const project = await window.api.chooseProjectFolder()
    if (project) {
      setProjects((current) => [project, ...current.filter((item) => item.path !== project.path)])
      setSelectedProjectPath(project.path)
      setExpandedProjects((current) => new Set(current).add(project.path))
      startNewThread()
    }
  }

  const createProject = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!projectName.trim() || projectSaving) return
    setProjectSaving(true)
    setProjectError('')
    try {
      const project = await window.api.createProject(projectName)
      setProjects((current) => [project, ...current.filter((item) => item.path !== project.path)])
      setSelectedProjectPath(project.path)
      setExpandedProjects((current) => new Set(current).add(project.path))
      setProjectDialogOpen(false)
    } catch (error) {
      setProjectError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Could not create the project')
    } finally {
      setProjectSaving(false)
    }
  }

  const startNewThread = (): void => {
    setActiveView('chat')
    setActiveView('chat')
    if (activeRequestIdRef.current) void window.api.cancelLocalCompletion(activeRequestIdRef.current)
    activeRequestIdRef.current = null
    activeThreadRef.current = null
    setActiveThread(null)
    setCompletionState('idle')
    setCompletionError('')
    setPendingAttachments([])
    setAttachmentError('')
    clearHeldActivity()
    setPrompt('')
    setAutoScrollEnabled(true)
    promptTextareaRef.current?.focus()
  }

  const renameThread = (thread: ChatThread): void => {
    setContextMenu(null)
    setRenamingThreadId(thread.id)
    setRenameValue(thread.title)
  }

  const commitRename = (thread: ChatThread): void => {
    const title = renameValue.trim()
    if (!title) {
      setRenamingThreadId(null)
      return
    }
    const updated = { ...thread, title, updatedAt: Date.now() }
    if (activeThreadRef.current?.id === thread.id) {
      activeThreadRef.current = updated
      setActiveThread(updated)
    }
    setThreads((items) => [updated, ...items.filter((item) => item.id !== updated.id)])
    setRenamingThreadId(null)
    void window.api.saveChatThread(updated)
  }

  const regenerateThreadTitle = async (thread: ChatThread): Promise<void> => {
    setContextMenu(null)
    const firstUserMsg = thread.messages.find((m) => m.role === 'user')
    if (!firstUserMsg) return
    setRegeneratingThreadId(thread.id)
    try {
      const title = await window.api.generateChatTitle(firstUserMsg.content)
      if (!title) return
      const updated = { ...thread, title, updatedAt: Date.now() }
      if (activeThreadRef.current?.id === thread.id) {
        activeThreadRef.current = updated
        setActiveThread(updated)
      }
      setThreads((items) => [updated, ...items.filter((item) => item.id !== updated.id)])
      void window.api.saveChatThread(updated)
    } finally {
      setRegeneratingThreadId(null)
    }
  }

  const confirmDeleteThread = async (): Promise<void> => {
    const thread = deleteConfirmThread
    if (!thread) return
    setDeleteConfirmThread(null)
    setContextMenu(null)
    if (activeThreadRef.current?.id === thread.id) {
      activeThreadRef.current = null
      setActiveThread(null)
      setCompletionError('')
    }
    setThreads((items) => items.filter((item) => item.id !== thread.id))
    void window.api.deleteChatThread(thread.id)
  }

  const startProjectThread = (project: Project): void => {
    setSelectedProjectPath(project.path)
    setExpandedProjects((current) => new Set(current).add(project.path))
    startNewThread()
  }

  const toggleProject = (project: Project): void => {
    setSelectedProjectPath(project.path)
    setExpandedProjects((current) => {
      const next = new Set(current)
      if (next.has(project.path)) next.delete(project.path)
      else next.add(project.path)
      return next
    })
  }

  const openThread = (thread: ChatThread): void => {
    if (activeRequestIdRef.current) return
    setActiveView('chat')
    setActiveView('chat')
    activeThreadRef.current = thread
    setActiveThread(thread)
    setSelectedProjectPath(thread.projectPath)
    setCompletionError('')
    setAutoScrollEnabled(true)
  }

  const updateThreadTitle = async (threadId: string, userMessage: string): Promise<void> => {
    try {
      const title = await window.api.generateChatTitle(userMessage)
      const current = activeThreadRef.current
      if (!current || current.id !== threadId || !title) return
      const updated = { ...current, title, updatedAt: Date.now() }
      activeThreadRef.current = updated
      setActiveThread(updated)
      setThreads((items) => [updated, ...items.filter((item) => item.id !== updated.id)])
      await window.api.saveChatThread(updated)
    } catch {
      return
    }
  }

  const formatDurationShort = (durationMs: number): string => {
    const seconds = Math.max(1, Math.round(durationMs / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`
  }

  const chooseChatImages = async (): Promise<void> => {
    setAttachmentError('')
    try {
      const selected = await window.api.chooseChatImages()
      if (selected.length === 0) return
      setPendingAttachments((current) => [...current, ...selected].slice(0, MAX_CHAT_ATTACHMENTS))
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Could not attach the image')
    }
  }

  const pasteChatImages = async (files: File[]): Promise<void> => {
    setAttachmentError('')
    try {
      const availableSlots = Math.max(0, MAX_CHAT_ATTACHMENTS - pendingAttachments.length)
      if (availableSlots === 0) throw new Error(`You can attach up to ${MAX_CHAT_ATTACHMENTS} images`)
      const attachments = await Promise.all(files.slice(0, availableSlots).map(pastedImageAttachment))
      setPendingAttachments((current) => [...current, ...attachments].slice(0, MAX_CHAT_ATTACHMENTS))
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Could not paste the image')
    }
  }

  const saveThreadDebounced = (): void => {
    if (saveTimerRef.current) return
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      const current = activeThreadRef.current
      if (current) void window.api.saveChatThread(current)
    }, 400)
  }

  const saveThreadImmediate = (): void => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const current = activeThreadRef.current
    if (current) void window.api.saveChatThread(current)
  }

  const exportRequest = (options: SettingsExportOptions): SettingsExportOptions => ({
    ...options,
    threadId: options.scope === 'thread' ? activeThread?.id : undefined,
    projectPath: options.scope === 'project' ? selectedProjectPath : undefined
  })

  const saveProviderConnection = async ({ input, connectionId }: SettingsConnectionRequest): Promise<void> => {
    const result = await window.api.saveConnection(input, connectionId)
    if (!result.ok) throw new Error(result.error)
    setConnections((current) => [...(current ?? []).filter((connection) => connection.id !== result.connection.id), result.connection])
  }

  const testProviderConnection = ({ input, connectionId }: SettingsConnectionRequest): Promise<SettingsConnectionTestResult> =>
    window.api.testConnection(input, connectionId)

  const disconnectProvider = async (connectionId: string): Promise<void> => {
    await window.api.deleteConnection(connectionId)
    setConnections((current) => (current ?? []).filter((connection) => connection.id !== connectionId))
  }

  const updateProviderModels = async (connectionId: string, selectedModelIds: readonly string[]): Promise<void> => {
    const result = await window.api.updateConnectionModels(connectionId, [...selectedModelIds])
    if (!result.ok) throw new Error(result.error)
    setConnections((current) => [...(current ?? []).filter((connection) => connection.id !== connectionId), result.connection])
  }

  const updateExportOptions = (options: SettingsExportOptions): void => {
    const request = exportRequest(options)
    setExportOptions(request)
    void window.api.previewConversationExport(request).then((preview) => setExportState((current) => ({ ...current, preview, error: undefined }))).catch((error) => setExportState((current) => ({ ...current, error: error instanceof Error ? error.message : 'Could not preview export' })))
  }

  const runExport = async (options: SettingsExportOptions): Promise<void> => {
    setExportState((current) => ({ ...current, busy: true, error: undefined }))
    try {
      const result = await window.api.exportConversations(exportRequest(options))
      setExportState((current) => ({ ...current, busy: false, result }))
    } catch (error) {
      setExportState((current) => ({ ...current, busy: false, error: error instanceof Error ? error.message : 'Could not export conversations' }))
    }
  }

  const submitPrompt = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const content = prompt.trim()
    if ((!content && pendingAttachments.length === 0) || completionState !== 'idle' || !selectedModel) return
    if (pendingAttachments.length > 0 && !selectedModel.vision) {
      setAttachmentError('The selected model does not support images')
      return
    }
    const isNewThread = !activeThreadRef.current
    const threadId = activeThreadRef.current?.id ?? crypto.randomUUID()
    const projectPath = activeThreadRef.current?.projectPath ?? selectedProjectPath ?? projects[0]?.path ?? ''
    const now = Date.now()
    const modelProvenance: AgentModelProvenance = selectedModel.source === 'local'
      ? {
          source: 'local',
          provider: selectedModel.providerName,
          modelId: selectedModel.modelId,
          displayName: selectedModel.displayName,
          reasoningRetention: 'retain'
        }
      : {
          source: 'remote',
          connectionId: selectedModel.connectionId,
          provider: selectedModel.providerName,
          modelId: selectedModel.modelId,
          displayName: selectedModel.displayName,
          reasoningRetention: selectedModel.remoteModel && shouldRetainRawReasoning(selectedModel.remoteModel) ? 'retain' : 'discard'
        }
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content, attachments: pendingAttachments, timestamp: now }
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', timestamp: now, startedAt: now, status: 'pending', model: modelProvenance }
    const thread: ChatThread = {
      id: threadId,
      projectPath,
      title: activeThreadRef.current?.title ?? (content.slice(0, 44) || 'Image request'),
      messages: [...(activeThreadRef.current?.messages ?? []), userMessage, assistantMessage],
      updatedAt: Date.now()
    }
    activeThreadRef.current = thread
    setActiveThread(thread)
    setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)])
    if (projectPath) setExpandedProjects((current) => new Set(current).add(projectPath))
    setPrompt('')
    setPendingAttachments([])
    setAttachmentError('')
    setCompletionError('')
    setCompletionState('starting')
    setAutoScrollEnabled(true)
    void window.api.saveChatThread(thread)
    if (isNewThread && content) void updateThreadTitle(threadId, content)
    startTimeRef.current = Date.now()
    try {
      if (selectedModel.source === 'local') {
        const localModel = selectedModel.localModel
        if (!localModel) throw new Error('The selected local model is unavailable')
        const status = await window.api.startDownloadedModel(localModel.hf_repo, localModel.gguf_file, pendingAttachments.length > 0)
        if (status.state !== 'ready') throw new Error(status.message ?? 'The local model could not start')
      }
      const messages = thread.messages.flatMap((message) => {
        if (message.role === 'tool' || (message.role === 'assistant' && !message.content)) return []
        if (message.role === 'user' && message.attachments?.length) {
          return [{
            role: 'user' as const,
            content: [
              ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
              ...message.attachments.map((attachment) => ({ type: 'image_url' as const, image_url: { url: attachment.dataUrl } }))
            ]
          }]
        }
        return message.content ? [{ role: message.role as 'user' | 'assistant', content: message.content }] : []
      })
      const localProfile = selectedModel.localModel ? reasoningProfile(selectedModel.localModel, reasoningEffort) : undefined
      const systemPrompt = localProfile
        ? `${localProfile.systemPrompt}\n\n${responseStylePrompt(responseStylePreference)}`
        : responseStylePrompt(responseStylePreference)
      const target: AgentExecutionTarget = selectedModel.source === 'local'
        ? { source: 'local', modelId: selectedModel.modelId, displayName: selectedModel.displayName }
        : { source: 'remote', connectionId: selectedModel.connectionId ?? '', modelId: selectedModel.modelId, reasoningEffort }
      const start = await window.api.startAgentCompletion(target, {
        threadId,
        projectPath,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        enableThinking: localProfile?.enableThinking ?? reasoningEffort !== 'Instant',
        temperature: localProfile?.temperature,
        topP: localProfile?.topP,
        topK: localProfile?.topK,
        minP: localProfile?.minP,
        presencePenalty: localProfile?.presencePenalty,
        repetitionPenalty: localProfile?.repetitionPenalty,
        maxTokens: DEFAULT_AGENT_MAX_TOKENS
      })
      activeRequestIdRef.current = start.requestId
      setCompletionState('streaming')
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'The selected model could not start')
      const current = activeThreadRef.current
      if (current) {
        const completedAt = Date.now()
        const messages = current.messages.map((message) => message.id === assistantMessage.id
          ? { ...message, status: 'error' as const, completedAt, durationMs: completedAt - now }
          : message)
        const failedThread = { ...current, messages, updatedAt: completedAt }
        activeThreadRef.current = failedThread
        setActiveThread(failedThread)
        setThreads((items) => [failedThread, ...items.filter((item) => item.id !== failedThread.id)])
        void window.api.saveChatThread(failedThread)
      }
      setCompletionState('idle')
    }
  }

  return (
    <>
      <header className="app-titlebar">
        <div className="titlebar-actions">
          <button className="titlebar-icon-button" type="button" aria-label="Toggle sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((current) => !current)}><PanelLeft size={16} /></button>
          <button className="titlebar-icon-button" type="button" aria-label="Go back" disabled><ChevronLeft size={16} /></button>
          <button className="titlebar-icon-button" type="button" aria-label="Go forward" disabled><ChevronRight size={16} /></button>
          <nav className="titlebar-menu" aria-label="Application menu" ref={titlebarMenuRef}>
            {(Object.keys(TITLEBAR_MENUS) as TitlebarMenuId[]).map((menuId) => (
              <div className="titlebar-menu-group" key={menuId}>
                <button
                  className={openTitlebarMenu === menuId ? 'titlebar-menu-trigger open' : 'titlebar-menu-trigger'}
                  type="button"
                  aria-expanded={openTitlebarMenu === menuId}
                  aria-haspopup="menu"
                  onMouseDown={() => { previousFocusRef.current = document.activeElement as HTMLElement }}
                  onClick={() => setOpenTitlebarMenu((current) => current === menuId ? null : menuId)}
                >
                  {menuId[0].toUpperCase() + menuId.slice(1)}
                </button>
                {openTitlebarMenu === menuId && (
                  <div className="titlebar-dropdown" role="menu">
                    {TITLEBAR_MENUS[menuId].map((item, index) => item.separator ? (
                      <div className="titlebar-dropdown-separator" key={`separator-${index}`} />
                    ) : (
                      <button
                        className="titlebar-dropdown-item"
                        disabled={item.disabled}
                        key={item.label}
                        role="menuitem"
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => item.theme ? selectTheme(item.theme) : item.action && runTitlebarAction(item.action)}
                      >
                        <span>{item.label}</span>
                        {item.shortcut && <kbd>{item.shortcut}</kbd>}
                        {item.theme && <span className="titlebar-menu-check" aria-hidden="true">{theme === item.theme ? '✓' : ''}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </nav>
        </div>
        <div className="titlebar-drag-region" aria-hidden="true" />
      </header>
      <WindowControls showMaximize />
      <main className={sidebarOpen ? 'app-shell' : 'app-shell sidebar-collapsed'}>
        <aside className="app-sidebar">
        <nav className="sidebar-nav" aria-label="Primary navigation">
          <button className="sidebar-action" type="button" onClick={startNewThread}>
            <SquarePen size={16} />
            <span>New thread</span>
            <kbd>Ctrl N</kbd>
          </button>
          <button className="sidebar-action" type="button">
            <Search size={16} />
            <span>Search</span>
            <kbd>Ctrl K</kbd>
          </button>
          <button className={activeView === 'settings' ? 'sidebar-action active' : 'sidebar-action'} type="button" aria-current={activeView === 'settings' ? 'page' : undefined} onClick={() => setActiveView('settings')}>
            <Settings2 size={16} />
            <span>Settings</span>
          </button>
        </nav>
        <div className="sidebar-section">
          <div className="sidebar-section-heading">
            <div className="sidebar-section-label">Projects</div>
            <div className="project-add-wrap" ref={projectMenuRef}>
              <button className="project-add-button" type="button" aria-label="Add project" aria-haspopup="menu" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((current) => !current)}><FolderPlus size={14} /></button>
              {projectMenuOpen && (
                <div className="project-add-menu" role="menu">
                  <button type="button" role="menuitem" onClick={openCreateProjectDialog}>Start from scratch</button>
                  <button type="button" role="menuitem" onClick={() => void chooseProjectFolder()}>Use an existing folder</button>
                </div>
              )}
            </div>
          </div>
          {projects.length === 0
            ? <p className="sidebar-empty-message">Your projects will appear here.</p>
            : <div className="project-list">{projects.map((project) => {
              const projectThreads = threads.filter((thread) => thread.projectPath === project.path)
              const expanded = expandedProjects.has(project.path)
              const showAllThreads = fullyExpandedProjects.has(project.path)
              const visibleThreads = projectThreads.slice(0, showAllThreads ? projectThreads.length : 5)
              const showMoreThreads = projectThreads.length > 5 && !showAllThreads
              const visibleThreadItemCount = visibleThreads.length + Number(showMoreThreads)
              return (
                <div className={expanded ? 'project-group expanded' : 'project-group'} key={project.path}>
                  <div className={selectedProjectPath === project.path && !activeThread ? 'project-row selected' : 'project-row'}>
                    <button className="project-row-main" type="button" title={project.path} aria-expanded={expanded} onClick={() => toggleProject(project)}><FolderOpen size={14} /><span>{project.name}</span></button>
                    <button className="project-new-thread" type="button" aria-label={`New thread in ${project.name}`} title={`New thread in ${project.name}`} onClick={() => startProjectThread(project)}><SquarePen size={15} /></button>
                  </div>
                  <div className="project-threads-shell" aria-hidden={!expanded} inert={!expanded}>
                    <div className="project-threads">
                      {visibleThreads.map((thread, index) =>
                        renamingThreadId === thread.id ? (
                          <input
                            ref={renameInputRef}
                            className="project-thread-rename-input"
                            key={thread.id}
                            style={projectThreadAnimationStyle(index, visibleThreadItemCount)}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => commitRename(thread)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename(thread)
                              if (e.key === 'Escape') setRenamingThreadId(null)
                            }}
                          />
                        ) : (
                          <button
                            className={activeThread?.id === thread.id ? 'project-thread active' : 'project-thread'}
                            type="button"
                            key={thread.id}
                            style={projectThreadAnimationStyle(index, visibleThreadItemCount)}
                            onClick={() => openThread(thread)}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              setContextMenu({ thread, x: e.clientX, y: e.clientY })
                            }}
                          >
                            {regeneratingThreadId === thread.id ? 'Generating...' : thread.title}
                          </button>
                        )
                      )}
                      {showMoreThreads && <button className="project-show-more" style={projectThreadAnimationStyle(visibleThreads.length, visibleThreadItemCount)} type="button" onClick={() => setFullyExpandedProjects((current) => new Set(current).add(project.path))}>Show more</button>}
                    </div>
                  </div>
                </div>
              )
            })}</div>}
        </div>
        </aside>

        <section className="app-workspace">
        {activeView === 'settings' ? (
          <SettingsPage
            connections={connections ?? []}
            catalog={REMOTE_MODEL_CATALOG}
            exportOptions={exportRequest(exportOptions)}
            exportState={exportState}
            onSaveConnection={saveProviderConnection}
            onTestConnection={testProviderConnection}
            onDisconnectConnection={disconnectProvider}
            onUpdateModelSelection={updateProviderModels}
            onExportOptionsChange={updateExportOptions}
            onExport={runExport}
            onClose={() => setActiveView('chat')}
          />
        ) : <>
        {activeThread ? (
          <div
            className="conversation"
            aria-live="polite"
            ref={conversationRef}
            onWheel={(event) => { if (event.deltaY < 0) setAutoScrollEnabled(false) }}
            onScroll={(event) => {
              const target = event.currentTarget
              const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight
              setAutoScrollEnabled(distanceFromBottom <= AUTO_SCROLL_THRESHOLD)
            }}
          >
            <div className="conversation-inner">
              {activeThread.messages.map((message, messageIndex) => {
                if (message.role === 'user') {
                  return (
                    <div className="user-turn" key={message.id}>
                      {message.attachments && message.attachments.length > 0 && (
                        <div className="message-attachments">
                          {message.attachments.map((attachment) => <img src={attachment.dataUrl} alt={attachment.name} title={attachment.name} key={attachment.id} />)}
                        </div>
                      )}
                      {message.content && (
                        <div className="chat-message user-message">
                          <button className="copy-user-message" onClick={() => navigator.clipboard.writeText(message.content)} title="Copy message">
                            <Copy className="copy-user-message-icon" width={14} height={14} />
                          </button>
                          <MarkdownMessage content={message.content} />
                        </div>
                      )}
                    </div>
                  )
                }
                if (message.role === 'tool') {
                  const parent = message.parentAssistantId
                    ? activeThread.messages.find((candidate) => candidate.id === message.parentAssistantId)
                    : activeThread.messages.slice(messageIndex + 1).find((candidate) => candidate.role === 'assistant')
                  const parentToolCalls = parent
                    ? activeThread.messages.filter((candidate) => candidate.role === 'tool' && candidate.parentAssistantId === parent.id).flatMap((candidate) => candidate.toolCalls ?? [])
                    : []
                  if (message.content === '__progress__' && message.reasoningSummary) {
                    if (parent?.role === 'assistant' && parent.status !== 'pending' && !expandedWorkIds.has(parent.id)) return null
                    return (
                      <div className="chat-message progress-message" key={message.id}>
                        <span>{message.reasoningSummary}</span>
                      </div>
                    )
                  }
                  const parentIsFinished = parent?.role === 'assistant' && parent.status !== 'pending'
                  if (parentIsFinished && parent && !expandedWorkIds.has(parent.id)) return null
                  if (message.content === '__reasoning__' && message.reasoningSummary) {
                    return (
                      <div className="chat-message reasoning-message" key={message.id}>
                        <div className="reasoning-summary">
                          <span className="reasoning-summary-text">{message.reasoningSummary}</span>
                        </div>
                      </div>
                    )
                  }
                  if (message.toolCalls?.every((toolCall) => toolCall.result === undefined && !toolCall.error)) return null
                  const hasLaterProgress = activeThread.messages.slice(messageIndex + 1).some((candidate) =>
                    candidate.role === 'tool' && candidate.parentAssistantId === parent?.id && candidate.content === '__progress__'
                  )
                  if (!parentIsFinished && !hasLaterProgress) return null
                  const previousProgressOffset = activeThread.messages.slice(0, messageIndex).findLastIndex((candidate) =>
                    candidate.role === 'tool' && candidate.parentAssistantId === parent?.id && candidate.content === '__progress__'
                  )
                  const nextProgressOffset = activeThread.messages.slice(messageIndex + 1).findIndex((candidate) =>
                    candidate.role === 'tool' && candidate.parentAssistantId === parent?.id && candidate.content === '__progress__'
                  )
                  const phaseStart = previousProgressOffset + 1
                  const phaseEnd = nextProgressOffset >= 0 ? messageIndex + 1 + nextProgressOffset : activeThread.messages.length
                  const phaseToolMessages = activeThread.messages.slice(phaseStart, phaseEnd).filter((candidate) =>
                    candidate.role === 'tool' && candidate.parentAssistantId === parent?.id && (candidate.toolCalls?.length ?? 0) > 0
                  )
                  if (phaseToolMessages.at(-1)?.id !== message.id) return null
                  const phaseToolCalls = phaseToolMessages.flatMap((candidate) => candidate.toolCalls ?? [])
                  const bundleCall = phaseToolCalls.at(-1)
                  if (!bundleCall) return null
                  const bundleRunning = bundleCall.result === undefined && !bundleCall.error
                  const bundleUsesPresentTense = bundleRunning || presentTenseToolIds.has(bundleCall.id)
                  const BundleIcon = toolIconMap[bundleCall.name] ?? toolIconMap.default
                  const bundleLabel = bundleUsesPresentTense ? runningToolLabel(bundleCall) : completedToolLabel(bundleCall)
                  return (
                    <div className="chat-message tool-message" key={message.id}>
                      <details className="tool-bundle">
                        <summary className="tool-bundle-summary">
                          <span className="tool-call-icon"><BundleIcon size={12} className={bundleCall.error ? 'tool-call-icon-error' : 'tool-call-icon-check'} /></span>
                          <span className="tool-bundle-label">{bundleLabel}</span>
                          <ChevronDown size={12} className="tool-bundle-chevron" />
                        </summary>
                        <div className="tool-bundle-list">
                          {phaseToolCalls.map((tc) => {
                            const hasResult = tc.result !== undefined && !tc.error
                            const hasError = !!tc.error
                            const running = !hasResult && !hasError
                            const usesPresentTense = running || presentTenseToolIds.has(tc.id)
                            return (
                              <details className={hasResult ? 'tool-call completed' : hasError ? 'tool-call error' : 'tool-call running'} key={tc.id}>
                                <summary className="tool-call-summary">
                                  <span className="tool-call-icon">{(() => {
                                    const Icon = toolIconMap[tc.name] ?? toolIconMap.default
                                    return <Icon size={12} className={hasError ? 'tool-call-icon-error' : 'tool-call-icon-check'} />
                                  })()}</span>
                                  <span className="tool-call-name">{usesPresentTense ? runningToolLabel(tc) : completedToolLabel(tc)}</span>
                                </summary>
                                {(tc.result || tc.error) && <pre className="tool-call-preview">{tc.error ?? tc.result}</pre>}
                              </details>
                            )
                          })}
                        </div>
                      </details>
                    </div>
                  )
                }
                return (() => {
                  const turnToolCalls = activeThread.messages
                    .filter((candidate) => candidate.role === 'tool' && candidate.parentAssistantId === message.id)
                    .flatMap((candidate) => candidate.toolCalls ?? [])
                  const displayedFileChanges = message.fileChanges ?? message.filesChanged?.map((path) => ({ path, ...legacyFileChangeCounts(path, turnToolCalls) })) ?? []
                  const totalAdditions = displayedFileChanges.reduce((total, file) => total + file.additions, 0)
                  const totalDeletions = displayedFileChanges.reduce((total, file) => total + file.deletions, 0)
                  const showDuration = message.status !== 'pending' && message.durationMs !== undefined
                  const runningTool = [...activeThread.messages.slice(0, messageIndex)].reverse().find((candidate) =>
                    candidate.role === 'tool' && candidate.parentAssistantId === message.id && candidate.toolCalls?.some((toolCall) => toolCall.result === undefined && !toolCall.error)
                  )
                  const runningToolCall = runningTool?.toolCalls?.find((toolCall) => toolCall.result === undefined && !toolCall.error)
                  const heldActivityLabel = heldActivity?.assistantId === message.id && heldActivity.until > Date.now() ? heldActivity.label : undefined
                  const activeLabel = runningToolCall ? runningToolLabel(runningToolCall) : heldActivityLabel ?? 'Thinking'
                  const activityToolCall = runningToolCall ?? (heldActivityLabel ? turnToolCalls.at(-1) : undefined)
                  const activityIsAnimating = !activityToolCall || !!runningToolCall || presentTenseToolIds.has(activityToolCall.id)
                  const mostRecentSearch = [...turnToolCalls].reverse().find((toolCall) => toolCall.name === 'web_search')
                  const streamedSearchDetail = webSearchActivity?.assistantId === message.id
                    ? webSearchActivity.text.slice(0, webSearchActivity.revealedCharacters)
                    : undefined
                  const visibleSearchDetail = activeLabel === 'Searching the web'
                    ? streamedSearchDetail ?? webSearchDetail(runningToolCall ?? mostRecentSearch ?? { id: '', name: '', arguments: {} }) ?? ''
                    : ''
                  const expanded = expandedWorkIds.has(message.id)
                  return (
                    <div key={message.id}>
                      {showDuration && (
                        <button className="work-duration" type="button" aria-expanded={expanded} onClick={() => setExpandedWorkIds((current) => {
                          const next = new Set(current)
                          if (next.has(message.id)) next.delete(message.id)
                          else next.add(message.id)
                          return next
                        })}>
                          <span className="work-duration-text">Worked for {formatDurationShort(message.durationMs ?? 0)}</span>
                          <ChevronRight size={12} className={expanded ? 'work-duration-chevron expanded' : 'work-duration-chevron'} />
                        </button>
                      )}
                      <div className={message.content ? 'chat-message assistant-message' : 'chat-message assistant-message pending'}>
                        {message.content
                          ? <MarkdownMessage content={message.content} />
                          : message.status === 'cancelled'
                            ? <span className="terminal-activity-label">Stopped</span>
                            : message.status === 'error'
                              ? <span className="terminal-activity-label error">Failed</span>
                            : <span className={activityToolCall ? 'assistant-activity tool-active' : 'assistant-activity'}>{activityToolCall && <span className="activity-tool-icon">{(() => {
                                const Icon = toolIconMap[activityToolCall.name] ?? toolIconMap.default
                                return <Icon size={13} />
                              })()}</span>}{activityIsAnimating
                                ? <span className="activity-label" data-text={activeLabel}>{activeLabel}</span>
                                : <span className="activity-label-static">{activeLabel}</span>}{visibleSearchDetail && <span className="web-search-detail">{visibleSearchDetail}</span>}</span>}
                        {message.status !== 'pending' && displayedFileChanges.length > 0 && (
                          <div className="files-changed">
                            <div className="files-changed-summary">
                              <span>{displayedFileChanges.length} Changed {displayedFileChanges.length === 1 ? 'file' : 'files'}</span>
                              <span className="files-changed-totals"><span className="line-additions">+{totalAdditions}</span><span className="line-deletions">−{totalDeletions}</span></span>
                            </div>
                            <div className="files-changed-list">
                              {displayedFileChanges.map((file) => (
                                <div className="files-changed-file" key={file.path}>
                                  <span className="files-changed-path">{file.path}</span>
                                  <span className="files-changed-row-end"><span className="line-additions">+{file.additions}</span><span className="line-deletions">−{file.deletions}</span><ChevronRight size={13} aria-hidden="true" /></span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })()
              })}
              {completionError && <div className="completion-error" role="alert">{completionError}</div>}
              <div ref={conversationEndRef} />
            </div>
          </div>
        ) : (
          <div className="empty-state" aria-hidden="true">
            <h1>What should we build?</h1>
            <p>Start a new thread with a local model.</p>
          </div>
        )}

        {activeThread && !autoScrollEnabled && (
          <button
            className="jump-to-latest"
            type="button"
            aria-label="Jump to latest message"
            onClick={() => {
              setAutoScrollEnabled(true)
              conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' })
            }}
          >
            <ArrowDown size={16} />
          </button>
        )}

        <form className={activeThread ? 'prompt-composer' : 'prompt-composer new-thread-composer'} ref={promptComposerRef} onSubmit={(event) => void submitPrompt(event)}>
          <div className="composer-shape" aria-hidden="true" />
          {pendingAttachments.length > 0 && (
            <div className="composer-attachments" aria-label="Attached images">
              {pendingAttachments.map((attachment) => (
                <div className="composer-attachment" key={attachment.id}>
                  <img src={attachment.dataUrl} alt={attachment.name} />
                  <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={11} /></button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={promptTextareaRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.items)
                .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                .flatMap((item) => item.getAsFile() ?? [])
              if (images.length === 0) return
              event.preventDefault()
              void pasteChatImages(images)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                promptComposerRef.current?.requestSubmit()
              }
            }}
            placeholder="Ask anything"
            aria-label="Prompt"
            rows={2}
          />
          {attachmentError && <div className="attachment-error" role="alert">{attachmentError}</div>}
          <div className="composer-toolbar" ref={controlsRef}>
            <button className="composer-icon-button" type="button" aria-label="Attach images" title="Attach images" disabled={completionState !== 'idle' || !selectedModel?.vision || pendingAttachments.length >= MAX_CHAT_ATTACHMENTS} onClick={() => void chooseChatImages()}><Plus size={14} /></button>
            <div className="composer-controls">
              <div className="composer-menu-wrap">
                {openMenu !== null && (
                  <div className="composer-menu advanced-menu" role="menu">
                    <div className="menu-heading-compact">Effort</div>
                    {REASONING_EFFORTS.map((effort) => (
                      <button
                        className={effort === reasoningEffort ? 'menu-option menu-option-compact selected' : 'menu-option menu-option-compact'}
                        key={effort}
                        type="button"
                        onClick={() => { setReasoningEffort(effort); setOpenMenu(null) }}
                      >
                        <span className="menu-option-copy"><strong>{effort}</strong></span>
                      </button>
                    ))}
                    <div className="menu-divider" />
                    <button className="advanced-option" type="button"
                      onMouseEnter={() => {
                        if (modelMenuTimerRef.current) clearTimeout(modelMenuTimerRef.current)
                        modelMenuTimerRef.current = setTimeout(() => setOpenMenu('model'), 350)
                      }}
                      onMouseLeave={() => {
                        if (modelMenuTimerRef.current) clearTimeout(modelMenuTimerRef.current)
                        if (openMenu === 'model') modelMenuTimerRef.current = setTimeout(() => setOpenMenu('advanced'), 200)
                      }}
                      onFocus={() => { if (modelMenuTimerRef.current) clearTimeout(modelMenuTimerRef.current); setOpenMenu('model') }}
                      onClick={() => { if (modelMenuTimerRef.current) clearTimeout(modelMenuTimerRef.current); setOpenMenu('model') }}
                    >
                      <span>Model</span>
                      <span className="advanced-value">{selectedModel?.displayName ?? 'None'}</span>
                      <ChevronDown size={12} />
                    </button>
                  </div>
                )}
                {openMenu === 'model' && (
                  <div className="composer-menu submenu-menu model-menu" role="menu"
                    onMouseEnter={() => {
                      if (modelMenuTimerRef.current) clearTimeout(modelMenuTimerRef.current)
                    }}
                    onMouseLeave={() => {
                      modelMenuTimerRef.current = setTimeout(() => setOpenMenu('advanced'), 200)
                    }}
                  >
                    <div className="menu-heading">Model</div>
                    {downloadedModelIds === null && <div className="menu-message">Checking downloaded models…</div>}
                    {downloadedModelIds !== null && composerModels.length === 0 && (
                      <div className="menu-message">
                        <strong>No downloaded models</strong>
                        <span>Download a supported model to use it here.</span>
                      </div>
                    )}
                    {composerModels.map((model) => (
                      <button
                        className={model.id === selectedModelId ? 'menu-option selected' : 'menu-option'}
                        key={model.id}
                        type="button"
                        onClick={() => { setSelectedModelId(model.id); setOpenMenu(null) }}
                      >
                        <span className="menu-option-copy"><strong>{model.displayName}</strong><small>{model.providerName}</small></span>
                      </button>
                    ))}
                  </div>
                )}
                {contextTokens && selectedModel && (
                  <div className="context-meter-wrap">
                    <svg className="context-meter-ring" viewBox="0 0 22 22">
                      <circle className="context-meter-track" cx="11" cy="11" r="8.5" />
                      <circle className="context-meter-fill" cx="11" cy="11" r="8.5"
                        style={{
                          strokeDasharray: `${2 * Math.PI * 8.5}`,
                          strokeDashoffset: `${2 * Math.PI * 8.5 * (1 - contextTokens.percent / 100)}`
                        }} />
                    </svg>
                    <div className="context-meter-tooltip" role="tooltip">
                      <span className="context-meter-used">{contextTokens.used.toLocaleString()}</span>
                      <span className="context-meter-separator"> / </span>
                      <span className="context-meter-total">{contextTokens.total.toLocaleString()}</span>
                      <span className="context-meter-token-label"> tokens</span>
                      <span className="context-meter-percent"> ({contextTokens.percent}%)</span>
                    </div>
                  </div>
                )}
                <button className="composer-select model-select" type="button" disabled={completionState !== 'idle'} onClick={() => setOpenMenu(openMenu === null ? 'advanced' : null)}>
                  <span>{selectedModel?.displayName ?? (downloadedModelIds === null ? 'Checking models…' : 'No models')}</span>
                  <span className="combined-effort">{reasoningEffort}</span>
                  <ChevronDown size={12} />
                </button>
              </div>
              {completionState === 'idle'
                ? <button className="send-button" type="submit" disabled={(!prompt.trim() && pendingAttachments.length === 0) || !selectedModel} aria-label="Send prompt"><ArrowUp size={16} /></button>
                : <button className="send-button stop-button" type="button" aria-label="Stop response" onClick={() => { if (activeRequestIdRef.current) void window.api.cancelLocalCompletion(activeRequestIdRef.current) }}><Square size={14} /></button>}
            </div>
          </div>
          {!activeThread && (
            <div className="composer-project-strip">
              <label className="composer-project-selector">
                <FolderOpen size={14} aria-hidden="true" />
                <select aria-label="Project" value={selectedProjectPath} onChange={(event) => setSelectedProjectPath(event.target.value)}>
                  {projects.length === 0 && <option value="">No project</option>}
                  {projects.map((project) => <option key={project.path} value={project.path}>{project.name}</option>)}
                </select>
                <ChevronDown size={12} aria-hidden="true" />
              </label>
            </div>
          )}
        </form>
        </>}
        </section>
      </main>
      {projectDialogOpen && (
        <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !projectSaving) setProjectDialogOpen(false) }}>
          <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
            <h2 id="project-dialog-title">Name your project</h2>
            <p>A project should be short and memorable</p>
            <form onSubmit={(event) => void createProject(event)}>
              <input ref={projectNameRef} value={projectName} onChange={(event) => { setProjectName(event.target.value); setProjectError('') }} placeholder="e.g. Portfolio redesign" aria-label="Project name" aria-describedby={projectError ? 'project-name-error' : undefined} disabled={projectSaving} />
              {projectError && <div className="project-dialog-error" id="project-name-error" role="alert">{projectError}</div>}
              <div className="project-dialog-actions">
                <button type="button" onClick={() => setProjectDialogOpen(false)} disabled={projectSaving}>Cancel</button>
                <button className="primary" type="submit" disabled={!projectName.trim() || projectSaving}>{projectSaving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </section>
        </div>
      )}
      {contextMenu && (
        <div
          className="thread-context-menu"
          ref={contextMenuRef}
          role="menu"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
          onClick={() => setContextMenu(null)}
        >
          <button type="button" role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => { e.stopPropagation(); renameThread(contextMenu.thread) }}
          >
            <PenLine size={14} />
            <span>Rename</span>
          </button>
          <button type="button" role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => { e.stopPropagation(); void regenerateThreadTitle(contextMenu.thread) }}
            disabled={regeneratingThreadId === contextMenu.thread.id}
          >
            <RefreshCw size={14} className={regeneratingThreadId === contextMenu.thread.id ? 'refresh-icon-spin' : ''} />
            <span>Regenerate title</span>
          </button>
          <div className="thread-context-menu-separator" />
          <button type="button" role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => { e.stopPropagation(); setDeleteConfirmThread(contextMenu.thread); setContextMenu(null) }}
          >
            <Trash2 size={14} />
            <span>Delete</span>
          </button>
        </div>
      )}
      {deleteConfirmThread && (
        <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteConfirmThread(null) }}>
          <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
            <h2 id="delete-dialog-title">Delete thread</h2>
            <p>Are you sure you want to delete "<strong>{deleteConfirmThread.title}</strong>"? This action cannot be undone.</p>
            <div className="project-dialog-actions">
              <button type="button" onClick={() => setDeleteConfirmThread(null)}>Cancel</button>
              <button className="primary delete-confirm" type="button" onClick={() => void confirmDeleteThread()}>Delete</button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
