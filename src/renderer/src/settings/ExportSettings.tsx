import { Check, Download, FileJson, LoaderCircle, Lock, ShieldCheck } from 'lucide-react'
import type { JSX } from 'react'
import type {
  SettingsAttachmentMode,
  SettingsExportFormat,
  SettingsExportOptions,
  SettingsExportScope,
  SettingsExportState
} from './settingsTypes'

interface ExportSettingsProps {
  options: SettingsExportOptions
  state: SettingsExportState
  onOptionsChange: (options: SettingsExportOptions) => void
  onExport: (options: SettingsExportOptions) => Promise<void>
}

interface ExportToggleProps {
  checked: boolean
  title: string
  description: string
  onChange: (checked: boolean) => void
}

const scopeOptions: readonly { value: SettingsExportScope; title: string; description: string }[] = [
  { value: 'thread', title: 'Current thread', description: 'Export only the conversation that is open.' },
  { value: 'project', title: 'Current project', description: 'Export every saved thread in the active project.' },
  { value: 'all', title: 'All threads', description: 'Export every conversation stored by SupraCode.' }
]

const formatOptions: readonly { value: SettingsExportFormat; title: string; description: string }[] = [
  { value: 'jsonl', title: 'HF / OpenAI JSONL', description: 'One compatible training or inspection record per line.' },
  { value: 'json', title: 'JSON bundle', description: 'One structured file with conversations and metadata.' }
]

const attachmentOptions: readonly { value: SettingsAttachmentMode; label: string }[] = [
  { value: 'none', label: 'Exclude attachments' },
  { value: 'metadata', label: 'Metadata only' },
  { value: 'embedded', label: 'Embed image data' }
]

function ExportToggle({ checked, title, description, onChange }: ExportToggleProps): JSX.Element {
  return (
    <label className="settings-toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="settings-toggle" aria-hidden="true"><span /></span>
    </label>
  )
}

export default function ExportSettings({ options, state, onOptionsChange, onExport }: ExportSettingsProps): JSX.Element {
  const update = <Key extends keyof SettingsExportOptions>(key: Key, value: SettingsExportOptions[Key]): void => {
    onOptionsChange({ ...options, [key]: value })
  }

  const scopeDetail = state.preview?.threadCount

  return (
    <div className="settings-panel settings-export-panel">
      <header className="settings-panel-header">
        <p className="settings-eyebrow">Data</p>
        <h2>Export conversations</h2>
        <p>Create a portable dataset with explicit controls for tools, attachments, and eligible reasoning.</p>
      </header>

      <section className="settings-section" aria-labelledby="export-scope-title">
        <div className="settings-section-heading">
          <div>
            <h3 id="export-scope-title">Scope</h3>
            <p>Choose how much saved conversation history to include.</p>
          </div>
          {scopeDetail !== undefined && <span className="settings-section-count">{scopeDetail} thread{scopeDetail === 1 ? '' : 's'}</span>}
        </div>
        <div className="settings-choice-grid three-columns" role="radiogroup" aria-label="Export scope">
          {scopeOptions.map((scope) => (
            <label className={options.scope === scope.value ? 'settings-choice-card selected' : 'settings-choice-card'} key={scope.value}>
              <input type="radio" name="export-scope" value={scope.value} checked={options.scope === scope.value} onChange={() => update('scope', scope.value)} />
              <span className="settings-choice-indicator" aria-hidden="true">{options.scope === scope.value && <Check size={11} />}</span>
              <span><strong>{scope.title}</strong><small>{scope.description}</small></span>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="export-format-title">
        <div className="settings-section-heading">
          <div>
            <h3 id="export-format-title">Format</h3>
            <p>Both formats preserve OpenAI-style roles and function tool calls.</p>
          </div>
        </div>
        <div className="settings-choice-grid" role="radiogroup" aria-label="Export format">
          {formatOptions.map((format) => (
            <label className={options.format === format.value ? 'settings-choice-card selected' : 'settings-choice-card'} key={format.value}>
              <input type="radio" name="export-format" value={format.value} checked={options.format === format.value} onChange={() => update('format', format.value)} />
              <span className="settings-choice-icon" aria-hidden="true"><FileJson size={16} /></span>
              <span><strong>{format.title}</strong><small>{format.description}</small></span>
              <span className="settings-choice-indicator" aria-hidden="true">{options.format === format.value && <Check size={11} />}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="export-content-title">
        <div className="settings-section-heading">
          <div>
            <h3 id="export-content-title">Contents</h3>
            <p>Raw tool arguments and results may contain project data. Review the destination before sharing.</p>
          </div>
        </div>
        <div className="settings-toggle-list">
          <ExportToggle checked={options.includeMessages} title="Messages" description="User prompts and visible assistant responses." onChange={(checked) => update('includeMessages', checked)} />
          <ExportToggle checked={options.includeToolCalls} title="Raw tool calls" description="Function names, arguments, results, and errors." onChange={(checked) => update('includeToolCalls', checked)} />
          <ExportToggle checked={options.includeTimestamps} title="Timestamps and provenance" description="Thread timing, provider, connection, and model identifiers." onChange={(checked) => update('includeTimestamps', checked)} />
          <ExportToggle checked={options.includeReasoningSummaries} title="Reasoning summaries" description="User-visible summaries generated during model work." onChange={(checked) => update('includeReasoningSummaries', checked)} />
          <ExportToggle checked={options.includeRawReasoning} title="Eligible raw reasoning" description="Only local, DeepSeek, and Qwen reasoning that the retention policy permits." onChange={(checked) => update('includeRawReasoning', checked)} />
          <ExportToggle checked={options.redactSensitiveData} title="Redact sensitive values" description="Remove likely credentials and authentication headers from raw tool payloads." onChange={(checked) => update('redactSensitiveData', checked)} />
          <label className="settings-select-row">
            <span>
              <strong>Attachments</strong>
              <small>Embedded images can make exports substantially larger.</small>
            </span>
            <select value={options.attachments} onChange={(event) => update('attachments', event.target.value as SettingsAttachmentMode)}>
              {attachmentOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
      </section>

      <aside className="settings-privacy-lock">
        <span className="settings-privacy-lock-icon" aria-hidden="true"><Lock size={17} /></span>
        <div>
          <strong>Provider privacy rule is locked</strong>
          <p>Raw reasoning from OpenAI and GPT models, Gemini, and Anthropic is discarded before persistence. It cannot be restored or included in an export, even when eligible raw reasoning is enabled.</p>
        </div>
        <ShieldCheck size={19} aria-hidden="true" />
      </aside>

      <footer className="settings-export-footer">
        <div className="settings-export-result" aria-live="polite">
          {state.error
            ? <span className="error">{state.error}</span>
            : state.result?.filePath
              ? <span>Saved to <code>{state.result.filePath}</code></span>
              : <span>A native save dialog opens before any file is written.</span>}
        </div>
        <button className="settings-button primary settings-export-button" type="button" disabled={state.busy} onClick={() => void onExport(options)}>
          {state.busy ? <LoaderCircle className="settings-spinner" size={15} /> : <Download size={15} />}
          <span>{state.busy ? 'Preparing export…' : `Export .${options.format}`}</span>
        </button>
      </footer>
    </div>
  )
}
