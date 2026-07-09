import { useState, useEffect, useRef, useMemo } from 'react'
import WindowControls from './WindowControls'
import { MODEL_LIST, type CatalogModel, type Ratings } from './modelCatalog'
import './WelcomeScreen.css'

const ESSENTIAL_MODELS: { id: string; hf_repo: string; label: string }[] = [
  { id: 'supra-reasoning-summarizer', hf_repo: 'SupraLabs/reasoning-summarizer-800m-pre-gguf', label: 'Reasoning Summarizer' },
  { id: 'supra-title', hf_repo: 'SupraLabs/supra-title-50M-pre-gguf', label: 'Title Generator' },
  { id: 'supra-router', hf_repo: 'SupraLabs/Supra-Router-51M-gguf', label: 'Model Router' },
]

const ROLES = [
  'General Agent',
  'Coding & Software Engineering',
  'Analytics & Data Science',
  'Writing & Documentation',
  'Research & Long Context',
  'DevOps & Terminal',
  'Frontend & UI Development',
  'Something Else',
] as const

const ROLE_TO_RATINGS: Record<string, (keyof Ratings)[]> = {
  'General Agent': ['agentic', 'tool_use', 'instruction_following'],
  'Coding & Software Engineering': ['coding', 'reasoning'],
  'Analytics & Data Science': ['data_science', 'math'],
  'Writing & Documentation': ['writing'],
  'Research & Long Context': ['reasoning', 'long_context'],
  'DevOps & Terminal': ['tool_use', 'coding'],
  'Frontend & UI Development': ['coding'],
  'Something Else': [],
}

type Phase = 'idle' | 'exit' | 'enter'

const EXIT_STAGGER_MS = 80
const EXIT_DURATION_MS = 220
const ENTER_TITLE_MS = 180
const ENTER_CARD_DELAY_MS = 70
const ENTER_CARD_STAGGER_MS = 55
const ENTER_CARD_DURATION_MS = 170
const TRANSITION_CLEARANCE_MS = 80
const WELCOME_EXIT_STEP_COUNT = 4

const staggeredDuration = (itemCount: number) =>
  ENTER_CARD_DELAY_MS + Math.max(itemCount - 1, 0) * ENTER_CARD_STAGGER_MS + ENTER_CARD_DURATION_MS

const exitDuration = (currentPage: number) => {
  if (currentPage === 0) return (WELCOME_EXIT_STEP_COUNT - 1) * EXIT_STAGGER_MS + EXIT_DURATION_MS
  if (currentPage === 1) return ROLES.length * EXIT_STAGGER_MS + EXIT_DURATION_MS
  if (currentPage === 2) return MODEL_LIST.length * EXIT_STAGGER_MS + EXIT_DURATION_MS
  return EXIT_DURATION_MS
}

const enterDuration = (nextPage: number) => {
  if (nextPage === 1) return Math.max(ENTER_TITLE_MS, staggeredDuration(ROLES.length))
  if (nextPage === 2) return Math.max(ENTER_TITLE_MS, staggeredDuration(MODEL_LIST.length))
  return ENTER_TITLE_MS
}

const animationDelay = (delayMs: number) => ({ animationDelay: `${delayMs}ms` })

function computeInterestScore(model: CatalogModel, selectedRoles: string[]): number {
  if (selectedRoles.length === 0) return 0
  const dims = new Set<keyof Ratings>()
  for (const role of selectedRoles) {
    for (const d of (ROLE_TO_RATINGS[role] || [])) {
      dims.add(d)
    }
  }
  if (dims.size === 0) return 0
  let total = 0
  for (const d of dims) {
    total += model.ratings[d]
  }
  return total / dims.size
}

export default function WelcomeScreen(): JSX.Element {
  const [page, setPage] = useState(0)
  const [prevPage, setPrevPage] = useState(0)
  const [phase, setPhase] = useState<Phase>('idle')
  const [selectedRoles, setSelectedRoles] = useState<string[]>([])
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [cachedModels, setCachedModels] = useState<Set<string>>(new Set())
  const [activeDownloads, setActiveDownloads] = useState<Set<string>>(new Set())
  const [downloadProgress, setDownloadProgress] = useState<Record<string, { downloaded: number; total: number }>>({})
  const [downloadList, setDownloadList] = useState<{ id: string; name: string; hf_repo: string }[]>([])
  const transitioning = useRef(false)
  const downloadsStarted = useRef(false)

  useEffect(() => {
    if (page !== 2) return
    const allModels = [...MODEL_LIST, ...ESSENTIAL_MODELS]
    for (const m of allModels) {
      window.api.checkModelCache(m.hf_repo).then(cached => {
        if (cached) setCachedModels(prev => new Set(prev).add(m.id))
      })
    }
  }, [page])

  useEffect(() => {
    return window.api.onDownloadProgress(({ repoId, downloaded, total }) => {
      setDownloadProgress(prev => ({ ...prev, [repoId]: { downloaded, total } }))
    })
  }, [])

  const goNext = () => {
    if (transitioning.current) return
    transitioning.current = true
    const nextPage = page + 1
    setPrevPage(page)
    setPhase('exit')
    setTimeout(() => {
      setPage(nextPage)
      setPhase('enter')
      setTimeout(() => {
        setPhase('idle')
        transitioning.current = false
      }, enterDuration(nextPage) + TRANSITION_CLEARANCE_MS)
    }, exitDuration(page))
  }

  const toggleRole = (role: string) => {
    setSelectedRoles(prev =>
      prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
    )
  }

  const toggleModel = (id: string) => {
    setSelectedModels(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useEffect(() => {
    if (page !== 3 || downloadsStarted.current) return
    downloadsStarted.current = true

    const list = [
      ...MODEL_LIST
        .filter(m => selectedModels.has(m.id) && !cachedModels.has(m.id))
        .map(m => ({ id: m.id, name: m.name, hf_repo: m.hf_repo })),
      ...ESSENTIAL_MODELS
        .filter(m => !cachedModels.has(m.id))
        .map(m => ({ id: m.id, name: m.label, hf_repo: m.hf_repo }))
    ]
    setDownloadList(list)

    const run = async () => {
      for (const model of list) {
        setActiveDownloads(prev => new Set(prev).add(model.id))
        try {
          await window.api.downloadModel(model.hf_repo)
          setCachedModels(prev => new Set(prev).add(model.id))
        } catch {
          // download failed or cancelled
        } finally {
          setActiveDownloads(prev => {
            const next = new Set(prev)
            next.delete(model.id)
            return next
          })
        }
      }
    }
    run()
  }, [page])

  const sortedModels = useMemo(() => {
    return MODEL_LIST
      .map(m => ({ model: m, interested: computeInterestScore(m, selectedRoles) > 0 }))
      .sort((a, b) => Number(b.interested) - Number(a.interested) || a.model.recommended_vram_gb - b.model.recommended_vram_gb)
  }, [selectedRoles])

  const displayPage = phase === 'exit' ? prevPage : page

  return (
    <div className="welcome">
      <div className="drag-region" />
      <WindowControls />
      {displayPage === 0 && (
        <div className="page-inner welcome-inner">
          <div className="welcome-center">
            <h1 className={`welcome-title${phase === 'exit' ? ' exit-left' : ''}`} style={phase === 'exit' ? animationDelay(0) : undefined}>
              SupraCode
            </h1>
            <p className={`welcome-subtitle${phase === 'exit' ? ' exit-left' : ''}`} style={phase === 'exit' ? animationDelay(EXIT_STAGGER_MS) : undefined}>
              Welcome to SupraCode!
            </p>
            <p className={`welcome-description${phase === 'exit' ? ' exit-left' : ''}`} style={phase === 'exit' ? animationDelay(EXIT_STAGGER_MS * 2) : undefined}>
              Let&apos;s download (or connect to) the necessary AI models we
              need for the app to work.
            </p>
          </div>
          <div className={`next-wrapper${phase === 'exit' ? ' exit-left' : ''}`} style={phase === 'exit' ? animationDelay(EXIT_STAGGER_MS * 3) : undefined}>
            <button className="next-btn" onClick={goNext}>Next</button>
          </div>
        </div>
      )}
      {displayPage === 1 && (
        <div className="page-inner roles-inner">
          <div className="roles-header">
            <h2 className={`roles-title${phase === 'enter' ? ' enter-fade' : ''}${phase === 'exit' ? ' exit-left' : ''}`}
                style={phase === 'enter' ? animationDelay(0) : phase === 'exit' ? animationDelay(0) : undefined}>
              Before we continue, let&apos;s see what you will be doing with SupraCode
            </h2>
          </div>
          <div className="roles-list">
            {ROLES.map((role, i) => (
              <div
                key={role}
                className={`role-card${selectedRoles.includes(role) ? ' selected' : ''}${phase === 'enter' ? ' enter-right' : ''}${phase === 'exit' ? ' exit-left' : ''}`}
                style={phase === 'enter' ? animationDelay(ENTER_CARD_DELAY_MS + i * ENTER_CARD_STAGGER_MS) : phase === 'exit' ? animationDelay(i * EXIT_STAGGER_MS) : undefined}
                onClick={() => toggleRole(role)}
              >
                <div className={`role-checkbox${selectedRoles.includes(role) ? ' checked' : ''}`}>
                  {selectedRoles.includes(role) && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M2 5l2.5 2.5L8 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
                <span className="role-label">{role}</span>
              </div>
            ))}
          </div>
          <div className={`roles-footer${phase === 'exit' ? ' exit-left' : ''}`} style={phase === 'exit' ? animationDelay(ROLES.length * EXIT_STAGGER_MS) : undefined}>
            <button
              className="next-btn"
              disabled={selectedRoles.length === 0}
              onClick={goNext}
            >
              Next
            </button>
          </div>
        </div>
      )}
      {displayPage === 2 && (
        <div className="page-inner models-inner">
          <div className="models-header">
            <h2 className={`models-title${phase === 'enter' ? ' enter-fade' : ''}`}
                style={phase === 'enter' ? animationDelay(0) : undefined}>
              Select Models to Download
            </h2>
          </div>
          <div className="models-list">
            {sortedModels.map(({ model }, i) => (
              <ModelCard
                key={model.id}
                model={model}
                selected={selectedModels.has(model.id)}
                cached={cachedModels.has(model.id)}
                downloading={activeDownloads.has(model.id)}
                progress={downloadProgress[model.hf_repo]}
                onToggle={() => toggleModel(model.id)}
                phase={phase}
                index={i}
              />
            ))}
          </div>
          <div className="models-footer">
            <button
              className="next-btn"
              disabled={selectedModels.size === 0}
              onClick={goNext}
            >
              Download Selected
            </button>
          </div>
        </div>
      )}
      {displayPage === 3 && (
        <div className="page-inner ready-inner">
          <div className="ready-header">
            <h2 className={`ready-title${phase === 'enter' ? ' enter-fade' : ''}`}
                style={phase === 'enter' ? animationDelay(0) : undefined}>
              You&apos;re all set! SupraCode will fetch these models and the essentials from SupraLabs.
            </h2>
            <p className={`ready-subtitle${phase === 'enter' ? ' enter-fade' : ''}`}
               style={phase === 'enter' ? animationDelay(120) : undefined}>
              These models take a little while to download. Perfect time to stretch your legs or grab a drink.
            </p>
          </div>
          <div className="download-list">
            {downloadList.map((m) => (
              <DownloadItem
                key={m.id}
                name={m.name}
                done={cachedModels.has(m.id)}
                active={activeDownloads.has(m.id)}
                progress={downloadProgress[m.hf_repo]}
                phase={phase}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ModelCard({ model, selected, cached, downloading, progress, onToggle, phase, index }: {
  model: CatalogModel
  selected: boolean
  cached: boolean
  downloading: boolean
  progress?: { downloaded: number; total: number }
  onToggle: () => void
  phase: Phase
  index: number
}): JSX.Element {
  const ratingKeys = ['coding', 'reasoning', 'writing', 'agentic', 'tool_use'] as const
  const topRatings = ratingKeys.map(k => ({ key: k, val: model.ratings[k] }))
  const animClass = phase === 'enter' ? ' enter-right' : phase === 'exit' ? ' exit-left' : ''
  const animDelay =
    phase === 'enter'
      ? animationDelay(ENTER_CARD_DELAY_MS + index * ENTER_CARD_STAGGER_MS)
      : phase === 'exit'
        ? animationDelay(index * EXIT_STAGGER_MS)
        : undefined

  return (
    <div
      className={`model-card${selected ? ' selected' : ''}${cached ? ' cached' : ''}${downloading ? ' downloading' : ''}${animClass}`}
      style={animDelay}
      onClick={onToggle}
    >
      <div className="model-card-top">
        {cached ? (
          <span className="cached-badge" title="Already cached">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6.5" fill="#12c905" />
              <path d="M4 7l2 2 4-4" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        ) : (
          <div className={`model-checkbox${selected ? ' checked' : ''}`}>
            {selected && (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 5l2.5 2.5L8 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        )}
        <span className="model-card-name">{model.name}</span>
        <span className="model-card-dev">{model.developer}</span>
      </div>
      <div className="model-card-meta">
        <span className="model-meta-tag">{model.parameters}</span>
        <span className="model-meta-tag">{model.quantization}</span>
        <span className="model-meta-tag">{model.architecture}</span>
        <span className="model-meta-tag">{model.recommended_vram_gb}GB VRAM</span>
      </div>
      <div className="model-card-ratings">
        {topRatings.map(r => (
          <span key={r.key} className="rating-dot" data-level={r.val}>
            {r.key.replace('_', ' ')}
          </span>
        ))}
      </div>
      {downloading && (
        <div className="model-download-track">
          <div className="model-download-fill" style={{ width: progress ? `${(progress.downloaded / progress.total) * 100}%` : '0%' }} />
        </div>
      )}
      {cached && <p className="model-cached-text">Already downloaded</p>}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function DownloadItem({ name, done, active, progress, phase }: {
  name: string
  done: boolean
  active: boolean
  progress?: { downloaded: number; total: number }
  phase: Phase
}): JSX.Element {
  const pct = progress && progress.total > 0
    ? Math.min(100, (progress.downloaded / progress.total) * 100)
    : 0

  return (
    <div className={`download-item${done ? ' done' : ''}${active ? ' active' : ''}`}>
      <div className="download-item-icon">
        {done ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="6.5" fill="#12c905" />
            <path d="M4 7l2 2 4-4" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : active ? (
          <span className="download-spinner" />
        ) : (
          <span className="download-dot" />
        )}
      </div>
      <div className="download-item-body">
        <div className="download-item-row">
          <span className="download-item-name">{name}</span>
          <span className="download-item-status">
            {done
              ? 'Done'
              : active
                ? progress && progress.total > 0
                  ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
                  : 'Starting…'
                : 'Queued'}
          </span>
        </div>
        <div className="download-item-track">
          <div
            className="download-item-fill"
            style={{ width: done ? '100%' : `${pct}%` }}
          />
        </div>
      </div>
    </div>
  )
}
