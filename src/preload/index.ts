import { contextBridge, ipcRenderer } from 'electron'
import type { NativeLanguage, OnboardingPreferences, OnboardingState, ResponseStylePreference, ThemePreference } from '../shared/settings'
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
import type { PromptRefinementPreferences, PromptRefinementResult, PromptRefinementTarget } from '../shared/promptRefinement'
import type { TerminalExitEvent, TerminalInterventionRequest, TerminalInterventionResolution, TerminalOutputEvent, TerminalRevealEvent, TerminalSessionEvent, TerminalSessionInfo } from '../shared/terminal'

const api = {
  platform: process.platform,
  minimize: () => ipcRenderer.send('minimize-window'),
  toggleMaximize: () => ipcRenderer.send('toggle-maximize-window'),
  runWindowCommand: (command: WindowCommand) => ipcRenderer.send('run-window-command', command),
  onNativeMenuCommand: (callback: (command: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: string) => callback(command)
    ipcRenderer.on('native-menu-command', handler)
    return () => { ipcRenderer.removeListener('native-menu-command', handler) }
  },
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
  setResponseStylePreference: (preference: ResponseStylePreference): Promise<ResponseStylePreference> => ipcRenderer.invoke('set-response-style-preference', preference),
  getNativeLanguage: (): Promise<NativeLanguage> => ipcRenderer.invoke('get-native-language'),
  setNativeLanguage: (nativeLanguage: NativeLanguage): Promise<NativeLanguage> => ipcRenderer.invoke('set-native-language', nativeLanguage),
  setTheme: (theme: ThemePreference): Promise<ThemePreference> => ipcRenderer.invoke('set-theme', theme),
  getPromptRefinementPreferences: (): Promise<PromptRefinementPreferences> => ipcRenderer.invoke('get-prompt-refinement-preferences'),
  setPromptRefinementPreferences: (preference: PromptRefinementPreferences): Promise<PromptRefinementPreferences> => ipcRenderer.invoke('set-prompt-refinement-preferences', preference),
  refinePrompt: (prompt: string, targets: PromptRefinementTarget[]): Promise<PromptRefinementResult> => ipcRenderer.invoke('refine-prompt', prompt, targets),
  getConnections: (): Promise<ConnectionSummary[]> => ipcRenderer.invoke('get-connections'),
  getConnectionSecurityStatus: (): Promise<ConnectionSecurityStatus> => ipcRenderer.invoke('get-connection-security-status'),
  resolveProviderSiteIcon: (baseUrl: string): Promise<string | undefined> => ipcRenderer.invoke('resolve-provider-site-icon', baseUrl),
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
  renameProject: (projectPath: string, name: string): Promise<Project[]> => ipcRenderer.invoke('rename-project', projectPath, name),
  removeProject: (projectPath: string): Promise<Project[]> => ipcRenderer.invoke('remove-project', projectPath),
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
  },
  listTerminals: (): Promise<TerminalSessionInfo[]> => ipcRenderer.invoke('terminal-list'),
  listTerminalInterventions: (): Promise<TerminalInterventionRequest[]> => ipcRenderer.invoke('terminal-list-interventions'),
  createTerminal: (cwd?: string, projectPath?: string): Promise<TerminalSessionInfo> => ipcRenderer.invoke('terminal-create', cwd, projectPath),
  attachTerminal: (sessionId: string) => ipcRenderer.send('terminal-ready', sessionId),
  writeTerminal: (sessionId: string, data: string) => ipcRenderer.send('terminal-input', sessionId, data),
  resizeTerminal: (sessionId: string, columns: number, rows: number) => ipcRenderer.send('terminal-resize', sessionId, columns, rows),
  updateTerminalUiState: (visible: boolean, activeId: string) => ipcRenderer.send('terminal-ui-state', visible, activeId),
  closeTerminal: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('terminal-close', sessionId),
  resolveTerminalIntervention: (resolution: TerminalInterventionResolution): Promise<boolean> => ipcRenderer.invoke('terminal-resolve-intervention', resolution),
  onTerminalSessionEvent: (callback: (event: TerminalSessionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionEvent: TerminalSessionEvent) => callback(sessionEvent)
    ipcRenderer.on('terminal-session-event', handler)
    return () => { ipcRenderer.removeListener('terminal-session-event', handler) }
  },
  onTerminalReveal: (callback: (event: TerminalRevealEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, reveal: TerminalRevealEvent) => callback(reveal)
    ipcRenderer.on('terminal-reveal', handler)
    return () => { ipcRenderer.removeListener('terminal-reveal', handler) }
  },
  onTerminalIntervention: (callback: (request: TerminalInterventionRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: TerminalInterventionRequest) => callback(request)
    ipcRenderer.on('terminal-intervention', handler)
    return () => { ipcRenderer.removeListener('terminal-intervention', handler) }
  },
  onTerminalInterventionDismissed: (callback: (id: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string) => callback(id)
    ipcRenderer.on('terminal-intervention-dismissed', handler)
    return () => { ipcRenderer.removeListener('terminal-intervention-dismissed', handler) }
  },
  onTerminalOutput: (callback: (event: TerminalOutputEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, output: TerminalOutputEvent) => callback(output)
    ipcRenderer.on('terminal-output', handler)
    return () => { ipcRenderer.removeListener('terminal-output', handler) }
  },
  onTerminalExit: (callback: (event: TerminalExitEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, exit: TerminalExitEvent) => callback(exit)
    ipcRenderer.on('terminal-exit', handler)
    return () => { ipcRenderer.removeListener('terminal-exit', handler) }
  }
}

contextBridge.exposeInMainWorld('api', api)
