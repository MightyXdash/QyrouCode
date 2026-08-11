import { app, shell, BrowserWindow, Menu, dialog, ipcMain, nativeImage, nativeTheme, net } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { basename, dirname, extname, join } from 'path'
import { existsSync, readdirSync, createWriteStream, createReadStream, mkdirSync, unlinkSync, renameSync, statSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { homedir } from 'os'

import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { addProject, completeOnboarding, deleteChatThread, getAgentSession, getAgentSessions, getChatThreads, getExpandedProjectPaths, getNativeLanguage, getOnboardingState, getProjects, getPromptRefinementPreferences, getResponseStylePreference, getSelectedContextWindowTokens, getSpeedCounterEnabled, getTheme, getWorkspaceViewState, removeProject, renameProject, saveAgentSession, saveChatThread, saveWorkspaceViewState, setContextWindowTokens, setExpandedProjectPaths, setNativeLanguage, setPromptRefinementPreferences, setResponseStylePreference, setSpeedCounterEnabled, setTheme } from './settings'
import { DEFAULT_NATIVE_LANGUAGE, validateNativeLanguage } from '../shared/settings'
import { LlamaRuntime } from './llamaRuntime'
import { LLAMA_TITLE_SERVER_PORT, type LlamaModelLoadProgress } from '../shared/llama'
import { WINDOW_COMMANDS, type WindowCommand } from '../shared/windowCommands'
import { resolveModelArtifact } from './modelResolver'
import { getModelArtifact, INITIAL_MODEL_ARTIFACTS } from '../shared/modelManifest'
import type { LocalCompletionEvent, LocalCompletionStart } from './localCompletionClient'
import { AgentRuntime, type AgentRunRequest, type AgentStateListener, type AgentToolEvent } from './agentRuntime'
import { CHAT_ATTACHMENT_MIME_TYPES, MAX_CHAT_ATTACHMENT_BYTES, MAX_CHAT_ATTACHMENTS, MAX_FILE_PREVIEW_CHARACTERS, type ChatAttachment, type ChatAttachmentMimeType, type ChatThread, type StoredChatFile } from '../shared/chat'
import { deleteConnection, getConnections, getConnectionSecurityStatus, migrateLegacyCatalogModelIds, resolveConnection, resolveProviderSiteIcon, saveConnection, testConnection, updateConnectionModels, type ResolvedConnection } from './connectionStore'
import type { ConnectionInput } from '../shared/connections'
import { buildConversationExport, exportFilename } from './conversationExport'
import { validateConversationExportRequest } from '../shared/conversationExport'
import { prepareNativeImage } from './imagePrep'
import { extractFileText } from './fileViewer'
import type { AgentExecutionTarget, AgentModelProvenance, AgentModelSource } from '../shared/agent'
import { getReasoningEffortPrompt, humanizeRemoteModelId, inferRemoteModel, resolveRemoteReasoningEffort, shouldRetainRemoteReasoning, type CatalogConnectionKind, type ConnectionModelsResult, type RemoteModel } from '../shared/remoteModels'
import { clearRemoteModelCatalog, getCachedRemoteModels, refreshRemoteModels } from './remoteModelCatalog'
import { RemoteCompletionClient } from './remoteCompletionClient'
import { getExternalProjectorSource, isModelProjectorFile, isModelWeightsFile, selectModelProjectorFile, type ModelTreeEntry } from '../shared/modelProjector'
import { MAX_PROMPT_REFINEMENT_BACKUPS, MAX_PROMPT_REFINEMENT_MODEL_ID_CHARACTERS, type PromptRefinementTarget } from '../shared/promptRefinement'
import { refinePrompt, type PromptRefinementCandidate } from './promptRefiner'
import { createAgentTerminalController, disposeTerminals, registerTerminalIpc } from './terminalManager'
import { DESKTOP_PLATFORMS, usesNativeWindowControls } from '../shared/platform'
import { attachBrowserPanel, captureBrowserScreenshot, openUrlInBrowserPanel, registerBrowserPanelIpc } from './browserPanel'

const WINDOW_READY_TIMEOUT_MS = 2500
const ICON_DIRECTORY = 'icons'
const WINDOWS_ICON_FILENAME = 'icon.ico'
const DEFAULT_ICON_FILENAME = 'icon.png'
const MAIN_WINDOW_QUERY_KEY = 'window'
const MAIN_WINDOW_QUERY_VALUE = 'app'
const MAIN_APP_WINDOW_WIDTH = 1440
const MAIN_APP_WINDOW_HEIGHT = 900
const MACOS_TRAFFIC_LIGHT_POSITION = { x: 16, y: 15 } as const
const MACOS_WINDOW_BACKGROUND = '#00000000'
const GGUF_FILE_EXTENSION = '.gguf'

function applyTheme(value: unknown): ReturnType<typeof setTheme> {
  const theme = setTheme(value)
  nativeTheme.themeSource = theme
  return theme
}
const TITLE_MODEL_REPOSITORY = 'SupraLabs/Supra-Title-350M-exp-GGUF'
const TITLE_MODEL_FILENAME = 'LiquidAI_LFM2.5-350M-Base_1781204855.Q5_K_M.gguf'
const TITLE_MODEL_CONTEXT_TOKENS = 4096
const TITLE_MODEL_MAX_INPUT_CHARACTERS = 12000
const MODEL_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const INVALID_PROJECT_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/
const WINDOWS_RESERVED_PROJECT_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const CHAT_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'ico'] as const
const CHAT_IMAGE_EXTENSION_SET = new Set(CHAT_IMAGE_EXTENSIONS.map((extension) => `.${extension}`))
const MODEL_DOWNLOAD_ATTEMPTS = 3

let mainAppWindow: BrowserWindow | null = null
let llamaRuntime: LlamaRuntime | null = null
let titleRuntime: LlamaRuntime | null = null
const activeCompletionRequests = new Map<string, { senderId: number; controller: AbortController; source: AgentModelSource }>()
const activeModelDownloads = new Map<string, () => void>()

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
      const isModelFile = isModelWeightsFile(normalizedName)
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
      if (attachment.kind !== undefined && !['image', 'file'].includes(attachment.kind)) return false
      if (attachment.preview !== undefined && typeof attachment.preview !== 'string') return false
      if (attachment.kind === 'file') return typeof attachment.dataUrl === 'string' && attachment.dataUrl.startsWith('data:')
      return CHAT_ATTACHMENT_MIME_TYPES.includes(attachment.mimeType as ChatAttachmentMimeType) && typeof attachment.dataUrl === 'string' && attachment.dataUrl.startsWith(`data:${attachment.mimeType};base64,`)
    }))) return false
    if (message.status !== undefined && !['pending', 'completed', 'cancelled', 'error'].includes(message.status)) return false
    return true
  })) throw new Error('Invalid chat messages')
  return thread as ChatThread
}

function readChatAttachment(filePath: string): ChatAttachment {
  if (!CHAT_IMAGE_EXTENSION_SET.has(extname(filePath).toLowerCase())) throw new Error('Choose an image file')
  if (statSync(filePath).size > MAX_CHAT_ATTACHMENT_BYTES) throw new Error('Each image must be 10 MB or smaller')
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) throw new Error(`Could not decode ${basename(filePath)} as an image`)
  const prepared = prepareNativeImage(image, { format: 'png' })
  if (prepared.bytes > MAX_CHAT_ATTACHMENT_BYTES) throw new Error('The converted image must be 10 MB or smaller')
  return {
    id: randomUUID(),
    name: basename(filePath),
    mimeType: prepared.mimeType,
    dataUrl: prepared.dataUrl,
    size: prepared.bytes,
    kind: 'image'
  }
}

const FILE_ATTACHMENT_EXTENSIONS = ['txt', 'md', 'json', 'jsonc', 'yaml', 'yml', 'csv', 'tsv', 'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'log', 'zip', 'tar', 'tgz', 'gz', 'py', 'js', 'ts', 'tsx', 'jsx', 'html', 'css', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'sh', 'env', 'toml', 'xml', 'sql']

function readChatFileAttachment(filePath: string): ChatAttachment {
  if (!statSync(filePath).isFile()) throw new Error('Choose a file')
  if (statSync(filePath).size > MAX_CHAT_ATTACHMENT_BYTES) throw new Error('Each file must be 10 MB or smaller')
  const buffer = readFileSync(filePath)
  const extension = extname(filePath).toLowerCase()
  const mimeType = extension ? `application/${extension.slice(1)}` : 'application/octet-stream'
  return {
    id: randomUUID(),
    name: basename(filePath),
    mimeType,
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    size: buffer.length,
    kind: 'file'
  }
}

function chatAttachmentDirectory(threadId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(threadId)) throw new Error('Invalid thread ID')
  return join(app.getPath('userData'), 'chat-attachments', threadId)
}

function sanitizeAttachmentName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  return base || 'attachment'
}

function validateFileAttachments(attachments: unknown): ChatAttachment[] {
  if (!Array.isArray(attachments) || attachments.length === 0 || attachments.length > MAX_CHAT_ATTACHMENTS) throw new Error('Invalid file attachments')
  return attachments.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid file attachment')
    const attachment = value as Partial<ChatAttachment>
    if (typeof attachment.id !== 'string' || !attachment.id || typeof attachment.name !== 'string' || typeof attachment.size !== 'number' || attachment.size > MAX_CHAT_ATTACHMENT_BYTES) throw new Error('Invalid file attachment')
    if (attachment.kind !== undefined && attachment.kind !== 'file') throw new Error('Only file attachments can be stored')
    if (typeof attachment.dataUrl !== 'string' || !attachment.dataUrl.startsWith('data:')) throw new Error('Invalid file attachment data')
    return { ...attachment, kind: 'file' } as ChatAttachment
  })
}

async function storeChatFiles(threadId: string, attachments: ChatAttachment[]): Promise<StoredChatFile[]> {
  const directory = chatAttachmentDirectory(threadId)
  mkdirSync(directory, { recursive: true })
  return Promise.all(attachments.map(async (attachment) => {
    const match = /^data:[^,]*;base64,([A-Za-z0-9+/=]+)$/.exec(attachment.dataUrl)
    if (!match) throw new Error('Invalid file attachment data')
    const buffer = Buffer.from(match[1], 'base64')
    if (buffer.length !== attachment.size) throw new Error('File attachment size mismatch')
    const storedPath = join(directory, `${attachment.id}-${sanitizeAttachmentName(attachment.name)}`)
    writeFileSync(storedPath, buffer)
    const rawPreview = await extractFileText(storedPath)
    const preview = rawPreview === undefined ? '' : truncatePreview(rawPreview)
    return { attachment: { ...attachment, preview }, preview }
  }))
}

function truncatePreview(value: string): string {
  if (value.length <= MAX_FILE_PREVIEW_CHARACTERS) return value
  return `${value.slice(0, MAX_FILE_PREVIEW_CHARACTERS)}\n\n... preview truncated (${value.length} characters total)`
}

function findProjector(modelPath: string): string | undefined {
  const candidates: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) visit(entryPath)
      else if (isModelProjectorFile(entry.name)) candidates.push(entryPath)
    }
  }

  try {
    visit(dirname(modelPath))
    return candidates.sort((a, b) => projectorPreferenceRank(a) - projectorPreferenceRank(b))[0]
  } catch {
    return undefined
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('close', () => resolve(hash.digest('hex')))
    stream.on('data', (chunk) => hash.update(chunk))
  })
}

function messageContentEquals(left: AgentRunRequest['messages'][number]['content'], right: AgentRunRequest['messages'][number]['content'] | undefined): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right
  if (left === null || right === null || left === undefined || right === undefined) return left === right
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((part, index) => {
    const candidate = right[index]
    if (!candidate || part.type !== candidate.type) return false
    return part.type === 'text'
      ? candidate.type === 'text' && part.text === candidate.text
      : candidate.type === 'image_url' && part.image_url.url === candidate.image_url.url
  })
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

interface ProjectorDownload {
  repository: string
  path: string
  size: number
  sha256?: string
}

async function resolveProjectorDownload(repoId: string, tree: readonly ModelTreeEntry[]): Promise<ProjectorDownload | undefined> {
  const bundledPath = selectModelProjectorFile(tree)
  if (bundledPath) {
    return {
      repository: repoId,
      path: bundledPath,
      size: tree.find((entry) => entry.path === bundledPath)?.size ?? 0
    }
  }

  const externalSource = getExternalProjectorSource(repoId)
  if (!externalSource) return undefined
  const externalTree = await fetchModelTree(externalSource.repository)
  const entry = externalTree.find((candidate) => candidate.path === externalSource.path)
  if (!entry || !isModelProjectorFile(entry.path)) throw new Error('The configured vision projector is unavailable')
  return { ...externalSource, size: entry.size }
}

async function ensureModelProjector(repoId: string, modelPath: string): Promise<string | undefined> {
  const cachedProjector = findProjector(modelPath)
  if (cachedProjector) return cachedProjector

  const tree = await fetchModelTree(repoId)
  const projector = await resolveProjectorDownload(repoId, tree)
  if (!projector) return undefined

  const filename = projector.path.split('/').at(-1)
  if (!filename) throw new Error('The model projector has an invalid filename')
  const targetPath = join(dirname(modelPath), filename)
  if (existsSync(targetPath)) return targetPath
  const partPath = `${targetPath}.part`
  const encodedPath = projector.path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  const cancelFns: Array<() => void> = []

  for (let attempt = 1; attempt <= MODEL_DOWNLOAD_ATTEMPTS; attempt += 1) {
    const resumeFrom = existsSync(partPath) ? statSync(partPath).size : 0
    try {
      await downloadGgufFile(projector.repository, encodedPath, partPath, resumeFrom, () => {}, cancelFns)
      if (!existsSync(partPath)) throw new Error('The vision projector download produced no file')
      const partStats = statSync(partPath)
      if (projector.size > 0 && partStats.size !== projector.size) {
        throw new Error('The vision projector download size does not match the remote file')
      }
      if (projector.sha256) {
        const digest = await sha256File(partPath)
        if (digest !== projector.sha256) {
          unlinkSync(partPath)
          throw new Error('The vision projector SHA-256 does not match the expected value')
        }
      }
      renameSync(partPath, targetPath)
      return targetPath
    } catch (error) {
      if (attempt === MODEL_DOWNLOAD_ATTEMPTS) throw error
    }
  }
  throw new Error('The vision projector could not be downloaded')
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

  const isMacOS = process.platform === DESKTOP_PLATFORMS.macOS
  const targetWindow = new BrowserWindow({
    width: MAIN_APP_WINDOW_WIDTH,
    height: MAIN_APP_WINDOW_HEIGHT,
    resizable: true,
    maximizable: true,
    minimizable: true,
    frame: usesNativeWindowControls(process.platform),
    titleBarStyle: isMacOS ? 'hidden' : 'default',
    trafficLightPosition: isMacOS
      ? MACOS_TRAFFIC_LIGHT_POSITION
      : undefined,
    backgroundColor: isMacOS ? MACOS_WINDOW_BACKGROUND : undefined,
    vibrancy: isMacOS ? 'sidebar' : undefined,
    visualEffectState: isMacOS ? 'active' : undefined,
    title: 'QyrouCode',
    show: false,
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainAppWindow = targetWindow
  attachBrowserPanel(targetWindow)
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

function createMacApplicationMenu(): void {
  if (process.platform !== 'darwin') return
  const sendCommand = (command: string) => {
    if (mainAppWindow && !mainAppWindow.isDestroyed()) mainAppWindow.webContents.send('native-menu-command', command)
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [{ label: 'New Thread', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-thread') }, { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => sendCommand('reload') }, { label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => sendCommand('toggle-dev-tools') }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Theme', submenu: [{ label: 'System', click: () => { applyTheme('system'); sendCommand('theme:system') } }, { label: 'Dark', click: () => { applyTheme('dark'); sendCommand('theme:dark') } }, { label: 'Light', click: () => { applyTheme('light'); sendCommand('theme:light') } }] },
    { label: 'Help', submenu: [{ label: 'QyrouCode', enabled: false }, { label: 'Local coding model runner', enabled: false }] }
  ]))
}

function registerModelDownloadIpc(): void {
  ipcMain.handle('download-model', async (event, repoId: string, ggufFile?: string) => {
    const folder = 'models--' + repoId.replace(/[/.]/g, '--')
    const snapshotsDir = join(huggingFaceHubPath(), folder, 'snapshots', 'main')
    mkdirSync(snapshotsDir, { recursive: true })

    const tree = await fetchModelTree(repoId)
    const targetWeights = ggufFile ?? tree.find((entry) => isModelWeightsFile(entry.path))?.path
    if (!targetWeights) throw new Error('No GGUF file found in repo')
    const projector = await resolveProjectorDownload(repoId, tree)
    const targets = [
      { repository: repoId, path: targetWeights, size: tree.find((entry) => entry.path === targetWeights)?.size ?? 0 },
      ...(projector ? [projector] : [])
    ]

    let cancelled = false
    const cancelFns: Array<() => void> = []
    activeModelDownloads.set(repoId, () => { cancelled = true; cancelFns.forEach((fn) => fn()) })

    const total = targets.reduce((sum, file) => sum + file.size, 0)
    let downloaded = 0
    event.sender.send('download-progress', { repoId, downloaded, total })

    for (const file of targets) {
      if (cancelled) { activeModelDownloads.delete(repoId); throw new Error('Cancelled') }
      const filename = file.path.split('/').pop() as string
      const encodedPath = file.path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
      const filePath = join(snapshotsDir, filename)
      const partPath = filePath + '.part'
      if (existsSync(filePath)) { downloaded += file.size; continue }

      let attempt = 0
      let completed = false
      while (!completed && !cancelled && attempt < MODEL_DOWNLOAD_ATTEMPTS) {
        attempt++
        const resumeFrom = existsSync(partPath) ? statSync(partPath).size : 0
        try {
          await downloadGgufFile(file.repository, encodedPath, partPath, resumeFrom, (bytes) => {
            downloaded += bytes
            event.sender.send('download-progress', { repoId, downloaded, total })
          }, cancelFns)
          renameSync(partPath, filePath)
          completed = true
        } catch (error) {
          if (cancelled) throw new Error('Cancelled')
          if (attempt >= MODEL_DOWNLOAD_ATTEMPTS) throw error
        }
      }
      if (!completed) { activeModelDownloads.delete(repoId); throw new Error('Download failed after multiple attempts') }
    }
    activeModelDownloads.delete(repoId)
  })

  ipcMain.handle('cancel-download', (_event, repoId: string) => {
    activeModelDownloads.get(repoId)?.()
  })
}

function createWindow(): void {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  const nativeWindowControls = usesNativeWindowControls(process.platform)

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: nativeWindowControls,
    resizable: nativeWindowControls,
    maximizable: nativeWindowControls,
    minimizable: true,
    titleBarStyle: process.platform === DESKTOP_PLATFORMS.macOS ? 'hidden' : 'default',
    trafficLightPosition: process.platform === DESKTOP_PLATFORMS.macOS
      ? MACOS_TRAFFIC_LIGHT_POSITION
      : undefined,
    title: 'QyrouCode',
    show: false,
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  ipcMain.handle('get-onboarding-state', () => getOnboardingState())
  ipcMain.handle('complete-onboarding', (_event, preferences: unknown) => {
    const completed = completeOnboarding(preferences)
    nativeTheme.themeSource = completed.theme
    return completed
  })

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
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(mainWindow)
}

app.whenReady().then(() => {
  nativeTheme.themeSource = getTheme()
  migrateLegacyCatalogModelIds()
  void Promise.allSettled(
    getConnections()
      .filter((connection) => connection.kind !== 'openai-compatible')
      .map((connection) => refreshRemoteModels(resolveConnection(connection.id)))
  )
  registerTerminalIpc()
  registerBrowserPanelIpc()
  registerModelDownloadIpc()
  electronApp.setAppUserModelId('com.qyroucode')
  llamaRuntime = new LlamaRuntime()
  titleRuntime = new LlamaRuntime(LLAMA_TITLE_SERVER_PORT)
  createMacApplicationMenu()

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
  ipcMain.handle('set-response-style-preference', (_event, preference: unknown) => setResponseStylePreference(preference))
  ipcMain.handle('get-context-window-tokens', () => getSelectedContextWindowTokens())
  ipcMain.handle('set-context-window-tokens', (_event, tokens: unknown) => setContextWindowTokens(tokens))
  ipcMain.handle('get-native-language', () => getNativeLanguage())
  ipcMain.handle('set-native-language', (_event, nativeLanguage: unknown) => setNativeLanguage(nativeLanguage))
  ipcMain.handle('get-speed-counter-enabled', () => getSpeedCounterEnabled())
  ipcMain.handle('set-speed-counter-enabled', (_event, enabled: unknown) => setSpeedCounterEnabled(enabled))
  ipcMain.handle('get-prompt-refinement-preferences', () => getPromptRefinementPreferences())
  ipcMain.handle('set-prompt-refinement-preferences', (_event, preference: unknown) => setPromptRefinementPreferences(preference))
  ipcMain.handle('set-theme', (_event, theme: unknown) => applyTheme(theme))
  ipcMain.handle('get-connections', () => getConnections())
  ipcMain.handle('get-connection-security-status', () => getConnectionSecurityStatus())
  ipcMain.handle('resolve-provider-site-icon', (_event, baseUrl: unknown) => {
    if (typeof baseUrl !== 'string') throw new Error('Invalid provider base URL')
    return resolveProviderSiteIcon(baseUrl)
  })
  ipcMain.handle('save-connection', (_event, value: unknown, connectionId?: unknown) => {
    if (connectionId !== undefined && typeof connectionId !== 'string') throw new Error('Invalid connection ID')
    return saveConnection(value as ConnectionInput, connectionId)
  })
  ipcMain.handle('test-connection', (_event, value: unknown, connectionId?: unknown) => {
    if (connectionId !== undefined && typeof connectionId !== 'string') throw new Error('Invalid connection ID')
    return testConnection(value as ConnectionInput, connectionId)
  })
  ipcMain.handle('delete-connection', (_event, connectionId: unknown) => {
    if (typeof connectionId !== 'string' || !connectionId) throw new Error('Invalid connection ID')
    clearRemoteModelCatalog(connectionId)
    return deleteConnection(connectionId)
  })
  ipcMain.handle('update-connection-models', (_event, connectionId: unknown, selectedModelIds: unknown) => {
    if (typeof connectionId !== 'string' || !connectionId || !Array.isArray(selectedModelIds)) throw new Error('Invalid model selection')
    return updateConnectionModels(connectionId, selectedModelIds)
  })
  const connectionModels = async (connectionId: unknown, refresh: boolean): Promise<ConnectionModelsResult> => {
    if (typeof connectionId !== 'string' || !connectionId) throw new Error('Invalid connection ID')
    try {
      const connection = resolveConnection(connectionId)
      if (connection.kind === 'openai-compatible') return { ok: true, models: [] }
      const cached = refresh ? undefined : getCachedRemoteModels(connectionId)
      return { ok: true, models: cached ?? await refreshRemoteModels(connection) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not load models' }
    }
  }
  ipcMain.handle('get-connection-models', (_event, connectionId: unknown) => connectionModels(connectionId, false))
  ipcMain.handle('refresh-connection-models', (_event, connectionId: unknown) => connectionModels(connectionId, true))
  ipcMain.handle('refine-prompt', async (_event, prompt: unknown, value: unknown) => {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROMPT_REFINEMENT_BACKUPS + 1) {
      throw new Error('Choose at least one valid prompt refinement model')
    }
    const targets = value as PromptRefinementTarget[]
    if (new Set(targets.map((target) => target?.id)).size !== targets.length) {
      throw new Error('Prompt refinement models must be unique')
    }
    const candidates: PromptRefinementCandidate[] = targets.map((target) => {
      if (
        !target ||
        typeof target !== 'object' ||
        typeof target.id !== 'string' ||
        !target.id ||
        target.id.length > MAX_PROMPT_REFINEMENT_MODEL_ID_CHARACTERS ||
        typeof target.modelId !== 'string' ||
        !target.modelId ||
        target.modelId.length > MAX_PROMPT_REFINEMENT_MODEL_ID_CHARACTERS
      ) {
        throw new Error('Invalid prompt refinement model')
      }
      if (target.source === 'local') {
        if (
          typeof target.repository !== 'string' ||
          !MODEL_REPOSITORY_PATTERN.test(target.repository) ||
          typeof target.filename !== 'string' ||
          target.filename !== basename(target.filename) ||
          !target.filename.toLowerCase().endsWith(GGUF_FILE_EXTENSION)
        ) throw new Error('Invalid local prompt refinement model')
        return {
          modelId: target.id,
          modelName: target.repository,
          complete: async (request) => {
            if (!llamaRuntime) throw new Error('Local model runtime is unavailable')
            if ([...activeCompletionRequests.values()].some((activeRequest) => activeRequest.source === 'local')) {
              throw new Error('a local model is currently handling another request')
            }
            const modelPath = resolveDownloadedModel(target.repository, target.filename)
            const status = await llamaRuntime.start(modelPath, getSelectedContextWindowTokens(), findProjector(modelPath))
            if (status.state !== 'ready') throw new Error(status.message ?? 'the local model could not start')
            return llamaRuntime.complete(request)
          }
        }
      }
      if (target.source !== 'remote' || typeof target.connectionId !== 'string' || !target.connectionId) throw new Error('Invalid provider prompt refinement model')
      return {
        modelId: target.id,
        modelName: target.modelId,
        complete: async (request) => {
          const connection = resolveConnection(target.connectionId)
          if (!connection.selectedModelIds.includes(target.modelId)) throw new Error('Select this model in Settings before using it')
          if (connection.kind === 'openai-compatible' && !connection.modelIds.includes(target.modelId)) {
            throw new Error('This prompt refinement model is not configured for the selected provider')
          }
          await ensureCatalogAvailable(connection, target.modelId)
          return new RemoteCompletionClient({
            kind: connection.kind,
            baseUrl: connection.baseUrl,
            apiKey: connection.apiKey,
            modelId: target.modelId,
            retainReasoning: false,
            reasoning: { enabled: false }
          }).complete(request)
        }
      }
    })
    return refinePrompt(prompt, candidates)
  })
  ipcMain.handle('preview-conversation-export', (_event, value: unknown) => {
    const request = validateConversationExportRequest(value)
    return buildConversationExport(request, getChatThreads(), getAgentSessions()).preview
  })
  ipcMain.handle('export-conversations', async (event, value: unknown) => {
    const request = validateConversationExportRequest(value)
    const built = buildConversationExport(request, getChatThreads(), getAgentSessions())
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(owner ?? undefined, {
      defaultPath: exportFilename(request),
      filters: [{ name: request.format === 'jsonl' ? 'JSON Lines' : 'JSON', extensions: [request.format] }]
    })
    if (result.canceled || !result.filePath) return { saved: false, ...built.preview }
    await writeFile(result.filePath, built.content, 'utf8')
    return { saved: true, filePath: result.filePath, ...built.preview }
  })
  ipcMain.handle('get-projects', () => getProjects())
  ipcMain.handle('get-expanded-project-paths', () => getExpandedProjectPaths())
  ipcMain.handle('set-expanded-project-paths', (_event, paths: unknown) => setExpandedProjectPaths(paths))
  ipcMain.handle('get-chat-threads', () => getChatThreads())
  ipcMain.handle('save-chat-thread', (_event, value: unknown) => saveChatThread(validateChatThread(value)))
  ipcMain.handle('choose-chat-images', async (event): Promise<ChatAttachment[]> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(parent ?? undefined, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: [...CHAT_IMAGE_EXTENSIONS] }]
    })
    if (result.canceled) return []
    return result.filePaths.slice(0, MAX_CHAT_ATTACHMENTS).map(readChatAttachment)
  })
  ipcMain.handle('choose-chat-files', async (event): Promise<ChatAttachment[]> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(parent ?? undefined, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: FILE_ATTACHMENT_EXTENSIONS },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    return result.filePaths.slice(0, MAX_CHAT_ATTACHMENTS).map(readChatFileAttachment)
  })
  ipcMain.handle('store-chat-files', (_event, threadId: unknown, attachments: unknown): Promise<StoredChatFile[]> => {
    if (typeof threadId !== 'string' || !threadId) throw new Error('A valid thread ID is required')
    return storeChatFiles(threadId, validateFileAttachments(attachments))
  })
  ipcMain.handle('delete-chat-thread', (_event, threadId: unknown) => {
    if (typeof threadId !== 'string' || !threadId) throw new Error('A valid thread ID is required')
    rmSync(chatAttachmentDirectory(threadId), { recursive: true, force: true })
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
  ipcMain.handle('rename-project', (_event, projectPath: unknown, value: unknown) => {
    if (typeof projectPath !== 'string' || !projectPath) throw new Error('Invalid project')
    return renameProject(projectPath, validateProjectName(value))
  })
  ipcMain.handle('remove-project', (_event, projectPath: unknown) => {
    if (typeof projectPath !== 'string' || !projectPath) throw new Error('Invalid project')
    return removeProject(projectPath)
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
    return llamaRuntime.start(resolved.path, getSelectedContextWindowTokens(), resolved.mmprojPath ?? findProjector(resolved.path))
  })
  ipcMain.handle('start-downloaded-model', async (event, repoId: unknown, filename: unknown, loadId: unknown, requireVision: unknown = false) => {
    if (!llamaRuntime) throw new Error('llama-server is not available')
    if ([...activeCompletionRequests.values()].some((request) => request.source === 'local')) {
      throw new Error('A local model is already running in another thread')
    }
    if (typeof loadId !== 'string' || !loadId || loadId.length > 128) throw new Error('Invalid local model load request')
    if (typeof requireVision !== 'boolean') throw new Error('Invalid vision mode')
    const modelPath = resolveDownloadedModel(repoId, filename)
    const projectorPath = await ensureModelProjector(repoId as string, modelPath)
    if (requireVision && !projectorPath) throw new Error('This model is missing the vision projector required for image input')
    return llamaRuntime.start(modelPath, getSelectedContextWindowTokens(), projectorPath, (progress) => {
      if (event.sender.isDestroyed()) return
      event.sender.send('local-model-load-progress', {
        ...progress,
        loadId,
        modelName: repoId as string
      } satisfies LlamaModelLoadProgress)
    })
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
  ipcMain.handle('stop-llama-server', () => llamaRuntime?.stop())

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
      case 'progress-update':
        send({ requestId, type: 'progress-update', summary: event.summary })
        break
      case 'todos-updated':
        send({ requestId, type: 'todos-updated', todos: event.todos })
        break
      case 'response-reset':
        send({ requestId, type: 'response-reset' })
        break
    }
  }
  type AgentRunner = (
    request: AgentRunRequest,
    onDelta: (delta: string) => void,
    onState?: AgentStateListener,
    onToolEvent?: (event: AgentToolEvent) => void
  ) => Promise<void>

  const startAgentRun = (
    event: Electron.IpcMainInvokeEvent,
    request: AgentRunRequest,
    model: AgentModelProvenance,
    runner: AgentRunner
  ): LocalCompletionStart => {
    if (!request || typeof request.threadId !== 'string' || !request.threadId) throw new Error('A chat thread is required for the agent')
    const nativeLanguage = validateNativeLanguage(request.nativeLanguage ?? DEFAULT_NATIVE_LANGUAGE)
    const project = getProjects().find((item) => item.path === request.projectPath)
    if (!project || !existsSync(project.path) || !statSync(project.path).isDirectory()) throw new Error('Select a valid project before running an agent')
    if (model.source === 'local' && [...activeCompletionRequests.values()].some((request) => request.source === 'local')) {
      throw new Error('A local model is already running in another thread')
    }
    if (model.source === 'local' && request.messages.some((message) =>
      message.role === 'user' && Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')
    )) {
      if (!llamaRuntime) throw new Error('llama-server is not available')
      if (llamaRuntime.getStatus().state !== 'ready') throw new Error('Start the local model before attaching images')
      if (!llamaRuntime.getStatus().visionReady) throw new Error('The selected local model cannot process images: its vision projector is missing or failed to load')
    }
    const requestId = randomUUID()
    const controller = new AbortController()
    activeCompletionRequests.set(requestId, { senderId: event.sender.id, controller, source: model.source })
    const send = (completionEvent: LocalCompletionEvent): void => event.sender.send('local-completion-event', {
      ...completionEvent,
      threadId: request.threadId
    })
    const persisted = getAgentSession(request.threadId, project.path)
    const systemMessages = request.messages.filter((message) => message.role === 'system')
    const latestUserMessage = [...request.messages].reverse().find((message) => message.role === 'user')
    const persistedLastUser = persisted ? [...persisted.messages].reverse().find((message) => message.role === 'user') : undefined
    const persistedFinished = persisted?.messages.at(-1)?.role === 'assistant'
    const resumedMessages = persisted
      ? [...systemMessages, ...persisted.messages, ...(latestUserMessage && (persistedFinished || !messageContentEquals(latestUserMessage.content, persistedLastUser?.content)) ? [latestUserMessage] : [])]
      : request.messages
    const agentRequest = {
      ...request,
      nativeLanguage,
      messages: resumedMessages,
      projectPath: project.path,
      signal: controller.signal,
      model,
      visionAvailable: model.source === 'local' ? llamaRuntime?.getStatus().visionReady === true : true,
      captureScreenshot: () => captureBrowserScreenshot(event.sender),
      terminalController: createAgentTerminalController(
        event.sender,
        project.path,
        request.threadId,
        controller.signal,
        (url) => openUrlInBrowserPanel(event.sender, url)
      )
    }
    void runner(
      agentRequest,
      (delta) => send({ requestId, type: 'delta', delta }),
      (messages) => saveAgentSession({
        threadId: request.threadId,
        projectPath: project.path,
        messages: messages.filter((message) => message.role !== 'system'),
        updatedAt: Date.now()
      }),
      (toolEvent) => sendToolEvent(send, requestId, toolEvent)
    )
      .then(() => send({ requestId, type: controller.signal.aborted ? 'cancelled' : 'complete' }))
      .catch((error) => send(controller.signal.aborted
        ? { requestId, type: 'cancelled' }
        : { requestId, type: 'error', message: error instanceof Error ? error.message : 'Agent completion failed' }))
      .finally(() => activeCompletionRequests.delete(requestId))
    return { requestId }
  }

  const localTargetModel = (target: Extract<AgentExecutionTarget, { source: 'local' }>): AgentModelProvenance => ({
    source: 'local',
    provider: 'Local',
    modelId: target.modelId,
    displayName: target.displayName,
    reasoningRetention: 'retain'
  })

  const runtimeCatalogModel = async (connection: ResolvedConnection, modelId: string): Promise<RemoteModel | undefined> => {
    if (connection.kind === 'openai-compatible') return undefined
    const models = getCachedRemoteModels(connection.id) ?? await refreshRemoteModels(connection).catch(() => undefined)
    if (!models) return undefined
    const catalogModel = models.find((model) => model.id === modelId)
    if (!catalogModel) throw new Error('This model is not available from the selected connection')
    return catalogModel
  }

  const ensureCatalogAvailable = async (connection: ResolvedConnection, modelId: string): Promise<void> => {
    await runtimeCatalogModel(connection, modelId)
  }

  const remoteRunner = async (target: Extract<AgentExecutionTarget, { source: 'remote' }>): Promise<{ model: AgentModelProvenance; runner: AgentRunner }> => {
    const connection = resolveConnection(target.connectionId)
    if (!connection.selectedModelIds.includes(target.modelId)) throw new Error('Select this model in Settings before using it')
    if (connection.kind === 'openai-compatible' && !connection.modelIds.includes(target.modelId)) {
      throw new Error('This model is not configured for the selected connection')
    }
    const catalogModel = await runtimeCatalogModel(connection, target.modelId)
    const reasoning = connection.kind === 'openai-compatible'
      ? {
          enabled: target.reasoningEffort !== 'Instant',
          nativeEffort: null,
          systemPrompt: getReasoningEffortPrompt(target.reasoningEffort)
        }
      : resolveRemoteReasoningEffort(
          catalogModel ?? inferRemoteModel(connection.kind as CatalogConnectionKind, { id: target.modelId }),
          target.reasoningEffort
        )
    const retainReasoning = shouldRetainRemoteReasoning(connection.kind) && reasoning.enabled
    const client = new RemoteCompletionClient({
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      modelId: target.modelId,
      retainReasoning,
      reasoning: {
        enabled: reasoning.enabled,
        nativeEffort: reasoning.nativeEffort ?? undefined,
        fallbackPrompt: reasoning.systemPrompt ?? undefined
      }
    })
    const runtime = new AgentRuntime(client)
    return {
      model: {
        source: 'remote',
        connectionId: connection.id,
        provider: connection.providerName,
        modelId: target.modelId,
        displayName: catalogModel?.displayName ?? (connection.kind === 'openai-compatible' ? target.modelId : humanizeRemoteModelId(target.modelId)),
        reasoningRetention: retainReasoning ? 'retain' : 'discard'
      },
      runner: runtime.run.bind(runtime)
    }
  }

  ipcMain.handle('start-agent-completion', async (event, target: AgentExecutionTarget, request: AgentRunRequest): Promise<LocalCompletionStart> => {
    if (!target || !['local', 'remote'].includes(target.source)) throw new Error('Choose a valid model')
    if (target.source === 'local') {
      if (!llamaRuntime) throw new Error('llama-server is not available')
      if (typeof target.modelId !== 'string' || !target.modelId || typeof target.displayName !== 'string' || !target.displayName) throw new Error('Choose a valid local model')
      return startAgentRun(event, request, localTargetModel(target), llamaRuntime.runAgent.bind(llamaRuntime))
    }
    if (typeof target.connectionId !== 'string' || !target.connectionId || typeof target.modelId !== 'string' || !target.modelId) throw new Error('Choose a valid remote model')
    const remote = await remoteRunner(target)
    return startAgentRun(event, request, remote.model, remote.runner)
  })

  ipcMain.handle('start-local-completion', (event, request: AgentRunRequest): LocalCompletionStart => {
    if (!llamaRuntime) throw new Error('llama-server is not available')
    const requested = request.model?.source === 'local' ? request.model : undefined
    const target: Extract<AgentExecutionTarget, { source: 'local' }> = {
      source: 'local',
      modelId: requested?.modelId ?? 'local-model',
      displayName: requested?.displayName ?? 'Local model'
    }
    return startAgentRun(event, request, localTargetModel(target), llamaRuntime.runAgent.bind(llamaRuntime))
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
  disposeTerminals()
  void llamaRuntime?.stop()
})
