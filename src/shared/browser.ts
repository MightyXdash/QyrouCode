export const BROWSER_NEW_TAB_URL = ''
export const BROWSER_NEW_TAB_TITLE = 'New tab'
export const BROWSER_SEARCH_URL = 'https://www.google.com/search?q='
export const BROWSER_SESSION_PARTITION = 'persist:qyroucode-browser'
export const DEFAULT_BROWSER_PANEL_WIDTH = 620
export const MIN_BROWSER_PANEL_WIDTH = 360
export const MAX_BROWSER_PANEL_WIDTH = 2000
export const BROWSER_CAPTURE_FLASH_DURATION_MS = 1_000

export const BROWSER_CAPTURE_FLASH_COLORS: Record<'light' | 'dark', string> = {
  light: 'rgba(255, 255, 255, 0.75)',
  dark: 'rgba(255, 255, 255, 0.35)'
}

const DEFAULT_BROWSER_TAB_ID = 'browser-home'
const MAX_BROWSER_TAB_ID_CHARACTERS = 128
const MAX_BROWSER_TITLE_CHARACTERS = 512
const EXPLICIT_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i
const DOMAIN_PATTERN = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#].*)?$/i
const LOCAL_HOST_PATTERN = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#].*)?$/i

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PersistedBrowserTab {
  id: string
  title: string
  url: string
}

export interface PersistedBrowserState {
  tabs: PersistedBrowserTab[]
  activeTabId: string
  panelWidth: number
}

export interface BrowserTabState extends PersistedBrowserTab {
  faviconUrl?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserPanelState {
  tabs: BrowserTabState[]
  activeTabId: string
  visible: boolean
  panelWidth: number
}

export type BrowserNavigationAction = 'back' | 'forward' | 'reload' | 'stop'

export const DEFAULT_BROWSER_STATE: PersistedBrowserState = {
  tabs: [{ id: DEFAULT_BROWSER_TAB_ID, title: BROWSER_NEW_TAB_TITLE, url: BROWSER_NEW_TAB_URL }],
  activeTabId: DEFAULT_BROWSER_TAB_ID,
  panelWidth: DEFAULT_BROWSER_PANEL_WIDTH
}

export function isAllowedBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

export function normalizeBrowserInput(value: string): string {
  const input = value.trim()
  if (!input) return BROWSER_NEW_TAB_URL

  if (!/\s/u.test(input) && (DOMAIN_PATTERN.test(input) || LOCAL_HOST_PATTERN.test(input))) {
    const protocol = LOCAL_HOST_PATTERN.test(input) ? 'http://' : 'https://'
    const url = new URL(`${protocol}${input}`)
    if (!isAllowedBrowserUrl(url.toString())) throw new Error('Enter a valid web address')
    return url.toString()
  }

  if (EXPLICIT_SCHEME_PATTERN.test(input)) {
    if (!isAllowedBrowserUrl(input)) throw new Error('Only HTTP and HTTPS addresses can be opened')
    return new URL(input).toString()
  }

  return `${BROWSER_SEARCH_URL}${encodeURIComponent(input)}`
}

export function normalizePersistedBrowserState(value: unknown): PersistedBrowserState {
  if (!value || typeof value !== 'object') return structuredClone(DEFAULT_BROWSER_STATE)
  const candidate = value as Partial<PersistedBrowserState>
  const seenIds = new Set<string>()
  const tabs = Array.isArray(candidate.tabs)
    ? candidate.tabs.flatMap((tab): PersistedBrowserTab[] => {
        if (!tab || typeof tab !== 'object') return []
        const stored = tab as Partial<PersistedBrowserTab>
        const isNewTab = stored.url === BROWSER_NEW_TAB_URL
        if (
          typeof stored.id !== 'string' ||
          !stored.id ||
          stored.id.length > MAX_BROWSER_TAB_ID_CHARACTERS ||
          seenIds.has(stored.id) ||
          typeof stored.url !== 'string' ||
          (!isNewTab && !isAllowedBrowserUrl(stored.url))
        ) return []
        seenIds.add(stored.id)
        return [{
          id: stored.id,
          title: typeof stored.title === 'string' && stored.title.trim()
            ? stored.title.trim().slice(0, MAX_BROWSER_TITLE_CHARACTERS)
            : isNewTab ? BROWSER_NEW_TAB_TITLE : new URL(stored.url).hostname,
          url: isNewTab ? BROWSER_NEW_TAB_URL : new URL(stored.url).toString()
        }]
      })
    : []
  const normalizedTabs = tabs.length > 0 ? tabs : structuredClone(DEFAULT_BROWSER_STATE.tabs)
  const activeTabId = typeof candidate.activeTabId === 'string' && normalizedTabs.some((tab) => tab.id === candidate.activeTabId)
    ? candidate.activeTabId
    : normalizedTabs[0].id
  const panelWidth = typeof candidate.panelWidth === 'number' && Number.isFinite(candidate.panelWidth)
    ? Math.min(MAX_BROWSER_PANEL_WIDTH, Math.max(MIN_BROWSER_PANEL_WIDTH, Math.round(candidate.panelWidth)))
    : DEFAULT_BROWSER_PANEL_WIDTH
  return { tabs: normalizedTabs, activeTabId, panelWidth }
}
