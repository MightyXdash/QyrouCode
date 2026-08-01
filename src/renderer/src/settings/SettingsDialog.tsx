import { useCallback, useEffect, useMemo, useRef, Fragment, useState, type JSX } from 'react'
import { Bot, Database, Download, Palette, Plug, SlidersHorizontal } from 'lucide-react'
import { CONNECTION_PROVIDERS, type ConnectionProviderMetadata, type ConnectionSummary } from '../../../shared/connections'
import AppearanceSettings from './AppearanceSettings'
import ConnectionEditor from './ConnectionEditor'
import DataSettings from './DataSettings'
import GeneralSettings from './GeneralSettings'
import LocalModelsSettings from './LocalModelsSettings'
import ModelsSettings from './ModelsSettings'
import ProvidersSettings from './ProvidersSettings'
import type { SettingsDialogProps, SettingsSection } from './settingsTypes'
import './Settings.css'

export type {
  LocalModelDownloadState,
  RemoteCatalogState,
  SettingsAttachmentMode,
  SettingsConnectionRequest,
  SettingsConnectionTestResult,
  SettingsDialogProps,
  SettingsExportFormat,
  SettingsExportOptions,
  SettingsExportScope,
  SettingsExportState
} from './settingsTypes'

interface ConnectionTarget {
  provider: ConnectionProviderMetadata
  connection?: ConnectionSummary
}

const navigation: readonly { section: SettingsSection; label: string; icon: React.ComponentType }[] = [
  { section: 'general', label: 'General', icon: SlidersHorizontal },
  { section: 'appearance', label: 'Appearance', icon: Palette },
  { section: 'providers', label: 'Providers', icon: Plug },
  { section: 'models', label: 'Models', icon: Bot },
  { section: 'local-models', label: 'Local models', icon: Download },
  { section: 'data', label: 'Data', icon: Database }
]

export default function SettingsDialog(props: SettingsDialogProps): JSX.Element {
  const [section, setSection] = useState<SettingsSection>('general')
  const [activeConnectionId, setActiveConnectionId] = useState(props.connections[0]?.id ?? '')
  const [connectionTarget, setConnectionTarget] = useState<ConnectionTarget | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const activeConnection = useMemo(
    () => props.connections.find((connection) => connection.id === activeConnectionId) ?? props.connections[0],
    [activeConnectionId, props.connections]
  )

  useEffect(() => {
    if (!activeConnectionId && props.connections[0]) setActiveConnectionId(props.connections[0].id)
    if (activeConnectionId && !props.connections.some((connection) => connection.id === activeConnectionId)) setActiveConnectionId(props.connections[0]?.id ?? '')
  }, [activeConnectionId, props.connections])

  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (connectionTarget) setConnectionTarget(null)
      else props.onClose()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [connectionTarget, props.onClose])

  const configureConnection = (provider: ConnectionProviderMetadata, connection?: ConnectionSummary): void => {
    setConnectionTarget({ provider, connection })
  }

  const manageConnection = (connection: ConnectionSummary): void => {
    const provider = CONNECTION_PROVIDERS.find((item) => item.kind === connection.kind)
    if (provider) configureConnection(provider, connection)
  }

  const keepFocusInside = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Tab') return
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose() }}>
      <section className="settings-dialog-shell" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Settings" onKeyDown={keepFocusInside}>
        <div className="settings-dialog-layout">
          <nav className="settings-navigation" aria-label="Settings sections">
            {navigation.map((item) => {
              const Icon = item.icon
              return (
                <Fragment key={item.section}>
                  <button data-settings-section={item.section} className={section === item.section ? 'active' : ''} type="button" onClick={() => setSection(item.section)}>
                    <Icon size={14} /><span>{item.label}</span>
                  </button>
                  {item.section === 'models' && props.connections.length > 0 && (
                    <div className="settings-provider-nav">
                      {props.connections.map((connection) => (
                        <button
                          className={section === 'models' && activeConnection?.id === connection.id ? 'active' : ''}
                          type="button"
                          title={connection.providerName}
                          key={connection.id}
                          onClick={() => { setActiveConnectionId(connection.id); setSection('models') }}
                        >
                          <span>{connection.providerName}</span><small>{connection.selectedModelIds.length}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </Fragment>
              )
            })}
          </nav>

          <main className="settings-panel">
            {section === 'appearance' && <AppearanceSettings theme={props.theme} onThemeChange={props.onThemeChange} />}
            {section === 'general' && <GeneralSettings reasoningEffort={props.reasoningEffort} responseStyle={props.responseStyle} nativeLanguage={props.nativeLanguage} contextWindowTokens={props.contextWindowTokens} promptRefinementPreferences={props.promptRefinementPreferences} promptRefinementModels={props.promptRefinementModels} onReasoningEffortChange={props.onReasoningEffortChange} onResponseStyleChange={props.onResponseStyleChange} onNativeLanguageChange={props.onNativeLanguageChange} onContextWindowTokensChange={props.onContextWindowTokensChange} onPromptRefinementPreferencesChange={props.onPromptRefinementPreferencesChange} />}
            {section === 'providers' && <ProvidersSettings connections={props.connections} onConfigure={configureConnection} />}
            {section === 'models' && <ModelsSettings connection={activeConnection} catalog={activeConnection ? props.catalogs[activeConnection.id] : undefined} onManageConnection={manageConnection} onUpdateSelection={props.onUpdateModelSelection} onRefreshCatalog={props.onRefreshCatalog} />}
            {section === 'local-models' && <LocalModelsSettings catalog={props.localCatalog} downloadedModelIds={props.downloadedLocalModelIds} downloads={props.localModelDownloads} onDownload={props.onDownloadLocalModel} onCancel={props.onCancelLocalModelDownload} />}
            {section === 'data' && <DataSettings options={props.exportOptions} state={props.exportState} onOptionsChange={props.onExportOptionsChange} onExport={props.onExport} />}
          </main>
        </div>
      </section>

      {connectionTarget && (
        <ConnectionEditor
          provider={connectionTarget.provider}
          connection={connectionTarget.connection}
          connections={props.connections}
          onClose={() => setConnectionTarget(null)}
          onSave={props.onSaveConnection}
          onTest={props.onTestConnection}
          onDisconnect={props.onDisconnectConnection}
        />
      )}
    </div>
  )
}
