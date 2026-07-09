import { app, shell, BrowserWindow, Menu, ipcMain, net } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, createWriteStream, mkdirSync, unlinkSync, renameSync } from 'fs'
import { homedir } from 'os'

import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { completeOnboarding, getOnboardingState } from './settings'

const WINDOW_READY_TIMEOUT_MS = 2500

function modelCachePath(modelId: string): string {
  const folder = 'models--' + modelId.replace(/[/.]/g, '--')
  return join(homedir(), '.cache', 'huggingface', 'hub', folder, 'snapshots', 'main')
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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  ipcMain.on('minimize-window', () => mainWindow.minimize())
  ipcMain.on('close-window', () => mainWindow.close())
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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.suprarcode')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
