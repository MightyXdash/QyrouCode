import { Download, LoaderCircle } from 'lucide-react'
import type { JSX } from 'react'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsControls'
import SettingsSelect from './SettingsSelect'
import type { SettingsAttachmentMode, SettingsExportFormat, SettingsExportOptions, SettingsExportScope, SettingsExportState } from './settingsTypes'

interface DataSettingsProps {
  options: SettingsExportOptions
  state: SettingsExportState
  onOptionsChange: (options: SettingsExportOptions) => void
  onExport: (options: SettingsExportOptions) => Promise<void>
}

export default function DataSettings({ options, state, onOptionsChange, onExport }: DataSettingsProps): JSX.Element {
  const update = <Key extends keyof SettingsExportOptions>(key: Key, value: SettingsExportOptions[Key]): void => {
    onOptionsChange({ ...options, [key]: value })
  }

  return (
    <>
      <div className="settings-tab-header"><h2>Data</h2></div>
      <div className="settings-tab-body">
        <SettingsGroup title="Export">
          <SettingsRow title="Scope" description="Choose which saved conversations to export.">
            <SettingsSelect value={options.scope} label="Export scope" options={[
              { value: 'thread', label: 'Current thread' },
              { value: 'project', label: 'Current project' },
              { value: 'all', label: 'All threads' }
            ]} onChange={(value) => update('scope', value as SettingsExportScope)} />
          </SettingsRow>
          <SettingsRow title="Format" description="OpenAI-compatible JSONL or a structured JSON bundle.">
            <SettingsSelect value={options.format} label="Export format" options={[
              { value: 'jsonl', label: 'HF / OpenAI JSONL' },
              { value: 'json', label: 'JSON' }
            ]} onChange={(value) => update('format', value as SettingsExportFormat)} />
          </SettingsRow>
          <SettingsRow title="Attachments" description="Choose whether image data is included.">
            <SettingsSelect value={options.attachments} label="Export attachments" options={[
              { value: 'none', label: 'Exclude' },
              { value: 'metadata', label: 'Metadata only' },
              { value: 'embedded', label: 'Embed data' }
            ]} onChange={(value) => update('attachments', value as SettingsAttachmentMode)} />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Contents">
          <SettingsRow title="Messages" description="User prompts and assistant responses."><SettingsSwitch checked={options.includeMessages} label="Include messages" onChange={(checked) => update('includeMessages', checked)} /></SettingsRow>
          <SettingsRow title="Tool calls" description="Tool names, inputs, results, and errors."><SettingsSwitch checked={options.includeToolCalls} label="Include tool calls" onChange={(checked) => update('includeToolCalls', checked)} /></SettingsRow>
          <SettingsRow title="Model reasoning" description="Reasoning captured with the conversation."><SettingsSwitch checked={options.includeRawReasoning} label="Include model reasoning" onChange={(checked) => update('includeRawReasoning', checked)} /></SettingsRow>
          <SettingsRow title="Timestamps" description="Conversation and model provenance metadata."><SettingsSwitch checked={options.includeTimestamps} label="Include timestamps" onChange={(checked) => update('includeTimestamps', checked)} /></SettingsRow>
          <SettingsRow title="Redact secrets" description="Remove likely keys and authentication headers."><SettingsSwitch checked={options.redactSensitiveData} label="Redact secrets" onChange={(checked) => update('redactSensitiveData', checked)} /></SettingsRow>
        </SettingsGroup>

        <div className="settings-export-bar">
          <span className={state.error ? 'error' : ''}>{state.error ?? (state.result?.filePath ? `Saved to ${state.result.filePath}` : state.preview ? `${state.preview.threadCount} threads ready` : '')}</span>
          <button className="primary" type="button" disabled={state.busy} onClick={() => void onExport(options)}>
            {state.busy ? <LoaderCircle className="settings-spinner" size={13} /> : <Download size={13} />}
            Export .{options.format}
          </button>
        </div>
      </div>
    </>
  )
}
