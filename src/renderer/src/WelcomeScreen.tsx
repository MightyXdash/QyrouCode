import { memo, useState, useCallback, useEffect, useMemo, useRef } from 'react'
import WindowControls from './WindowControls'
import { MODEL_LIST, type CatalogModel, type Ratings } from './modelCatalog'
import {
  CUSTOM_RESPONSE_INSTRUCTION_LABEL,
  CUSTOM_RESPONSE_INSTRUCTION_PLACEHOLDER,
  ONBOARDING_QUESTIONS,
  buildOnboardingPreferences,
  isQuestionComplete,
  type OnboardingDraft,
  type OnboardingQuestion,
  type PreferenceQuestionKey
} from './onboardingQuestions'
import { MAX_CUSTOM_RESPONSE_STYLE_LENGTH } from '../../shared/settings'
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
type TransitionDirection = 'forward' | 'back'
type OnboardingStatus = 'loading' | 'active' | 'complete'
type DownloadEntry = { id: string; name: string; hf_repo: string }

const EXIT_STAGGER_MS = 80
const EXIT_DURATION_MS = 220
const WELCOME_EXIT_DURATION_MS = 320
const DOWNLOAD_COMPLETION_HOLD_MS = 520
const SETUP_INTRO_PAGE = 4
const QUESTION_START_PAGE = SETUP_INTRO_PAGE + 1
const SETUP_INTRO_ENTER_MS = 280
const QUESTION_HEADER_DURATION_MS = 180
const QUESTION_CARD_DELAY_MS = 55
const QUESTION_CARD_DURATION_MS = 200
const QUESTION_EXIT_STAGGER_MS = 55
const ENTER_TITLE_MS = 180
const ENTER_CARD_DELAY_MS = 70
const ENTER_CARD_STAGGER_MS = 55
const ENTER_CARD_DURATION_MS = 170
const ROLES_ENTER_CARD_DURATION_MS = 200
const TRANSITION_CLEARANCE_MS = 80
const DOWNLOAD_VISIBLE_ITEM_COUNT = 6
const READY_TITLE_LINES = [
  "You're all set! SupraCode will fetch these models",
  'and the essentials from SupraLabs.',
] as const
const READY_SUBTITLE_LINES = [
  'These models take a little while to download. Perfect time to',
  'stretch your legs or grab a drink.',
] as const
const READY_TITLE_TEXT = READY_TITLE_LINES.join(' ')
const READY_SUBTITLE_TEXT = READY_SUBTITLE_LINES.join(' ')
const READY_SUBTITLE_CPS = 80
const READY_TITLE_SCALE_MS = 360
const READY_SUBTITLE_CHAR_FADE_MS = 120
const READY_CARD_DELAY_AFTER_TEXT_MS = 110
const READY_CARD_STAGGER_MS = 70
const READY_CARD_POP_MS = 360
const READY_MAX_DOWNLOAD_ITEM_COUNT = MODEL_LIST.length + ESSENTIAL_MODELS.length
const INITIAL_ASSET_TIMEOUT_MS = 1200
const INITIAL_MOTION_FRAME_COUNT = 2

const isQuestionPage = (page: number) =>
  page >= QUESTION_START_PAGE && page < QUESTION_START_PAGE + ONBOARDING_QUESTIONS.length

const questionIndexForPage = (page: number) => page - QUESTION_START_PAGE

const questionForPage = (page: number) => ONBOARDING_QUESTIONS[questionIndexForPage(page)]

const questionEnterDuration = (page: number) => {
  const question = questionForPage(page)
  if (!question) return QUESTION_HEADER_DURATION_MS
  return QUESTION_CARD_DELAY_MS + Math.max(question.choices.length - 1, 0) * QUESTION_CARD_DELAY_MS + QUESTION_CARD_DURATION_MS
}

const questionExitDuration = (page: number) => {
  const question = questionForPage(page)
  if (!question) return EXIT_DURATION_MS
  return question.choices.length * QUESTION_EXIT_STAGGER_MS + EXIT_DURATION_MS
}

const staggeredDuration = (itemCount: number, durationMs = ENTER_CARD_DURATION_MS) =>
  ENTER_CARD_DELAY_MS + Math.max(itemCount - 1, 0) * ENTER_CARD_STAGGER_MS + durationMs

const streamDuration = (text: string, charsPerSecond: number) =>
  Math.ceil((text.length / charsPerSecond) * 1000)

const readySubtitleDelay = () => READY_TITLE_SCALE_MS

const readySubtitleDuration = () =>
  streamDuration(READY_SUBTITLE_TEXT, READY_SUBTITLE_CPS) + READY_SUBTITLE_CHAR_FADE_MS

const readyCardsDelay = () =>
  readySubtitleDelay() + readySubtitleDuration() + READY_CARD_DELAY_AFTER_TEXT_MS

const readyEnterDuration = () =>
  readyCardsDelay() + Math.max(READY_MAX_DOWNLOAD_ITEM_COUNT - 1, 0) * READY_CARD_STAGGER_MS + READY_CARD_POP_MS

const exitDuration = (currentPage: number) => {
  if (currentPage === 0) return WELCOME_EXIT_DURATION_MS
  if (currentPage === 3) return EXIT_DURATION_MS
  if (currentPage === SETUP_INTRO_PAGE) return EXIT_DURATION_MS
  if (isQuestionPage(currentPage)) return questionExitDuration(currentPage)
  if (currentPage === 1) return ROLES.length * EXIT_STAGGER_MS + EXIT_DURATION_MS
  if (currentPage === 2) return MODEL_LIST.length * EXIT_STAGGER_MS + EXIT_DURATION_MS
  return EXIT_DURATION_MS
}

const enterDuration = (nextPage: number) => {
  if (nextPage === 1) return Math.max(ENTER_TITLE_MS, staggeredDuration(ROLES.length, ROLES_ENTER_CARD_DURATION_MS))
  if (nextPage === 2) return Math.max(ENTER_TITLE_MS, staggeredDuration(MODEL_LIST.length))
  if (nextPage === 3) return readyEnterDuration()
  if (nextPage === SETUP_INTRO_PAGE) return SETUP_INTRO_ENTER_MS
  if (isQuestionPage(nextPage)) return questionEnterDuration(nextPage)
  return ENTER_TITLE_MS
}

const animationDelay = (delayMs: number) => ({ animationDelay: `${delayMs}ms` })
const transitionStyle = (delayMs: number, durationMs?: number) => ({
  animationDelay: `${delayMs}ms`,
  ...(durationMs ? { animationDuration: `${durationMs}ms` } : {}),
})

const waitForAnimationFrame = () =>
  new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))

const waitForInitialPaint = async () => {
  for (let frame = 0; frame < INITIAL_MOTION_FRAME_COUNT; frame += 1) {
    await waitForAnimationFrame()
  }
}

const waitForInitialAssets = () =>
  Promise.race([
    document.fonts.ready,
    new Promise<void>(resolve => window.setTimeout(resolve, INITIAL_ASSET_TIMEOUT_MS))
  ])

const ReadyStreamedText = memo(function ReadyStreamedText({
  lines,
  charsPerSecond,
  delayMs,
  className,
  durationMs,
}: {
  lines: readonly string[]
  charsPerSecond: number
  delayMs: number
  className: string
  durationMs: number
}): JSX.Element {
  const charDelayMs = 1000 / charsPerSecond
  let charIndex = 0

  return (
    <>
      {lines.map((line) => (
        <span key={line} className="ready-text-line">
          {line.split(' ').map((word, wordIndex, words) => (
            <span key={`${word}-${wordIndex}`} className="ready-text-word">
              {[...word].map((char) => {
                const currentIndex = charIndex
                charIndex += 1

                return (
                  <span
                    key={`${char}-${currentIndex}`}
                    className={`${className} streaming`}
                    style={transitionStyle(delayMs + currentIndex * charDelayMs, durationMs)}
                  >
                    {char}
                  </span>
                )
              })}
              {wordIndex < words.length - 1 && (() => {
                charIndex += 1
                return ' '
              })()}
            </span>
          ))}
        </span>
      ))}
    </>
  )
})

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
  const [modelCacheReady, setModelCacheReady] = useState(false)
  const [activeDownloads, setActiveDownloads] = useState<Set<string>>(new Set())
  const [downloadProgress, setDownloadProgress] = useState<Record<string, { downloaded: number; total: number }>>({})
  const [downloadList, setDownloadList] = useState<DownloadEntry[]>([])
  const [downloadFailures, setDownloadFailures] = useState<Record<string, string>>({})
  const [downloadsSettled, setDownloadsSettled] = useState(false)
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus>('loading')
  const [preferenceDraft, setPreferenceDraft] = useState<OnboardingDraft>({ customResponseInstruction: '' })
  const [settingsError, setSettingsError] = useState('')
  const [savingPreferences, setSavingPreferences] = useState(false)
  const [initialMotionReady, setInitialMotionReady] = useState(false)
  const transitioning = useRef(false)
  const downloadsStarted = useRef(false)
  const downloadsTransitionStarted = useRef(false)
  const [transitionDirection, setTransitionDirection] = useState<TransitionDirection>('forward')

  useEffect(() => {
    let cancelled = false

    const beginInitialMotion = async () => {
      await waitForInitialPaint()
      if (!cancelled) setInitialMotionReady(true)
    }

    const stopListening = window.api.onWindowShown(() => {
      void beginInitialMotion()
    })

    const signalRendererReady = async () => {
      await waitForInitialAssets()
      await waitForInitialPaint()
      if (!cancelled) window.api.rendererReady()
    }

    void signalRendererReady()

    return () => {
      cancelled = true
      stopListening()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    window.api.getOnboardingState()
      .then(state => {
        if (!cancelled) setOnboardingStatus(state.completed ? 'complete' : 'active')
      })
      .catch(() => {
        if (!cancelled) setOnboardingStatus('active')
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (page !== 2) return
    let cancelled = false
    setModelCacheReady(false)

    const allModels = [...MODEL_LIST, ...ESSENTIAL_MODELS]

    const checkCaches = async () => {
      try {
        const results = await Promise.all(
          allModels.map(async model => ({
            id: model.id,
            cached: await window.api.checkModelCache(model.hf_repo)
          }))
        )

        if (cancelled) return
        setCachedModels(new Set(results.filter(result => result.cached).map(result => result.id)))
      } catch {
        if (!cancelled) setCachedModels(new Set())
      } finally {
        if (!cancelled) setModelCacheReady(true)
      }
    }

    void checkCaches()

    return () => {
      cancelled = true
    }
  }, [page])

  useEffect(() => {
    return window.api.onDownloadProgress(({ repoId, downloaded, total }) => {
      setDownloadProgress(prev => ({ ...prev, [repoId]: { downloaded, total } }))
    })
  }, [])

  const pendingDownloadList = useMemo<DownloadEntry[]>(() => [
    ...MODEL_LIST
      .filter(model => selectedModels.has(model.id) && !cachedModels.has(model.id))
      .map(model => ({ id: model.id, name: model.name, hf_repo: model.hf_repo })),
    ...ESSENTIAL_MODELS
      .filter(model => !cachedModels.has(model.id))
      .map(model => ({ id: model.id, name: model.label, hf_repo: model.hf_repo }))
  ], [cachedModels, selectedModels])

  const cachedSelectableModelIds = useMemo(
    () => MODEL_LIST.filter(model => cachedModels.has(model.id)).map(model => model.id),
    [cachedModels]
  )

  const navigate = (nextPage: number, direction: TransitionDirection) => {
    if (transitioning.current) return
    transitioning.current = true
    setTransitionDirection(direction)
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

  const goNext = () => {
    const nextPage = page === 2 && modelCacheReady && pendingDownloadList.length === 0
      ? SETUP_INTRO_PAGE
      : page + 1
    navigate(nextPage, 'forward')
  }

  const goBack = () => {
    if (page <= SETUP_INTRO_PAGE) return
    navigate(page - 1, 'back')
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

  const runDownloadQueue = useCallback(async (models: DownloadEntry[]) => {
    setDownloadsSettled(false)

    for (const model of models) {
      setActiveDownloads(prev => new Set(prev).add(model.id))
      setDownloadFailures(prev => {
        const next = { ...prev }
        delete next[model.id]
        return next
      })

      try {
        await window.api.downloadModel(model.hf_repo)
        setCachedModels(prev => new Set(prev).add(model.id))
      } catch {
        setDownloadFailures(prev => ({
          ...prev,
          [model.id]: 'Unable to download this model. Check your connection and try again.'
        }))
      } finally {
        setActiveDownloads(prev => {
          const next = new Set(prev)
          next.delete(model.id)
          return next
        })
      }
    }

    setDownloadsSettled(true)
  }, [])

  useEffect(() => {
    if (page !== 3 || downloadsStarted.current) return
    downloadsStarted.current = true

    const list = pendingDownloadList
    setDownloadList(list)
    void runDownloadQueue(list)
  }, [page, pendingDownloadList, runDownloadQueue])

  const retryDownload = (model: DownloadEntry) => {
    if (activeDownloads.has(model.id)) return
    void runDownloadQueue([model])
  }

  const downloadsComplete =
    downloadsSettled &&
    downloadList.every(model => cachedModels.has(model.id)) &&
    Object.keys(downloadFailures).length === 0

  useEffect(() => {
    if (page !== 3 || !downloadsComplete || downloadsTransitionStarted.current) return
    downloadsTransitionStarted.current = true
    const timeout = window.setTimeout(goNext, DOWNLOAD_COMPLETION_HOLD_MS)
    return () => window.clearTimeout(timeout)
  }, [downloadsComplete, page])

  const selectPreference = (key: PreferenceQuestionKey, value: string | number | boolean) => {
    setSettingsError('')
    setPreferenceDraft(previous => ({ ...previous, [key]: value } as OnboardingDraft))
  }

  const savePreferences = async () => {
    setSettingsError('')
    setSavingPreferences(true)

    try {
      await window.api.completeOnboarding(
        buildOnboardingPreferences(
          preferenceDraft,
          selectedRoles,
          [...new Set([...selectedModels, ...cachedSelectableModelIds])]
        )
      )
      setOnboardingStatus('complete')
    } catch {
      setSettingsError('Unable to save your preferences. Please try again.')
    } finally {
      setSavingPreferences(false)
    }
  }

  const sortedModels = useMemo(() => {
    return MODEL_LIST
      .map(m => ({ model: m, interested: computeInterestScore(m, selectedRoles) > 0 }))
      .sort((a, b) => Number(b.interested) - Number(a.interested) || a.model.recommended_vram_gb - b.model.recommended_vram_gb)
  }, [selectedRoles])

  const displayPage = phase === 'exit' ? prevPage : page
  const currentQuestionIndex = isQuestionPage(displayPage) ? questionIndexForPage(displayPage) : -1
  const currentQuestion = currentQuestionIndex >= 0 ? ONBOARDING_QUESTIONS[currentQuestionIndex] : undefined
  const hasCachedSelectableModels = cachedSelectableModelIds.length > 0
  const canContinueFromModelSelector = modelCacheReady && (selectedModels.size > 0 || hasCachedSelectableModels)
  const modelSelectorAction = !modelCacheReady
    ? 'Checking downloaded models…'
    : selectedModels.size > 0
      ? 'Download selected'
      : 'Continue with downloaded models'

  if (onboardingStatus !== 'active') {
    return (
      <div className="welcome blank-state">
        <div className="drag-region" />
        <WindowControls />
      </div>
    )
  }

  return (
    <div className={`welcome${initialMotionReady ? ' initial-motion-ready' : ' initial-motion-pending'}`}>
      <div className="drag-region" />
      <WindowControls />
      {displayPage === 0 && (
        <div className={`page-inner welcome-inner${phase === 'exit' ? ' welcome-exit' : ''}`}>
          <div className="welcome-center">
            <h1 className="welcome-title initial-enter">
              SupraCode
            </h1>
            <p className="welcome-subtitle initial-enter">
              Welcome to SupraCode!
            </p>
            <p className="welcome-description initial-enter">
              Let&apos;s download (or connect to) the necessary AI models we
              need for the app to work.
            </p>
          </div>
          <div className="next-wrapper initial-enter">
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
            {modelCacheReady && hasCachedSelectableModels && (
              <p className="models-availability">
                {cachedSelectableModelIds.length} downloaded model{cachedSelectableModelIds.length === 1 ? '' : 's'} ready to use.
              </p>
            )}
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
                onToggle={cachedModels.has(model.id) ? undefined : () => toggleModel(model.id)}
                phase={phase}
                index={i}
              />
            ))}
          </div>
          <div className="models-footer">
            <button
              className="next-btn"
              disabled={!canContinueFromModelSelector}
              onClick={goNext}
            >
              {modelSelectorAction}
            </button>
          </div>
        </div>
      )}
      {displayPage === 3 && (
        <div className={`page-inner ready-inner${phase === 'exit' ? ' ready-exit' : ''}`}>
          <div className="ready-header">
            <h2
              className={`ready-title${phase === 'enter' ? ' ready-title-scale-in' : ''}`}
              style={phase === 'enter' ? transitionStyle(0, READY_TITLE_SCALE_MS) : undefined}
            >
              {READY_TITLE_TEXT}
            </h2>
            <p className="ready-subtitle" aria-label={READY_SUBTITLE_TEXT}>
              <span aria-hidden="true">
                <ReadyStreamedText
                  lines={READY_SUBTITLE_LINES}
                  charsPerSecond={READY_SUBTITLE_CPS}
                  delayMs={readySubtitleDelay()}
                  className="ready-subtitle-char"
                  durationMs={READY_SUBTITLE_CHAR_FADE_MS}
                />
              </span>
            </p>
          </div>
          <div className={`download-list${downloadList.length > DOWNLOAD_VISIBLE_ITEM_COUNT ? ' has-overflow' : ''}`}>
            {downloadList.map((m, index) => (
              <DownloadItem
                key={m.id}
                name={m.name}
                done={cachedModels.has(m.id)}
                active={activeDownloads.has(m.id)}
                failure={downloadFailures[m.id]}
                progress={downloadProgress[m.hf_repo]}
                phase={phase}
                index={index}
                onRetry={() => retryDownload(m)}
              />
            ))}
          </div>
          <p className="ready-warning">
            {Object.keys(downloadFailures).length > 0
              ? 'Retry every failed download to continue.'
              : 'DO NOT CLOSE THIS WINDOW!'}
          </p>
        </div>
      )}
      {displayPage === SETUP_INTRO_PAGE && (
        <div className={`page-inner setup-intro${phase === 'enter' ? ' setup-intro-enter' : ''}${phase === 'exit' ? ' setup-intro-exit' : ''}`}>
          <div className="setup-intro-content">
            <p className="setup-eyebrow">Personalise SupraCode</p>
            <h2>We&apos;re almost done</h2>
            <p>SupraCode will ask a few quick questions to tailor the app to how you work. Select Ready whenever you&apos;re set.</p>
          </div>
          <button className="next-btn" onClick={goNext}>Ready</button>
        </div>
      )}
      {currentQuestion && (
        <PreferenceQuestion
          question={currentQuestion}
          step={currentQuestionIndex + 1}
          totalSteps={ONBOARDING_QUESTIONS.length}
          draft={preferenceDraft}
          phase={phase}
          direction={transitionDirection}
          saving={savingPreferences}
          error={settingsError}
          onSelect={selectPreference}
          onCustomInstructionChange={value => {
            setSettingsError('')
            setPreferenceDraft(previous => ({ ...previous, customResponseInstruction: value }))
          }}
          onBack={goBack}
          onContinue={currentQuestionIndex === ONBOARDING_QUESTIONS.length - 1 ? savePreferences : goNext}
        />
      )}
    </div>
  )
}

function PreferenceQuestion({
  question,
  step,
  totalSteps,
  draft,
  phase,
  direction,
  saving,
  error,
  onSelect,
  onCustomInstructionChange,
  onBack,
  onContinue
}: {
  question: OnboardingQuestion
  step: number
  totalSteps: number
  draft: OnboardingDraft
  phase: Phase
  direction: TransitionDirection
  saving: boolean
  error: string
  onSelect: (key: PreferenceQuestionKey, value: string | number | boolean) => void
  onCustomInstructionChange: (value: string) => void
  onBack: () => void
  onContinue: () => void
}): JSX.Element {
  const selectedValue = draft[question.key]
  const isCustomResponseStyle = question.key === 'responseStyle' && selectedValue === 'custom'
  const isLastQuestion = step === totalSteps
  const complete = isQuestionComplete(question, draft)
  const exitClass = direction === 'forward' ? ' exit-left' : ' exit-right'
  const enterClass = direction === 'forward' ? ' preference-enter-right' : ' preference-enter-left'
  const headerClass = phase === 'exit'
    ? exitClass
    : phase === 'enter'
      ? ' preference-header-enter'
      : ''
  const footerDelay = QUESTION_CARD_DELAY_MS +
    Math.max(question.choices.length - 1, 0) * QUESTION_CARD_DELAY_MS
  const footerClass = phase === 'exit'
    ? exitClass
    : phase === 'enter'
      ? enterClass
      : ''

  return (
    <div className="page-inner preference-inner">
      <div
        className={`preference-header${headerClass}`}
        style={phase === 'exit' ? animationDelay(0) : undefined}
      >
        <div className="preference-progress" aria-label={`Step ${step} of ${totalSteps}`}>
          <span>{question.group}</span>
          <span>Step {step} of {totalSteps}</span>
        </div>
        <h2>{question.title}</h2>
        <p>{question.description}</p>
      </div>
      <div className="preference-choices" role="radiogroup" aria-label={question.title}>
        {question.choices.map((choice, index) => {
          const selected = selectedValue === choice.value
          const choiceClass = phase === 'exit'
            ? exitClass
            : phase === 'enter'
              ? enterClass
              : ''
          const choiceDelay = phase === 'exit'
            ? index * QUESTION_EXIT_STAGGER_MS
            : QUESTION_CARD_DELAY_MS + index * QUESTION_CARD_DELAY_MS

          return (
            <button
              key={String(choice.value)}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`preference-choice${selected ? ' selected' : ''}${choice.caution ? ' caution' : ''}${choiceClass}`}
              style={phase === 'idle' ? undefined : animationDelay(choiceDelay)}
              onClick={() => onSelect(question.key, choice.value)}
            >
              <span className={`preference-radio${selected ? ' checked' : ''}`} aria-hidden="true">
                {selected && (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="preference-choice-copy">
                <span className="preference-choice-title">{choice.label}</span>
                <span className="preference-choice-description">{choice.description}</span>
              </span>
              <span className="preference-choice-meta">
                {choice.recommended && <span className="preference-recommended">Recommended</span>}
                {choice.detail && <span className="preference-detail">{choice.detail}</span>}
              </span>
            </button>
          )
        })}
      </div>
      {isCustomResponseStyle && (
        <div
          className={`custom-response-field${phase === 'exit' ? exitClass : phase === 'enter' ? enterClass : ''}`}
          style={phase === 'idle' ? undefined : animationDelay(footerDelay)}
        >
          <label htmlFor="custom-response-instruction">{CUSTOM_RESPONSE_INSTRUCTION_LABEL}</label>
          <textarea
            id="custom-response-instruction"
            maxLength={MAX_CUSTOM_RESPONSE_STYLE_LENGTH}
            placeholder={CUSTOM_RESPONSE_INSTRUCTION_PLACEHOLDER}
            value={draft.customResponseInstruction}
            onChange={event => onCustomInstructionChange(event.target.value)}
          />
          <span>{draft.customResponseInstruction.length} / {MAX_CUSTOM_RESPONSE_STYLE_LENGTH}</span>
        </div>
      )}
      <div
        className={`preference-footer${footerClass}`}
        style={phase === 'idle' ? undefined : animationDelay(phase === 'exit' ? question.choices.length * QUESTION_EXIT_STAGGER_MS : footerDelay)}
      >
        <button className="back-btn" onClick={onBack} disabled={saving}>Back</button>
        <div className="preference-submit">
          {error && <p className="preference-error" role="alert">{error}</p>}
          <button className="next-btn" disabled={!complete || saving} onClick={onContinue}>
            {saving ? 'Saving…' : isLastQuestion ? 'Save preferences' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModelCard({ model, selected, cached, downloading, progress, onToggle, phase, index }: {
  model: CatalogModel
  selected: boolean
  cached: boolean
  downloading: boolean
  progress?: { downloaded: number; total: number }
  onToggle?: () => void
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

function DownloadItem({ name, done, active, failure, progress, phase, index, onRetry }: {
  name: string
  done: boolean
  active: boolean
  failure?: string
  progress?: { downloaded: number; total: number }
  phase: Phase
  index: number
  onRetry: () => void
}): JSX.Element {
  const pct = progress && progress.total > 0
    ? Math.min(100, (progress.downloaded / progress.total) * 100)
    : 0
  const activeStatus = progress && progress.total > 0
    ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
    : 'Starting…'

  return (
    <div
      className={`download-item${done ? ' done' : ''}${active ? ' active' : ''}${failure ? ' failed' : ''}${phase === 'enter' ? ' ready-pop-in' : ''}`}
      style={phase === 'enter' ? transitionStyle(readyCardsDelay() + index * READY_CARD_STAGGER_MS, READY_CARD_POP_MS) : undefined}
    >
      <div className="download-item-icon">
        {done ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="6.5" fill="#12c905" />
            <path d="M4 7l2 2 4-4" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : active ? (
          <span className="download-spinner" />
        ) : failure ? (
          <span className="download-failure-mark">!</span>
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
                  ? activeStatus
                  : activeStatus
                : failure
                  ? 'Needs attention'
                : 'Queued'}
          </span>
        </div>
        <div className="download-item-track">
          <div
            className="download-item-fill"
            style={{ width: done ? '100%' : `${pct}%` }}
          />
        </div>
        {failure && (
          <div className="download-failure-row">
            <span>{failure}</span>
            <button type="button" onClick={onRetry}>Retry</button>
          </div>
        )}
      </div>
    </div>
  )
}
