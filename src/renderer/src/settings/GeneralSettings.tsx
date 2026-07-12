import { useEffect, useState, type JSX } from 'react'
import { MAX_CUSTOM_RESPONSE_STYLE_LENGTH, RESPONSE_STYLES, THEMES, type ResponseStylePreference, type ThemePreference } from '../../../shared/settings'
import { REASONING_EFFORTS, type ReasoningEffort } from '../reasoningProfiles'
import { SettingsGroup, SettingsRow } from './SettingsControls'

interface GeneralSettingsProps {
  theme: ThemePreference
  reasoningEffort: ReasoningEffort
  responseStyle: ResponseStylePreference
  onThemeChange: (theme: ThemePreference) => void
  onReasoningEffortChange: (effort: ReasoningEffort) => void
  onResponseStyleChange: (preference: ResponseStylePreference) => Promise<void> | void
}

const label = (value: string): string => value.replace('-', ' ').replace(/^./, (character) => character.toUpperCase())

export default function GeneralSettings({
  theme,
  reasoningEffort,
  responseStyle,
  onThemeChange,
  onReasoningEffortChange,
  onResponseStyleChange
}: GeneralSettingsProps): JSX.Element {
  const [style, setStyle] = useState(responseStyle.style)
  const [customInstruction, setCustomInstruction] = useState(responseStyle.customInstruction)

  useEffect(() => {
    setStyle(responseStyle.style)
    setCustomInstruction(responseStyle.customInstruction)
  }, [responseStyle])

  return (
    <>
      <div className="settings-tab-header"><h2>General</h2></div>
      <div className="settings-tab-body">
        <SettingsGroup title="Appearance">
          <SettingsRow title="Color scheme" description="Choose how SupraCode follows your desktop theme.">
            <select value={theme} onChange={(event) => onThemeChange(event.target.value as ThemePreference)}>
              {THEMES.map((option) => <option value={option} key={option}>{label(option)}</option>)}
            </select>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Chat defaults">
          <SettingsRow title="Reasoning effort" description="Used for the next request and remembered per workspace.">
            <select value={reasoningEffort} onChange={(event) => onReasoningEffortChange(event.target.value as ReasoningEffort)}>
              {REASONING_EFFORTS.map((option) => <option value={option} key={option}>{option}</option>)}
            </select>
          </SettingsRow>
          <SettingsRow title="Response style" description="Controls the tone of generated responses.">
            <select
              value={style}
              onChange={(event) => {
                const nextStyle = event.target.value as ResponseStylePreference['style']
                setStyle(nextStyle)
                if (nextStyle !== 'custom') void onResponseStyleChange({ style: nextStyle, customInstruction: '' })
              }}
            >
              {RESPONSE_STYLES.map((option) => <option value={option} key={option}>{label(option)}</option>)}
            </select>
          </SettingsRow>
          {style === 'custom' && (
            <div className="settings-custom-style-row">
              <textarea
                value={customInstruction}
                maxLength={MAX_CUSTOM_RESPONSE_STYLE_LENGTH}
                rows={3}
                aria-label="Custom response style"
                placeholder="Describe how responses should sound"
                onChange={(event) => setCustomInstruction(event.target.value)}
              />
              <div>
                <span>{customInstruction.length} / {MAX_CUSTOM_RESPONSE_STYLE_LENGTH}</span>
                <button type="button" disabled={!customInstruction.trim()} onClick={() => void onResponseStyleChange({ style: 'custom', customInstruction })}>Save</button>
              </div>
            </div>
          )}
        </SettingsGroup>
      </div>
    </>
  )
}
