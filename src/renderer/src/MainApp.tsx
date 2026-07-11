import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MODEL_LIST } from './modelCatalog'
import { DEFAULT_RESPONSE_STYLE, type ResponseStylePreference, type ThemePreference } from '../../shared/settings'
import { WINDOW_COMMANDS } from '../../shared/windowCommands'
import type { Project } from '../../shared/projects'
import type { ChatMessage, ChatThread } from '../../shared/chat'
import WindowControls from './WindowControls'
import MarkdownMessage from './MarkdownMessage'
import { REASONING_EFFORTS, reasoningProfile, type ReasoningEffort } from './reasoningProfiles'
import { responseStylePrompt } from './responseStylePrompts'
import './MainApp.css'

const COMPOSER_SHAPE_WIDTH = 760
const COMPOSER_CORNER_RADIUS = 32
const COMPOSER_CURVE_UNIT_DIVISOR = 16
const AUTO_SCROLL_THRESHOLD = 72

type OpenMenu = 'advanced' | 'model' | 'reasoning' | null
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

function SearchIcon(): JSX.Element {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25" /><path d="m12.5 12.5 4 4" /></svg>
}

function PlusIcon(): JSX.Element {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v13M3.5 10h13" /></svg>
}

function ChevronIcon(): JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
}

function SendIcon(): JSX.Element {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m0 0L6.5 8.5M10 5l3.5 3.5" /></svg>
}

function SidebarIcon(): JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.25" y="2.5" width="11.5" height="11" rx="2" /><path d="M6 2.75v10.5" /></svg>
}

function ArrowIcon({ direction }: { direction: 'back' | 'forward' }): JSX.Element {
  return <svg className={direction === 'forward' ? 'forward-arrow' : undefined} viewBox="0 0 16 16" aria-hidden="true"><path d="m9.75 3.5-4.5 4.5 4.5 4.5M5.5 8h6" /></svg>
}

function composerShapePath(height: number): string {
  const radius = Math.min(COMPOSER_CORNER_RADIUS, height / 2)
  const unit = radius / COMPOSER_CURVE_UNIT_DIVISOR
  const right = COMPOSER_SHAPE_WIDTH
  const bottom = height
  return `M${radius} 0H${right - radius}C${right - (unit * 7)} 0 ${right - (unit * 3)} ${unit * 2} ${right - unit} ${unit * 7}C${right} ${unit * 9} ${right} ${unit * 12} ${right} ${radius}V${bottom - radius}C${right} ${bottom - (unit * 12)} ${right} ${bottom - (unit * 9)} ${right - unit} ${bottom - (unit * 7)}C${right - (unit * 3)} ${bottom - (unit * 2)} ${right - (unit * 7)} ${bottom} ${right - radius} ${bottom}H${radius}C${unit * 7} ${bottom} ${unit * 3} ${bottom - (unit * 2)} ${unit} ${bottom - (unit * 7)}C0 ${bottom - (unit * 9)} 0 ${bottom - (unit * 12)} 0 ${bottom - radius}V${radius}C0 ${unit * 12} 0 ${unit * 9} ${unit} ${unit * 7}C${unit * 3} ${unit * 2} ${unit * 7} 0 ${radius} 0Z`
}

function ComposerShape({ height }: { height: number }): JSX.Element {
  return (
    <svg className="composer-shape" viewBox={`0 0 ${COMPOSER_SHAPE_WIDTH} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={composerShapePath(height)} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function StopIcon(): JSX.Element {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="6" height="6" rx="1" /></svg>
}

function ArrowDownIcon(): JSX.Element {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v10m0 0 4-4m-4 4-4-4" /></svg>
}

function FolderPlusIcon(): JSX.Element {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.75 5.75h5l1.5 1.75h8v8.25H2.75z" /><path d="M12.75 10v4m-2-2h4" /></svg>
}

function FolderIcon(): JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4.25h4l1.25 1.5h7.25v7.5H1.75z" /></svg>
}

function modelDisplayName(modelName: string): string {
  return modelName.split('/').at(-1) ?? modelName
}

export default function MainApp(): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [downloadedModelIds, setDownloadedModelIds] = useState<Set<string> | null>(null)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('Medium')
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [openTitlebarMenu, setOpenTitlebarMenu] = useState<TitlebarMenuId | null>(null)
  const [composerHeight, setComposerHeight] = useState(0)
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
  const downloadedModels = downloadedModelIds
    ? MODEL_LIST.filter((model) => downloadedModelIds.has(model.id))
    : []
  const selectedModel = downloadedModels.find((model) => model.id === selectedModelId)

  useEffect(() => {
    void window.api.getTheme().then(setTheme)
    void window.api.getResponseStylePreference().then(setResponseStylePreference)
    void Promise.all([window.api.getProjects(), window.api.getExpandedProjectPaths()]).then(([storedProjects, storedExpandedPaths]) => {
      const projectPaths = new Set(storedProjects.map((project) => project.path))
      setProjects(storedProjects)
      setSelectedProjectPath(storedProjects[0]?.path ?? '')
      setExpandedProjects(new Set(storedExpandedPaths.filter((path) => projectPaths.has(path))))
      projectExpansionLoadedRef.current = true
    })
    void window.api.getChatThreads().then(setThreads)
    void window.api.getDownloadedModels(MODEL_LIST.map((model) => model.hf_repo)).then((downloadedRepos) => {
      const repoSet = new Set(downloadedRepos)
      setDownloadedModelIds(new Set(MODEL_LIST.filter((model) => repoSet.has(model.hf_repo)).map((model) => model.id)))
    }).catch(() => setDownloadedModelIds(new Set()))
  }, [])

  useEffect(() => {
    if (!downloadedModelIds || downloadedModels.some((model) => model.id === selectedModelId)) return
    setSelectedModelId(downloadedModels[0]?.id ?? '')
  }, [downloadedModelIds, downloadedModels, selectedModelId])

  useEffect(() => {
    const closeMenus = (event: MouseEvent): void => {
      if (!controlsRef.current?.contains(event.target as Node)) setOpenMenu(null)
      if (!titlebarMenuRef.current?.contains(event.target as Node)) setOpenTitlebarMenu(null)
      if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false)
    }
    window.addEventListener('mousedown', closeMenus)
    return () => window.removeEventListener('mousedown', closeMenus)
  }, [])

  useEffect(() => {
    if (!projectExpansionLoadedRef.current) return
    void window.api.setExpandedProjectPaths([...expandedProjects])
  }, [expandedProjects])

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
      return
    }
    if (event.type === 'error') {
      const current = activeThreadRef.current
      if (current) {
        const messages = current.messages.map((message, index) => index === current.messages.length - 1 && !message.content
          ? { ...message, content: 'The local model could not respond.' }
          : message)
        const updated = { ...current, messages, updatedAt: Date.now() }
        activeThreadRef.current = updated
        setActiveThread(updated)
      }
      setCompletionError(event.message)
    }
    const completed = activeThreadRef.current
    if (completed) {
      setThreads((current) => [completed, ...current.filter((thread) => thread.id !== completed.id)])
      void window.api.saveChatThread(completed)
    }
    activeRequestIdRef.current = null
    setCompletionState('idle')
  }), [])

  useEffect(() => {
    if (autoScrollEnabled) conversationEndRef.current?.scrollIntoView({ behavior: completionState === 'streaming' ? 'auto' : 'smooth' })
  }, [activeThread, autoScrollEnabled, completionState])

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
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [theme])

  useLayoutEffect(() => {
    const textarea = promptTextareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
    const height = promptComposerRef.current?.offsetHeight
    if (height) setComposerHeight((current) => current === height ? current : height)
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
    if (activeRequestIdRef.current) void window.api.cancelLocalCompletion(activeRequestIdRef.current)
    activeRequestIdRef.current = null
    activeThreadRef.current = null
    setActiveThread(null)
    setCompletionState('idle')
    setCompletionError('')
    setPrompt('')
    setAutoScrollEnabled(true)
    promptTextareaRef.current?.focus()
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

  const submitPrompt = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const content = prompt.trim()
    if (!content || completionState !== 'idle' || !selectedModel) return
    const isNewThread = !activeThreadRef.current
    const threadId = activeThreadRef.current?.id ?? crypto.randomUUID()
    const projectPath = activeThreadRef.current?.projectPath ?? selectedProjectPath ?? projects[0]?.path ?? ''
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content }
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '' }
    const thread: ChatThread = {
      id: threadId,
      projectPath,
      title: activeThreadRef.current?.title ?? content.slice(0, 44),
      messages: [...(activeThreadRef.current?.messages ?? []), userMessage, assistantMessage],
      updatedAt: Date.now()
    }
    activeThreadRef.current = thread
    setActiveThread(thread)
    setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)])
    if (projectPath) setExpandedProjects((current) => new Set(current).add(projectPath))
    setPrompt('')
    setCompletionError('')
    setCompletionState('starting')
    setAutoScrollEnabled(true)
    void window.api.saveChatThread(thread)
    if (isNewThread) void updateThreadTitle(threadId, content)
    try {
      const status = await window.api.startDownloadedModel(selectedModel.hf_repo, selectedModel.gguf_file)
      if (status.state !== 'ready') throw new Error(status.message ?? 'The local model could not start')
      const messages = thread.messages.filter((message) => message.content).map(({ role, content: messageContent }) => ({ role, content: messageContent }))
      const profile = reasoningProfile(selectedModel, reasoningEffort)
      const systemPrompt = `${profile.systemPrompt}\n\n${responseStylePrompt(responseStylePreference)}`
      const start = await window.api.startLocalCompletion({
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        enableThinking: profile.enableThinking,
        temperature: profile.temperature,
        topP: profile.topP,
        topK: profile.topK,
        minP: profile.minP,
        presencePenalty: profile.presencePenalty,
        repetitionPenalty: profile.repetitionPenalty,
        maxTokens: 8192
      })
      activeRequestIdRef.current = start.requestId
      setCompletionState('streaming')
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'The local model could not start')
      setCompletionState('idle')
    }
  }

  return (
    <>
      <header className="app-titlebar">
        <div className="titlebar-actions">
          <button className="titlebar-icon-button" type="button" aria-label="Toggle sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((current) => !current)}><SidebarIcon /></button>
          <button className="titlebar-icon-button" type="button" aria-label="Go back" disabled><ArrowIcon direction="back" /></button>
          <button className="titlebar-icon-button" type="button" aria-label="Go forward" disabled><ArrowIcon direction="forward" /></button>
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
            <PlusIcon />
            <span>New thread</span>
            <kbd>Ctrl N</kbd>
          </button>
          <button className="sidebar-action" type="button">
            <SearchIcon />
            <span>Search</span>
            <kbd>Ctrl K</kbd>
          </button>
        </nav>
        <div className="sidebar-section">
          <div className="sidebar-section-heading">
            <div className="sidebar-section-label">Projects</div>
            <div className="project-add-wrap" ref={projectMenuRef}>
              <button className="project-add-button" type="button" aria-label="Add project" aria-haspopup="menu" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((current) => !current)}><FolderPlusIcon /></button>
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
              return (
                <div className={expanded ? 'project-group expanded' : 'project-group'} key={project.path}>
                  <button className="project-row" type="button" title={project.path} aria-expanded={expanded} onClick={() => toggleProject(project)}><FolderIcon /><span>{project.name}</span></button>
                  {expanded && (
                    <div className="project-threads">
                      {projectThreads.slice(0, fullyExpandedProjects.has(project.path) ? projectThreads.length : 5).map((thread) => <button className={activeThread?.id === thread.id ? 'project-thread active' : 'project-thread'} type="button" key={thread.id} onClick={() => openThread(thread)}>{thread.title}</button>)}
                      {projectThreads.length > 5 && !fullyExpandedProjects.has(project.path) && <button className="project-show-more" type="button" onClick={() => setFullyExpandedProjects((current) => new Set(current).add(project.path))}>Show more</button>}
                    </div>
                  )}
                </div>
              )
            })}</div>}
        </div>
        </aside>

        <section className="app-workspace">
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
              {activeThread.messages.map((message) => message.role === 'user'
                ? <div className="chat-message user-message" key={message.id}><MarkdownMessage content={message.content} /></div>
                : <div className={message.content ? 'chat-message assistant-message' : 'chat-message assistant-message pending'} key={message.id}>{message.content ? <MarkdownMessage content={message.content} /> : <span className="thinking-label">Thinking</span>}</div>)}
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
            <ArrowDownIcon />
          </button>
        )}

        <form className="prompt-composer" ref={promptComposerRef} onSubmit={(event) => void submitPrompt(event)}>
          <ComposerShape height={composerHeight || COMPOSER_CORNER_RADIUS * 2} />
          <textarea
            ref={promptTextareaRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
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
          <div className="composer-toolbar" ref={controlsRef}>
            <button className="composer-icon-button" type="button" aria-label="Add context"><PlusIcon /></button>
            <div className="composer-controls">
              <div className="composer-menu-wrap">
                {openMenu !== null && (
                  <div className="composer-menu advanced-menu" role="menu">
                    <button className="advanced-option" type="button" onMouseEnter={() => setOpenMenu('model')} onFocus={() => setOpenMenu('model')} onClick={() => setOpenMenu('model')}>
                      <span>Model</span>
                      <span className="advanced-value">{selectedModel ? modelDisplayName(selectedModel.base_model) : 'None'}</span>
                      <ChevronIcon />
                    </button>
                    <button className="advanced-option" type="button" onMouseEnter={() => setOpenMenu('reasoning')} onFocus={() => setOpenMenu('reasoning')} onClick={() => setOpenMenu('reasoning')}>
                      <span>Effort</span>
                      <span className="advanced-value">{reasoningEffort}</span>
                      <ChevronIcon />
                    </button>
                  </div>
                )}
                {openMenu === 'model' && (
                  <div className="composer-menu submenu-menu model-menu" role="menu">
                    <div className="menu-heading">Model</div>
                    {downloadedModelIds === null && <div className="menu-message">Checking downloaded models…</div>}
                    {downloadedModelIds !== null && downloadedModels.length === 0 && (
                      <div className="menu-message">
                        <strong>No downloaded models</strong>
                        <span>Download a supported model to use it here.</span>
                      </div>
                    )}
                    {downloadedModels.map((model) => (
                      <button
                        className={model.id === selectedModelId ? 'menu-option selected' : 'menu-option'}
                        key={model.id}
                        type="button"
                        onClick={() => { setSelectedModelId(model.id); setOpenMenu(null) }}
                      >
                        <span className="menu-option-copy"><strong>{modelDisplayName(model.base_model)}</strong></span>
                        {model.id === selectedModelId && <span className="checkmark">✓</span>}
                      </button>
                    ))}
                  </div>
                )}
                {openMenu === 'reasoning' && (
                  <div className="composer-menu submenu-menu reasoning-menu" role="menu">
                    <div className="menu-heading">Effort</div>
                    {REASONING_EFFORTS.map((effort) => (
                      <button
                        className={effort === reasoningEffort ? 'menu-option selected' : 'menu-option'}
                        key={effort}
                        type="button"
                        onClick={() => { setReasoningEffort(effort); setOpenMenu(null) }}
                      >
                        <span className="menu-option-copy"><strong>{effort}</strong></span>
                        {effort === reasoningEffort && <span className="checkmark">✓</span>}
                      </button>
                    ))}
                  </div>
                )}
                <button className="composer-select model-select" type="button" disabled={completionState !== 'idle'} onClick={() => setOpenMenu(openMenu === null ? 'advanced' : null)}>
                  <span>{selectedModel ? modelDisplayName(selectedModel.base_model) : (downloadedModelIds === null ? 'Checking models…' : 'No models')}</span>
                  <span className="combined-effort">{reasoningEffort}</span>
                  <ChevronIcon />
                </button>
              </div>
              {completionState === 'idle'
                ? <button className="send-button" type="submit" disabled={!prompt.trim() || !selectedModel} aria-label="Send prompt"><SendIcon /></button>
                : <button className="send-button stop-button" type="button" aria-label="Stop response" onClick={() => { if (activeRequestIdRef.current) void window.api.cancelLocalCompletion(activeRequestIdRef.current) }}><StopIcon /></button>}
            </div>
          </div>
        </form>
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
    </>
  )
}
