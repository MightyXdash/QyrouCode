import { type JSX } from 'react'
import { THEMES, type ThemePreference } from '../../../shared/settings'
import { SettingsGroup, SettingsRow } from './SettingsControls'

interface AppearanceSettingsProps {
  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void
}

const label = (value: string): string => value.replace('-', ' ').replace(/^./, (character) => character.toUpperCase())

export default function AppearanceSettings({ theme, onThemeChange }: AppearanceSettingsProps): JSX.Element {
  return (
    <>
      <div className="settings-tab-header"><h2>Appearance</h2></div>
      <div className="settings-tab-body">
        <SettingsGroup title="Theme">
          <SettingsRow title="Color scheme" description="Choose how SupraCode follows your desktop theme.">
            <select value={theme} onChange={(event) => onThemeChange(event.target.value as ThemePreference)}>
              {THEMES.map((option) => <option value={option} key={option}>{label(option)}</option>)}
            </select>
          </SettingsRow>
        </SettingsGroup>
      </div>
    </>
  )
}