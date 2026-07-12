import { contextBridge, ipcRenderer } from 'electron'
import type { OnboardingPreferences, OnboardingState, ResponseStylePreference, ThemePreference } from '../shared/settings'
import type { LlamaRuntimeStatus } from '../shared/llama'
import type { WindowCommand } from '../shared/windowCommands'
import type { LocalCompletionEvent, LocalCompletionStart } from '../main/localCompletionClient'
import type { AgentRunRequest } from '../main/agentRuntime'
import type { Project } from '../shared/projects'
import type { ChatAttachment, ChatThread } from '../shared/chat'
import type { AgentExecutionTarget, PersistedAgentSession, WorkspaceViewState } from '../shared/agent'
import type { ConnectionInput, ConnectionMutationResult, ConnectionSummary, ConnectionTestResult } from '../shared/connections'
import type { ConnectionSecurityStatus } from '../main/connectionStore'
import type { ConversationExportPreview, ConversationExportRequest, ConversationExportResult } from '../shared/conversationExport'

const api = {
  minimize: () => ipcRenderer.send('minimize-window'),
  toggleMaximize: () => ipcRenderer.send('toggle-maximize-window'),
  runWindowCommand: (command: WindowCommand) => ipcRenderer.send('run-window-command', command),
  close: () => ipcRenderer.send('close-window'),
  openMainWindow: (): Promise<void> => ipcRenderer.invoke('open-main-window'),
  rendererReady: () => ipcRenderer.send('renderer-ready'),
  onWindowShown: (callback: () => void) => {
    ipcRenderer.once('window-shown', callback)
    return () => { ipcRenderer.removeListener('window-shown', callback) }
  },
  getOnboardingState: (): Promise<OnboardingState> =>
    ipcRenderer.invoke('get-onboarding-state'),
  completeOnboarding: (preferences: OnboardingPreferences): Promise<void> =>
    ipcRenderer.invoke('complete-onboarding', preferences),
  getTheme: (): Promise<ThemePreference> => ipcRenderer.invoke('get-theme'),
  getResponseStylePreference: (): Promise<ResponseStylePreference> => ipcRenderer.invoke('get-response-style-preference'),
  setTheme: (theme: ThemePreference): Promise<ThemePreference> => ipcRenderer.invoke('set-theme', theme),
  getConnections: (): Promise<ConnectionSummary[]> => ipcRenderer.invoke('get-connections'),
  getConnectionSecurityStatus: (): Promise<ConnectionSecurityStatus> => ipcRenderer.invoke('get-connection-security-status'),
  saveConnection: (input: ConnectionInput, connectionId?: string): Promise<ConnectionMutationResult> => ipcRenderer.invoke('save-connection', input, connectionId),
  testConnection: (input: ConnectionInput, connectionId?: string): Promise<ConnectionTestResult> => ipcRenderer.invoke('test-connection', input, connectionId),
  deleteConnection: (connectionId: string): Promise<boolean> => ipcRenderer.invoke('delete-connection', connectionId),
  updateConnectionModels: (connectionId: string, selectedModelIds: string[]): Promise<ConnectionMutationResult> => ipcRenderer.invoke('update-connection-models', connectionId, selectedModelIds),
  previewConversationExport: (request: ConversationExportRequest): Promise<ConversationExportPreview> => ipcRenderer.invoke('preview-conversation-export', request),
  exportConversations: (request: ConversationExportRequest): Promise<ConversationExportResult> => ipcRenderer.invoke('export-conversations', request),
  getProjects: (): Promise<Project[]> => ipcRenderer.invoke('get-projects'),
  getExpandedProjectPaths: (): Promise<string[]> => ipcRenderer.invoke('get-expanded-project-paths'),
  setExpandedProjectPaths: (paths: string[]): Promise<string[]> => ipcRenderer.invoke('set-expanded-project-paths', paths),
  createProject: (name: string): Promise<Project> => ipcRenderer.invoke('create-project', name),
  chooseProjectFolder: (): Promise<Project | null> => ipcRenderer.invoke('choose-project-folder'),
  getChatThreads: (): Promise<ChatThread[]> => ipcRenderer.invoke('get-chat-threads'),
  saveChatThread: (thread: ChatThread): Promise<ChatThread[]> => ipcRenderer.invoke('save-chat-thread', thread),
  deleteChatThread: (threadId: string): Promise<ChatThread[]> => ipcRenderer.invoke('delete-chat-thread', threadId),
  chooseChatImages: (): Promise<ChatAttachment[]> => ipcRenderer.invoke('choose-chat-images'),
  getAgentSession: (threadId: string, projectPath: string): Promise<PersistedAgentSession | null> => ipcRenderer.invoke('get-agent-session', threadId, projectPath),
  getWorkspaceViewState: (): Promise<WorkspaceViewState> => ipcRenderer.invoke('get-workspace-view-state'),
  saveWorkspaceViewState: (state: WorkspaceViewState): Promise<WorkspaceViewState> => ipcRenderer.invoke('save-workspace-view-state', state),
  startDownloadedModel: (repoId: string, filename: string, requireVision = false): Promise<LlamaRuntimeStatus> => ipcRenderer.invoke('start-downloaded-model', repoId, filename, requireVision),
  generateChatTitle: (userMessage: string): Promise<string> => ipcRenderer.invoke('generate-chat-title', userMessage),
  checkModelCache: (modelId: string): Promise<boolean> =>
    ipcRenderer.invoke('check-model-cache', modelId),
  getDownloadedModels: (repos: string[]): Promise<string[]> =>
    ipcRenderer.invoke('get-downloaded-models', repos),
  downloadModel: (repoId: string, ggufFile: string): Promise<void> =>
    ipcRenderer.invoke('download-model', repoId, ggufFile),
  cancelDownload: (repoId: string): Promise<void> =>
    ipcRenderer.invoke('cancel-download', repoId),
  onDownloadProgress: (callback: (data: { repoId: string; downloaded: number; total: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { repoId: string; downloaded: number; total: number }) => callback(data)
    ipcRenderer.on('download-progress', handler)
    return () => { ipcRenderer.removeListener('download-progress', handler) }
  },
  getLlamaStatus: (): Promise<LlamaRuntimeStatus> => ipcRenderer.invoke('get-llama-status'),
  startLocalModel: (modelId: string): Promise<LlamaRuntimeStatus> => ipcRenderer.invoke('start-local-model', modelId),
  startLlamaServer: (modelPath: string, contextTokens: number): Promise<LlamaRuntimeStatus> =>
    ipcRenderer.invoke('start-llama-server', modelPath, contextTokens),
  stopLlamaServer: (): Promise<LlamaRuntimeStatus> => ipcRenderer.invoke('stop-llama-server'),
  /*
   * Sequence 3 adds only the typed completion transport. It does not modify renderer layout, styling,
   * controls, or interaction behavior. Sequence 4 may consume these methods from the existing composer
   * and render deltas in a conversation surface without moving or restyling the current UI elements.
   */
  startLocalCompletion: (request: AgentRunRequest): Promise<LocalCompletionStart> => ipcRenderer.invoke('start-local-completion', request),
  startAgentCompletion: (target: AgentExecutionTarget, request: AgentRunRequest): Promise<LocalCompletionStart> => ipcRenderer.invoke('start-agent-completion', target, request),
  cancelLocalCompletion: (requestId: string): Promise<boolean> => ipcRenderer.invoke('cancel-local-completion', requestId),
  onLocalCompletionEvent: (callback: (event: LocalCompletionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, completionEvent: LocalCompletionEvent) => callback(completionEvent)
    ipcRenderer.on('local-completion-event', handler)
    return () => { ipcRenderer.removeListener('local-completion-event', handler) }
  }
}

contextBridge.exposeInMainWorld('api', api)
