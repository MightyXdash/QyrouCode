import { useMemo, useState, type FormEvent, type JSX } from 'react'
import { Eye, EyeOff, LoaderCircle, X } from 'lucide-react'
import {
  MAX_CUSTOM_MODELS_PER_CONNECTION,
  MAX_PROVIDER_NAME_LENGTH,
  normalizeConnectionBaseUrl,
  normalizeProviderName,
  validateAvailableModelIds,
  type ConnectionInput,
  type ConnectionProviderMetadata,
  type ConnectionSummary
} from '../../../shared/connections'
import type { SettingsConnectionRequest, SettingsConnectionTestResult } from './settingsTypes'

interface ConnectionEditorProps {
  provider: ConnectionProviderMetadata
  connection?: ConnectionSummary
  connections: readonly ConnectionSummary[]
  onClose: () => void
  onSave: (request: SettingsConnectionRequest) => Promise<void>
  onTest: (request: SettingsConnectionRequest) => Promise<SettingsConnectionTestResult>
  onDisconnect: (connectionId: string) => Promise<void>
}

type Operation = 'idle' | 'test' | 'save' | 'disconnect'

const parseModelIds = (value: string): string[] => [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
const readableError = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : fallback

export default function ConnectionEditor({ provider, connection, connections, onClose, onSave, onTest, onDisconnect }: ConnectionEditorProps): JSX.Element {
  const [providerName, setProviderName] = useState(connection?.providerName ?? (provider.allowsMultiple ? '' : provider.displayName))
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? provider.defaultBaseUrl)
  const [apiKey, setApiKey] = useState('')
  const [modelIdsText, setModelIdsText] = useState(connection?.modelIds.join('\n') ?? '')
  const [showKey, setShowKey] = useState(false)
  const [operation, setOperation] = useState<Operation>('idle')
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const modelIds = useMemo(() => parseModelIds(modelIdsText), [modelIdsText])
  const busy = operation !== 'idle'

  const validationError = (): string => {
    if (provider.allowsMultiple && !providerName.trim()) return 'Enter a unique provider name.'
    if (provider.allowsMultiple) {
      const normalizedName = normalizeProviderName(providerName).toLowerCase()
      if (connections.some((item) => item.id !== connection?.id && item.kind === provider.kind && normalizeProviderName(item.providerName).toLowerCase() === normalizedName)) {
        return 'A provider with this name already exists.'
      }
    }
    if (provider.requiresBaseUrl && !baseUrl.trim()) return 'Enter a base URL.'
    if (baseUrl.trim()) {
      try { normalizeConnectionBaseUrl(baseUrl) } catch (caught) { return readableError(caught, 'Enter a valid base URL.') }
    }
    if (!connection?.hasCredential && !apiKey.trim() && provider.kind !== 'openai-compatible') return 'Enter an API key.'
    if (provider.supportsCustomModels) {
      try { validateAvailableModelIds(modelIds) } catch (caught) { return readableError(caught, `Add no more than ${MAX_CUSTOM_MODELS_PER_CONNECTION} model IDs.`) }
      if (modelIds.length === 0) return 'Add at least one model ID.'
    }
    return ''
  }

  const request = (): SettingsConnectionRequest => {
    const selectedModelIds = provider.supportsCustomModels
      ? (connection?.selectedModelIds ?? []).filter((modelId) => modelIds.includes(modelId))
      : connection?.selectedModelIds ?? []
    const input: ConnectionInput = {
      kind: provider.kind,
      apiKey: apiKey.trim(),
      providerName: providerName.trim(),
      baseUrl: baseUrl.trim() || undefined,
      modelIds: provider.supportsCustomModels ? modelIds : [],
      selectedModelIds
    }
    return { connectionId: connection?.id, input, preserveCredential: Boolean(connection?.hasCredential && !apiKey.trim()) }
  }

  const validate = (): boolean => {
    const message = validationError()
    setError(message)
    setResult('')
    return !message
  }

  const test = async (): Promise<void> => {
    if (!validate()) return
    setOperation('test')
    try {
      const response = await onTest(request())
      if (response.ok) setResult(response.message)
      else setError(response.error)
    } catch (caught) {
      setError(readableError(caught, 'Connection test failed.'))
    } finally {
      setOperation('idle')
    }
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!validate()) return
    setOperation('save')
    try {
      await onSave(request())
      onClose()
    } catch (caught) {
      setError(readableError(caught, 'Connection could not be saved.'))
      setOperation('idle')
    }
  }

  const disconnect = async (): Promise<void> => {
    if (!connection) return
    if (!confirmDisconnect) {
      setConfirmDisconnect(true)
      return
    }
    setOperation('disconnect')
    try {
      await onDisconnect(connection.id)
      onClose()
    } catch (caught) {
      setError(readableError(caught, 'Connection could not be removed.'))
      setOperation('idle')
    }
  }

  return (
    <div className="settings-subdialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="settings-subdialog" role="dialog" aria-modal="true" aria-labelledby="connection-editor-title">
        <header>
          <div><h2 id="connection-editor-title">{connection?.providerName ?? provider.displayName}</h2><p>{connection ? 'Update connection' : 'New connection'}</p></div>
          {!provider.allowsMultiple && <button className="settings-icon-button" type="button" aria-label="Close" disabled={busy} onClick={onClose}><X size={15} /></button>}
        </header>
        <form onSubmit={(event) => void save(event)}>
          {provider.allowsMultiple && (
            <label><span>Provider name</span><input autoFocus value={providerName} maxLength={MAX_PROVIDER_NAME_LENGTH} disabled={busy} placeholder="Company gateway" onChange={(event) => setProviderName(event.target.value)} /></label>
          )}
          {provider.requiresBaseUrl && (
            <label><span>Base URL</span><input autoFocus={!provider.allowsMultiple} value={baseUrl} disabled={busy} placeholder="https://api.example.com/v1" onChange={(event) => setBaseUrl(event.target.value)} /></label>
          )}
          <label>
            <span>API key</span>
            <div className="settings-secret-field">
              <input autoFocus={!provider.allowsMultiple && !provider.requiresBaseUrl} value={apiKey} type={showKey ? 'text' : 'password'} disabled={busy} placeholder={connection?.hasCredential ? 'Stored key' : 'Paste API key'} onChange={(event) => setApiKey(event.target.value)} />
              <button type="button" aria-label={showKey ? 'Hide key' : 'Show key'} onClick={() => setShowKey((current) => !current)}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            </div>
          </label>
          {provider.supportsCustomModels && (
            <label><span>Model IDs <small>one per line</small></span><textarea rows={5} value={modelIdsText} disabled={busy} placeholder="provider/model-name" onChange={(event) => setModelIdsText(event.target.value)} /></label>
          )}
          <div className="settings-form-message" aria-live="polite">{error ? <span className="error">{error}</span> : result}</div>
          <footer>
            <div>{connection && <button className="danger" type="button" disabled={busy} onClick={() => void disconnect()}>{confirmDisconnect ? 'Confirm remove' : 'Remove'}</button>}</div>
            <div>
              {provider.allowsMultiple && <button type="button" disabled={busy} onClick={onClose}>Cancel</button>}
              <button type="button" disabled={busy} onClick={() => void test()}>{operation === 'test' ? <LoaderCircle className="settings-spinner" size={13} /> : null}Test</button>
              <button className="primary" type="submit" disabled={busy}>{operation === 'save' ? 'Saving…' : 'Save'}</button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  )
}
