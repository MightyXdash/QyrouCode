import { nativeImage, session } from 'electron'
import Store from 'electron-store'
import { BROWSER_SESSION_PARTITION, isAllowedBrowserUrl } from '../shared/browser'

interface BrowserFaviconCacheEntry {
  origin: string
  sourceUrl: string
  dataUrl: string
  etag?: string
  lastModified?: string
  checkedAt: number
  accessedAt: number
}

interface BrowserFaviconCacheData {
  entries: BrowserFaviconCacheEntry[]
}

const CACHE_STORE_NAME = 'browser-favicons'
const MAX_CACHE_ENTRIES = 512
const MAX_FAVICON_BYTES = 512 * 1024
const MAX_FAVICON_DIMENSION = 64
const REVALIDATION_INTERVAL_MS = 30 * 60 * 1000
const FAVICON_REQUEST_TIMEOUT_MS = 5_000
const DATA_URL_PREFIX = 'data:image/png;base64,'

function siteOrigin(value: string): string | undefined {
  if (!isAllowedBrowserUrl(value)) return undefined
  return new URL(value).origin
}

function validEntry(value: unknown): value is BrowserFaviconCacheEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<BrowserFaviconCacheEntry>
  return typeof entry.origin === 'string' &&
    siteOrigin(entry.origin) === entry.origin &&
    typeof entry.sourceUrl === 'string' &&
    isAllowedBrowserUrl(entry.sourceUrl) &&
    typeof entry.dataUrl === 'string' &&
    entry.dataUrl.startsWith(DATA_URL_PREFIX) &&
    entry.dataUrl.length <= (MAX_FAVICON_BYTES * 2) &&
    typeof entry.checkedAt === 'number' &&
    Number.isFinite(entry.checkedAt) &&
    typeof entry.accessedAt === 'number' &&
    Number.isFinite(entry.accessedAt) &&
    (entry.etag === undefined || typeof entry.etag === 'string') &&
    (entry.lastModified === undefined || typeof entry.lastModified === 'string')
}

function normalizedFaviconDataUrl(bytes: Buffer): string | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FAVICON_BYTES) return undefined
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return undefined
  const size = image.getSize()
  if (size.width <= 0 || size.height <= 0) return undefined
  const scale = Math.min(1, MAX_FAVICON_DIMENSION / size.width, MAX_FAVICON_DIMENSION / size.height)
  const normalized = scale < 1
    ? image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best'
      })
    : image
  return normalized.toDataURL()
}

export class BrowserFaviconCache {
  private readonly store = new Store<BrowserFaviconCacheData>({
    name: CACHE_STORE_NAME,
    defaults: { entries: [] }
  })
  private readonly entries = new Map<string, BrowserFaviconCacheEntry>()
  private readonly inFlight = new Map<string, Promise<string | undefined>>()

  constructor() {
    const storedValue: unknown = this.store.get('entries')
    const storedEntries = (Array.isArray(storedValue) ? storedValue : [])
      .filter(validEntry)
      .sort((left, right) => right.accessedAt - left.accessedAt)
      .slice(0, MAX_CACHE_ENTRIES)
    for (const entry of storedEntries) this.entries.set(entry.origin, entry)
    if (!Array.isArray(storedValue) || storedEntries.length !== storedValue.length) this.persist()
  }

  get(pageUrl: string): string | undefined {
    const origin = siteOrigin(pageUrl)
    if (!origin) return undefined
    const entry = this.entries.get(origin)
    if (!entry) return undefined
    entry.accessedAt = Date.now()
    return entry.dataUrl
  }

  revalidate(pageUrl: string, faviconUrls: string[]): Promise<string | undefined> {
    const origin = siteOrigin(pageUrl)
    const sourceUrl = faviconUrls.find(isAllowedBrowserUrl)
    if (!origin || !sourceUrl) return Promise.resolve(this.get(pageUrl))
    const cached = this.entries.get(origin)
    if (
      cached?.sourceUrl === sourceUrl &&
      Date.now() - cached.checkedAt < REVALIDATION_INTERVAL_MS
    ) return Promise.resolve(this.get(pageUrl))
    const running = this.inFlight.get(origin)
    if (running) return running
    const request = this.refresh(origin, sourceUrl, cached).finally(() => this.inFlight.delete(origin))
    this.inFlight.set(origin, request)
    return request
  }

  private async refresh(
    origin: string,
    sourceUrl: string,
    cached: BrowserFaviconCacheEntry | undefined
  ): Promise<string | undefined> {
    const headers: Record<string, string> = { 'cache-control': 'no-cache' }
    if (cached?.sourceUrl === sourceUrl && cached.etag) headers['if-none-match'] = cached.etag
    if (cached?.sourceUrl === sourceUrl && cached.lastModified) headers['if-modified-since'] = cached.lastModified
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FAVICON_REQUEST_TIMEOUT_MS)
    try {
      const response = await session.fromPartition(BROWSER_SESSION_PARTITION).fetch(sourceUrl, {
        headers,
        redirect: 'follow',
        signal: controller.signal
      })
      const now = Date.now()
      if (response.status === 304 && cached) {
        cached.checkedAt = now
        cached.accessedAt = now
        this.persist()
        return cached.dataUrl
      }
      const contentLength = Number(response.headers.get('content-length'))
      if (!response.ok || (Number.isFinite(contentLength) && contentLength > MAX_FAVICON_BYTES)) {
        return cached?.dataUrl
      }
      const dataUrl = normalizedFaviconDataUrl(Buffer.from(await response.arrayBuffer()))
      if (!dataUrl) return cached?.dataUrl
      const entry: BrowserFaviconCacheEntry = {
        origin,
        sourceUrl,
        dataUrl,
        etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined,
        checkedAt: now,
        accessedAt: now
      }
      this.entries.set(origin, entry)
      this.persist()
      return dataUrl
    } catch {
      return cached?.dataUrl
    } finally {
      clearTimeout(timeout)
    }
  }

  private persist(): void {
    const entries = [...this.entries.values()]
      .sort((left, right) => right.accessedAt - left.accessedAt)
      .slice(0, MAX_CACHE_ENTRIES)
    this.entries.clear()
    for (const entry of entries) this.entries.set(entry.origin, entry)
    this.store.set('entries', entries)
  }
}
