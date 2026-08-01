import { useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
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
  const activeTabTrackRef = useRef<HTMLDivElement>(null)
  const activeTabIndicatorRef = useRef<HTMLDivElement>(null)
  const draggedTabIdRef = useRef<string>()
  const previewTabIdsRef = useRef<string[]>()
  const [address, setAddress] = useState('')
  const [newTabSearch, setNewTabSearch] = useState('')
  const [navigationError, setNavigationError] = useState('')
  const [tabOverflow, setTabOverflow] = useState<TabOverflowState>({ left: false, right: false })
  const [draggedTabId, setDraggedTabId] = useState<string>()
  const [previewTabIds, setPreviewTabIds] = useState<string[]>()
  const [shimmeringTabIds, setShimmeringTabIds] = useState<Set<string>>(
    () => new Set(state.tabs.filter((tab) => tab.loading).map((tab) => tab.id))
  )
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
  const tabsById = new Map(state.tabs.map((tab) => [tab.id, tab]))
  const displayedTabs = previewTabIds?.flatMap((tabId) => tabsById.get(tabId) ?? []) ?? state.tabs
  const tabOrder = displayedTabs.map((tab) => tab.id).join('\u0000')

  useEffect(() => {
    setShimmeringTabIds((current) => {
      const availableTabIds = new Set(state.tabs.map((tab) => tab.id))
      const next = new Set([...current].filter((tabId) => availableTabIds.has(tabId)))
      for (const tab of state.tabs) {
        if (tab.loading) next.add(tab.id)
      }
      if (next.size === current.size && [...next].every((tabId) => current.has(tabId))) return current
      return next
    })
  }, [state.tabs])

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
    const track = activeTabTrackRef.current
    const indicator = activeTabIndicatorRef.current
    if (!target || !track || !indicator || !open) return
    let frameId = 0
    let readyFrameId = 0
    const updateIndicator = (): void => {
      if (frameId) return
      frameId = requestAnimationFrame(() => {
        frameId = 0
        track.style.width = `${target.scrollWidth}px`
        track.style.transform = `translateX(${-target.scrollLeft}px)`
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
    for (const tab of target.querySelectorAll<HTMLElement>('.browser-tab')) observer.observe(tab)
    target.addEventListener('scroll', updateIndicator, { passive: true })
    updateIndicator()
    return () => {
      cancelAnimationFrame(frameId)
      cancelAnimationFrame(readyFrameId)
      observer.disconnect()
      target.removeEventListener('scroll', updateIndicator)
    }
  }, [open, state.activeTabId, state.tabs.length, tabOrder])

  useLayoutEffect(() => {
    const tabs = tabsRef.current
    const selectedTab = tabs?.querySelector<HTMLElement>('.browser-tab.active')
    if (!open || !tabs || !selectedTab) return
    const tabLeft = selectedTab.offsetLeft
    const tabRight = tabLeft + selectedTab.offsetWidth
    const visibleLeft = tabs.scrollLeft
    const visibleRight = visibleLeft + tabs.clientWidth
    if (tabLeft < visibleLeft) tabs.scrollLeft = tabLeft
    else if (tabRight > visibleRight) tabs.scrollLeft = tabRight - tabs.clientWidth
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

  const finishTabShimmer = (tabId: string): void => {
    if (state.tabs.find((tab) => tab.id === tabId)?.loading) return
    setShimmeringTabIds((current) => {
      if (!current.has(tabId)) return current
      const next = new Set(current)
      next.delete(tabId)
      return next
    })
  }

  const clearTabDrag = (): void => {
    draggedTabIdRef.current = undefined
    previewTabIdsRef.current = undefined
    setDraggedTabId(undefined)
    setPreviewTabIds(undefined)
  }

  const beginTabDrag = (event: ReactDragEvent<HTMLButtonElement>, tabId: string): void => {
    draggedTabIdRef.current = tabId
    const tabIds = state.tabs.map((tab) => tab.id)
    previewTabIdsRef.current = tabIds
    setDraggedTabId(tabId)
    setPreviewTabIds(tabIds)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', tabId)
  }

  const updateTabPreview = (event: ReactDragEvent<HTMLButtonElement>, targetTabId: string): void => {
    const sourceTabId = draggedTabIdRef.current
    if (!sourceTabId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (sourceTabId === targetTabId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const insertAfterTarget = event.clientX >= bounds.left + (bounds.width / 2)
    const current = previewTabIdsRef.current ?? state.tabs.map((tab) => tab.id)
    const next = current.filter((tabId) => tabId !== sourceTabId)
    const targetIndex = next.indexOf(targetTabId)
    next.splice(targetIndex + (insertAfterTarget ? 1 : 0), 0, sourceTabId)
    if (next.every((tabId, index) => tabId === current[index])) return
    previewTabIdsRef.current = next
    setPreviewTabIds(next)
  }

  const dropTab = (event: ReactDragEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    const tabIds = previewTabIdsRef.current
    const currentTabIds = state.tabs.map((tab) => tab.id)
    clearTabDrag()
    if (!tabIds || tabIds.every((tabId, index) => tabId === currentTabIds[index])) return
    update(window.api.reorderBrowserTabs(tabIds))
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
          <div className="browser-active-tab-track" ref={activeTabTrackRef} aria-hidden="true">
            <div className="browser-active-tab-indicator" ref={activeTabIndicatorRef} />
          </div>
          <div className="browser-tabs" ref={tabsRef}>
            {displayedTabs.map((tab) => (
              <button
                className={`${tab.id === state.activeTabId ? 'browser-tab active' : 'browser-tab'}${draggedTabId === tab.id ? ' dragging' : ''}`}
                type="button"
                role="tab"
                aria-selected={tab.id === state.activeTabId}
                title={tab.title}
                key={tab.id}
                draggable
                onDragStart={(event) => beginTabDrag(event, tab.id)}
                onDragOver={(event) => updateTabPreview(event, tab.id)}
                onDrop={dropTab}
                onDragEnd={clearTabDrag}
                onClick={() => update(window.api.activateBrowserTab(tab.id))}
              >
                {tab.faviconUrl
                  ? <img src={tab.faviconUrl} alt="" />
                  : <Globe2 size={13} aria-hidden="true" />}
                <span
                  className={shimmeringTabIds.has(tab.id) ? 'browser-tab-title loading' : 'browser-tab-title'}
                  data-text={shimmeringTabIds.has(tab.id) ? tab.title || 'New tab' : undefined}
                  onAnimationIteration={() => finishTabShimmer(tab.id)}
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
                  <X />
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
