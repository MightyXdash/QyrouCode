import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MODEL_LIST } from './modelCatalog'
import type { LlamaRuntimeStatus } from '../../shared/llama'
import type { ThemePreference } from '../../shared/settings'
import { WINDOW_COMMANDS } from '../../shared/windowCommands'
import WindowControls from './WindowControls'
import './MainApp.css'

const REASONING_EFFORTS = ['Low', 'Medium', 'High'] as const
const COMPOSER_SHAPE_WIDTH = 760
const COMPOSER_CORNER_RADIUS = 32
const COMPOSER_CURVE_UNIT_DIVISOR = 16

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

export default function MainApp(): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [downloadedModelIds, setDownloadedModelIds] = useState<Set<string> | null>(null)
  const [reasoningEffort, setReasoningEffort] = useState<(typeof REASONING_EFFORTS)[number]>('Medium')
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [openTitlebarMenu, setOpenTitlebarMenu] = useState<TitlebarMenuId | null>(null)
  const [composerHeight, setComposerHeight] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [runtimeStatus, setRuntimeStatus] = useState<LlamaRuntimeStatus | null>(null)
  const [theme, setTheme] = useState<ThemePreference>('system')
  const controlsRef = useRef<HTMLDivElement>(null)
  const titlebarMenuRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null)
  const promptComposerRef = useRef<HTMLFormElement>(null)
  const downloadedModels = downloadedModelIds
    ? MODEL_LIST.filter((model) => downloadedModelIds.has(model.id))
    : []
  const selectedModel = downloadedModels.find((model) => model.id === selectedModelId)

  useEffect(() => {
    void window.api.getTheme().then(setTheme)
    void window.api.getLlamaStatus().then(setRuntimeStatus)
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
    }
    window.addEventListener('mousedown', closeMenus)
    return () => window.removeEventListener('mousedown', closeMenus)
  }, [])

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
    if (action === 'new-thread') setPrompt('')
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
          <button className="sidebar-action" type="button">
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
          <div className="sidebar-section-label">Threads</div>
          <p className="sidebar-empty-message">Your recent threads will appear here.</p>
        </div>
        </aside>

        <section className="app-workspace">
        <div className="empty-state" aria-hidden="true">
          <h1>What should we build?</h1>
          <p>Start a new thread with a local model.</p>
        </div>

        <form className="prompt-composer" ref={promptComposerRef} onSubmit={(event) => event.preventDefault()}>
          <ComposerShape height={composerHeight || COMPOSER_CORNER_RADIUS * 2} />
          <textarea
            ref={promptTextareaRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
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
                    <div className="menu-heading">Advanced</div>
                    <div className="menu-divider" />
                    <button className="advanced-option" type="button" onClick={() => setOpenMenu('model')}>
                      <span>Model</span>
                      <span className="advanced-value">{selectedModel?.base_model ?? 'None'}</span>
                      <ChevronIcon />
                    </button>
                    <button className="advanced-option" type="button" onClick={() => setOpenMenu('reasoning')}>
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
                        <span className="model-dot" />
                        <span className="menu-option-copy"><strong>{model.base_model}</strong><small>{model.size} · {model.quantization}</small></span>
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
                <button className="composer-select model-select" type="button" onClick={() => setOpenMenu(openMenu === null ? 'advanced' : null)}>
                  <span className={`status-dot runtime-${runtimeStatus?.state ?? 'unavailable'}`} />
                  <span>{selectedModel?.base_model ?? (downloadedModelIds === null ? 'Checking models…' : 'No models')}</span>
                  <span className="combined-effort">{reasoningEffort}</span>
                  <ChevronIcon />
                </button>
              </div>
              <button className="send-button" type="submit" disabled={!prompt.trim()} aria-label="Send prompt"><SendIcon /></button>
            </div>
          </div>
        </form>
        </section>
      </main>
    </>
  )
}
