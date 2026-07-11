import './WindowControls.css'
import { Minus, Square, X } from 'lucide-react'
import type { OnboardingPreferences, OnboardingState, ResponseStylePreference, ThemePreference } from '../../shared/settings'
import type { LlamaRuntimeStatus } from '../../shared/llama'
import type { WindowCommand } from '../../shared/windowCommands'
import type { LocalCompletionEvent, LocalCompletionStart } from '../../main/localCompletionClient'
import type { AgentRunRequest } from '../../main/agentRuntime'
import type { Project } from '../../shared/projects'
import type { ChatAttachment, ChatThread } from '../../shared/chat'
import type { PersistedAgentSession, WorkspaceViewState } from '../../shared/agent'

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
      getResponseStylePreference: () => Promise<ResponseStylePreference>
      setTheme: (theme: ThemePreference) => Promise<ThemePreference>
      getProjects: () => Promise<Project[]>
      getExpandedProjectPaths: () => Promise<string[]>
      setExpandedProjectPaths: (paths: string[]) => Promise<string[]>
      createProject: (name: string) => Promise<Project>
      chooseProjectFolder: () => Promise<Project | null>
      getChatThreads: () => Promise<ChatThread[]>
      saveChatThread: (thread: ChatThread) => Promise<ChatThread[]>
      deleteChatThread: (threadId: string) => Promise<ChatThread[]>
      chooseChatImages: () => Promise<ChatAttachment[]>
      getAgentSession: (threadId: string, projectPath: string) => Promise<PersistedAgentSession | null>
      getWorkspaceViewState: () => Promise<WorkspaceViewState>
      saveWorkspaceViewState: (state: WorkspaceViewState) => Promise<WorkspaceViewState>
      startDownloadedModel: (repoId: string, filename: string) => Promise<LlamaRuntimeStatus>
      generateChatTitle: (userMessage: string) => Promise<string>
      checkModelCache: (modelId: string) => Promise<boolean>
      downloadModel: (repoId: string, ggufFile: string) => Promise<void>
      cancelDownload: (repoId: string) => Promise<void>
      onDownloadProgress: (callback: (data: { repoId: string; downloaded: number; total: number }) => void) => () => void
      getLlamaStatus: () => Promise<LlamaRuntimeStatus>
      startLocalModel: (modelId: string) => Promise<LlamaRuntimeStatus>
      startLocalCompletion: (request: AgentRunRequest) => Promise<LocalCompletionStart>
      cancelLocalCompletion: (requestId: string) => Promise<boolean>
      onLocalCompletionEvent: (callback: (event: LocalCompletionEvent) => void) => () => void
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
        <Minus size={10} strokeWidth={1.5} />
      </button>
      {showMaximize && (
        <button className="win-btn win-btn-maximize" onClick={() => window.api.toggleMaximize()} aria-label="Maximize or restore">
          <Square size={8} strokeWidth={1.5} />
        </button>
      )}
      <button className="win-btn win-btn-close" onClick={() => window.api.close()} aria-label="Close">
        <X size={11} strokeWidth={1.5} />
      </button>
    </div>
  )
}
