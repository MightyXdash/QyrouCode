import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowLeft, ArrowRight, Globe2, Plus, RefreshCw, Search, X } from 'lucide-react'
import {
  BROWSER_NEW_TAB_URL,
  MAX_BROWSER_PANEL_WIDTH,
  MIN_BROWSER_PANEL_WIDTH,
  type BrowserNavigationAction,
  type BrowserPanelState
} from '../../shared/browser'
import './BrowserPanel.css'

const MIN_CHAT_PANE_WIDTH = 420
const TAB_SCROLL_TOLERANCE = 1

interface TabOverflowState {
  left: boolean
  right: boolean
}

interface BrowserPanelProps {
  open: boolean
  suppressed: boolean
  state: BrowserPanelState
  onStateChange: (state: BrowserPanelState) => void
  onPanelWidthChange: (width: number) => void
}

export default function BrowserPanel({
  open,
  suppressed,
  state,
  onStateChange,
  onPanelWidthChange
}: BrowserPanelProps): JSX.Element | null {
  const contentRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const activeTabIndicatorRef = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState('')
  const [newTabSearch, setNewTabSearch] = useState('')
  const [navigationError, setNavigationError] = useState('')
  const [tabOverflow, setTabOverflow] = useState<TabOverflowState>({ left: false, right: false })
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]

  useEffect(() => {
    setAddress(activeTab?.url ?? '')
    setNewTabSearch('')
    setNavigationError('')
  }, [activeTab?.id, activeTab?.url])

  useEffect(() => window.api.onBrowserFocusAddress(() => {
    addressRef.current?.focus()
    addressRef.current?.select()
  }), [])

  useEffect(() => {
    void window.api.setBrowserVisible(open && !suppressed).then(onStateChange)
  }, [onStateChange, open, suppressed])

  useLayoutEffect(() => {
    const target = contentRef.current
    if (!target || !open || suppressed) {
      window.api.setBrowserBounds({ x: 0, y: 0, width: 0, height: 0 })
      return
    }
    let frameId = 0
    const updateBounds = (): void => {
      if (frameId) return
      frameId = requestAnimationFrame(() => {
        frameId = 0
        const bounds = target.getBoundingClientRect()
        window.api.setBrowserBounds({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height
        })
      })
    }
    const observer = new ResizeObserver(updateBounds)
    observer.observe(target)
    window.addEventListener('resize', updateBounds)
    updateBounds()
    return () => {
      cancelAnimationFrame(frameId)
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
      window.api.setBrowserBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }, [open, suppressed])

  useLayoutEffect(() => {
    const target = tabsRef.current
    if (!target || !open) return
    let frameId = 0
    const updateOverflow = (): void => {
      if (frameId) return
      frameId = requestAnimationFrame(() => {
        frameId = 0
        const maximumScroll = Math.max(0, target.scrollWidth - target.clientWidth)
        const next = {
          left: target.scrollLeft > TAB_SCROLL_TOLERANCE,
          right: target.scrollLeft < maximumScroll - TAB_SCROLL_TOLERANCE
        }
        setTabOverflow((current) =>
          current.left === next.left && current.right === next.right ? current : next)
      })
    }
    const resizeObserver = new ResizeObserver(updateOverflow)
    const mutationObserver = new MutationObserver(updateOverflow)
    resizeObserver.observe(target)
    mutationObserver.observe(target, { childList: true, subtree: true, characterData: true })
    target.addEventListener('scroll', updateOverflow, { passive: true })
    updateOverflow()
    return () => {
      cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      target.removeEventListener('scroll', updateOverflow)
    }
  }, [open])

  useLayoutEffect(() => {
    const target = tabsRef.current
    const indicator = activeTabIndicatorRef.current
    if (!target || !indicator || !open) return
    let frameId = 0
    let readyFrameId = 0
    const updateIndicator = (): void => {
      if (frameId) return
      frameId = requestAnimationFrame(() => {
        frameId = 0
        const selectedTab = target.querySelector<HTMLElement>('.browser-tab.active')
        if (!selectedTab) {
          indicator.classList.remove('visible')
          return
        }
        indicator.style.width = `${selectedTab.offsetWidth}px`
        indicator.style.transform = `translateX(${selectedTab.offsetLeft}px)`
        indicator.classList.add('visible')
        if (!indicator.classList.contains('ready')) {
          readyFrameId = requestAnimationFrame(() => indicator.classList.add('ready'))
        }
      })
    }
    const observer = new ResizeObserver(updateIndicator)
    observer.observe(target)
    updateIndicator()
    return () => {
      cancelAnimationFrame(frameId)
      cancelAnimationFrame(readyFrameId)
      observer.disconnect()
    }
  }, [open, state.activeTabId, state.tabs.length])

  if (!open) return null

  const update = (operation: Promise<BrowserPanelState>): void => {
    void operation.then(onStateChange).catch((error) => {
      setNavigationError(error instanceof Error ? error.message : 'Browser action failed')
    })
  }

  const navigate = (event: FormEvent): void => {
    event.preventDefault()
    if (!activeTab) return
    setNavigationError('')
    update(window.api.navigateBrowser(activeTab.id, address))
  }

  const searchFromNewTab = (event: FormEvent): void => {
    event.preventDefault()
    if (!activeTab || !newTabSearch.trim()) return
    setNavigationError('')
    update(window.api.navigateBrowser(activeTab.id, newTabSearch))
  }

  const runNavigation = (action: BrowserNavigationAction): void => {
    if (activeTab) update(window.api.runBrowserNavigation(activeTab.id, action))
  }

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const workspace = event.currentTarget.closest<HTMLElement>('.app-workspace')
    if (!workspace) return
    const handle = event.currentTarget
    const workspaceBounds = workspace.getBoundingClientRect()
    let latestWidth = state.panelWidth
    const maximum = Math.min(
      MAX_BROWSER_PANEL_WIDTH,
      Math.max(MIN_BROWSER_PANEL_WIDTH, workspaceBounds.width - MIN_CHAT_PANE_WIDTH)
    )
    const applyWidth = (pointerEvent: PointerEvent): void => {
      latestWidth = Math.round(Math.min(
        maximum,
        Math.max(MIN_BROWSER_PANEL_WIDTH, workspaceBounds.right - pointerEvent.clientX)
      ))
      workspace.style.setProperty('--browser-panel-width', `${latestWidth}px`)
    }
    const finish = (): void => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
      handle.removeEventListener('pointermove', applyWidth)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', finish)
      workspace.classList.remove('browser-resizing')
      onPanelWidthChange(latestWidth)
      update(window.api.setBrowserPanelWidth(latestWidth))
    }

    workspace.classList.add('browser-resizing')
    handle.setPointerCapture(event.pointerId)
    handle.addEventListener('pointermove', applyWidth)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
  }

  return (
    <aside className="browser-panel" aria-label="Browser">
      <div className="browser-resize-handle" role="separator" aria-label="Resize browser panel" aria-orientation="vertical" onPointerDown={beginResize} />
      <div className="browser-tab-strip" role="tablist" aria-label="Browser tabs">
        <div className={`browser-tabs-shell${tabOverflow.left ? ' can-scroll-left' : ''}${tabOverflow.right ? ' can-scroll-right' : ''}`}>
          <div className="browser-tabs" ref={tabsRef}>
            <div className="browser-active-tab-indicator" ref={activeTabIndicatorRef} aria-hidden="true" />
            {state.tabs.map((tab) => (
              <button
                className={tab.id === state.activeTabId ? 'browser-tab active' : 'browser-tab'}
                type="button"
                role="tab"
                aria-selected={tab.id === state.activeTabId}
                title={tab.title}
                key={tab.id}
                onClick={() => update(window.api.activateBrowserTab(tab.id))}
              >
                {tab.faviconUrl
                  ? <img src={tab.faviconUrl} alt="" />
                  : <Globe2 size={13} aria-hidden="true" />}
                <span
                  className={tab.loading ? 'browser-tab-title loading' : 'browser-tab-title'}
                  data-text={tab.loading ? tab.title || 'New tab' : undefined}
                >
                  {tab.title || 'New tab'}
                </span>
                <span
                  className="browser-tab-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${tab.title || 'tab'}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    update(window.api.closeBrowserTab(tab.id))
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    event.stopPropagation()
                    update(window.api.closeBrowserTab(tab.id))
                  }}
                >
                  <X size={11} />
                </span>
              </button>
            ))}
          </div>
        </div>
        <button className="browser-new-tab" type="button" aria-label="New tab" title="New tab" onClick={() => update(window.api.createBrowserTab())}>
          <Plus size={15} />
        </button>
      </div>
      <div className="browser-toolbar">
        <button type="button" aria-label="Back" title="Back" disabled={!activeTab?.canGoBack} onClick={() => runNavigation('back')}><ArrowLeft size={15} /></button>
        <button type="button" aria-label="Forward" title="Forward" disabled={!activeTab?.canGoForward} onClick={() => runNavigation('forward')}><ArrowRight size={15} /></button>
        <button type="button" aria-label={activeTab?.loading ? 'Stop loading' : 'Reload'} title={activeTab?.loading ? 'Stop loading' : 'Reload'} disabled={!activeTab?.url} onClick={() => runNavigation(activeTab?.loading ? 'stop' : 'reload')}>
          {activeTab?.loading ? <X size={14} /> : <RefreshCw size={14} />}
        </button>
        <form onSubmit={navigate}>
          {activeTab?.url ? <Globe2 size={13} aria-hidden="true" /> : <Search size={13} aria-hidden="true" />}
          <input
            ref={addressRef}
            value={address}
            aria-label="Address and search"
            placeholder="Search anything"
            spellCheck={false}
            onChange={(event) => {
              setAddress(event.target.value)
              setNavigationError('')
            }}
            onFocus={(event) => event.currentTarget.select()}
          />
        </form>
      </div>
      {navigationError && <div className="browser-navigation-error" role="alert">{navigationError}</div>}
      <div className="browser-content-host" ref={contentRef}>
        {activeTab?.url === BROWSER_NEW_TAB_URL && (
          <div className="browser-new-tab-page">
            <form className="browser-new-tab-search" onSubmit={searchFromNewTab}>
              <Search size={15} aria-hidden="true" />
              <input
                value={newTabSearch}
                aria-label="Search anything"
                placeholder="Search anything"
                spellCheck={false}
                autoFocus
                onChange={(event) => {
                  setNewTabSearch(event.target.value)
                  setNavigationError('')
                }}
              />
            </form>
          </div>
        )}
      </div>
    </aside>
  )
}
