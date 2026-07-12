import { useEffect, useMemo, useState, type JSX } from 'react'
import { Check, Image, LoaderCircle, Lock, Search, Settings, Wrench } from 'lucide-react'
import {
  MAX_SELECTED_MODELS_PER_CONNECTION,
  type ConnectionSummary
} from '../../../shared/connections'
import {
  shouldRetainRawReasoning,
  sortRemoteModels,
  type RemoteModel
} from '../../../shared/remoteModels'

interface ProviderModelsSettingsProps {
  connection: ConnectionSummary
  catalog: readonly RemoteModel[]
  onManageConnection: () => void
  onUpdateSelection: (connectionId: string, selectedModelIds: readonly string[]) => Promise<void> | void
}

interface ModelListItem {
  id: string
  providerModelId: string
  displayName: string
  publisher: string
  remote?: RemoteModel
}

interface ModelGroup {
  publisher: string
  models: ModelListItem[]
}

const formatContextWindow = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M context`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K context`
  return `${tokens.toLocaleString()} context`
}

const modalityLabel = (modalities: readonly string[]): string =>
  modalities.map((modality) => modality[0].toUpperCase() + modality.slice(1)).join(' + ')

const readableError = (error: unknown): string =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'The model selection could not be saved.'

export default function ProviderModelsSettings({
  connection,
  catalog,
  onManageConnection,
  onUpdateSelection
}: ProviderModelsSettingsProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([...connection.selectedModelIds])
  const [savingModelId, setSavingModelId] = useState('')
  const [selectionError, setSelectionError] = useState('')

  useEffect(() => {
    setSelectedModelIds([...connection.selectedModelIds])
    setQuery('')
    setSelectionError('')
  }, [connection.id, connection.selectedModelIds])

  const models = useMemo<ModelListItem[]>(() => {
    if (connection.kind === 'openai-compatible') {
      return connection.modelIds.map((modelId) => ({
        id: modelId,
        providerModelId: modelId,
        displayName: modelId.split('/').at(-1) ?? modelId,
        publisher: connection.providerName
      }))
    }
    return sortRemoteModels(catalog.filter((model) => model.availableOn.some((availableKind) => availableKind === connection.kind))).map((model) => ({
      id: model.id,
      providerModelId: model.providerModelIds[connection.kind === 'openai-compatible' ? 'openrouter' : connection.kind] ?? model.id,
      displayName: model.displayName,
      publisher: model.publisher,
      remote: model
    }))
  }, [catalog, connection.kind, connection.modelIds, connection.providerName])

  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return models
    return models.filter((model) =>
      `${model.displayName} ${model.id} ${model.providerModelId} ${model.publisher}`.toLocaleLowerCase().includes(normalizedQuery)
    )
  }, [models, query])

  const groups = useMemo<ModelGroup[]>(() => {
    if (connection.kind !== 'openrouter') return [{ publisher: connection.providerName, models: filteredModels }]
    const grouped = new Map<string, ModelListItem[]>()
    filteredModels.forEach((model) => grouped.set(model.publisher, [...(grouped.get(model.publisher) ?? []), model]))
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([publisher, groupedModels]) => ({ publisher, models: groupedModels }))
  }, [connection.kind, connection.providerName, filteredModels])

  const limitReached = selectedModelIds.length >= MAX_SELECTED_MODELS_PER_CONNECTION

  const toggleModel = async (modelId: string): Promise<void> => {
    const selected = selectedModelIds.includes(modelId)
    if (!selected && limitReached) {
      setSelectionError(`Choose up to ${MAX_SELECTED_MODELS_PER_CONNECTION} models from ${connection.providerName}.`)
      return
    }
    const previous = selectedModelIds
    const next = selected ? previous.filter((candidate) => candidate !== modelId) : [...previous, modelId]
    setSelectedModelIds(next)
    setSavingModelId(modelId)
    setSelectionError('')
    try {
      await onUpdateSelection(connection.id, next)
    } catch (error) {
      setSelectedModelIds(previous)
      setSelectionError(readableError(error))
    } finally {
      setSavingModelId('')
    }
  }

  return (
    <div className="settings-panel settings-models-panel">
      <header className="settings-panel-header settings-models-header">
        <div>
          <p className="settings-eyebrow">Models</p>
          <h2>{connection.providerName}</h2>
          <p>Choose the models that should be easy to reach from the composer.</p>
        </div>
        <button className="settings-button" type="button" onClick={onManageConnection}>
          <Settings size={14} />
          <span>Manage connection</span>
        </button>
      </header>

      <div className="settings-model-toolbar">
        <label className="settings-search-field">
          <Search size={15} aria-hidden="true" />
          <span className="settings-visually-hidden">Search {connection.providerName} models</span>
          <input value={query} type="search" placeholder="Search models" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className={limitReached ? 'settings-selection-count at-limit' : 'settings-selection-count'} aria-live="polite">
          <strong>{selectedModelIds.length}</strong>
          <span> / {MAX_SELECTED_MODELS_PER_CONNECTION} selected</span>
        </div>
      </div>

      {selectionError && <p className="settings-form-error settings-model-error" role="alert">{selectionError}</p>}

      {models.length === 0 ? (
        <div className="settings-empty-state">
          <h3>No models configured</h3>
          <p>{connection.kind === 'openai-compatible' ? 'Manage this connection to add model IDs.' : 'No supported models are available for this provider yet.'}</p>
          {connection.kind === 'openai-compatible' && <button className="settings-button" type="button" onClick={onManageConnection}>Add model IDs</button>}
        </div>
      ) : filteredModels.length === 0 ? (
        <div className="settings-empty-state compact">
          <h3>No matching models</h3>
          <p>Try another model name, ID, or publisher.</p>
        </div>
      ) : (
        <div className="settings-model-groups">
          {groups.map((group) => (
            <section className="settings-model-group" aria-labelledby={`model-publisher-${connection.id}-${group.publisher}`} key={group.publisher}>
              <div className="settings-model-group-heading">
                <h3 id={`model-publisher-${connection.id}-${group.publisher}`}>{group.publisher}</h3>
                <span>{group.models.length} model{group.models.length === 1 ? '' : 's'}</span>
              </div>
              <div className="settings-model-list">
                {group.models.map((model) => {
                  const selected = selectedModelIds.includes(model.id)
                  const disabled = Boolean(savingModelId) || (!selected && limitReached)
                  const nativeReasoning = Boolean(model.remote?.reasoning.nativeEfforts.length)
                  return (
                    <label className={selected ? 'settings-model-row selected' : disabled ? 'settings-model-row disabled' : 'settings-model-row'} key={model.id}>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={disabled}
                        aria-describedby={`model-detail-${connection.id}-${model.id}`}
                        onChange={() => void toggleModel(model.id)}
                      />
                      <span className="settings-model-checkbox" aria-hidden="true">
                        {savingModelId === model.id ? <LoaderCircle className="settings-spinner" size={12} /> : selected && <Check size={11} />}
                      </span>
                      <span className="settings-model-copy">
                        <span className="settings-model-title-row">
                          <strong>{model.displayName}</strong>
                          <code>{model.providerModelId}</code>
                        </span>
                        <span className="settings-model-badges" id={`model-detail-${connection.id}-${model.id}`}>
                          {model.remote ? (
                            <>
                              <span>{formatContextWindow(model.remote.contextWindow)}</span>
                              <span className={model.remote.inputModalities.includes('image') ? 'capability' : ''}>
                                {model.remote.inputModalities.includes('image') && <Image size={11} aria-hidden="true" />}
                                Input: {modalityLabel(model.remote.inputModalities)}
                              </span>
                              <span>Output: {modalityLabel(model.remote.outputModalities)}</span>
                              {model.remote.supportsTools && <span className="capability"><Wrench size={11} aria-hidden="true" />Tools</span>}
                              <span className={nativeReasoning ? 'reasoning-native' : 'reasoning-prompt'}>
                                {model.remote.reasoning.mandatory ? 'Reasoning always on' : nativeReasoning ? 'Native effort control' : 'Prompt-mapped effort'}
                              </span>
                              <span className={shouldRetainRawReasoning(model.remote) ? 'privacy-retained' : 'privacy-private'}>
                                <Lock size={11} aria-hidden="true" />
                                {shouldRetainRawReasoning(model.remote) ? 'Raw reasoning retained locally' : 'Private reasoning discarded'}
                              </span>
                            </>
                          ) : (
                            <>
                              <span>Custom model ID</span>
                              <span className="reasoning-prompt">Provider-defined capabilities</span>
                              <span className="privacy-private"><Lock size={11} aria-hidden="true" />Privacy policy enforced at runtime</span>
                            </>
                          )}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
