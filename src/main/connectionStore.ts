import { randomUUID } from 'crypto'
import { safeStorage } from 'electron'
import Store from 'electron-store'
import {
  getConnectionProvider,
  normalizeConnectionBaseUrl,
  validateConnectionInput,
  validateModelSelection,
  type ConnectionInput,
  type ConnectionKind,
  type ConnectionMutationResult,
  type ConnectionSummary,
  type ConnectionTestResult
} from '../shared/connections'
import { getRemoteModelsForConnectionKind } from '../shared/remoteModels'

interface StoredConnection {
  id: string
  kind: ConnectionKind
  providerName: string
  baseUrl: string
  modelIds: string[]
  selectedModelIds: string[]
  createdAt: string
  updatedAt: string
}

interface ConnectionStoreData {
  connections: StoredConnection[]
}

interface ConnectionSecretStoreData {
  credentials: Record<string, string>
}

export interface ResolvedConnection extends StoredConnection {
  apiKey: string
}

export interface ConnectionSecurityStatus {
  available: boolean
  backend: 'os-protected' | 'unavailable'
  message: string
}

const CONNECTION_TEST_TIMEOUT_MS = 15_000
const connectionsStore = new Store<ConnectionStoreData>({
  name: 'connections',
  defaults: { connections: [] }
})
const secretsStore = new Store<ConnectionSecretStoreData>({
  name: 'connection-secrets',
  defaults: { credentials: {} }
})

function encryptionAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform !== 'linux') return true
  return safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

export function getConnectionSecurityStatus(): ConnectionSecurityStatus {
  const available = encryptionAvailable()
  return {
    available,
    backend: available ? 'os-protected' : 'unavailable',
    message: available
      ? 'API keys are encrypted with the operating system credential store.'
      : 'Secure operating system credential storage is unavailable. API keys will not be saved.'
  }
}

function encryptedCredential(connectionId: string): string | undefined {
  return secretsStore.get('credentials')[connectionId]
}

function decryptCredential(connectionId: string): string {
  const encrypted = encryptedCredential(connectionId)
  if (!encrypted) return ''
  if (!encryptionAvailable()) throw new Error('Secure credential storage is unavailable')
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    throw new Error('The saved API key could not be decrypted')
  }
}

function saveCredential(connectionId: string, apiKey: string): void {
  if (!apiKey) {
    const credentials = { ...secretsStore.get('credentials') }
    delete credentials[connectionId]
    secretsStore.set('credentials', credentials)
    return
  }
  if (!encryptionAvailable()) throw new Error('Secure credential storage is unavailable. Configure your operating system keychain before saving an API key.')
  const encrypted = safeStorage.encryptString(apiKey).toString('base64')
  secretsStore.set('credentials', { ...secretsStore.get('credentials'), [connectionId]: encrypted })
}

function summary(connection: StoredConnection): ConnectionSummary {
  return {
    id: connection.id,
    kind: connection.kind,
    providerName: connection.providerName,
    baseUrl: connection.kind === 'openai-compatible' ? connection.baseUrl : undefined,
    modelIds: [...connection.modelIds],
    selectedModelIds: [...connection.selectedModelIds],
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    hasCredential: Boolean(encryptedCredential(connection.id))
  }
}

export function getConnections(): ConnectionSummary[] {
  return connectionsStore.get('connections').map(summary)
}

function findStoredConnection(connectionId: string): StoredConnection | undefined {
  return connectionsStore.get('connections').find((connection) => connection.id === connectionId)
}

function validatedInput(input: ConnectionInput, connectionId?: string): ReturnType<typeof validateConnectionInput> {
  const existing = connectionId ? findStoredConnection(connectionId) : undefined
  const apiKey = input.apiKey.trim() || (existing ? decryptCredential(connectionId as string) : '')
  const validated = validateConnectionInput({ ...input, apiKey }, getConnections(), connectionId)
  const normalized = validated.kind === 'openai-compatible'
    ? validated
    : {
        ...validated,
        selectedModelIds: validateModelSelection(
          validated.selectedModelIds,
          getRemoteModelsForConnectionKind(validated.kind).map((model) => model.id)
        )
      }
  if (normalized.kind === 'openai-compatible') {
    const duplicateEndpoint = connectionsStore.get('connections').some((connection) =>
      connection.id !== connectionId &&
      connection.kind === 'openai-compatible' &&
      normalizeConnectionBaseUrl(connection.baseUrl) === normalized.baseUrl)
    if (duplicateEndpoint) throw new Error('This OpenAI-compatible endpoint already has a connection')
  }
  return normalized
}

export function saveConnection(input: ConnectionInput, connectionId?: string): ConnectionMutationResult {
  try {
    const existing = connectionId ? findStoredConnection(connectionId) : undefined
    if (connectionId && !existing) throw new Error('Connection not found')
    const normalized = validatedInput(input, connectionId)
    const id = existing?.id ?? randomUUID()
    const now = new Date().toISOString()
    if (input.apiKey.trim() || !existing) saveCredential(id, normalized.apiKey)
    const connection: StoredConnection = {
      id,
      kind: normalized.kind,
      providerName: normalized.providerName,
      baseUrl: normalized.baseUrl,
      modelIds: normalized.modelIds,
      selectedModelIds: normalized.selectedModelIds,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    const connections = connectionsStore.get('connections').filter((candidate) => candidate.id !== id)
    connectionsStore.set('connections', [...connections, connection])
    return { ok: true, connection: summary(connection) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save the connection' }
  }
}

export function updateConnectionModels(connectionId: string, selectedModelIds: readonly string[]): ConnectionMutationResult {
  try {
    const existing = findStoredConnection(connectionId)
    if (!existing) throw new Error('Connection not found')
    const availableModelIds = existing.kind === 'openai-compatible'
      ? existing.modelIds
      : getRemoteModelsForConnectionKind(existing.kind).map((model) => model.id)
    const selected = validateModelSelection(selectedModelIds, availableModelIds)
    const updated: StoredConnection = { ...existing, selectedModelIds: selected, updatedAt: new Date().toISOString() }
    connectionsStore.set('connections', connectionsStore.get('connections').map((connection) => connection.id === connectionId ? updated : connection))
    return { ok: true, connection: summary(updated) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not update selected models' }
  }
}

export function deleteConnection(connectionId: string): boolean {
  const current = connectionsStore.get('connections')
  if (!current.some((connection) => connection.id === connectionId)) return false
  connectionsStore.set('connections', current.filter((connection) => connection.id !== connectionId))
  const credentials = { ...secretsStore.get('credentials') }
  delete credentials[connectionId]
  secretsStore.set('credentials', credentials)
  return true
}

export function resolveConnection(connectionId: string): ResolvedConnection {
  const connection = findStoredConnection(connectionId)
  if (!connection) throw new Error('Connection not found')
  return { ...connection, apiKey: decryptCredential(connectionId) }
}

export async function testConnection(input: ConnectionInput, connectionId?: string): Promise<ConnectionTestResult> {
  let normalized: ReturnType<typeof validateConnectionInput>
  try {
    normalized = validatedInput(input, connectionId)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid connection' }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CONNECTION_TEST_TIMEOUT_MS)
  try {
    const baseUrl = normalized.baseUrl.endsWith('/') ? normalized.baseUrl : `${normalized.baseUrl}/`
    const response = await fetch(new URL('models', baseUrl), {
      headers: normalized.apiKey ? { authorization: `Bearer ${normalized.apiKey}` } : undefined,
      signal: controller.signal
    })
    if (!response.ok) return { ok: false, error: `Connection test failed with status ${response.status}` }
    const body = await response.json() as { data?: unknown[]; models?: unknown[] }
    const modelCount = Array.isArray(body.data) ? body.data.length : Array.isArray(body.models) ? body.models.length : undefined
    return {
      ok: true,
      message: modelCount === undefined
        ? `Connected to ${normalized.providerName}`
        : `Connected to ${normalized.providerName} with ${modelCount} available models`
    }
  } catch (error) {
    return { ok: false, error: controller.signal.aborted ? 'Connection test timed out' : error instanceof Error ? error.message.replaceAll(normalized.apiKey, '[REDACTED]') : 'Connection test failed' }
  } finally {
    clearTimeout(timeout)
  }
}

export function connectionBaseUrl(kind: ConnectionKind, customBaseUrl?: string): string {
  return kind === 'openai-compatible'
    ? normalizeConnectionBaseUrl(customBaseUrl ?? '')
    : getConnectionProvider(kind).defaultBaseUrl
}
