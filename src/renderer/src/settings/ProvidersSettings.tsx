import { ChevronRight, Plus } from 'lucide-react'
import { useEffect, useState, type JSX } from 'react'
import { CONNECTION_PROVIDERS, type ConnectionProviderMetadata, type ConnectionSummary } from '../../../shared/connections'
import anthropicIcon from '../../assets/providers/anthropic.png'
import geminiIcon from '../../assets/providers/gemini.png'
import openaiIcon from '../../assets/providers/openai.png'
import openrouterIcon from '../../assets/providers/openrouter.png'

interface ProvidersSettingsProps {
  connections: readonly ConnectionSummary[]
  onConfigure: (provider: ConnectionProviderMetadata, connection?: ConnectionSummary) => void
}

const fallbackProviderIcons: Record<string, JSX.Element> = {
  openrouter: <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm6.605 4.61a8.502 8.502 0 011.93 5.314c-.281-.054-3.101-.629-5.943-.271-.065-.141-.12-.293-.184-.445a25.416 25.416 0 00-.564-1.236c3.145-1.28 4.577-3.124 4.761-3.362zM12 3.475c2.17 0 4.154 1.051 5.662 2.748-.152.216-1.443 1.941-4.48 3.08-1.399-2.57.231-5.88 4.321-7.545-2.119-1.959-6.312-.938-6.78 1.14-.091.37.166 1.076.338 1.63-.575 1.86-1.31 4.169-2.45 5.886-.611 1.062-1.34 2.226-2.13 3.391a10.488 10.488 0 002.172 1.178c3.17 0 6.312-1.47 8.01-3.23.626-.636 1.589-1.476 2.384-2.453a9.615 9.615 0 002.01-3.314c-.173-.125-1.888-1.452-4.13-2.27a10.239 10.239 0 01-4.13-2.27c-.853-.416-1.73-.867-2.525-1.35-.57-.317-1.11-.662-1.61-.92-.49-.258-1.07-.588-1.67-.87-.43-.244-1.01-.555-1.57-.81-.44-.235-.9-.495-1.38-.76-.36-.187-.72-.375-1.08-.56-.36-.185-.7-.363-.99-.52-.43-.242-.83-.498-1.21-.72-.19-.106-.37-.21-.54-.31-.17-.1-.36-.2-.53-.28-.17-.08-.33-.15-.48-.22-.15-.07-.29-.13-.42-.19-.14-.05-.27-.1-.38-.14-.11-.04-.22-.08-.32-.11-.1-.03-.2-.06-.3-.09z"/></svg>,
  openai: <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm6.605 4.61a8.502 8.502 0 011.93 5.314c-.281-.054-3.101-.629-5.943-.271-.065-.141-.12-.293-.184-.445a25.416 25.416 0 00-.564-1.236c3.145-1.28 4.577-3.124 4.761-3.362zM12 3.475c2.17 0 4.154 1.051 5.662 2.748-.152.216-1.443 1.941-4.48 3.08-1.399-2.57.231-5.88 4.321-7.545-2.119-1.959-6.312-.938-6.78 1.14-.091.37.166 1.076.338 1.63-.575 1.86-1.31 4.169-2.45 5.886-.611 1.062-1.34 2.226-2.13 3.391a10.488 10.488 0 002.172 1.178c3.17 0 6.312-1.47 8.01-3.23.626-.636 1.589-1.476 2.384-2.453a9.615 9.615 0 002.01-3.314c-.173-.125-1.888-1.452-4.13-2.27a10.239 10.239 0 01-4.13-2.27c-.853-.416-1.73-.867-2.525-1.35-.57-.317-1.11-.662-1.61-.92-.49-.258-1.07-.588-1.67-.87-.43-.244-1.01-.555-1.57-.81-.44-.235-.9-.495-1.38-.76-.36-.187-.72-.375-1.08-.56-.36-.185-.7-.363-.99-.52-.43-.242-.83-.498-1.21-.72-.19-.106-.37-.21-.54-.31-.17-.1-.36-.2-.53-.28-.17-.08-.33-.15-.48-.22-.15-.07-.29-.13-.42-.19-.14-.05-.27-.1-.38-.14-.11-.04-.22-.08-.32-.11-.1-.03-.2-.06-.3-.09z"/></svg>,
  gemini: <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm6.605 4.61a8.502 8.502 0 011.93 5.314c-.281-.054-3.101-.629-5.943-.271-.065-.141-.12-.293-.184-.445a25.416 25.416 0 00-.564-1.236c3.145-1.28 4.577-3.124 4.761-3.362zM12 3.475c2.17 0 4.154 1.051 5.662 2.748-.152.216-1.443 1.941-4.48 3.08-1.399-2.57.231-5.88 4.321-7.545-2.119-1.959-6.312-.938-6.78 1.14-.091.37.166 1.076.338 1.63-.575 1.86-1.31 4.169-2.45 5.886-.611 1.062-1.34 2.226-2.13 3.391a10.488 10.488 0 002.172 1.178c3.17 0 6.312-1.47 8.01-3.23.626-.636 1.589-1.476 2.384-2.453a9.615 9.615 0 002.01-3.314c-.173-.125-1.888-1.452-4.13-2.27a10.239 10.239 0 01-4.13-2.27c-.853-.416-1.73-.867-2.525-1.35-.57-.317-1.11-.662-1.61-.92-.49-.258-1.07-.588-1.67-.87-.43-.244-1.01-.555-1.57-.81-.44-.235-.9-.495-1.38-.76-.36-.187-.72-.375-1.08-.56-.36-.185-.7-.363-.99-.52-.43-.242-.83-.498-1.21-.72-.19-.106-.37-.21-.54-.31-.17-.1-.36-.2-.53-.28-.17-.08-.33-.15-.48-.22-.15-.07-.29-.13-.42-.19-.14-.05-.27-.1-.38-.14-.11-.04-.22-.08-.32-.11-.1-.03-.2-.06-.3-.09z"/></svg>,
  anthropic: <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm6.605 4.61a8.502 8.502 0 011.93 5.314c-.281-.054-3.101-.629-5.943-.271-.065-.141-.12-.293-.184-.445a25.416 25.416 0 00-.564-1.236c3.145-1.28 4.577-3.124 4.761-3.362zM12 3.475c2.17 0 4.154 1.051 5.662 2.748-.152.216-1.443 1.941-4.48 3.08-1.399-2.57.231-5.88 4.321-7.545-2.119-1.959-6.312-.938-6.78 1.14-.091.37.166 1.076.338 1.63-.575 1.86-1.31 4.169-2.45 5.886-.611 1.062-1.34 2.226-2.13 3.391a10.488 10.488 0 002.172 1.178c3.17 0 6.312-1.47 8.01-3.23.626-.636 1.589-1.476 2.384-2.453a9.615 9.615 0 002.01-3.314c-.173-.125-1.888-1.452-4.13-2.27a10.239 10.239 0 01-4.13-2.27c-.853-.416-1.73-.867-2.525-1.35-.57-.317-1.11-.662-1.61-.92-.49-.258-1.07-.588-1.67-.87-.43-.244-1.01-.555-1.57-.81-.44-.235-.9-.495-1.38-.76-.36-.187-.72-.375-1.08-.56-.36-.185-.7-.363-.99-.52-.43-.242-.83-.498-1.21-.72-.19-.106-.37-.21-.54-.31-.17-.1-.36-.2-.53-.28-.17-.08-.33-.15-.48-.22-.15-.07-.29-.13-.42-.19-.14-.05-.27-.1-.38-.14-.11-.04-.22-.08-.32-.11-.1-.03-.2-.06-.3-.09z"/></svg>,
  'openai-compatible': <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><rect x="3" y="11" width="18" height="2" rx="1" ry="1" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
}

const providerImageIcons: Record<string, string> = {
  openrouter: openrouterIcon,
  openai: openaiIcon,
  gemini: geminiIcon,
  anthropic: anthropicIcon
}

function CustomProviderIcon({ baseUrl }: { baseUrl: string }): JSX.Element {
  const [favicon, setFavicon] = useState<string | undefined>()

  useEffect(() => {
    let active = true
    setFavicon(undefined)
    void window.api.resolveProviderSiteIcon(baseUrl).then((icon) => {
      if (active) setFavicon(icon)
    }).catch(() => {})
    return () => { active = false }
  }, [baseUrl])

  if (!favicon) return fallbackProviderIcons['openai-compatible']

  return <img src={favicon} alt="" />
}

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
                  <span className="settings-provider-icon" aria-hidden="true">
                    {providerImageIcons[provider.kind] ? <img src={providerImageIcons[provider.kind]} alt="" /> : fallbackProviderIcons[provider.kind] ?? provider.kind.toUpperCase()}
                  </span>
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
                  <span className="settings-provider-icon" aria-hidden="true"><CustomProviderIcon baseUrl={connection.baseUrl ?? ''} /></span>
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
