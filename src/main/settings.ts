import Store from 'electron-store'
import {
  SETTINGS_VERSION,
  type OnboardingPreferences,
  type OnboardingState,
  type SettingsStoreData,
  validateOnboardingPreferences
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
