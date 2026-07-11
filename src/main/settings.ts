import Store from 'electron-store'
import {
  SETTINGS_VERSION,
  DEFAULT_RESPONSE_STYLE,
  type OnboardingPreferences,
  type OnboardingState,
  type SettingsStoreData,
  type ThemePreference,
  type ResponseStylePreference,
  validateOnboardingPreferences,
  validateThemePreference
} from '../shared/settings'
import type { Project } from '../shared/projects'
import type { ChatThread } from '../shared/chat'
import { FIRST_LOAD_CONTEXT_TOKENS } from '../shared/llama'

const settingsStore = new Store<SettingsStoreData>({
  name: 'settings',
  defaults: {
    settingsVersion: SETTINGS_VERSION,
    onboardingCompleted: false
  }
})

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

export const getProjects = (): Project[] => settingsStore.get('projects') ?? []

export const addProject = (project: Project): Project[] => {
  const projects = getProjects().filter((item) => item.path !== project.path)
  const nextProjects = [project, ...projects]
  settingsStore.set('projects', nextProjects)
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
