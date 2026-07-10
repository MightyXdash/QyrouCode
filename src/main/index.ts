import { app, shell, BrowserWindow, Menu, ipcMain, net } from 'electron'
import { dirname, join } from 'path'
import { existsSync, readdirSync, createWriteStream, mkdirSync, unlinkSync, renameSync, statSync } from 'fs'
import { homedir } from 'os'

import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { completeOnboarding, getOnboardingState } from './settings'
import { LlamaRuntime } from './llamaRuntime'

const WINDOW_READY_TIMEOUT_MS = 2500
const ICON_DIRECTORY = 'icons'
const WINDOWS_ICON_FILENAME = 'icon.ico'
const DEFAULT_ICON_FILENAME = 'icon.png'
const MAIN_WINDOW_QUERY_KEY = 'window'
const MAIN_WINDOW_QUERY_VALUE = 'app'
const MAIN_APP_WINDOW_WIDTH = 1440
const MAIN_APP_WINDOW_HEIGHT = 900
const GGUF_FILE_EXTENSION = '.gguf'
const MODEL_PROJECTOR_MARKERS = ['mmproj', 'projector']

let mainAppWindow: BrowserWindow | null = null
let llamaRuntime: LlamaRuntime | null = null

function appIconPath(): string {
  const filename = process.platform === 'win32' ? WINDOWS_ICON_FILENAME : DEFAULT_ICON_FILENAME
  return app.isPackaged
    ? join(process.resourcesPath, ICON_DIRECTORY, filename)
    : join(__dirname, '../../build', filename)
}

function huggingFaceHubPath(): string {
  if (process.env['HUGGINGFACE_HUB_CACHE']) return process.env['HUGGINGFACE_HUB_CACHE']
  if (process.env['HF_HOME']) return join(process.env['HF_HOME'], 'hub')
  return join(homedir(), '.cache', 'huggingface', 'hub')
}

function modelCachePath(modelId: string): string {
  const folder = 'models--' + modelId.replace(/[/.]/g, '--')
  return join(huggingFaceHubPath(), folder, 'snapshots')
}

function containsGguf(directory: string): boolean {
  if (!existsSync(directory)) return false
  try {
    return readdirSync(directory, { withFileTypes: true }).some((entry) => {
      const normalizedName = entry.name.toLowerCase()
      const isModelFile = normalizedName.endsWith(GGUF_FILE_EXTENSION) &&
        !MODEL_PROJECTOR_MARKERS.some((marker) => normalizedName.includes(marker))
      if (isModelFile) return true
      return entry.isDirectory() && containsGguf(join(directory, entry.name))
    })
  } catch {
    return false
  }
}

function findProjector(modelPath: string): string | undefined {
  const modelDir = dirname(modelPath)
  if (!existsSync(modelDir)) return undefined
  try {
    return readdirSync(modelDir).find((name) => {
      const normalizedName = name.toLowerCase()
      return normalizedName.endsWith(GGUF_FILE_EXTENSION) &&
        MODEL_PROJECTOR_MARKERS.some((marker) => normalizedName.includes(marker))
    })
  } catch {
    return undefined
  }
}

interface ModelTreeEntry {
  path: string
  size: number
}

function isWeightsFile(path: string): boolean {
  const normalizedName = path.toLowerCase()
  return normalizedName.endsWith(GGUF_FILE_EXTENSION) &&
    !MODEL_PROJECTOR_MARKERS.some((marker) => normalizedName.includes(marker))
}

function isProjectorFile(path: string): boolean {
  const normalizedName = path.toLowerCase()
  return normalizedName.endsWith(GGUF_FILE_EXTENSION) &&
    MODEL_PROJECTOR_MARKERS.some((marker) => normalizedName.includes(marker))
}

function projectorPreferenceRank(path: string): number {
  const normalizedName = path.toLowerCase()
  if (normalizedName.includes('f16')) return 1
  if (normalizedName.includes('bf16')) return 2
  if (normalizedName.includes('f32')) return 3
  return 4
}

function selectProjectorFile(entries: ModelTreeEntry[]): string | undefined {
  const projectors = entries.filter((entry) => isProjectorFile(entry.path))
  if (projectors.length === 0) return undefined
  return projectors.sort((a, b) => projectorPreferenceRank(a.path) - projectorPreferenceRank(b.path))[0].path
}

function fetchModelTree(repoId: string): Promise<ModelTreeEntry[]> {
  return new Promise((resolve, reject) => {
    const req = net.request(`https://huggingface.co/api/models/${repoId}/tree/main?recursive=true`)
    let data = ''
    req.on('response', (res) => {
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as { path: string; size?: number; type?: string }[]
          resolve(parsed
            .filter((entry) => entry.type !== 'directory' && entry.path.toLowerCase().endsWith(GGUF_FILE_EXTENSION))
            .map((entry) => ({ path: entry.path, size: entry.size ?? 0 })))
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function downloadGgufFile(
  repoId: string,
  encodedPath: string,
  partPath: string,
  resumeFrom: number,
  onProgress: (bytes: number) => void,
  cancelFns: Array<() => void>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = net.request(`https://huggingface.co/${repoId}/resolve/main/${encodedPath}`)
    if (resumeFrom > 0) req.setHeader('Range', `bytes=${resumeFrom}-`)
    const abort = () => req.abort()
    cancelFns.push(abort)
    let stream: ReturnType<typeof createWriteStream> | undefined

    req.on('response', (res) => {
      if (resumeFrom > 0 && res.statusCode !== 206) {
        req.abort()
        try { unlinkSync(partPath) } catch { /* ignore */ }
        reject(new Error('Server ignored resume request'))
        return
      }
      if (resumeFrom === 0 && res.statusCode !== 200) {
        req.abort()
        try { unlinkSync(partPath) } catch { /* ignore */ }
        reject(new Error(`Failed to download ${encodedPath} (status ${res.statusCode})`))
        return
      }
      stream = createWriteStream(partPath, { flags: resumeFrom > 0 ? 'a' : 'w' })
      res.on('data', (chunk: Buffer) => {
        stream.write(chunk)
        onProgress(chunk.length)
      })
      res.on('end', () => stream.end(() => resolve()))
      res.on('error', (err) => {
        stream.close()
        reject(err)
      })
    })
    req.on('abort', () => reject(new Error('Download cancelled')))
    req.on('error', (err) => {
      try { stream?.close() } catch { /* ignore */ }
      reject(err)
    })
    req.end()
  })
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
    ipcMain.removeHandler('download-model')
    ipcMain.removeHandler('cancel-download')
  })

  const activeDownloads = new Map<string, () => void>()

  ipcMain.handle('download-model', async (event, repoId: string, ggufFile?: string) => {
    const folder = 'models--' + repoId.replace(/[/.]/g, '--')
    const snapshotsDir = join(huggingFaceHubPath(), folder, 'snapshots', 'main')
    mkdirSync(snapshotsDir, { recursive: true })

    const tree = await fetchModelTree(repoId)
    const targetWeights = ggufFile ?? tree.find((entry) => isWeightsFile(entry.path))?.path
    if (!targetWeights) throw new Error('No GGUF file found in repo')
    const projectorPath = selectProjectorFile(tree)
    const targets = [targetWeights, ...(projectorPath ? [projectorPath] : [])]
      .map((path) => ({ path, size: tree.find((entry) => entry.path === path)?.size ?? 0 }))

    let cancelled = false
    const cancelFns: Array<() => void> = []
    activeDownloads.set(repoId, () => { cancelled = true; cancelFns.forEach((fn) => fn()) })

    const total = targets.reduce((sum, file) => sum + file.size, 0)
    let downloaded = 0
    event.sender.send('download-progress', { repoId, downloaded, total })

    const DOWNLOAD_ATTEMPTS = 3
    for (const file of targets) {
      if (cancelled) { activeDownloads.delete(repoId); throw new Error('Cancelled') }
      const filename = file.path.split('/').pop() as string
      const encodedPath = file.path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
      const filePath = join(snapshotsDir, filename)
      const partPath = filePath + '.part'
      if (existsSync(filePath)) { downloaded += file.size; continue }

      let attempt = 0
      let completed = false
      while (!completed && !cancelled && attempt < DOWNLOAD_ATTEMPTS) {
        attempt++
        const resumeFrom = existsSync(partPath) ? statSync(partPath).size : 0
        try {
          await downloadGgufFile(repoId, encodedPath, partPath, resumeFrom, (bytes) => {
            downloaded += bytes
            event.sender.send('download-progress', { repoId, downloaded, total })
          }, cancelFns)
          renameSync(partPath, filePath)
          completed = true
        } catch (error) {
          if (cancelled) throw new Error('Cancelled')
          if (attempt >= DOWNLOAD_ATTEMPTS) throw error
        }
      }
      if (!completed) { activeDownloads.delete(repoId); throw new Error('Download failed after multiple attempts') }
    }
    activeDownloads.delete(repoId)
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
  llamaRuntime = new LlamaRuntime()

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
  ipcMain.handle('get-llama-status', () => llamaRuntime?.getStatus())
  ipcMain.handle('start-llama-server', (_event, modelPath: string, contextTokens: number) => {
    const mmprojPath = findProjector(modelPath)
    return llamaRuntime?.start(modelPath, contextTokens, mmprojPath)
  })
  ipcMain.handle('stop-llama-server', () => llamaRuntime?.stop())
  ipcMain.handle('check-model-cache', (_event, modelId: string) => {
    return containsGguf(modelCachePath(modelId))
  })
  ipcMain.handle('get-downloaded-models', (_event, repos: string[]): string[] => {
    const hubPath = huggingFaceHubPath()
    if (!existsSync(hubPath)) return []
    const byFolder = new Map<string, string>()
    for (const repo of repos) byFolder.set('models--' + repo.replace(/[/.]/g, '--'), repo)
    const downloaded: string[] = []
    try {
      for (const entry of readdirSync(hubPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const repo = byFolder.get(entry.name)
        if (!repo) continue
        if (containsGguf(join(hubPath, entry.name, 'snapshots'))) downloaded.push(repo)
      }
    } catch {
      return []
    }
    return downloaded
  })

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

app.on('before-quit', () => {
  void llamaRuntime?.stop()
})
