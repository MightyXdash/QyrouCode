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

export type SettingsView =
  | { section: 'connections' }
  | { section: 'models'; connectionId: string }
  | { section: 'exports' }

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

export interface SettingsPageProps {
  connections: readonly ConnectionSummary[]
  catalog: readonly RemoteModel[]
  exportOptions: SettingsExportOptions
  exportState: SettingsExportState
  initialView?: SettingsView
  onSaveConnection: (request: SettingsConnectionRequest) => Promise<void>
  onTestConnection: (request: SettingsConnectionRequest) => Promise<SettingsConnectionTestResult>
  onDisconnectConnection: (connectionId: string) => Promise<void>
  onUpdateModelSelection: (connectionId: string, selectedModelIds: readonly string[]) => Promise<void> | void
  onExportOptionsChange: (options: SettingsExportOptions) => void
  onExport: (options: SettingsExportOptions) => Promise<void>
  onClose?: () => void
}
