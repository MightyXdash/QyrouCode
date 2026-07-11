import { app, shell, BrowserWindow, Menu, dialog, ipcMain, net } from 'electron'
import { randomUUID } from 'crypto'
import { basename, dirname, extname, join } from 'path'
import { existsSync, readdirSync, createWriteStream, mkdirSync, readFileSync, unlinkSync, renameSync, statSync } from 'fs'
import { homedir } from 'os'

import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { addProject, completeOnboarding, deleteChatThread, getAgentSession, getChatThreads, getExpandedProjectPaths, getOnboardingState, getProjects, getResponseStylePreference, getSelectedContextWindowTokens, getTheme, getWorkspaceViewState, saveAgentSession, saveChatThread, saveWorkspaceViewState, setExpandedProjectPaths, setTheme } from './settings'
import { LlamaRuntime } from './llamaRuntime'
import { WINDOW_COMMANDS, type WindowCommand } from '../shared/windowCommands'
import { resolveModelArtifact } from './modelResolver'
import { getModelArtifact, INITIAL_MODEL_ARTIFACTS } from '../shared/modelManifest'
import { LLAMA_TITLE_SERVER_PORT } from '../shared/llama'
import type { LocalCompletionEvent, LocalCompletionStart } from './localCompletionClient'
import type { AgentRunRequest, AgentToolEvent } from './agentRuntime'
import { CHAT_ATTACHMENT_MIME_TYPES, MAX_CHAT_ATTACHMENT_BYTES, MAX_CHAT_ATTACHMENTS, type ChatAttachment, type ChatAttachmentMimeType, type ChatThread } from '../shared/chat'

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
const TITLE_MODEL_REPOSITORY = 'SupraLabs/supra-title-50M-pre-gguf'
const TITLE_MODEL_FILENAME = 'SupraTitle-50M-Q4_K_M.gguf'
const TITLE_MODEL_CONTEXT_TOKENS = 4096
const TITLE_MODEL_MAX_INPUT_CHARACTERS = 12000
const SUMMARIZER_MODEL_REPOSITORY = 'SupraLabs/reasoning-summarizer-800m-pre-gguf'
const SUMMARIZER_MODEL_FILENAME = 'reasoning-summarizer-800m-pre-Q4_K_M.gguf'
const SUMMARIZER_MODEL_CONTEXT_TOKENS = 4096
const SUMMARIZER_SERVER_PORT = 39283
const MODEL_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const INVALID_PROJECT_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/
const WINDOWS_RESERVED_PROJECT_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const CHAT_ATTACHMENT_MIME_BY_EXTENSION: Readonly<Record<string, ChatAttachmentMimeType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

let mainAppWindow: BrowserWindow | null = null
let llamaRuntime: LlamaRuntime | null = null
let titleRuntime: LlamaRuntime | null = null
let summarizerRuntime: LlamaRuntime | null = null
const activeCompletionRequests = new Map<string, { senderId: number; controller: AbortController }>()

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

function validateProjectName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a project name')
  const name = value.trim()
  if (!name) throw new Error('Enter a project name')
  if (name === '.' || name === '..' || name.endsWith('.') || name.endsWith(' ') || INVALID_PROJECT_NAME_CHARACTERS.test(name) || WINDOWS_RESERVED_PROJECT_NAMES.test(name)) {
    throw new Error('Choose a name without reserved characters')
  }
  return name
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

function findCachedFile(directory: string, filename: string): string | undefined {
  if (!existsSync(directory)) return undefined
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isFile() && entry.name === filename) return entryPath
    if (entry.isDirectory()) {
      const match = findCachedFile(entryPath, filename)
      if (match) return match
    }
  }
  return undefined
}

function resolveDownloadedModel(repoId: unknown, filename: unknown): string {
  if (typeof repoId !== 'string' || !MODEL_REPOSITORY_PATTERN.test(repoId)) throw new Error('Invalid model repository')
  if (typeof filename !== 'string' || filename !== basename(filename) || !filename.toLowerCase().endsWith(GGUF_FILE_EXTENSION)) throw new Error('Invalid model filename')
  const modelPath = findCachedFile(modelCachePath(repoId), filename)
  if (!modelPath) throw new Error('The selected model is not downloaded')
  return modelPath
}

function validateChatThread(value: unknown): ChatThread {
  if (!value || typeof value !== 'object') throw new Error('Invalid chat thread')
  const thread = value as Partial<ChatThread>
  if (typeof thread.id !== 'string' || typeof thread.projectPath !== 'string' || typeof thread.title !== 'string' || typeof thread.updatedAt !== 'number' || !Array.isArray(thread.messages)) throw new Error('Invalid chat thread')
  if (!thread.messages.every((message) => {
    if (!message || typeof message.id !== 'string' || !['user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string') return false
    if (message.attachments !== undefined && (!Array.isArray(message.attachments) || message.attachments.length > MAX_CHAT_ATTACHMENTS || !message.attachments.every((attachment) => {
      if (!attachment || typeof attachment.id !== 'string' || typeof attachment.name !== 'string' || typeof attachment.size !== 'number' || attachment.size > MAX_CHAT_ATTACHMENT_BYTES) return false
      return CHAT_ATTACHMENT_MIME_TYPES.includes(attachment.mimeType) && typeof attachment.dataUrl === 'string' && attachment.dataUrl.startsWith(`data:${attachment.mimeType};base64,`)
    }))) return false
    if (message.status !== undefined && !['pending', 'completed', 'cancelled', 'error'].includes(message.status)) return false
    return true
  })) throw new Error('Invalid chat messages')
  return thread as ChatThread
}

function readChatAttachment(filePath: string): ChatAttachment {
  const mimeType = CHAT_ATTACHMENT_MIME_BY_EXTENSION[extname(filePath).toLowerCase()]
  if (!mimeType) throw new Error('Choose a PNG, JPEG, or WebP image')
  const size = statSync(filePath).size
  if (size > MAX_CHAT_ATTACHMENT_BYTES) throw new Error('Each image must be 10 MB or smaller')
  const data = readFileSync(filePath).toString('base64')
  return {
    id: randomUUID(),
    name: basename(filePath),
    mimeType,
    dataUrl: `data:${mimeType};base64,${data}`,
    size
  }
}

function findProjector(modelPath: string): string | undefined {
  const modelDir = dirname(modelPath)
  if (!existsSync(modelDir)) return undefined
  try {
    const match = readdirSync(modelDir).find((name) => {
      const normalizedName = name.toLowerCase()
      return normalizedName.endsWith(GGUF_FILE_EXTENSION) &&
        MODEL_PROJECTOR_MARKERS.some((marker) => normalizedName.includes(marker))
    })
    return match ? join(modelDir, match) : undefined
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
    frame: false,
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
  titleRuntime = new LlamaRuntime(LLAMA_TITLE_SERVER_PORT)
  summarizerRuntime = new LlamaRuntime(SUMMARIZER_SERVER_PORT)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('minimize-window', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on('toggle-maximize-window', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    if (!targetWindow) return
    if (targetWindow.isMaximized()) targetWindow.unmaximize()
    else targetWindow.maximize()
  })
  ipcMain.on('run-window-command', (event, command: WindowCommand) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    if (!targetWindow) return
    if (command === WINDOW_COMMANDS.reload) targetWindow.webContents.reload()
    if (command === WINDOW_COMMANDS.toggleDevTools) targetWindow.webContents.toggleDevTools()
    if (command === WINDOW_COMMANDS.toggleFullscreen) targetWindow.setFullScreen(!targetWindow.isFullScreen())
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
  ipcMain.handle('get-theme', () => getTheme())
  ipcMain.handle('get-response-style-preference', () => getResponseStylePreference())
  ipcMain.handle('set-theme', (_event, theme: unknown) => setTheme(theme))
  ipcMain.handle('get-projects', () => getProjects())
  ipcMain.handle('get-expanded-project-paths', () => getExpandedProjectPaths())
  ipcMain.handle('set-expanded-project-paths', (_event, paths: unknown) => setExpandedProjectPaths(paths))
  ipcMain.handle('get-chat-threads', () => getChatThreads())
  ipcMain.handle('save-chat-thread', (_event, value: unknown) => saveChatThread(validateChatThread(value)))
  ipcMain.handle('choose-chat-images', async (event): Promise<ChatAttachment[]> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(parent ?? undefined, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled) return []
    return result.filePaths.slice(0, MAX_CHAT_ATTACHMENTS).map(readChatAttachment)
  })
  ipcMain.handle('delete-chat-thread', (_event, threadId: unknown) => {
    if (typeof threadId !== 'string' || !threadId) throw new Error('A valid thread ID is required')
    return deleteChatThread(threadId)
  })
  ipcMain.handle('get-agent-session', (_event, threadId: unknown, projectPath: unknown) => {
    if (typeof threadId !== 'string' || typeof projectPath !== 'string') return null
    return getAgentSession(threadId, projectPath) ?? null
  })
  ipcMain.handle('get-workspace-view-state', () => getWorkspaceViewState())
  ipcMain.handle('save-workspace-view-state', (_event, value: unknown) => saveWorkspaceViewState(value))
  ipcMain.handle('create-project', (_event, value: unknown) => {
    const name = validateProjectName(value)
    const projectPath = join(app.getPath('documents'), name)
    if (existsSync(projectPath)) throw new Error('A folder with this name already exists in Documents')
    mkdirSync(projectPath)
    const project = { name, path: projectPath }
    addProject(project)
    return project
  })
  ipcMain.handle('choose-project-folder', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(owner ?? undefined, {
      title: 'Choose a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    const projectPath = result.filePaths[0]
    if (result.canceled || !projectPath) return null
    const project = { name: projectPath.split(/[\\/]/).at(-1) ?? projectPath, path: projectPath }
    addProject(project)
    return project
  })
  ipcMain.handle('start-local-model', async (_event, modelId: string) => {
    const artifact = getModelArtifact(INITIAL_MODEL_ARTIFACTS, modelId)
    if (!artifact) throw new Error('The selected model is not approved for local runtime use')
    if (!llamaRuntime) throw new Error('llama-server is not available')
    const resolved = await resolveModelArtifact(huggingFaceHubPath(), artifact)
    return llamaRuntime.start(resolved.path, getSelectedContextWindowTokens())
  })
  ipcMain.handle('start-downloaded-model', (_event, repoId: unknown, filename: unknown) => {
    if (!llamaRuntime) throw new Error('llama-server is not available')
    const modelPath = resolveDownloadedModel(repoId, filename)
    return llamaRuntime.start(modelPath, getSelectedContextWindowTokens(), findProjector(modelPath))
  })
  ipcMain.handle('generate-chat-title', async (_event, userMessage: unknown) => {
    if (typeof userMessage !== 'string' || !userMessage.trim()) throw new Error('A user message is required for title generation')
    if (!titleRuntime) throw new Error('Title model runtime is unavailable')
    const modelPath = resolveDownloadedModel(TITLE_MODEL_REPOSITORY, TITLE_MODEL_FILENAME)
    const status = await titleRuntime.start(modelPath, TITLE_MODEL_CONTEXT_TOKENS)
    if (status.state !== 'ready') throw new Error(status.message ?? 'Title model could not start')
    const titleInput = userMessage.trim().slice(0, TITLE_MODEL_MAX_INPUT_CHARACTERS)
    const title = await titleRuntime.completePrompt(`User: ${titleInput}\nTitle: `)
    return title.replace(/[\r\n]+/g, ' ').replace(/^Title:\s*/i, '').trim()
  })
  ipcMain.handle('start-llama-server', (_event, modelPath: string, contextTokens: number) => {
    const mmprojPath = findProjector(modelPath)
    return llamaRuntime?.start(modelPath, contextTokens, mmprojPath)
  })
  ipcMain.handle('stop-llama-server', () => llamaRuntime?.stop())

  const summarizeReasoning = async (rawReasoning: string): Promise<string> => {
    if (!summarizerRuntime) return 'Processing...'
    try {
      const modelPath = resolveDownloadedModel(SUMMARIZER_MODEL_REPOSITORY, SUMMARIZER_MODEL_FILENAME)
      const status = await summarizerRuntime.start(modelPath, SUMMARIZER_MODEL_CONTEXT_TOKENS)
      if (status.state !== 'ready') return 'Processing...'
      const input = rawReasoning.slice(0, 6000)
      const response = await summarizerRuntime.completePrompt(`Summarize this reasoning as JSON with a "summary" key:\n\n${input}\n\n{"summary":`)
      const parsed = JSON.parse(`{"summary":${response}`)
      return (typeof parsed.summary === 'string' && parsed.summary.trim()) || 'Processing...'
    } catch {
      try {
        const input = rawReasoning.slice(0, 6000)
        const fallback = await summarizerRuntime.completePrompt(`Summarize this reasoning in one short line:\n\n${input}\n\nSummary:`)
        return fallback.replace(/[\r\n]+/g, ' ').replace(/^Summary:\s*/i, '').trim() || 'Processing...'
      } catch {
        return 'Processing...'
      }
    }
  }

  const sendToolEvent = (send: (event: LocalCompletionEvent) => void, requestId: string, event: AgentToolEvent): void => {
    switch (event.type) {
      case 'tool-call':
        send({ requestId, type: 'tool-call', toolCallId: event.toolCallId, name: event.name, arguments: event.arguments, summary: event.summary })
        break
      case 'tool-result':
        send({ requestId, type: 'tool-result', toolCallId: event.toolCallId, result: event.result, filePath: event.filePath })
        break
      case 'tool-error':
        send({ requestId, type: 'tool-error', toolCallId: event.toolCallId, error: event.error })
        break
      case 'files-changed':
        send({ requestId, type: 'files-changed', files: event.files })
        break
      case 'reasoning-summary':
        void summarizeReasoning(event.summary).then((summary) => {
          send({ requestId, type: 'reasoning-summary', summary })
        }).catch(() => {
          send({ requestId, type: 'reasoning-summary', summary: 'Processing...' })
        })
        break
    }
  }
  ipcMain.handle('start-local-completion', (event, request: AgentRunRequest): LocalCompletionStart => {
    if (!request || typeof request.threadId !== 'string' || !request.threadId) throw new Error('A chat thread is required for the agent')
    if (!llamaRuntime) throw new Error('llama-server is not available')
    const project = getProjects().find((item) => item.path === request.projectPath)
    if (!project || !existsSync(project.path) || !statSync(project.path).isDirectory()) throw new Error('Select a valid project before running an agent')
    const requestId = randomUUID()
    const controller = new AbortController()
    activeCompletionRequests.set(requestId, { senderId: event.sender.id, controller })
    const send = (completionEvent: LocalCompletionEvent): void => event.sender.send('local-completion-event', completionEvent)
    const persisted = getAgentSession(request.threadId, project.path)
    const systemMessages = request.messages.filter((message) => message.role === 'system')
    const latestUserMessage = [...request.messages].reverse().find((message) => message.role === 'user')
    const persistedLastUser = persisted ? [...persisted.messages].reverse().find((message) => message.role === 'user') : undefined
    const persistedFinished = persisted?.messages.at(-1)?.role === 'assistant'
    const resumedMessages = persisted
      ? [...systemMessages, ...persisted.messages, ...(latestUserMessage && (persistedFinished || latestUserMessage.content !== persistedLastUser?.content) ? [latestUserMessage] : [])]
      : request.messages
    const agentRequest = { ...request, messages: resumedMessages, projectPath: project.path, signal: controller.signal }
    void llamaRuntime.runAgent(
      agentRequest,
      (delta) => send({ requestId, type: 'delta', delta }),
      (messages) => saveAgentSession({
        threadId: request.threadId,
        projectPath: project.path,
        messages: messages.filter((message) => message.role !== 'system'),
        updatedAt: Date.now()
      }),
      (event) => sendToolEvent(send, requestId, event)
    )
      .then(() => send({ requestId, type: controller.signal.aborted ? 'cancelled' : 'complete' }))
      .catch((error) => send(controller.signal.aborted
        ? { requestId, type: 'cancelled' }
        : { requestId, type: 'error', message: error instanceof Error ? error.message : 'Local completion failed' }))
      .finally(() => activeCompletionRequests.delete(requestId))
    return { requestId }
  })
  ipcMain.handle('cancel-local-completion', (event, requestId: string): boolean => {
    const request = activeCompletionRequests.get(requestId)
    if (!request || request.senderId !== event.sender.id) return false
    request.controller.abort()
    return true
  })
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
