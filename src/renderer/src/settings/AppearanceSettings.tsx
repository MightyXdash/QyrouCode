import { type JSX } from 'react'
import { THEMES, type ThemePreference } from '../../../shared/settings'
import { SettingsGroup, SettingsRow } from './SettingsControls'
import SettingsSelect from './SettingsSelect'

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
          <SettingsRow title="Color scheme" description="Choose how QyrouCode follows your desktop theme.">
            <SettingsSelect
              value={theme}
              label="Color scheme"
              options={THEMES.map((option) => ({ value: option, label: label(option) }))}
              onChange={(value) => onThemeChange(value as ThemePreference)}
            />
          </SettingsRow>
        </SettingsGroup>
      </div>
    </>
  )
}
