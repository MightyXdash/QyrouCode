import { useEffect, useRef, useState } from 'react'
import { MODEL_LIST } from './modelCatalog'
import type { LlamaRuntimeStatus } from '../../shared/llama'
import './MainApp.css'

const REASONING_EFFORTS = ['Low', 'Medium', 'High'] as const

type OpenMenu = 'advanced' | 'model' | 'reasoning' | null

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

export default function MainApp(): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [downloadedModelIds, setDownloadedModelIds] = useState<Set<string> | null>(null)
  const [reasoningEffort, setReasoningEffort] = useState<(typeof REASONING_EFFORTS)[number]>('Medium')
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [runtimeStatus, setRuntimeStatus] = useState<LlamaRuntimeStatus | null>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const downloadedModels = downloadedModelIds
    ? MODEL_LIST.filter((model) => downloadedModelIds.has(model.id))
    : []
  const selectedModel = downloadedModels.find((model) => model.id === selectedModelId)

  useEffect(() => {
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
    }
    window.addEventListener('mousedown', closeMenus)
    return () => window.removeEventListener('mousedown', closeMenus)
  }, [])

  return (
    <main className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-drag-region" />
        <div className="sidebar-brand" aria-label="SupraCode">
          <span className="brand-mark">S</span>
          <span>SupraCode</span>
        </div>
        <nav className="sidebar-nav" aria-label="Primary navigation">
          <button className="sidebar-action" type="button">
            <PlusIcon />
            <span>New thread</span>
            <kbd>⌘ N</kbd>
          </button>
          <button className="sidebar-action" type="button">
            <SearchIcon />
            <span>Search</span>
            <kbd>⌘ K</kbd>
          </button>
        </nav>
      </aside>

      <section className="app-workspace">
        <div className="workspace-drag-region" />
        <div className="empty-state" aria-hidden="true">
          <div className="empty-state-mark">S</div>
          <h1>What should we build?</h1>
          <p>Start a new thread with a local model.</p>
        </div>

        {/*
          Sequence 3 deliberately leaves this composer, its styling, and its position unchanged.
          Sequence 4 should connect this existing submit path to startLocalCompletion and render streamed
          events without altering the current visual structure unless a separate UI decision authorizes it.
        */}
        <form className="prompt-composer" onSubmit={(event) => event.preventDefault()}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask SupraCode anything"
            aria-label="Prompt"
            rows={3}
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
  )
}
