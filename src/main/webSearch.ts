import { lookup } from 'dns/promises'
import { isIP } from 'net'

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export type WebFetchFormat = 'text' | 'markdown' | 'html'

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const DEFAULT_RESULTS = 5
const MAX_RESULTS = 10
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 SupraCode/1.0'

const decodeHtml = (value: string): string => value
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))

const stripHtml = (value: string): string => decodeHtml(value)
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const unwrapDuckDuckGoUrl = (value: string): string => {
  const decoded = decodeHtml(value)
  try {
    const url = new URL(decoded, SEARCH_ENDPOINT)
    const target = url.searchParams.get('uddg')
    return target ? decodeURIComponent(target) : url.toString()
  } catch {
    return decoded
  }
}

export function parseDuckDuckGoResults(html: string, limit = DEFAULT_RESULTS): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const anchorPattern = /<a(?=[^>]*class="[^"]*result__a[^"]*")(?=[^>]*href="([^"]+)")[^>]*>([\s\S]*?)<\/a>/gi
  const anchors = [...html.matchAll(anchorPattern)]
  for (const [index, anchor] of anchors.entries()) {
    const start = (anchor.index ?? 0) + anchor[0].length
    const end = anchors[index + 1]?.index ?? Math.min(html.length, start + 8_000)
    const following = html.slice(start, end)
    const snippet = following.match(/<(?:a|div)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i)
    const url = unwrapDuckDuckGoUrl(anchor[1])
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue
    results.push({ title: stripHtml(anchor[2]), url, snippet: snippet ? stripHtml(snippet[1]) : '' })
    if (results.length >= Math.min(Math.max(limit, 1), MAX_RESULTS)) break
  }
  return results
}

function isPrivateAddress(address: string): boolean {
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true
  if (address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
}

async function validatePublicUrl(value: string): Promise<URL> {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must use http or https')
  if (!url.hostname) throw new Error('URL must include a hostname')
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error('Private and loopback network addresses are blocked')
  return url
}

async function responseBody(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_RESPONSE_BYTES) throw new Error('Web response exceeds the size limit')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('Web response exceeds the size limit')
  return new TextDecoder().decode(bytes)
}

function htmlToText(html: string): string {
  return decodeHtml(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function htmlToMarkdown(html: string): string {
  return decodeHtml(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, body: string) => `${'#'.repeat(Number(level))} ${stripHtml(body)}\n\n`)
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url: string, body: string) => `[${stripHtml(body)}](${decodeHtml(url)})`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, body: string) => `\`${stripHtml(body)}\``)
    .replace(/<(?:br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export class NoApiWebClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async search(query: string, maxResults = DEFAULT_RESULTS, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const normalized = query.trim()
    if (!normalized) throw new Error('A web search query is required')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Web search timed out')), REQUEST_TIMEOUT_MS)
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await this.fetcher(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(normalized)}`, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`Web search failed with status ${response.status}`)
      return parseDuckDuckGoResults(await responseBody(response), maxResults)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }

  async fetch(url: string, format: WebFetchFormat = 'markdown', signal?: AbortSignal): Promise<string> {
    let target = await validatePublicUrl(url)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Web fetch timed out')), REQUEST_TIMEOUT_MS)
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const response = await this.fetcher(target, {
          redirect: 'manual',
          headers: { 'user-agent': USER_AGENT, accept: 'text/markdown,text/plain,text/html;q=0.9,*/*;q=0.1', 'accept-language': 'en-US,en;q=0.9' },
          signal: controller.signal
        })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location) throw new Error('Web redirect did not include a target')
          target = await validatePublicUrl(new URL(location, target).toString())
          continue
        }
        if (!response.ok) throw new Error(`Web fetch failed with status ${response.status}`)
        const content = await responseBody(response)
        const contentType = response.headers.get('content-type') ?? ''
        if (format === 'html' || !contentType.includes('text/html')) return content
        return format === 'text' ? htmlToText(content) : htmlToMarkdown(content)
      }
      throw new Error('Web fetch exceeded the redirect limit')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }
}

export function formatWebSearchResults(results: readonly WebSearchResult[]): string {
  if (!results.length) return 'No results found. Try a different query.'
  return `${results.map((result) => `Title: ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`).join('\n\n---\n\n')}\n\n---\n\nThese are short snippets. Use web_fetch on a result URL when full page content is needed.`
}
