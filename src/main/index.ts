import { app, shell, BrowserWindow, Menu, ipcMain, net } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, createWriteStream, mkdirSync, unlinkSync, renameSync } from 'fs'
import { homedir } from 'os'

import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { completeOnboarding, getOnboardingState } from './settings'

const WINDOW_READY_TIMEOUT_MS = 2500
const ICON_DIRECTORY = 'icons'
const WINDOWS_ICON_FILENAME = 'icon.ico'
const DEFAULT_ICON_FILENAME = 'icon.png'
const MAIN_WINDOW_QUERY_KEY = 'window'
const MAIN_WINDOW_QUERY_VALUE = 'app'
const MAIN_APP_WINDOW_WIDTH = 1440
const MAIN_APP_WINDOW_HEIGHT = 900

let mainAppWindow: BrowserWindow | null = null

function appIconPath(): string {
  const filename = process.platform === 'win32' ? WINDOWS_ICON_FILENAME : DEFAULT_ICON_FILENAME
  return app.isPackaged
    ? join(process.resourcesPath, ICON_DIRECTORY, filename)
    : join(__dirname, '../../build', filename)
}

function modelCachePath(modelId: string): string {
  const folder = 'models--' + modelId.replace(/[/.]/g, '--')
  return join(homedir(), '.cache', 'huggingface', 'hub', folder, 'snapshots', 'main')
}

function loadRenderer(targetWindow: BrowserWindow, query?: Record<string, string>): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    for (const [key, value] of Object.entries(query ?? {})) {
      rendererUrl.searchParams.set(key, value)
    }
    void targetWindow.loadURL(rendererUrl.toString())
    return
  }

  void targetWindow.loadFile(join(__dirname, '../renderer/index.html'), { query })
}

function createMainAppWindow(): BrowserWindow {
  if (mainAppWindow && !mainAppWindow.isDestroyed()) {
    mainAppWindow.show()
    mainAppWindow.focus()
    return mainAppWindow
  }

  const targetWindow = new BrowserWindow({
    width: MAIN_APP_WINDOW_WIDTH,
    height: MAIN_APP_WINDOW_HEIGHT,
    resizable: true,
    maximizable: true,
    minimizable: true,
    title: 'SupraCode',
    show: false,
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainAppWindow = targetWindow
  targetWindow.once('ready-to-show', () => {
    targetWindow.maximize()
    targetWindow.show()
  })
  targetWindow.once('closed', () => {
    if (mainAppWindow === targetWindow) mainAppWindow = null
  })

  loadRenderer(targetWindow, { [MAIN_WINDOW_QUERY_KEY]: MAIN_WINDOW_QUERY_VALUE })
  return targetWindow
}

function createWindow(): void {
  Menu.setApplicationMenu(null)

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: true,
    title: '',
    show: false,
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  ipcMain.handle('get-onboarding-state', () => getOnboardingState())
  ipcMain.handle('complete-onboarding', (_event, preferences: unknown) => completeOnboarding(preferences))

  let windowShown = false
  let windowReadyTimeout: ReturnType<typeof setTimeout> | undefined

  const showWindow = () => {
    if (windowShown || mainWindow.isDestroyed()) return
    windowShown = true
    if (windowReadyTimeout) clearTimeout(windowReadyTimeout)
    mainWindow.show()
  }

  const handleRendererReady = (event: Electron.IpcMainEvent) => {
    if (event.sender !== mainWindow.webContents) return
    showWindow()
    mainWindow.webContents.send('window-shown')
  }

  ipcMain.on('renderer-ready', handleRendererReady)
  windowReadyTimeout = setTimeout(showWindow, WINDOW_READY_TIMEOUT_MS)

  mainWindow.once('closed', () => {
    if (windowReadyTimeout) clearTimeout(windowReadyTimeout)
    ipcMain.removeListener('renderer-ready', handleRendererReady)
    ipcMain.removeHandler('get-onboarding-state')
    ipcMain.removeHandler('complete-onboarding')
    ipcMain.removeHandler('check-model-cache')
    ipcMain.removeHandler('download-model')
    ipcMain.removeHandler('cancel-download')
  })

  ipcMain.handle('check-model-cache', (_event, modelId: string) => {
    const dir = modelCachePath(modelId)
    if (!existsSync(dir)) return false
    return readdirSync(dir).some(e => e.endsWith('.gguf'))
  })

  const activeDownloads = new Map<string, () => void>()

  ipcMain.handle('download-model', async (event, repoId: string) => {
    const folder = 'models--' + repoId.replace(/[/.]/g, '--')
    const snapshotsDir = join(homedir(), '.cache', 'huggingface', 'hub', folder, 'snapshots', 'main')
    mkdirSync(snapshotsDir, { recursive: true })

    const siblings = await new Promise<{ rfilename: string }[]>((resolve, reject) => {
      const req = net.request(`https://huggingface.co/api/models/${repoId}`)
      let data = ''
      req.on('response', (res) => {
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data).siblings || []) } catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.end()
    })

    const ggufFile = siblings.find(s => s.rfilename.endsWith('.gguf'))
    if (!ggufFile) throw new Error('No GGUF file found in repo')

    const filename = ggufFile.rfilename
    const filePath = join(snapshotsDir, filename)
    const partPath = filePath + '.part'

    if (existsSync(filePath)) return

    await new Promise<void>((resolve, reject) => {
      const req = net.request(`https://huggingface.co/${repoId}/resolve/main/${encodeURIComponent(filename)}`)
      const cleanup = () => {
        req.abort()
        try { unlinkSync(partPath) } catch { /* ignore */ }
        reject(new Error('Cancelled'))
      }
      activeDownloads.set(repoId, cleanup)

      req.on('response', (res) => {
        const total = parseInt(res.headers['content-length'] as string || '0', 10)
        let downloaded = 0
        const stream = createWriteStream(partPath)

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          stream.write(chunk)
          event.sender.send('download-progress', { repoId, downloaded, total })
        })
        res.on('end', () => {
          stream.end(() => {
            try { renameSync(partPath, filePath) } catch (e) { reject(e); return }
            activeDownloads.delete(repoId)
            resolve()
          })
        })
        res.on('error', (err) => {
          stream.close()
          try { unlinkSync(partPath) } catch { /* ignore */ }
          activeDownloads.delete(repoId)
          reject(err)
        })
      })
      req.on('error', (err) => {
        activeDownloads.delete(repoId)
        try { unlinkSync(partPath) } catch { /* ignore */ }
        reject(err)
      })
      req.end()
    })
  })

  ipcMain.handle('cancel-download', (_event, repoId: string) => {
    const cancel = activeDownloads.get(repoId)
    if (cancel) cancel()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(mainWindow)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.suprarcode')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('minimize-window', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on('close-window', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle('open-main-window', (event) => new Promise<void>((resolve) => {
    const onboardingWindow = BrowserWindow.fromWebContents(event.sender)
    const targetWindow = createMainAppWindow()
    const closeOnboardingWindow = () => {
      if (onboardingWindow && onboardingWindow !== targetWindow && !onboardingWindow.isDestroyed()) {
        onboardingWindow.close()
      }
      resolve()
    }

    if (targetWindow.isVisible()) closeOnboardingWindow()
    else targetWindow.once('ready-to-show', closeOnboardingWindow)
  }))

  if (getOnboardingState().completed) createMainAppWindow()
  else createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (getOnboardingState().completed) createMainAppWindow()
      else createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
