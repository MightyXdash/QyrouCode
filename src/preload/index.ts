import { contextBridge, ipcRenderer } from 'electron'
import type { OnboardingPreferences, OnboardingState, ThemePreference } from '../shared/settings'
import type { LlamaRuntimeStatus } from '../shared/llama'
import type { WindowCommand } from '../shared/windowCommands'
import type { LocalCompletionEvent, LocalCompletionRequest, LocalCompletionStart } from '../main/localCompletionClient'

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
  setTheme: (theme: ThemePreference): Promise<ThemePreference> => ipcRenderer.invoke('set-theme', theme),
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
  startLocalCompletion: (request: LocalCompletionRequest): Promise<LocalCompletionStart> => ipcRenderer.invoke('start-local-completion', request),
  cancelLocalCompletion: (requestId: string): Promise<boolean> => ipcRenderer.invoke('cancel-local-completion', requestId),
  onLocalCompletionEvent: (callback: (event: LocalCompletionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, completionEvent: LocalCompletionEvent) => callback(completionEvent)
    ipcRenderer.on('local-completion-event', handler)
    return () => { ipcRenderer.removeListener('local-completion-event', handler) }
  }
}

contextBridge.exposeInMainWorld('api', api)
