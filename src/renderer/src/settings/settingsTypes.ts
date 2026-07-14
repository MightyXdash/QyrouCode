import type { ConnectionInput, ConnectionSummary, ConnectionTestResult } from '../../../shared/connections'
import type {
  AttachmentExportMode,
  ConversationExportFormat,
  ConversationExportPreview,
  ConversationExportRequest,
  ConversationExportResult,
  ConversationExportScope
} from '../../../shared/conversationExport'
import type { RemoteModel } from '../../../shared/remoteModels'
import type { ResponseStylePreference, ThemePreference } from '../../../shared/settings'
import type { CatalogModel } from '../modelCatalog'
import type { ReasoningEffort } from '../reasoningProfiles'

export type SettingsSection = 'appearance' | 'general' | 'providers' | 'models' | 'local-models' | 'data'

export interface SettingsConnectionRequest {
  connectionId?: string
  input: ConnectionInput
  preserveCredential: boolean
}

export type SettingsConnectionTestResult = ConnectionTestResult
export type SettingsExportScope = ConversationExportScope
export type SettingsExportFormat = ConversationExportFormat
export type SettingsAttachmentMode = AttachmentExportMode
export type SettingsExportOptions = ConversationExportRequest

export interface SettingsExportState {
  busy: boolean
  preview?: ConversationExportPreview
  result?: ConversationExportResult
  error?: string
}

export interface LocalModelDownloadState {
  downloaded: number
  total: number
  error?: string
}

export interface SettingsDialogProps {
  connections: readonly ConnectionSummary[]
  catalog: readonly RemoteModel[]
  localCatalog: readonly CatalogModel[]
  downloadedLocalModelIds: ReadonlySet<string>
  localModelDownloads: Readonly<Record<string, LocalModelDownloadState>>
  theme: ThemePreference
  reasoningEffort: ReasoningEffort
  responseStyle: ResponseStylePreference
  exportOptions: SettingsExportOptions
  exportState: SettingsExportState
  onThemeChange: (theme: ThemePreference) => void
  onReasoningEffortChange: (effort: ReasoningEffort) => void
  onResponseStyleChange: (preference: ResponseStylePreference) => Promise<void> | void
  onSaveConnection: (request: SettingsConnectionRequest) => Promise<void>
  onTestConnection: (request: SettingsConnectionRequest) => Promise<SettingsConnectionTestResult>
  onDisconnectConnection: (connectionId: string) => Promise<void>
  onUpdateModelSelection: (connectionId: string, selectedModelIds: readonly string[]) => Promise<void> | void
  onDownloadLocalModel: (model: CatalogModel) => Promise<void>
  onCancelLocalModelDownload: (model: CatalogModel) => Promise<void> | void
  onExportOptionsChange: (options: SettingsExportOptions) => void
  onExport: (options: SettingsExportOptions) => Promise<void>
  onClose: () => void
}
