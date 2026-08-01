import { randomUUID } from 'crypto'
import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  nativeTheme,
  session,
  type Input,
  type Rectangle,
  type WebContents
} from 'electron'
import {
  BROWSER_CAPTURE_FLASH_COLORS,
  BROWSER_CAPTURE_FLASH_DURATION_MS,
  BROWSER_NEW_TAB_TITLE,
  BROWSER_NEW_TAB_URL,
  BROWSER_SESSION_PARTITION,
  normalizeBrowserInput,
  normalizePersistedBrowserState,
  isAllowedBrowserUrl,
  type BrowserBounds,
  type BrowserNavigationAction,
  type BrowserPanelState,
  type BrowserTabState,
  type PersistedBrowserState,
  type PersistedBrowserTab
} from '../shared/browser'
import { getBrowserState, saveBrowserState } from './settings'
import { BrowserFaviconCache } from './browserFaviconCache'
import { prepareNativeImage } from './imagePrep'

const BROWSER_STATE_EVENT = 'browser-state-changed'
const BROWSER_REVEAL_EVENT = 'browser-reveal'
const BROWSER_FOCUS_ADDRESS_EVENT = 'browser-focus-address'
const AUTO_DARK_MODE_COMMAND = 'Emulation.setAutoDarkModeOverride'
const browserFaviconCache = new BrowserFaviconCache()

interface ManagedBrowserTab {
  state: PersistedBrowserTab
  faviconUrl?: string
  view?: WebContentsView
}

const controllers = new Map<number, BrowserPanelController>()
let ipcRegistered = false
let browserSessionConfigured = false

function validatedBounds(owner: BrowserWindow, value: unknown): Rectangle {
  if (!value || typeof value !== 'object') return { x: 0, y: 0, width: 0, height: 0 }
  const candidate = value as Partial<BrowserBounds>
  if (![candidate.x, candidate.y, candidate.width, candidate.height].every((part) => typeof part === 'number' && Number.isFinite(part))) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const [ownerWidth, ownerHeight] = owner.getContentSize()
  const x = Math.min(ownerWidth, Math.max(0, Math.round(candidate.x as number)))
  const y = Math.min(ownerHeight, Math.max(0, Math.round(candidate.y as number)))
  return {
    x,
    y,
    width: Math.min(ownerWidth - x, Math.max(0, Math.round(candidate.width as number))),
    height: Math.min(ownerHeight - y, Math.max(0, Math.round(candidate.height as number)))
  }
}

function configureBrowserSession(): void {
  if (browserSessionConfigured) return
  const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION)
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserSessionConfigured = true
}

function shortcutModifier(input: Input): boolean {
  return process.platform === 'darwin' ? input.meta : input.control
}

function sameSiteOrigin(left: string, right: string): boolean {
  return isAllowedBrowserUrl(left) &&
    isAllowedBrowserUrl(right) &&
    new URL(left).origin === new URL(right).origin
}

async function applyBrowserTheme(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach()
    await contents.debugger.sendCommand(AUTO_DARK_MODE_COMMAND, {
      enabled: nativeTheme.shouldUseDarkColors
    })
  } catch {
    return
  }
}

class BrowserPanelController {
  private readonly tabs = new Map<string, ManagedBrowserTab>()
  private activeTabId: string
  private visible = false
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  private panelWidth: number
  private disposed = false

  constructor(private readonly owner: BrowserWindow, storedState: PersistedBrowserState) {
    const state = normalizePersistedBrowserState(storedState)
    for (const tab of state.tabs) {
      this.tabs.set(tab.id, { state: tab, faviconUrl: browserFaviconCache.get(tab.url) })
    }
    this.activeTabId = state.activeTabId
    this.panelWidth = state.panelWidth
  }

  getState(): BrowserPanelState {
    return {
      tabs: [...this.tabs.values()].map((tab): BrowserTabState => {
        const contents = tab.view?.webContents
        return {
          ...tab.state,
          faviconUrl: tab.faviconUrl,
          loading: contents?.isLoading() ?? false,
          canGoBack: contents?.navigationHistory.canGoBack() ?? false,
          canGoForward: contents?.navigationHistory.canGoForward() ?? false
        }
      }),
      activeTabId: this.activeTabId,
      visible: this.visible,
      panelWidth: this.panelWidth
    }
  }

  setVisible(visible: boolean): BrowserPanelState {
    const wasVisible = this.visible
    this.visible = visible
    if (visible && !wasVisible && this.activeTab()?.state.url !== BROWSER_NEW_TAB_URL) {
      this.ensureView(this.activeTabId)
      this.owner.webContents.send(BROWSER_REVEAL_EVENT)
    }
    if (visible && this.activeTab()?.state.url !== BROWSER_NEW_TAB_URL) this.ensureView(this.activeTabId)
    this.layoutViews()
    this.emitState()
    return this.getState()
  }

  setBounds(bounds: unknown): void {
    this.bounds = validatedBounds(this.owner, bounds)
    this.layoutViews()
  }

  setPanelWidth(width: unknown): BrowserPanelState {
    this.panelWidth = normalizePersistedBrowserState({
      tabs: this.persistedTabs(),
      activeTabId: this.activeTabId,
      panelWidth: width
    }).panelWidth
    this.persist()
    this.emitState()
    return this.getState()
  }

  createTab(value = BROWSER_NEW_TAB_URL, activate = true): BrowserPanelState {
    const url = normalizeBrowserInput(value)
    const tab: ManagedBrowserTab = {
      state: {
        id: randomUUID(),
        title: url === BROWSER_NEW_TAB_URL ? BROWSER_NEW_TAB_TITLE : new URL(url).hostname,
        url
      },
      faviconUrl: browserFaviconCache.get(url)
    }
    this.tabs.set(tab.state.id, tab)
    if (activate) {
      this.activeTabId = tab.state.id
      if (this.visible && url !== BROWSER_NEW_TAB_URL) this.ensureView(tab.state.id)
    }
    this.persist()
    this.layoutViews()
    this.emitState()
    return this.getState()
  }

  activateTab(tabId: unknown): BrowserPanelState {
    if (typeof tabId !== 'string' || !this.tabs.has(tabId)) return this.getState()
    this.activeTabId = tabId
    if (this.visible && this.activeTab()?.state.url !== BROWSER_NEW_TAB_URL) this.ensureView(tabId)
    this.persist()
    this.layoutViews()
    this.emitState()
    return this.getState()
  }

  reorderTabs(tabIds: unknown): BrowserPanelState {
    if (
      !Array.isArray(tabIds) ||
      tabIds.length !== this.tabs.size ||
      new Set(tabIds).size !== tabIds.length ||
      tabIds.some((tabId) => typeof tabId !== 'string' || !this.tabs.has(tabId))
    ) return this.getState()

    const reorderedTabs = tabIds.map((tabId) => this.tabs.get(tabId as string) as ManagedBrowserTab)
    this.tabs.clear()
    for (const tab of reorderedTabs) this.tabs.set(tab.state.id, tab)
    this.persist()
    this.emitState()
    return this.getState()
  }

  closeTab(tabId: unknown): BrowserPanelState {
    if (typeof tabId !== 'string') return this.getState()
    const entries = [...this.tabs.values()]
    const closingIndex = entries.findIndex((tab) => tab.state.id === tabId)
    if (closingIndex < 0) return this.getState()
    const closing = entries[closingIndex]
    this.destroyView(closing)
    this.tabs.delete(tabId)

    if (this.tabs.size === 0) {
      const replacement = {
        state: { id: randomUUID(), title: BROWSER_NEW_TAB_TITLE, url: BROWSER_NEW_TAB_URL }
      }
      this.tabs.set(replacement.state.id, replacement)
      this.activeTabId = replacement.state.id
    } else if (this.activeTabId === tabId) {
      const remaining = [...this.tabs.values()]
      this.activeTabId = remaining[Math.min(closingIndex, remaining.length - 1)].state.id
    }

    if (this.visible && this.activeTab()?.state.url !== BROWSER_NEW_TAB_URL) this.ensureView(this.activeTabId)
    this.persist()
    this.layoutViews()
    this.emitState()
    return this.getState()
  }

  navigate(tabId: unknown, value: unknown): BrowserPanelState {
    if (typeof tabId !== 'string' || typeof value !== 'string' || !this.tabs.has(tabId)) return this.getState()
    const url = normalizeBrowserInput(value)
    const tab = this.tabs.get(tabId) as ManagedBrowserTab
    this.updateTabUrl(tab, url)
    if (url === BROWSER_NEW_TAB_URL) {
      tab.state.title = BROWSER_NEW_TAB_TITLE
      this.destroyView(tab)
    } else {
      const view = this.ensureView(tabId)
      void view.webContents.loadURL(url).catch(() => undefined)
    }
    this.persist()
    this.layoutViews()
    this.emitState()
    return this.getState()
  }

  runNavigation(tabId: unknown, action: unknown): BrowserPanelState {
    if (
      typeof tabId !== 'string' ||
      !['back', 'forward', 'reload', 'stop'].includes(action as string) ||
      !this.tabs.has(tabId)
    ) return this.getState()
    const tab = this.tabs.get(tabId) as ManagedBrowserTab
    if (tab.state.url === BROWSER_NEW_TAB_URL) return this.getState()
    const contents = this.ensureView(tabId).webContents
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    if (action === 'reload') contents.reload()
    if (action === 'stop') contents.stop()
    this.emitState()
    return this.getState()
  }

  revealUrl(url: string): void {
    this.createTab(url, true)
    this.visible = true
    this.ensureView(this.activeTabId)
    this.layoutViews()
    this.owner.webContents.send(BROWSER_REVEAL_EVENT)
    this.emitState()
  }

  async captureActiveTab(): Promise<string> {
    const tab = this.tabs.get(this.activeTabId)
    if (!tab || tab.state.url === BROWSER_NEW_TAB_URL) throw new Error('Open a website in the browser panel before taking a screenshot')
    if (!this.visible) throw new Error('The browser panel is hidden; open a website first')
    const contents = this.ensureView(this.activeTabId).webContents
    if (contents.isLoading()) {
      await new Promise<void>((resolvePromise) => {
        contents.once('did-finish-load', () => resolvePromise())
        contents.once('did-fail-load', () => resolvePromise())
      })
    }
    const image = await contents.capturePage()
    if (image.isEmpty()) throw new Error('The browser screenshot was empty; wait for the page to finish loading')
    this.flashCapture(contents)
    return prepareNativeImage(image, { format: 'png' }).dataUrl
  }

  syncTheme(): void {
    for (const tab of this.tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        void applyBrowserTheme(tab.view.webContents)
      }
    }
  }

  private flashCapture(contents: WebContents): void {
    const color = nativeTheme.shouldUseDarkColors ? BROWSER_CAPTURE_FLASH_COLORS.dark : BROWSER_CAPTURE_FLASH_COLORS.light
    // Injected into the page because the native WebContentsView always composites above
    // renderer DOM overlays; WAAPI + CSSOM are used because page CSP can block <style>.
    const script = `(() => {
      const overlay = document.createElement('div')
      overlay.style.cssText = ${JSON.stringify([
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'pointer-events:none',
        'opacity:0',
        `background:${color}`
      ].join(';'))}
      document.documentElement.appendChild(overlay)
      const animation = overlay.animate([
        { opacity: 0 },
        { opacity: 1, offset: 0.14 },
        { opacity: 0 }
      ], { duration: ${BROWSER_CAPTURE_FLASH_DURATION_MS}, easing: 'ease-out' })
      animation.onfinish = () => overlay.remove()
    })()`
    void contents.executeJavaScript(script).catch(() => undefined)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const tab of this.tabs.values()) this.destroyView(tab)
    this.tabs.clear()
  }

  private persistedTabs(): PersistedBrowserTab[] {
    return [...this.tabs.values()].map((tab) => ({ ...tab.state }))
  }

  private activeTab(): ManagedBrowserTab | undefined {
    return this.tabs.get(this.activeTabId)
  }

  private persist(): void {
    saveBrowserState({
      tabs: this.persistedTabs(),
      activeTabId: this.activeTabId,
      panelWidth: this.panelWidth
    })
  }

  private emitState(): void {
    if (!this.owner.isDestroyed()) this.owner.webContents.send(BROWSER_STATE_EVENT, this.getState())
  }

  private ensureView(tabId: string): WebContentsView {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Browser tab is unavailable')
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view

    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_SESSION_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    })
    tab.view = view
    this.owner.contentView.addChildView(view)
    const contents = view.webContents
    void applyBrowserTheme(contents)
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url)) queueMicrotask(() => this.createTab(url, true))
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event) => {
      if (!isAllowedBrowserUrl(event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event) => {
      if (!isAllowedBrowserUrl(event.url)) event.preventDefault()
    })
    contents.on('did-start-loading', () => this.emitState())
    contents.on('did-stop-loading', () => {
      this.syncTabFromContents(tab)
      this.emitState()
    })
    contents.on('did-fail-load', () => this.emitState())
    contents.on('did-navigate', (_event, url) => {
      if (isAllowedBrowserUrl(url)) {
        this.updateTabUrl(tab, url)
        this.persist()
      }
      this.emitState()
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame && isAllowedBrowserUrl(url)) {
        this.updateTabUrl(tab, url)
        this.persist()
        this.emitState()
      }
    })
    contents.on('page-title-updated', (_event, title) => {
      if (title.trim()) {
        tab.state.title = title.trim()
        this.persist()
        this.emitState()
      }
    })
    contents.on('page-favicon-updated', (_event, favicons) => {
      const pageUrl = contents.getURL()
      const cachedFavicon = browserFaviconCache.get(pageUrl)
      const liveFavicon = favicons.find(isAllowedBrowserUrl)
      const immediateFavicon = cachedFavicon ?? liveFavicon
      if (immediateFavicon && tab.faviconUrl !== immediateFavicon) {
        tab.faviconUrl = immediateFavicon
        this.emitState()
      }
      void browserFaviconCache.revalidate(pageUrl, favicons).then((faviconUrl) => {
        if (
          faviconUrl &&
          tab.view?.webContents === contents &&
          sameSiteOrigin(contents.getURL(), pageUrl) &&
          tab.faviconUrl !== faviconUrl
        ) {
          tab.faviconUrl = faviconUrl
          this.emitState()
        }
      })
    })
    contents.on('before-input-event', (event, input) => this.handleShortcut(event, input, tab.state.id))
    contents.on('destroyed', () => {
      if (tab.view?.webContents === contents) tab.view = undefined
    })
    void contents.loadURL(tab.state.url).catch(() => undefined)
    return view
  }

  private handleShortcut(event: Electron.Event, input: Input, tabId: string): void {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const command = shortcutModifier(input)
    if (command && key === 'l') {
      event.preventDefault()
      this.owner.webContents.send(BROWSER_FOCUS_ADDRESS_EVENT)
    } else if (command && key === 't') {
      event.preventDefault()
      this.createTab()
    } else if (command && key === 'w') {
      event.preventDefault()
      this.closeTab(tabId)
    } else if (command && key === 'r') {
      event.preventDefault()
      this.runNavigation(tabId, 'reload')
    } else if (input.alt && key === 'left') {
      event.preventDefault()
      this.runNavigation(tabId, 'back')
    } else if (input.alt && key === 'right') {
      event.preventDefault()
      this.runNavigation(tabId, 'forward')
    } else if (key === 'escape') {
      event.preventDefault()
      this.runNavigation(tabId, 'stop')
    }
  }

  private syncTabFromContents(tab: ManagedBrowserTab): void {
    const contents = tab.view?.webContents
    if (!contents || contents.isDestroyed()) return
    const url = contents.getURL()
    const title = contents.getTitle()
    if (isAllowedBrowserUrl(url)) this.updateTabUrl(tab, url)
    if (title.trim()) tab.state.title = title.trim()
    this.persist()
  }

  private updateTabUrl(tab: ManagedBrowserTab, url: string): void {
    const originChanged = !sameSiteOrigin(tab.state.url, url)
    tab.state.url = url
    const cachedFavicon = browserFaviconCache.get(url)
    if (cachedFavicon || originChanged) tab.faviconUrl = cachedFavicon
  }

  private layoutViews(): void {
    for (const tab of this.tabs.values()) {
      const active = this.visible &&
        tab.state.id === this.activeTabId &&
        tab.state.url !== BROWSER_NEW_TAB_URL &&
        this.bounds.width > 0 &&
        this.bounds.height > 0
      tab.view?.setVisible(active)
      if (active) tab.view?.setBounds(this.bounds)
    }
  }

  private destroyView(tab: ManagedBrowserTab): void {
    const view = tab.view
    if (!view) return
    this.owner.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    tab.view = undefined
  }
}

function controllerFor(sender: WebContents): BrowserPanelController | undefined {
  const owner = BrowserWindow.fromWebContents(sender)
  return owner ? controllers.get(owner.id) : undefined
}

export function registerBrowserPanelIpc(): void {
  if (ipcRegistered) return
  configureBrowserSession()
  nativeTheme.on('updated', () => {
    for (const controller of controllers.values()) controller.syncTheme()
  })
  ipcMain.handle('browser-get-state', (event) => controllerFor(event.sender)?.getState())
  ipcMain.handle('browser-set-visible', (event, visible: unknown) =>
    controllerFor(event.sender)?.setVisible(visible === true))
  ipcMain.on('browser-set-bounds', (event, bounds: unknown) =>
    controllerFor(event.sender)?.setBounds(bounds))
  ipcMain.handle('browser-set-panel-width', (event, width: unknown) =>
    controllerFor(event.sender)?.setPanelWidth(width))
  ipcMain.handle('browser-create-tab', (event, url?: unknown) =>
    controllerFor(event.sender)?.createTab(typeof url === 'string' ? url : BROWSER_NEW_TAB_URL))
  ipcMain.handle('browser-activate-tab', (event, tabId: unknown) =>
    controllerFor(event.sender)?.activateTab(tabId))
  ipcMain.handle('browser-reorder-tabs', (event, tabIds: unknown) =>
    controllerFor(event.sender)?.reorderTabs(tabIds))
  ipcMain.handle('browser-close-tab', (event, tabId: unknown) =>
    controllerFor(event.sender)?.closeTab(tabId))
  ipcMain.handle('browser-navigate', (event, tabId: unknown, value: unknown) =>
    controllerFor(event.sender)?.navigate(tabId, value))
  ipcMain.handle('browser-navigation-action', (event, tabId: unknown, action: BrowserNavigationAction) =>
    controllerFor(event.sender)?.runNavigation(tabId, action))
  ipcRegistered = true
}

export function attachBrowserPanel(owner: BrowserWindow): void {
  controllers.get(owner.id)?.dispose()
  const controller = new BrowserPanelController(owner, getBrowserState())
  controllers.set(owner.id, controller)
  owner.once('closed', () => {
    controller.dispose()
    controllers.delete(owner.id)
  })
}

export async function openUrlInBrowserPanel(ownerContents: WebContents, url: string): Promise<void> {
  const controller = controllerFor(ownerContents)
  if (!controller) throw new Error('The embedded browser is unavailable')
  controller.revealUrl(url)
}

export async function captureBrowserScreenshot(ownerContents: WebContents): Promise<string> {
  const controller = controllerFor(ownerContents)
  if (!controller) throw new Error('The embedded browser is unavailable')
  return controller.captureActiveTab()
}
