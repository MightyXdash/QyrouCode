import { ChevronRight, Plus } from 'lucide-react'
import type { JSX } from 'react'
import { CONNECTION_PROVIDERS, type ConnectionProviderMetadata, type ConnectionSummary } from '../../../shared/connections'

interface ProvidersSettingsProps {
  connections: readonly ConnectionSummary[]
  onConfigure: (provider: ConnectionProviderMetadata, connection?: ConnectionSummary) => void
}

const providerInitials = (name: string): string => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()

export default function ProvidersSettings({ connections, onConfigure }: ProvidersSettingsProps): JSX.Element {
  const customProvider = CONNECTION_PROVIDERS.find((provider) => provider.kind === 'openai-compatible')
  const builtInProviders = CONNECTION_PROVIDERS.filter((provider) => !provider.allowsMultiple)
  const customConnections = connections.filter((connection) => connection.kind === 'openai-compatible')

  return (
    <>
      <div className="settings-tab-header"><h2>Providers</h2></div>
      <div className="settings-tab-body">
        <section className="settings-group">
          <h3>Connections</h3>
          <div className="settings-list settings-provider-list">
            {builtInProviders.map((provider) => {
              const connection = connections.find((item) => item.kind === provider.kind)
              return (
                <button className="settings-provider-row" type="button" key={provider.kind} onClick={() => onConfigure(provider, connection)}>
                  <span className="settings-provider-icon" aria-hidden="true">{providerInitials(provider.displayName)}</span>
                  <span className="settings-provider-copy">
                    <strong>{provider.displayName}</strong>
                    <span>{connection ? `${connection.selectedModelIds.length} models enabled` : provider.description}</span>
                  </span>
                  <span className={connection ? 'settings-provider-status connected' : 'settings-provider-status'}>{connection ? 'Connected' : 'Connect'}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              )
            })}
          </div>
        </section>

        {customProvider && (
          <section className="settings-group">
            <div className="settings-group-heading">
              <h3>OpenAI compatible</h3>
              <button className="settings-text-button" type="button" onClick={() => onConfigure(customProvider)}><Plus size={13} />Add</button>
            </div>
            <div className="settings-list settings-provider-list">
              {customConnections.length === 0 ? (
                <button className="settings-empty-row" type="button" onClick={() => onConfigure(customProvider)}>
                  Add a provider with its own endpoint and model IDs
                </button>
              ) : customConnections.map((connection) => (
                <button className="settings-provider-row" type="button" key={connection.id} onClick={() => onConfigure(customProvider, connection)}>
                  <span className="settings-provider-icon" aria-hidden="true">{providerInitials(connection.providerName)}</span>
                  <span className="settings-provider-copy">
                    <strong>{connection.providerName}</strong>
                    <span>{connection.baseUrl}</span>
                  </span>
                  <span className="settings-provider-status connected">Connected</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  )
}
