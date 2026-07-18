import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalInterventionRequest, TerminalSessionInfo } from '../../shared/terminal'
import './TerminalPanel.css'

const TERMINAL_FONT_SIZE = 13
const TERMINAL_SCROLLBAR_REVEAL_RATIO = 0.1
const TERMINAL_MIN_HEIGHT = 120
const TERMINAL_WORKSPACE_MIN_HEIGHT = 180
const TERMINAL_KEYBOARD_RESIZE_STEP = 20

interface TerminalPanelProps {
  cwd?: string
  height: number
  onClose: () => void
  onHeightChange: (height: number) => void
  onReveal: () => void
  visible: boolean
}

interface TerminalResizeState {
  pointerId: number
  startHeight: number
  startY: number
  maxHeight: number
}

interface TerminalTabIndicator {
  left: number
  visible: boolean
  width: number
}

function resolvedTerminalTheme(element: HTMLElement): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const styles = getComputedStyle(element)
  return {
    background: styles.backgroundColor,
    foreground: styles.color,
    cursor: styles.color,
    selectionBackground: styles.outlineColor
  }
}

function TerminalView({ active, session }: { active: boolean; session: TerminalSessionInfo }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, Geist Mono, monospace',
      fontSize: TERMINAL_FONT_SIZE,
      theme: resolvedTerminalTheme(hostRef.current!)
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(hostRef.current!)
    const fit = () => {
      if (!hostRef.current?.offsetParent) return
      fitAddon.fit()
      window.api.resizeTerminal(session.id, terminal.cols, terminal.rows)
    }
    const frame = requestAnimationFrame(fit)
    const observer = new ResizeObserver(fit)
    observer.observe(hostRef.current!)
    const syncTheme = () => { terminal.options.theme = resolvedTerminalTheme(hostRef.current!) }
    const themeObserver = new MutationObserver(syncTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    const systemTheme = matchMedia('(prefers-color-scheme: dark)')
    systemTheme.addEventListener('change', syncTheme)
    const input = terminal.onData((data) => window.api.writeTerminal(session.id, data))
    const stopOutput = window.api.onTerminalOutput((event) => {
      if (event.sessionId === session.id) terminal.write(event.data)
    })
    const stopExit = window.api.onTerminalExit((event) => {
      if (event.sessionId === session.id) terminal.writeln(`\r\n[Process exited with code ${event.exitCode}]`)
    })
    window.api.attachTerminal(session.id)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      themeObserver.disconnect()
      systemTheme.removeEventListener('change', syncTheme)
      input.dispose()
      stopOutput()
      stopExit()
      terminal.dispose()
    }
  }, [session.id])

  useEffect(() => {
    const textarea = hostRef.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (active) textarea?.focus({ preventScroll: true })
    else if (document.activeElement === textarea) textarea.blur()
  }, [active])

  return <div className={active ? 'terminal-view active' : 'terminal-view'} ref={hostRef} />
}

export default function TerminalPanel({ cwd, height, onClose, onHeightChange, onReveal, visible }: TerminalPanelProps): JSX.Element {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeId, setActiveId] = useState('')
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [interventions, setInterventions] = useState<TerminalInterventionRequest[]>([])
  const [scrollbarVisible, setScrollbarVisible] = useState(false)
  const [tabIndicator, setTabIndicator] = useState<TerminalTabIndicator>({ left: 0, visible: false, width: 0 })
  const tabListRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const resizeRef = useRef<TerminalResizeState | null>(null)

  const maximumHeight = (): number => Math.max(TERMINAL_MIN_HEIGHT, (panelRef.current?.parentElement?.clientHeight ?? height) - TERMINAL_WORKSPACE_MIN_HEIGHT)
  const resizeTo = (nextHeight: number): void => onHeightChange(Math.min(maximumHeight(), Math.max(TERMINAL_MIN_HEIGHT, Math.round(nextHeight))))

  const addTerminal = async (): Promise<void> => {
    const session = await window.api.createTerminal(cwd, cwd)
    setActiveId(session.id)
  }

  const closeTerminal = async (id: string): Promise<void> => {
    await window.api.closeTerminal(id)
  }

  useEffect(() => {
    let disposed = false
    void Promise.all([window.api.listTerminals(), window.api.listTerminalInterventions()]).then(([existing, pending]) => {
      if (disposed) return
      setSessions((current) => {
        const byId = new Map(existing.map((session) => [session.id, session]))
        for (const session of current) byId.set(session.id, session)
        return [...byId.values()]
      })
      setActiveId((current) => current || existing.find((session) => session.active)?.id || existing[0]?.id || '')
      setInterventions(pending)
      setSessionsLoaded(true)
      if (existing.some((session) => session.panelVisible)) onReveal()
    })
    return () => { disposed = true }
  }, [onReveal])
  useEffect(() => window.api.onTerminalSessionEvent((event) => {
    if (event.type === 'closed') {
      setSessions((current) => {
        const index = current.findIndex((session) => session.id === event.session.id)
        const next = current.filter((session) => session.id !== event.session.id)
        setActiveId((active) => active === event.session.id ? next[Math.min(Math.max(index, 0), next.length - 1)]?.id ?? '' : active)
        return next
      })
      return
    }
    setSessions((current) => current.some((session) => session.id === event.session.id)
      ? current.map((session) => session.id === event.session.id ? event.session : session)
      : [...current, event.session])
  }), [])
  useEffect(() => window.api.onTerminalReveal((event) => {
    setActiveId(event.sessionId)
    onReveal()
  }), [onReveal])
  useEffect(() => window.api.onTerminalIntervention((request) => {
    setInterventions((current) => [...current.filter((candidate) => candidate.id !== request.id), request])
    if (request.terminalId) setActiveId(request.terminalId)
    if (request.kind === 'user-input') onReveal()
  }), [onReveal])
  useEffect(() => window.api.onTerminalInterventionDismissed((id) => {
    setInterventions((current) => current.filter((request) => request.id !== id))
  }), [])
  useEffect(() => {
    if (!visible || !sessionsLoaded || sessions.length > 0) return
    void addTerminal()
  }, [sessionsLoaded, sessions.length, visible])
  useEffect(() => {
    if (!sessionsLoaded) return
    window.api.updateTerminalUiState(visible, activeId)
  }, [activeId, sessionsLoaded, visible])
  useEffect(() => {
    tabListRef.current?.querySelector<HTMLElement>(`[data-terminal-id="${activeId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])
  useLayoutEffect(() => {
    const tabList = tabListRef.current
    const activeTab = tabList?.querySelector<HTMLElement>(`[data-terminal-id="${activeId}"]`)
    if (!tabList || !activeTab) {
      setTabIndicator((current) => ({ ...current, visible: false }))
      return
    }
    const syncIndicator = () => setTabIndicator({ left: activeTab.offsetLeft, visible: true, width: activeTab.offsetWidth })
    syncIndicator()
    const observer = new ResizeObserver(syncIndicator)
    observer.observe(tabList)
    observer.observe(activeTab)
    return () => observer.disconnect()
  }, [activeId, sessions.length])
  useEffect(() => {
    const constrainHeight = () => resizeTo(panelRef.current?.offsetHeight ?? height)
    constrainHeight()
    window.addEventListener('resize', constrainHeight)
    return () => window.removeEventListener('resize', constrainHeight)
  }, [])

  const resolveIntervention = async (request: TerminalInterventionRequest, approved: boolean): Promise<void> => {
    setInterventions((current) => current.filter((candidate) => candidate.id !== request.id))
    await window.api.resolveTerminalIntervention({ id: request.id, approved })
  }
  const modalIntervention = interventions.find((request) => request.kind !== 'user-input')
  const handoff = interventions.find((request) => request.kind === 'user-input' && request.terminalId === activeId)

  return <>
    <section
      className={`${visible ? 'terminal-panel' : 'terminal-panel hidden'}${scrollbarVisible ? ' scrollbar-visible' : ''}`}
      aria-label="Terminal panel"
      aria-hidden={!visible}
      ref={panelRef}
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        setScrollbarVisible(event.clientX >= bounds.right - bounds.width * TERMINAL_SCROLLBAR_REVEAL_RATIO)
      }}
      onPointerLeave={() => setScrollbarVisible(false)}
    >
      <div
        className="terminal-resize-handle"
        role="separator"
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        aria-valuemin={TERMINAL_MIN_HEIGHT}
        aria-valuemax={maximumHeight()}
        aria-valuenow={height}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          event.preventDefault()
          resizeTo(height + (event.key === 'ArrowUp' ? TERMINAL_KEYBOARD_RESIZE_STEP : -TERMINAL_KEYBOARD_RESIZE_STEP))
        }}
        onPointerDown={(event) => {
          resizeRef.current = { pointerId: event.pointerId, startHeight: height, startY: event.clientY, maxHeight: maximumHeight() }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const resize = resizeRef.current
          if (!resize || resize.pointerId !== event.pointerId) return
          onHeightChange(Math.min(resize.maxHeight, Math.max(TERMINAL_MIN_HEIGHT, Math.round(resize.startHeight + resize.startY - event.clientY))))
        }}
        onPointerUp={(event) => {
          if (resizeRef.current?.pointerId !== event.pointerId) return
          resizeRef.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onLostPointerCapture={() => { resizeRef.current = null }}
        onPointerCancel={() => { resizeRef.current = null }}
      />
      <div className="terminal-tabs">
        <div className="terminal-tab-list" role="tablist" aria-label="Terminal sessions" ref={tabListRef} onWheel={(event) => {
          if (!event.deltaY || event.deltaX) return
          event.currentTarget.scrollLeft += event.deltaY
        }}>
          <div
            className={tabIndicator.visible ? 'terminal-tab-indicator visible' : 'terminal-tab-indicator'}
            style={{ width: `${tabIndicator.width}px`, transform: `translateX(${tabIndicator.left}px)` } as CSSProperties}
            aria-hidden="true"
          />
          {sessions.map((session, index) => (
            <div className={session.id === activeId ? 'terminal-tab active' : 'terminal-tab'} role="presentation" data-terminal-id={session.id} key={session.id}>
              <button className="terminal-tab-select" type="button" role="tab" aria-selected={session.id === activeId} onClick={() => setActiveId(session.id)}>
                <TerminalIcon size={13} />
                <span>{session.title} {index + 1}</span>
              </button>
              <button className="terminal-tab-close" type="button" aria-label={`Close ${session.title} ${index + 1}`} title="Close terminal" onClick={() => void closeTerminal(session.id)}><X size={12} /></button>
            </div>
          ))}
        </div>
        <button className="terminal-panel-action" type="button" aria-label="New terminal" title="New terminal" onClick={() => void addTerminal()}><Plus size={15} /></button>
        <button className="terminal-panel-action close" type="button" aria-label="Close terminal panel" title="Close terminal panel" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="terminal-views">
        {sessions.map((session) => <TerminalView active={visible && session.id === activeId} session={session} key={session.id} />)}
        {handoff && (
          <div className="terminal-handoff" role="status">
            <div><strong>{handoff.reason}</strong>{handoff.instruction && <span>{handoff.instruction}</span>}</div>
            <div className="terminal-handoff-actions">
              <button type="button" onClick={() => void resolveIntervention(handoff, false)}>{handoff.cancelLabel}</button>
              <button className="primary" type="button" onClick={() => void resolveIntervention(handoff, true)}>{handoff.approveLabel}</button>
            </div>
          </div>
        )}
      </div>
    </section>
    {modalIntervention && (
      <div className="terminal-confirm-backdrop" role="presentation">
        <div className="terminal-confirm" role="alertdialog" aria-modal="true" aria-labelledby="terminal-confirm-title">
          <h2 id="terminal-confirm-title">{modalIntervention.title}</h2>
          <p>{modalIntervention.reason}</p>
          <p className="terminal-confirm-impact">{modalIntervention.impact}</p>
          <div className="terminal-confirm-actions">
            <button type="button" onClick={() => void resolveIntervention(modalIntervention, false)}>{modalIntervention.cancelLabel}</button>
            <button className="danger" type="button" onClick={() => void resolveIntervention(modalIntervention, true)}>{modalIntervention.approveLabel}</button>
          </div>
        </div>
      </div>
    )}
  </>
}
