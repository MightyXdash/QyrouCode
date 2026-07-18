import { useEffect, useState, type JSX } from 'react'
import { HardDrive, X } from 'lucide-react'
import { MAX_CUSTOM_RESPONSE_STYLE_LENGTH, NATIVE_LANGUAGES, RESPONSE_STYLES, type NativeLanguage, type ResponseStylePreference } from '../../../shared/settings'
import { MAX_PROMPT_REFINEMENT_BACKUPS, type PromptRefinementModelOption, type PromptRefinementPreferences } from '../../../shared/promptRefinement'
import { REASONING_EFFORTS, type ReasoningEffort } from '../reasoningProfiles'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsControls'
import SettingsSelect, { type SettingsSelectOption } from './SettingsSelect'

interface GeneralSettingsProps {
  reasoningEffort: ReasoningEffort
  responseStyle: ResponseStylePreference
  nativeLanguage: NativeLanguage
  promptRefinementPreferences: PromptRefinementPreferences
  promptRefinementModels: readonly PromptRefinementModelOption[]
  onReasoningEffortChange: (effort: ReasoningEffort) => void
  onResponseStyleChange: (preference: ResponseStylePreference) => Promise<void> | void
  onNativeLanguageChange: (nativeLanguage: NativeLanguage) => Promise<void> | void
  onPromptRefinementPreferencesChange: (preference: PromptRefinementPreferences) => Promise<void> | void
}

const label = (value: string): string => value.replace('-', ' ').replace(/^./, (character) => character.toUpperCase())

export default function GeneralSettings({
  reasoningEffort,
  responseStyle,
  nativeLanguage,
  promptRefinementPreferences,
  promptRefinementModels,
  onReasoningEffortChange,
  onResponseStyleChange,
  onNativeLanguageChange,
  onPromptRefinementPreferencesChange
}: GeneralSettingsProps): JSX.Element {
  const [style, setStyle] = useState(responseStyle.style)
  const [customInstruction, setCustomInstruction] = useState(responseStyle.customInstruction)

  useEffect(() => {
    setStyle(responseStyle.style)
    setCustomInstruction(responseStyle.customInstruction)
  }, [responseStyle])

  const updatePrimaryModel = (primaryModelId: string): void => {
    void onPromptRefinementPreferencesChange({
      ...promptRefinementPreferences,
      primaryModelId,
      backupModelIds: promptRefinementPreferences.backupModelIds.filter((modelId) => modelId !== primaryModelId)
    })
  }

  const updateBackupModel = (index: number, modelId: string): void => {
    const backupModelIds = [...promptRefinementPreferences.backupModelIds]
    if (modelId) backupModelIds[index] = modelId
    else backupModelIds.splice(index, 1)
    void onPromptRefinementPreferencesChange({ ...promptRefinementPreferences, backupModelIds })
  }

  const modelOptions = (models: readonly PromptRefinementModelOption[]): SettingsSelectOption[] =>
    models.map((model) => ({ value: model.id, label: model.displayName, detail: model.providerName }))

  const primaryModelId = promptRefinementModels.some((model) => model.id === promptRefinementPreferences.primaryModelId)
    ? promptRefinementPreferences.primaryModelId
    : ''
  const primaryOptions: SettingsSelectOption[] = [
    { value: '', label: 'Auto', detail: 'Recommended' },
    ...modelOptions(promptRefinementModels)
  ]
  const availableBackupModels = promptRefinementModels.filter((model) => (
    model.id !== promptRefinementPreferences.primaryModelId &&
    !promptRefinementPreferences.backupModelIds.includes(model.id)
  ))
  const hasLocalBackup = promptRefinementPreferences.backupModelIds.some((modelId) =>
    promptRefinementModels.some((model) => model.id === modelId && model.source === 'local')
  )

  return (
    <>
      <div className="settings-tab-header"><h2>General</h2></div>
      <div className="settings-tab-body">
        <SettingsGroup title="Chat defaults">
          <SettingsRow title="Reasoning effort" description="Used for the next request and remembered per workspace.">
            <SettingsSelect
              value={reasoningEffort}
              label="Reasoning effort"
              options={REASONING_EFFORTS.map((option) => ({ value: option, label: option }))}
              onChange={(value) => onReasoningEffortChange(value as ReasoningEffort)}
            />
          </SettingsRow>
          <SettingsRow title="Response style" description="Controls the tone of generated responses.">
            <SettingsSelect
              value={style}
              label="Response style"
              options={RESPONSE_STYLES.map((option) => ({ value: option, label: label(option) }))}
              onChange={(value) => {
                const nextStyle = value as ResponseStylePreference['style']
                setStyle(nextStyle)
                if (nextStyle !== 'custom') void onResponseStyleChange({ style: nextStyle, customInstruction: '' })
              }}
            />
          </SettingsRow>
          <SettingsRow title="Native language" description="Used for task updates, activity messages, and final responses.">
            <SettingsSelect
              value={nativeLanguage}
              label="Native language"
              options={NATIVE_LANGUAGES.map((language) => ({ value: language, label: language }))}
              onChange={(value) => void onNativeLanguageChange(value as NativeLanguage)}
            />
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
        <SettingsGroup title="Prompt refinement">
          <div className="settings-refinement-primary">
            <div className="settings-refinement-copy">
              <strong>Refinement model</strong>
              <span>Choose a model or let SupraCode select one automatically.</span>
            </div>
            <SettingsSelect
              value={primaryModelId}
              label="Prompt refinement model"
              options={primaryOptions}
              onChange={updatePrimaryModel}
            />
          </div>
          <div className="settings-refinement-preference">
            <div className="settings-refinement-copy">
              <strong>Prefer provider models</strong>
              <span>In Auto mode, try connected cloud or offline providers before downloaded models.</span>
            </div>
            <SettingsSwitch
              checked={promptRefinementPreferences.preferProviderModels}
              label="Prefer provider models for prompt refinement"
              onChange={(preferProviderModels) => void onPromptRefinementPreferencesChange({ ...promptRefinementPreferences, preferProviderModels })}
            />
          </div>
          <div className="settings-refinement-backups">
            <div className="settings-refinement-backups-header">
              <div className="settings-refinement-copy">
                <strong>Backup models</strong>
                <span>SupraCode tries these in order if refinement fails.</span>
              </div>
              {promptRefinementPreferences.backupModelIds.length < MAX_PROMPT_REFINEMENT_BACKUPS && (
                <SettingsSelect
                  compact
                  value=""
                  label="Add a backup model"
                  placeholder="Add backup"
                  options={modelOptions(availableBackupModels)}
                  disabled={availableBackupModels.length === 0}
                  onChange={(modelId) => updateBackupModel(promptRefinementPreferences.backupModelIds.length, modelId)}
                />
              )}
            </div>
            {promptRefinementPreferences.backupModelIds.length === 0 ? (
              <div className="settings-refinement-empty">No backup models selected</div>
            ) : (
              <div className="settings-refinement-backup-list">
                {promptRefinementPreferences.backupModelIds.map((modelId, index) => {
                  const currentModel = promptRefinementModels.find((model) => model.id === modelId)
                  const choices = promptRefinementModels.filter((model) => (
                    model.id !== promptRefinementPreferences.primaryModelId &&
                    (!promptRefinementPreferences.backupModelIds.includes(model.id) || model.id === modelId)
                  ))
                  return (
                    <div className="settings-refinement-backup" key={modelId}>
                      <span className="settings-refinement-backup-order">{index + 1}</span>
                      <SettingsSelect
                        value={currentModel?.id ?? ''}
                        label={`Backup model ${index + 1}`}
                        placeholder="Unavailable model"
                        options={modelOptions(choices)}
                        onChange={(value) => updateBackupModel(index, value)}
                      />
                      <button className="settings-refinement-remove" type="button" aria-label={`Remove backup model ${index + 1}`} onClick={() => updateBackupModel(index, '')}><X aria-hidden="true" /></button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {promptRefinementPreferences.preferProviderModels && !hasLocalBackup && (
            <div className="settings-refinement-note">
              <HardDrive aria-hidden="true" />
              <span>Add a downloaded local model as a backup to keep refinement available when providers or your network are unavailable.</span>
            </div>
          )}
        </SettingsGroup>
      </div>
    </>
  )
}
