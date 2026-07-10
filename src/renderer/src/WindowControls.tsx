import './WindowControls.css'
import type { OnboardingPreferences, OnboardingState } from '../../shared/settings'
import type { LlamaRuntimeStatus } from '../../shared/llama'
import type { LocalCompletionEvent, LocalCompletionRequest, LocalCompletionStart } from '../../main/localCompletionClient'

declare global {
  interface Window {
    api: {
      minimize: () => void
      close: () => void
      openMainWindow: () => Promise<void>
      rendererReady: () => void
      onWindowShown: (callback: () => void) => () => void
      getOnboardingState: () => Promise<OnboardingState>
      completeOnboarding: (preferences: OnboardingPreferences) => Promise<void>
      checkModelCache: (modelId: string) => Promise<boolean>
      downloadModel: (repoId: string, ggufFile: string) => Promise<void>
      cancelDownload: (repoId: string) => Promise<void>
      onDownloadProgress: (callback: (data: { repoId: string; downloaded: number; total: number }) => void) => () => void
      getLlamaStatus: () => Promise<LlamaRuntimeStatus>
      startLocalModel: (modelId: string) => Promise<LlamaRuntimeStatus>
      startLocalCompletion: (request: LocalCompletionRequest) => Promise<LocalCompletionStart>
      cancelLocalCompletion: (requestId: string) => Promise<boolean>
      onLocalCompletionEvent: (callback: (event: LocalCompletionEvent) => void) => () => void
      startLlamaServer: (modelPath: string, contextTokens: number) => Promise<LlamaRuntimeStatus>
      stopLlamaServer: () => Promise<LlamaRuntimeStatus>
    }
  }
}

export default function WindowControls(): JSX.Element {
  return (
    <div className="window-controls">
      <button className="win-btn win-btn-minimize" onClick={() => window.api.minimize()} aria-label="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      <button className="win-btn win-btn-close" onClick={() => window.api.close()} aria-label="Close">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2.5 2.5l5 5m0-5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
