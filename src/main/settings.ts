import Store from 'electron-store'
import {
  SETTINGS_VERSION,
  type OnboardingPreferences,
  type OnboardingState,
  type SettingsStoreData,
  type ThemePreference,
  validateOnboardingPreferences,
  validateThemePreference
} from '../shared/settings'

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

export const setTheme = (value: unknown): ThemePreference => {
  const theme = validateThemePreference(value)
  const preferences = settingsStore.get('onboardingPreferences')
  if (preferences) settingsStore.set('onboardingPreferences', { ...preferences, theme })
  return theme
}
