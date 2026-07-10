import { contextBridge, ipcRenderer } from 'electron'
import type { OnboardingPreferences, OnboardingState, ThemePreference } from '../shared/settings'
import type { LlamaRuntimeStatus } from '../shared/llama'
import type { WindowCommand } from '../shared/windowCommands'

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
  startLlamaServer: (modelPath: string, contextTokens: number): Promise<LlamaRuntimeStatus> =>
    ipcRenderer.invoke('start-llama-server', modelPath, contextTokens),
  stopLlamaServer: (): Promise<LlamaRuntimeStatus> => ipcRenderer.invoke('stop-llama-server')
}

contextBridge.exposeInMainWorld('api', api)
