import './WindowControls.css'
import type { OnboardingPreferences, OnboardingState, ThemePreference } from '../../shared/settings'
import type { LlamaRuntimeStatus } from '../../shared/llama'
import type { WindowCommand } from '../../shared/windowCommands'

declare global {
  interface Window {
    api: {
      minimize: () => void
      toggleMaximize: () => void
      runWindowCommand: (command: WindowCommand) => void
      close: () => void
      openMainWindow: () => Promise<void>
      rendererReady: () => void
      onWindowShown: (callback: () => void) => () => void
      getOnboardingState: () => Promise<OnboardingState>
      completeOnboarding: (preferences: OnboardingPreferences) => Promise<void>
      getTheme: () => Promise<ThemePreference>
      setTheme: (theme: ThemePreference) => Promise<ThemePreference>
      checkModelCache: (modelId: string) => Promise<boolean>
      downloadModel: (repoId: string, ggufFile: string) => Promise<void>
      cancelDownload: (repoId: string) => Promise<void>
      onDownloadProgress: (callback: (data: { repoId: string; downloaded: number; total: number }) => void) => () => void
      getLlamaStatus: () => Promise<LlamaRuntimeStatus>
      startLlamaServer: (modelPath: string, contextTokens: number) => Promise<LlamaRuntimeStatus>
      stopLlamaServer: () => Promise<LlamaRuntimeStatus>
    }
  }
}

interface WindowControlsProps {
  showMaximize?: boolean
}

export default function WindowControls({ showMaximize = false }: WindowControlsProps): JSX.Element {
  return (
    <div className="window-controls">
      <button className="win-btn win-btn-minimize" onClick={() => window.api.minimize()} aria-label="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      {showMaximize && (
        <button className="win-btn win-btn-maximize" onClick={() => window.api.toggleMaximize()} aria-label="Maximize or restore">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="2" y="2" width="6" height="6" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
      )}
      <button className="win-btn win-btn-close" onClick={() => window.api.close()} aria-label="Close">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2.5 2.5l5 5m0-5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
