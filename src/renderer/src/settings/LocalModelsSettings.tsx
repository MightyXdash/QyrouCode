import { Check, Download, Search, X } from 'lucide-react'
import { useMemo, useState, type JSX } from 'react'
import type { CatalogModel } from '../modelCatalog'
import type { LocalModelDownloadState } from './settingsTypes'

interface LocalModelsSettingsProps {
  catalog: readonly CatalogModel[]
  downloadedModelIds: ReadonlySet<string>
  downloads: Readonly<Record<string, LocalModelDownloadState>>
  onDownload: (model: CatalogModel) => Promise<void>
  onCancel: (model: CatalogModel) => Promise<void> | void
}

const formatBytes = (bytes: number): string => {
  if (bytes <= 0) return 'Preparing…'
  const gibibytes = bytes / 1024 / 1024 / 1024
  return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GB`
}

export default function LocalModelsSettings({ catalog, downloadedModelIds, downloads, onDownload, onCancel }: LocalModelsSettingsProps): JSX.Element {
  const [query, setQuery] = useState('')
  const visibleModels = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return catalog
    return catalog.filter((model) => `${model.name} ${model.base_model} ${model.developer} ${model.parameters}`.toLowerCase().includes(normalized))
  }, [catalog, query])

  return (
    <>
      <div className="settings-tab-header"><h2>Local models</h2></div>
      <div className="settings-tab-body">
        <div className="settings-model-toolbar">
          <label><Search size={14} /><input type="search" value={query} placeholder="Search Hugging Face models" onChange={(event) => setQuery(event.target.value)} /></label>
          <span>{downloadedModelIds.size} installed</span>
        </div>
        <div className="settings-list settings-local-model-list">
          {visibleModels.map((model) => {
            const downloaded = downloadedModelIds.has(model.id)
            const download = downloads[model.hf_repo]
            const progress = download?.total ? Math.min(100, Math.round((download.downloaded / download.total) * 100)) : 0
            return (
              <div className="settings-local-model-row" key={model.id}>
                <div className="settings-local-model-copy">
                  <div><strong>{model.base_model}</strong>{model.vision && <span className="settings-badge">Vision</span>}</div>
                  <span>{model.parameters} · {model.quantization} · {model.recommended_vram_gb} GB recommended · {model.hf_repo}</span>
                  {download && !download.error && (
                    <div className="settings-download-progress"><span style={{ width: `${progress}%` }} /><small>{progress}% · {formatBytes(download.downloaded)} / {formatBytes(download.total)}</small></div>
                  )}
                  {download?.error && <small className="error">{download.error}</small>}
                </div>
                {downloaded ? (
                  <span className="settings-ready"><Check size={13} />Ready</span>
                ) : download && !download.error ? (
                  <button className="settings-icon-button" type="button" aria-label={`Cancel ${model.name} download`} onClick={() => void onCancel(model)}><X size={14} /></button>
                ) : (
                  <button type="button" onClick={() => void onDownload(model)}><Download size={13} />{download?.error ? 'Retry' : 'Download'}</button>
                )}
              </div>
            )
          })}
        </div>
        <p className="settings-footnote">Downloads are stored in the local Hugging Face cache. Finished models appear in the composer automatically.</p>
      </div>
    </>
  )
}
