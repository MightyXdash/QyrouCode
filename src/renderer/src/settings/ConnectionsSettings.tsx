import { ChevronRight, KeyRound, Lock, Plus, Server, ShieldCheck } from 'lucide-react'
import type { JSX } from 'react'
import {
  CONNECTION_PROVIDERS,
  MAX_SELECTED_MODELS_PER_CONNECTION,
  type ConnectionProviderMetadata,
  type ConnectionSummary
} from '../../../shared/connections'

interface ConnectionsSettingsProps {
  connections: readonly ConnectionSummary[]
  onConfigure: (provider: ConnectionProviderMetadata, connection?: ConnectionSummary) => void
}

export default function ConnectionsSettings({ connections, onConfigure }: ConnectionsSettingsProps): JSX.Element {
  const compatibleConnections = connections.filter((connection) => connection.kind === 'openai-compatible')

  return (
    <div className="settings-panel settings-connections-panel">
      <header className="settings-panel-header">
        <p className="settings-eyebrow">Connections</p>
        <h2>Bring your own models</h2>
        <p>Connect providers locally, then choose exactly which models appear in the composer.</p>
      </header>

      <section className="settings-section" aria-labelledby="connection-services-title">
        <div className="settings-section-heading">
          <div>
            <h3 id="connection-services-title">Services</h3>
            <p>Credentials stay outside the renderer and are never shown after saving.</p>
          </div>
        </div>
        <div className="settings-card-grid">
          {CONNECTION_PROVIDERS.map((provider) => {
            const connection = provider.allowsMultiple
              ? undefined
              : connections.find((candidate) => candidate.kind === provider.kind)
            const compatibleCount = provider.allowsMultiple ? compatibleConnections.length : 0
            const connected = Boolean(connection)
            return (
              <article className="settings-connection-card" key={provider.kind}>
                <div className="settings-connection-card-icon" aria-hidden="true">
                  {provider.allowsMultiple ? <Server size={18} /> : <KeyRound size={18} />}
                </div>
                <div className="settings-connection-card-copy">
                  <div className="settings-connection-card-title-row">
                    <h4>{provider.displayName}</h4>
                    <span className={connected || compatibleCount > 0 ? 'settings-status connected' : 'settings-status'}>
                      <span aria-hidden="true" />
                      {provider.allowsMultiple
                        ? `${compatibleCount} configured`
                        : connected ? 'Connected' : 'Not connected'}
                    </span>
                  </div>
                  <p>{provider.description}</p>
                  {connection && (
                    <span className="settings-card-detail">
                      {connection.selectedModelIds.length} model{connection.selectedModelIds.length === 1 ? '' : 's'} in composer
                    </span>
                  )}
                </div>
                <button
                  className="settings-card-action"
                  type="button"
                  aria-label={provider.allowsMultiple ? `Add ${provider.displayName} provider` : `${connection ? 'Manage' : 'Connect'} ${provider.displayName}`}
                  onClick={() => onConfigure(provider, connection)}
                >
                  {provider.allowsMultiple ? <Plus size={15} /> : <ChevronRight size={15} />}
                  <span>{provider.allowsMultiple ? 'Add provider' : connection ? 'Manage' : 'Connect'}</span>
                </button>
              </article>
            )
          })}
        </div>
      </section>

      {compatibleConnections.length > 0 && (
        <section className="settings-section" aria-labelledby="compatible-providers-title">
          <div className="settings-section-heading">
            <div>
              <h3 id="compatible-providers-title">OpenAI-compatible providers</h3>
              <p>Each instance is a distinct provider with its own endpoint and models.</p>
            </div>
          </div>
          <div className="settings-compact-list">
            {compatibleConnections.map((connection) => {
              const provider = CONNECTION_PROVIDERS.find((candidate) => candidate.kind === connection.kind)
              if (!provider) return null
              return (
                <button className="settings-compatible-row" type="button" key={connection.id} onClick={() => onConfigure(provider, connection)}>
                  <span className="settings-compatible-row-icon" aria-hidden="true"><Server size={15} /></span>
                  <span className="settings-compatible-row-copy">
                    <strong>{connection.providerName}</strong>
                    <span>{connection.baseUrl}</span>
                  </span>
                  <span className="settings-compatible-row-meta">{connection.selectedModelIds.length} / {MAX_SELECTED_MODELS_PER_CONNECTION} selected</span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              )
            })}
          </div>
        </section>
      )}

      <aside className="settings-security-note">
        <span aria-hidden="true"><Lock size={16} /></span>
        <div>
          <strong>Credential boundary</strong>
          <p>SupraCode only asks this page for connection metadata. Secret storage, request authentication, and key redaction remain in the main process.</p>
        </div>
        <ShieldCheck size={18} aria-hidden="true" />
      </aside>
    </div>
  )
}
