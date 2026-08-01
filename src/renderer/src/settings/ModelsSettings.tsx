import { Search } from 'lucide-react'
import { useEffect, useMemo, useState, type JSX } from 'react'
import { MAX_SELECTED_MODELS_PER_CONNECTION, type ConnectionSummary } from '../../../shared/connections'
import { sortRemoteModels } from '../../../shared/remoteModels'
import { SettingsSwitch } from './SettingsControls'
import type { RemoteCatalogState } from './settingsTypes'

interface ModelsSettingsProps {
  connection?: ConnectionSummary
  catalog?: RemoteCatalogState
  onManageConnection: (connection: ConnectionSummary) => void
  onUpdateSelection: (connectionId: string, selectedModelIds: readonly string[]) => Promise<void> | void
  onRefreshCatalog: (connectionId: string) => Promise<void> | void
}

interface ModelItem {
  id: string
  name: string
  publisher: string
  subtitle: string
  search: string
}

const contextLabel = (tokens: number): string => tokens >= 1_000_000
  ? `${Number((tokens / 1_000_000).toFixed(1))}M context`
  : `${Math.round(tokens / 1_000)}K context`

const readableError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Could not update models.'

export default function ModelsSettings({ connection, catalog, onManageConnection, onUpdateSelection, onRefreshCatalog }: ModelsSettingsProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>(connection ? [...connection.selectedModelIds] : [])
  const [saving, setSaving] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setSelected(connection ? [...connection.selectedModelIds] : [])
    setQuery('')
    setError('')
  }, [connection?.id, connection?.selectedModelIds])

  const models = useMemo<ModelItem[]>(() => {
    if (!connection) return []
    if (connection.kind === 'openai-compatible') {
      return connection.modelIds.map((id) => ({ id, name: id.split('/').at(-1) ?? id, publisher: connection.providerName, subtitle: id, search: id }))
    }
    return sortRemoteModels([...(catalog?.models ?? [])]).map((model) => {
      const capabilities = [contextLabel(model.contextWindow)]
      if (model.inputModalities.includes('image')) capabilities.push('Vision')
      if (model.supportsTools) capabilities.push('Tools')
      return {
        id: model.id,
        name: model.displayName,
        publisher: model.publisher,
        subtitle: `${model.publisher} · ${capabilities.join(' · ')}`,
        search: `${model.id} ${model.displayName} ${model.publisher}`
      }
    })
  }, [catalog, connection])

  const visibleModels = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? models.filter((model) => model.search.toLowerCase().includes(normalized)) : models
  }, [models, query])

  const groups = useMemo(() => {
    const grouped = new Map<string, ModelItem[]>()
    visibleModels.forEach((model) => grouped.set(model.publisher, [...(grouped.get(model.publisher) ?? []), model]))
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [visibleModels])

  const toggle = async (modelId: string, checked: boolean): Promise<void> => {
    if (!connection) return
    if (checked && selected.length >= MAX_SELECTED_MODELS_PER_CONNECTION) {
      setError(`You can enable up to ${MAX_SELECTED_MODELS_PER_CONNECTION} models for ${connection.providerName}.`)
      return
    }
    const previous = selected
    const next = checked ? [...previous, modelId] : previous.filter((id) => id !== modelId)
    setSelected(next)
    setSaving(modelId)
    setError('')
    try {
      await onUpdateSelection(connection.id, next)
    } catch (caught) {
      setSelected(previous)
      setError(readableError(caught))
    } finally {
      setSaving('')
    }
  }

  const catalogLoading = connection !== undefined && connection.kind !== 'openai-compatible' && !catalog?.models && !catalog?.error

  return (
    <>
      <div className="settings-tab-header settings-models-header">
        <div><h2>Models</h2>{connection && <span>{connection.providerName}</span>}</div>
        {connection && <button className="settings-text-button" type="button" onClick={() => onManageConnection(connection)}>Manage connection</button>}
      </div>
      <div className="settings-tab-body">
        {!connection ? (
          <div className="settings-empty-panel"><strong>No provider connected</strong><span>Connect a provider, then choose which models appear in the composer.</span></div>
        ) : catalogLoading ? (
          <div className="settings-empty-panel"><strong>Loading models…</strong><span>Fetching the available models from {connection.providerName}.</span></div>
        ) : catalog?.error ? (
          <div className="settings-empty-panel">
            <strong>Could not load models</strong>
            <span>{catalog.error}</span>
            <button className="settings-text-button" type="button" onClick={() => void onRefreshCatalog(connection.id)}>Retry</button>
          </div>
        ) : (
          <>
            <div className="settings-model-toolbar">
              <label><Search size={14} /><input type="search" value={query} placeholder="Search models" onChange={(event) => setQuery(event.target.value)} /></label>
              <span>{selected.length} / {MAX_SELECTED_MODELS_PER_CONNECTION}</span>
            </div>
            {error && <div className="settings-inline-error" role="alert">{error}</div>}
            {visibleModels.length === 0 ? <div className="settings-list settings-empty-row">No matching models</div> : (
              <div className="settings-model-groups">
                {groups.map(([publisher, publisherModels]) => (
                  <section className="settings-model-provider-group" key={publisher}>
                    <h3>{publisher}</h3>
                    <div className="settings-list settings-model-list">
                      {publisherModels.map((model) => {
                        const checked = selected.includes(model.id)
                        return (
                          <div className="settings-model-row" key={model.id}>
                            <div><strong>{model.name}</strong><span>{model.subtitle}</span></div>
                            <SettingsSwitch
                              checked={checked}
                              label={`${checked ? 'Disable' : 'Enable'} ${model.name}`}
                              disabled={Boolean(saving) || (!checked && selected.length >= MAX_SELECTED_MODELS_PER_CONNECTION)}
                              onChange={(next) => void toggle(model.id, next)}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
