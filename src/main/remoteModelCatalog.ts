import type { ConnectionKind } from '../shared/connections'
import { buildRemoteModelCatalog, type CatalogConnectionKind, type RemoteModel } from '../shared/remoteModels'

export interface RemoteModelConnectionShape {
  id: string
  kind: ConnectionKind
  baseUrl: string
  apiKey: string
}

interface RemoteModelCatalogEntry {
  models: RemoteModel[]
  fetchedAt: number
}

const MODEL_LIST_TIMEOUT_MS = 15_000
const ANTHROPIC_MODEL_LIST_LIMIT = '1000'
const ANTHROPIC_API_VERSION = '2023-06-01'

const catalogs = new Map<string, RemoteModelCatalogEntry>()
const pendingFetches = new Map<string, Promise<RemoteModel[]>>()

export const modelListHeaders = (kind: CatalogConnectionKind, apiKey: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
    if (kind === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = ANTHROPIC_API_VERSION
    }
  }
  return headers
}

export async function fetchRemoteModels(connection: RemoteModelConnectionShape): Promise<RemoteModel[]> {
  if (connection.kind === 'openai-compatible') return []
  const kind = connection.kind as CatalogConnectionKind
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS)
  try {
    const baseUrl = connection.baseUrl.endsWith('/') ? connection.baseUrl : `${connection.baseUrl}/`
    const url = new URL('models', baseUrl)
    if (kind === 'anthropic') url.searchParams.set('limit', ANTHROPIC_MODEL_LIST_LIMIT)
    const response = await fetch(url, { headers: modelListHeaders(kind, connection.apiKey), signal: controller.signal })
    if (!response.ok) throw new Error(`Model list request failed with status ${response.status}`)
    return buildRemoteModelCatalog(kind, await response.json())
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Model list request timed out')
    if (error instanceof Error && connection.apiKey) {
      throw new Error(error.message.replaceAll(connection.apiKey, '[REDACTED]'))
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function getCachedRemoteModels(connectionId: string): RemoteModel[] | undefined {
  return catalogs.get(connectionId)?.models
}

export function setCachedRemoteModels(connectionId: string, models: RemoteModel[]): void {
  catalogs.set(connectionId, { models, fetchedAt: Date.now() })
}

export function clearRemoteModelCatalog(connectionId: string): void {
  catalogs.delete(connectionId)
}

export async function refreshRemoteModels(connection: RemoteModelConnectionShape): Promise<RemoteModel[]> {
  const pending = pendingFetches.get(connection.id)
  if (pending) return pending
  const fetchPromise = fetchRemoteModels(connection)
    .then((models) => {
      setCachedRemoteModels(connection.id, models)
      return models
    })
    .finally(() => pendingFetches.delete(connection.id))
  pendingFetches.set(connection.id, fetchPromise)
  return fetchPromise
}
