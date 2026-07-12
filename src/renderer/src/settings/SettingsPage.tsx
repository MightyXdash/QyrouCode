import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Database, Download, Plug, X } from 'lucide-react'
import {
  CONNECTION_PROVIDERS,
  type ConnectionProviderMetadata,
  type ConnectionSummary
} from '../../../shared/connections'
import ConfigureConnectionDialog from './ConfigureConnectionDialog'
import ConnectionsSettings from './ConnectionsSettings'
import ExportSettings from './ExportSettings'
import ProviderModelsSettings from './ProviderModelsSettings'
import type { SettingsPageProps, SettingsView } from './settingsTypes'
import './SettingsPage.css'

export type {
  SettingsAttachmentMode,
  SettingsConnectionRequest,
  SettingsConnectionTestResult,
  SettingsExportFormat,
  SettingsExportOptions,
  SettingsExportScope,
  SettingsExportState,
  SettingsPageProps,
  SettingsView
} from './settingsTypes'

interface ConnectionDialogTarget {
  provider: ConnectionProviderMetadata
  connection?: ConnectionSummary
}

const providerOrder = new Map(CONNECTION_PROVIDERS.map((provider, index) => [provider.kind, index]))

export default function SettingsPage({
  connections,
  catalog,
  exportOptions,
  exportState,
  initialView = { section: 'connections' },
  onSaveConnection,
  onTestConnection,
  onDisconnectConnection,
  onUpdateModelSelection,
  onExportOptionsChange,
  onExport,
  onClose
}: SettingsPageProps): JSX.Element {
  const [view, setView] = useState<SettingsView>(initialView)
  const [dialogTarget, setDialogTarget] = useState<ConnectionDialogTarget | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const sortedConnections = useMemo(() => [...connections].sort((left, right) => {
    const kindDifference = (providerOrder.get(left.kind) ?? Number.MAX_SAFE_INTEGER) - (providerOrder.get(right.kind) ?? Number.MAX_SAFE_INTEGER)
    if (kindDifference !== 0) return kindDifference
    return left.createdAt.localeCompare(right.createdAt)
  }), [connections])

  const activeConnection = view.section === 'models'
    ? connections.find((connection) => connection.id === view.connectionId)
    : undefined

  useEffect(() => {
    if (view.section === 'models' && !connections.some((connection) => connection.id === view.connectionId)) {
      setView({ section: 'connections' })
    }
  }, [connections, view])

  const openConnectionDialog = (provider: ConnectionProviderMetadata, connection?: ConnectionSummary): void => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDialogTarget({ provider, connection })
  }

  const closeConnectionDialog = (): void => {
    setDialogTarget(null)
    window.requestAnimationFrame(() => previousFocusRef.current?.focus())
  }

  const manageActiveConnection = (): void => {
    if (!activeConnection) return
    const provider = CONNECTION_PROVIDERS.find((candidate) => candidate.kind === activeConnection.kind)
    if (provider) openConnectionDialog(provider, activeConnection)
  }

  return (
    <section className="settings-page" aria-label="Settings">
      <aside className="settings-navigation">
        <header className="settings-navigation-header">
          <div>
            <p className="settings-eyebrow">SupraCode</p>
            <h1>Settings</h1>
          </div>
          {onClose && (
            <button className="settings-icon-button" type="button" aria-label="Close settings" onClick={onClose}>
              <X size={16} />
            </button>
          )}
        </header>

        <nav className="settings-nav" aria-label="Settings sections">
          <button
            className={view.section === 'connections' ? 'settings-nav-item active' : 'settings-nav-item'}
            type="button"
            aria-current={view.section === 'connections' ? 'page' : undefined}
            onClick={() => setView({ section: 'connections' })}
          >
            <Plug size={15} />
            <span>Connections</span>
          </button>

          <div className="settings-nav-group">
            <p className="settings-nav-label">Models</p>
            {sortedConnections.length === 0 ? (
              <p className="settings-nav-empty">Connected providers appear here.</p>
            ) : sortedConnections.map((connection) => (
              <button
                className={view.section === 'models' && view.connectionId === connection.id ? 'settings-nav-item settings-provider-nav-item active' : 'settings-nav-item settings-provider-nav-item'}
                type="button"
                aria-current={view.section === 'models' && view.connectionId === connection.id ? 'page' : undefined}
                title={connection.providerName}
                key={connection.id}
                onClick={() => setView({ section: 'models', connectionId: connection.id })}
              >
                <span className="settings-provider-mark" aria-hidden="true">{connection.providerName.slice(0, 1).toLocaleUpperCase()}</span>
                <span>{connection.providerName}</span>
                <span className="settings-provider-selection-count">{connection.selectedModelIds.length}</span>
              </button>
            ))}
          </div>

          <div className="settings-nav-group">
            <p className="settings-nav-label">Data</p>
            <button
              className={view.section === 'exports' ? 'settings-nav-item active' : 'settings-nav-item'}
              type="button"
              aria-current={view.section === 'exports' ? 'page' : undefined}
              onClick={() => setView({ section: 'exports' })}
            >
              <Download size={15} />
              <span>Exports</span>
            </button>
          </div>
        </nav>

        <footer className="settings-navigation-footer">
          <Database size={14} aria-hidden="true" />
          <span>Configuration is stored locally.</span>
        </footer>
      </aside>

      <main className="settings-content">
        <div className="settings-content-inner">
          {view.section === 'connections' && (
            <ConnectionsSettings connections={connections} onConfigure={openConnectionDialog} />
          )}
          {view.section === 'models' && activeConnection && (
            <ProviderModelsSettings
              connection={activeConnection}
              catalog={catalog}
              onManageConnection={manageActiveConnection}
              onUpdateSelection={onUpdateModelSelection}
            />
          )}
          {view.section === 'exports' && (
            <ExportSettings options={exportOptions} state={exportState} onOptionsChange={onExportOptionsChange} onExport={onExport} />
          )}
        </div>
      </main>

      {dialogTarget && (
        <ConfigureConnectionDialog
          provider={dialogTarget.provider}
          connection={dialogTarget.connection}
          connections={connections}
          onDismiss={closeConnectionDialog}
          onSave={onSaveConnection}
          onTest={onTestConnection}
          onDisconnect={onDisconnectConnection}
        />
      )}
    </section>
  )
}
