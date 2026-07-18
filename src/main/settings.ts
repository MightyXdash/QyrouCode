import Store from 'electron-store'
import {
  SETTINGS_VERSION,
  DEFAULT_RESPONSE_STYLE,
  type OnboardingPreferences,
  type OnboardingState,
  type ExecutionApprovalPolicy,
  type SettingsStoreData,
  type ThemePreference,
  type ResponseStylePreference,
  validateOnboardingPreferences,
  validateResponseStylePreference,
  validateThemePreference
} from '../shared/settings'
import type { Project } from '../shared/projects'
import type { ChatThread } from '../shared/chat'
import { DEFAULT_WORKSPACE_VIEW_STATE, VIEW_REASONING_EFFORTS, type AgentModelProvenance, type PersistedAgentMessage, type PersistedAgentSession, type WorkspaceViewState } from '../shared/agent'
import { FIRST_LOAD_CONTEXT_TOKENS } from '../shared/llama'
import {
  DEFAULT_PROMPT_REFINEMENT_PREFERENCES,
  type PromptRefinementPreferences,
  validatePromptRefinementPreferences
} from '../shared/promptRefinement'

const settingsStore = new Store<SettingsStoreData>({
  name: 'settings',
  defaults: {
    settingsVersion: SETTINGS_VERSION,
    onboardingCompleted: false
  }
})

if (settingsStore.get('settingsVersion') < SETTINGS_VERSION) {
  settingsStore.set('settingsVersion', SETTINGS_VERSION)
}

export const getOnboardingState = (): OnboardingState => ({
  completed: settingsStore.get('onboardingCompleted')
})

export const completeOnboarding = (value: unknown): OnboardingPreferences => {
  const preferences = validateOnboardingPreferences(value)
  settingsStore.set({
    settingsVersion: SETTINGS_VERSION,
    onboardingCompleted: true,
    onboardingPreferences: preferences
  })
  return preferences
}

export const getTheme = (): ThemePreference =>
  settingsStore.get('onboardingPreferences')?.theme ?? 'system'

export const getSelectedContextWindowTokens = (): number =>
  settingsStore.get('onboardingPreferences')?.contextWindowTokens ?? FIRST_LOAD_CONTEXT_TOKENS

export const getExecutionApprovalPolicy = (): ExecutionApprovalPolicy =>
  settingsStore.get('onboardingPreferences')?.executionApproval ?? 'high-risk'

export const getResponseStylePreference = (): ResponseStylePreference => {
  const preferences = settingsStore.get('onboardingPreferences')
  return {
    style: preferences?.responseStyle ?? DEFAULT_RESPONSE_STYLE,
    customInstruction: preferences?.customResponseInstruction ?? ''
  }
}

export const setTheme = (value: unknown): ThemePreference => {
  const theme = validateThemePreference(value)
  const preferences = settingsStore.get('onboardingPreferences')
  if (preferences) settingsStore.set('onboardingPreferences', { ...preferences, theme })
  return theme
}

export const setResponseStylePreference = (value: unknown): ResponseStylePreference => {
  const responseStyle = validateResponseStylePreference(value)
  const preferences = settingsStore.get('onboardingPreferences')
  if (preferences) {
    settingsStore.set('onboardingPreferences', {
      ...preferences,
      responseStyle: responseStyle.style,
      customResponseInstruction: responseStyle.customInstruction
    })
  }
  return responseStyle
}

export const getPromptRefinementPreferences = (): PromptRefinementPreferences =>
  settingsStore.get('promptRefinementPreferences') ?? DEFAULT_PROMPT_REFINEMENT_PREFERENCES

export const setPromptRefinementPreferences = (value: unknown): PromptRefinementPreferences => {
  const preferences = validatePromptRefinementPreferences(value)
  settingsStore.set('promptRefinementPreferences', preferences)
  return preferences
}

export const getProjects = (): Project[] => settingsStore.get('projects') ?? []

export const addProject = (project: Project): Project[] => {
  const projects = getProjects().filter((item) => item.path !== project.path)
  const nextProjects = [project, ...projects]
  settingsStore.set('projects', nextProjects)
  return nextProjects
}

export const renameProject = (projectPath: string, name: string): Project[] => {
  const projects = getProjects()
  if (!projects.some((project) => project.path === projectPath)) throw new Error('Project not found')
  const nextProjects = projects.map((project) => project.path === projectPath ? { ...project, name } : project)
  settingsStore.set('projects', nextProjects)
  return nextProjects
}

export const removeProject = (projectPath: string): Project[] => {
  const nextProjects = getProjects().filter((project) => project.path !== projectPath)
  settingsStore.set('projects', nextProjects)
  settingsStore.set('expandedProjectPaths', getExpandedProjectPaths().filter((path) => path !== projectPath))
  return nextProjects
}

export const getExpandedProjectPaths = (): string[] => settingsStore.get('expandedProjectPaths') ?? []

export const setExpandedProjectPaths = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every((path) => typeof path === 'string')) throw new Error('Invalid expanded project paths')
  const paths = [...new Set(value)]
  settingsStore.set('expandedProjectPaths', paths)
  return paths
}

export const getChatThreads = (): ChatThread[] => settingsStore.get('chatThreads') ?? []

export const saveChatThread = (thread: ChatThread): ChatThread[] => {
  const threads = getChatThreads().filter((item) => item.id !== thread.id)
  const nextThreads = [thread, ...threads]
  settingsStore.set('chatThreads', nextThreads)
  return nextThreads
}

export const deleteChatThread = (threadId: string): ChatThread[] => {
  const threads = getChatThreads().filter((item) => item.id !== threadId)
  settingsStore.set('chatThreads', threads)
  const sessions = settingsStore.get('agentSessions')
  if (sessions && threadId in sessions) {
    const nextSessions = { ...sessions }
    delete nextSessions[threadId]
    settingsStore.set('agentSessions', nextSessions)
  }
  return threads
}

const validModelProvenance = (value: unknown): value is AgentModelProvenance => {
  if (!value || typeof value !== 'object') return false
  const model = value as Partial<AgentModelProvenance>
  return ['local', 'remote'].includes(model.source ?? '') &&
    typeof model.provider === 'string' && Boolean(model.provider) &&
    typeof model.modelId === 'string' && Boolean(model.modelId) &&
    typeof model.displayName === 'string' && Boolean(model.displayName) &&
    ['retain', 'discard'].includes(model.reasoningRetention ?? '') &&
    (model.connectionId === undefined || typeof model.connectionId === 'string')
}

const validAgentMessage = (value: unknown): value is PersistedAgentMessage => {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<PersistedAgentMessage>
  const validContent = message.content === null || typeof message.content === 'string' || (Array.isArray(message.content) && message.content.every((part) => {
    if (!part || typeof part !== 'object' || !('type' in part)) return false
    if (part.type === 'text') return typeof part.text === 'string'
    return part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:image/')
  }))
  if (!['user', 'assistant', 'tool'].includes(message.role ?? '') || !validContent) return false
  if (message.role === 'tool' && (typeof message.toolCallId !== 'string' || typeof message.name !== 'string')) return false
  if (message.toolCalls !== undefined && (!Array.isArray(message.toolCalls) || !message.toolCalls.every((call) => call && typeof call.id === 'string' && typeof call.name === 'string' && call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)))) return false
  if (message.reasoningText !== undefined && typeof message.reasoningText !== 'string') return false
  if (message.model !== undefined && !validModelProvenance(message.model)) return false
  return true
}

export const getAgentSession = (threadId: string, projectPath: string): PersistedAgentSession | undefined => {
  const session = settingsStore.get('agentSessions')?.[threadId]
  if (!session || session.threadId !== threadId || session.projectPath !== projectPath || !Array.isArray(session.messages) || !session.messages.every(validAgentMessage)) return undefined
  return session
}

export const getAgentSessions = (): Record<string, PersistedAgentSession> => {
  const sessions = settingsStore.get('agentSessions') ?? {}
  return Object.fromEntries(Object.entries(sessions).filter(([threadId, session]) =>
    session.threadId === threadId && Array.isArray(session.messages) && session.messages.every(validAgentMessage)))
}

export const saveAgentSession = (session: PersistedAgentSession): PersistedAgentSession => {
  if (!session.threadId || !session.projectPath || !session.messages.every(validAgentMessage)) throw new Error('Invalid agent session')
  settingsStore.set('agentSessions', { ...settingsStore.get('agentSessions'), [session.threadId]: session })
  return session
}

export const getWorkspaceViewState = (): WorkspaceViewState => ({
  ...DEFAULT_WORKSPACE_VIEW_STATE,
  ...settingsStore.get('workspaceViewState')
})

export const saveWorkspaceViewState = (value: unknown): WorkspaceViewState => {
  if (!value || typeof value !== 'object') throw new Error('Invalid workspace view state')
  const state = value as Partial<WorkspaceViewState>
  if (typeof state.selectedProjectPath !== 'string' || typeof state.activeThreadId !== 'string' || typeof state.selectedModelId !== 'string' || !VIEW_REASONING_EFFORTS.includes(state.reasoningEffort as typeof VIEW_REASONING_EFFORTS[number]) || typeof state.sidebarOpen !== 'boolean' || typeof state.promptDraft !== 'string' || !Array.isArray(state.expandedWorkIds) || !state.expandedWorkIds.every((id) => typeof id === 'string')) throw new Error('Invalid workspace view state')
  const next = state as WorkspaceViewState
  settingsStore.set('workspaceViewState', next)
  return next
}
