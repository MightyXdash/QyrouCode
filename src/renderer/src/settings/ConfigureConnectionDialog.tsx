import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type JSX, type KeyboardEvent } from 'react'
import { Check, Eye, EyeOff, LoaderCircle, Lock, Unplug, X } from 'lucide-react'
import {
  MAX_CUSTOM_MODELS_PER_CONNECTION,
  MAX_PROVIDER_NAME_LENGTH,
  MAX_SELECTED_MODELS_PER_CONNECTION,
  normalizeConnectionBaseUrl,
  normalizeProviderName,
  validateAvailableModelIds,
  type ConnectionInput,
  type ConnectionProviderMetadata,
  type ConnectionSummary
} from '../../../shared/connections'
import type { SettingsConnectionRequest, SettingsConnectionTestResult } from './settingsTypes'

interface ConfigureConnectionDialogProps {
  provider: ConnectionProviderMetadata
  connection?: ConnectionSummary
  connections: readonly ConnectionSummary[]
  onDismiss: () => void
  onSave: (request: SettingsConnectionRequest) => Promise<void>
  onTest: (request: SettingsConnectionRequest) => Promise<SettingsConnectionTestResult>
  onDisconnect: (connectionId: string) => Promise<void>
}

type DialogOperation = 'idle' | 'testing' | 'saving' | 'disconnecting'

interface DialogTestResult {
  ok: boolean
  message: string
}

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

const parseModelIds = (value: string): string[] => [...new Set(
  value
    .split(/\r?\n/)
    .map((modelId) => modelId.trim())
    .filter(Boolean)
)]

const readableError = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : fallback

export default function ConfigureConnectionDialog({
  provider,
  connection,
  connections,
  onDismiss,
  onSave,
  onTest,
  onDisconnect
}: ConfigureConnectionDialogProps): JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const providerNameId = useId()
  const baseUrlId = useId()
  const apiKeyId = useId()
  const modelIdsId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const initialFocusRef = useRef<HTMLInputElement>(null)
  const [providerName, setProviderName] = useState(connection?.providerName ?? (provider.allowsMultiple ? '' : provider.displayName))
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? provider.defaultBaseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [modelIdsText, setModelIdsText] = useState(connection?.modelIds.join('\n') ?? '')
  const [showApiKey, setShowApiKey] = useState(false)
  const [operation, setOperation] = useState<DialogOperation>('idle')
  const [error, setError] = useState('')
  const [testResult, setTestResult] = useState<DialogTestResult | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const busy = operation !== 'idle'
  const modelIds = useMemo(() => parseModelIds(modelIdsText), [modelIdsText])

  useEffect(() => {
    initialFocusRef.current?.focus()
  }, [])

  const validationError = (): string => {
    if (provider.allowsMultiple && !providerName.trim()) return 'Enter a unique provider name.'
    if (provider.allowsMultiple) {
      const duplicate = connections.some((candidate) =>
        candidate.id !== connection?.id &&
        candidate.kind === provider.kind &&
        normalizeProviderName(candidate.providerName).toLocaleLowerCase() === normalizeProviderName(providerName).toLocaleLowerCase()
      )
      if (duplicate) return 'A provider with this name already exists.'
    }
    if (provider.requiresBaseUrl && !baseUrl.trim()) return 'Enter the provider base URL.'
    if (baseUrl.trim()) {
      try {
        normalizeConnectionBaseUrl(baseUrl)
      } catch (caught) {
        return readableError(caught, 'Enter a valid provider base URL.')
      }
    }
    if (provider.kind !== 'openai-compatible' && !connection?.hasCredential && !apiKey.trim()) return 'Enter an API key.'
    if (provider.supportsCustomModels && modelIds.length === 0) return 'Add at least one model ID.'
    if (provider.supportsCustomModels) {
      try {
        validateAvailableModelIds(modelIds)
      } catch (caught) {
        return readableError(caught, `Add no more than ${MAX_CUSTOM_MODELS_PER_CONNECTION} model IDs.`)
      }
    }
    return ''
  }

  const request = (): SettingsConnectionRequest => {
    const retainedSelection = provider.supportsCustomModels
      ? (connection?.selectedModelIds ?? []).filter((modelId) => modelIds.includes(modelId))
      : connection?.selectedModelIds ?? []
    const input: ConnectionInput = {
      kind: provider.kind,
      apiKey: apiKey.trim(),
      providerName: providerName.trim(),
      baseUrl: baseUrl.trim() || undefined,
      modelIds: provider.supportsCustomModels ? modelIds : [],
      selectedModelIds: retainedSelection
    }
    return {
      connectionId: connection?.id,
      input,
      preserveCredential: Boolean(connection?.hasCredential && !apiKey.trim())
    }
  }

  const runTest = async (): Promise<void> => {
    setError('')
    setTestResult(null)
    const invalid = validationError()
    if (invalid) {
      setError(invalid)
      return
    }
    setOperation('testing')
    try {
      const result: SettingsConnectionTestResult = await onTest(request())
      setTestResult(result.ok ? result : { ok: false, message: result.error })
    } catch (caught) {
      setTestResult({ ok: false, message: readableError(caught, 'The connection test failed.') })
    } finally {
      setOperation('idle')
    }
  }

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setError('')
    const invalid = validationError()
    if (invalid) {
      setError(invalid)
      return
    }
    setOperation('saving')
    try {
      await onSave(request())
      onDismiss()
    } catch (caught) {
      setError(readableError(caught, 'The connection could not be saved.'))
      setOperation('idle')
    }
  }

  const disconnect = async (): Promise<void> => {
    if (!connection) return
    if (!confirmDisconnect) {
      setConfirmDisconnect(true)
      return
    }
    setError('')
    setOperation('disconnecting')
    try {
      await onDisconnect(connection.id)
      onDismiss()
    } catch (caught) {
      setError(readableError(caught, 'The connection could not be disconnected.'))
      setOperation('idle')
      setConfirmDisconnect(false)
    }
  }

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      onDismiss()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
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
    <div
      className="settings-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onDismiss()
      }}
    >
      <section
        className="settings-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="settings-dialog-header">
          <div>
            <p className="settings-eyebrow">{connection ? 'Manage connection' : 'New connection'}</p>
            <h2 id={titleId}>{connection?.providerName || provider.displayName}</h2>
            <p id={descriptionId}>{provider.description}</p>
          </div>
          <button className="settings-icon-button" type="button" aria-label="Close connection settings" disabled={busy} onClick={onDismiss}>
            <X size={16} />
          </button>
        </header>

        <form className="settings-dialog-form" onSubmit={(event) => void save(event)}>
          {provider.allowsMultiple && (
            <label className="settings-field" htmlFor={providerNameId}>
              <span>Provider name</span>
              <small>This unique name appears beneath Models and in the composer.</small>
              <input
                id={providerNameId}
                ref={initialFocusRef}
                value={providerName}
                maxLength={MAX_PROVIDER_NAME_LENGTH}
                autoComplete="off"
                disabled={busy}
                placeholder="e.g. Company gateway"
                onChange={(event) => {
                  setProviderName(event.target.value)
                  setError('')
                  setTestResult(null)
                }}
              />
            </label>
          )}

          {provider.requiresBaseUrl && (
            <label className="settings-field" htmlFor={baseUrlId}>
              <span>Base URL</span>
              <small>Use the root URL for this OpenAI-compatible provider.</small>
              <input
                id={baseUrlId}
                ref={provider.allowsMultiple ? undefined : initialFocusRef}
                value={baseUrl}
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
                placeholder="https://api.example.com/v1"
                onChange={(event) => {
                  setBaseUrl(event.target.value)
                  setError('')
                  setTestResult(null)
                }}
              />
            </label>
          )}

          <label className="settings-field" htmlFor={apiKeyId}>
            <span>API key</span>
              <small>{connection?.hasCredential ? 'Leave blank to keep the securely stored key.' : provider.kind === 'openai-compatible' ? 'Optional when this provider does not require authentication.' : 'The key is passed to the main process and is never displayed again.'}</small>
            <span className="settings-secret-input">
              <Lock size={14} aria-hidden="true" />
              <input
                id={apiKeyId}
                ref={!provider.allowsMultiple && !provider.requiresBaseUrl ? initialFocusRef : undefined}
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                autoCapitalize="none"
                autoComplete="new-password"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
                placeholder={connection?.hasCredential ? 'Stored securely' : 'Paste API key'}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  setError('')
                  setTestResult(null)
                }}
              />
              <button type="button" aria-label={showApiKey ? 'Hide API key' : 'Show API key'} disabled={busy || !apiKey} onClick={() => setShowApiKey((current) => !current)}>
                {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </span>
          </label>

          {provider.supportsCustomModels && (
            <label className="settings-field" htmlFor={modelIdsId}>
              <span className="settings-field-title-row">
                <span>Available model IDs</span>
                <span>{modelIds.length} / {MAX_CUSTOM_MODELS_PER_CONNECTION}</span>
              </span>
              <small>Enter one provider model ID per line. Choose up to {MAX_SELECTED_MODELS_PER_CONNECTION} for the composer after saving.</small>
              <textarea
                id={modelIdsId}
                value={modelIdsText}
                rows={5}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
                placeholder={'vendor/model-one\nvendor/model-two'}
                onChange={(event) => {
                  setModelIdsText(event.target.value)
                  setError('')
                  setTestResult(null)
                }}
              />
            </label>
          )}

          {testResult && (
            <div className={testResult.ok ? 'settings-inline-status success' : 'settings-inline-status error'} role="status">
              {testResult.ok && <Check size={14} aria-hidden="true" />}
              <span>{testResult.message}</span>
            </div>
          )}
          {error && <p className="settings-form-error" role="alert">{error}</p>}

          <footer className="settings-dialog-actions">
            <div>
              {connection && (
                <button className={confirmDisconnect ? 'settings-button danger-confirm' : 'settings-button danger'} type="button" disabled={busy} onClick={() => void disconnect()}>
                  {operation === 'disconnecting' ? <LoaderCircle className="settings-spinner" size={14} /> : <Unplug size={14} />}
                  <span>{confirmDisconnect ? 'Confirm disconnect' : 'Disconnect'}</span>
                </button>
              )}
            </div>
            <div className="settings-dialog-primary-actions">
              <button className="settings-button" type="button" disabled={busy} onClick={() => void runTest()}>
                {operation === 'testing' && <LoaderCircle className="settings-spinner" size={14} />}
                <span>{operation === 'testing' ? 'Testing…' : 'Test connection'}</span>
              </button>
              <button className="settings-button primary" type="submit" disabled={busy}>
                {operation === 'saving' && <LoaderCircle className="settings-spinner" size={14} />}
                <span>{operation === 'saving' ? 'Saving…' : 'Save'}</span>
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  )
}
