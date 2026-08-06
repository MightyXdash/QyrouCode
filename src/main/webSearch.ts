import { lookup } from 'dns/promises'
import { isIP } from 'net'

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export type WebFetchFormat = 'text' | 'markdown' | 'html'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const DEFAULT_RESULTS = 5
const MAX_RESULTS = 10
const SEARCH_RETRIES_PER_ENGINE = 2
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 QyrouCode/1.0'

interface SearchEngine {
  name: string
  endpoint: string
  queryParam: string
  parse: (html: string, limit: number) => WebSearchResult[]
}

const decodeHtml = (value: string): string => {
  return value
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (_, dec, hex, named) => {
      if (dec) return String.fromCodePoint(Number(dec))
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
      const entities: Record<string, string> = {
        amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
        nbsp: ' ', copy: '©', reg: '®', trade: '™',
      }
      return entities[named?.toLowerCase()] ?? `&${named};`
    })
    .replace(/&/g, '&')
}

const stripHtml = (value: string): string => decodeHtml(value)
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const unwrapDuckDuckGoUrl = (value: string): string => {
  const decoded = decodeHtml(value)
  try {
    const url = new URL(decoded, 'https://html.duckduckgo.com/html/')
    const target = url.searchParams.get('uddg')
    return target ? decodeURIComponent(target) : url.toString()
  } catch {
    return decoded
  }
}

function parseDuckDuckGoResults(html: string, limit = DEFAULT_RESULTS): WebSearchResult[] {
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

function parseBraveResults(html: string, limit = DEFAULT_RESULTS): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const titlePattern = /<a[^>]*class="[^"]*result-header[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetPattern = /<div[^>]*class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
  const titles = [...html.matchAll(titlePattern)]
  const snippets = [...html.matchAll(snippetPattern)]
  for (let i = 0; i < Math.min(titles.length, snippets.length, Math.min(Math.max(limit, 1), MAX_RESULTS)); i++) {
    const url = titles[i][1].startsWith('http') ? titles[i][1] : `https://search.brave.com${titles[i][1]}`
    results.push({ title: stripHtml(titles[i][2]), url, snippet: stripHtml(snippets[i][1]) })
  }
  return results
}

function parseStartpageResults(html: string, limit = DEFAULT_RESULTS): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const pattern = /<div[^>]*class="[^"]*w-gl__result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*w-gl__result[^"]*"[^>]*>/gi
  const matches = [...html.matchAll(pattern)]
  for (const match of matches) {
    if (results.length >= Math.min(Math.max(limit, 1), MAX_RESULTS)) break
    const content = match[1]
    const titleMatch = content.match(/<a[^>]*class="[^"]*w-gl__result-title[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    const snippetMatch = content.match(/<p[^>]*class="[^"]*w-gl__description[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    if (!titleMatch) continue
    const url = titleMatch[1].startsWith('http') ? titleMatch[1] : `https://www.startpage.com${titleMatch[1]}`
    results.push({ title: stripHtml(titleMatch[2]), url, snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '' })
  }
  return results
}

function parseMojeekResults(html: string, limit = DEFAULT_RESULTS): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const pattern = /<li[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  const matches = [...html.matchAll(pattern)]
  for (const match of matches) {
    if (results.length >= Math.min(Math.max(limit, 1), MAX_RESULTS)) break
    const content = match[1]
    const titleMatch = content.match(/<h3[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>/i)
    const snippetMatch = content.match(/<p[^>]*class="[^"]*s[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    if (!titleMatch) continue
    const url = titleMatch[1].startsWith('http') ? titleMatch[1] : `https://www.mojeek.com${titleMatch[1]}`
    results.push({ title: stripHtml(titleMatch[2]), url, snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '' })
  }
  return results
}

function parseQwantResults(html: string, limit = DEFAULT_RESULTS): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const pattern = /<div[^>]*class="[^"]*result[^"]*"[^>]*data-url="([^"]+)"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*result[^"]*"[^>]*data-url=/gi
  const matches = [...html.matchAll(pattern)]
  for (const match of matches) {
    if (results.length >= Math.min(Math.max(limit, 1), MAX_RESULTS)) break
    const url = match[1]
    const content = match[2]
    const titleMatch = content.match(/<a[^>]*class="[^"]*result-title[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    const snippetMatch = content.match(/<div[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    if (!titleMatch || !url.startsWith('http')) continue
    results.push({ title: stripHtml(titleMatch[1]), url, snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '' })
  }
  return results
}

function parseSearXNGResults(html: string, limit = DEFAULT_RESULTS): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const pattern = /<article[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/article>/gi
  const matches = [...html.matchAll(pattern)]
  for (const match of matches) {
    if (results.length >= Math.min(Math.max(limit, 1), MAX_RESULTS)) break
    const content = match[1]
    const titleMatch = content.match(/<h3[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>/i)
    const snippetMatch = content.match(/<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    if (!titleMatch) continue
    const url = titleMatch[1].startsWith('http') ? titleMatch[1] : ''
    if (!url) continue
    results.push({ title: stripHtml(titleMatch[2]), url, snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '' })
  }
  return results
}

const SEARCH_ENGINES: SearchEngine[] = [
  { name: 'DuckDuckGo', endpoint: 'https://html.duckduckgo.com/html/?q=', queryParam: 'q', parse: parseDuckDuckGoResults },
  { name: 'Brave Search', endpoint: 'https://search.brave.com/search?q=', queryParam: 'q', parse: parseBraveResults },
  { name: 'Startpage', endpoint: 'https://www.startpage.com/sp/search?q=', queryParam: 'q', parse: parseStartpageResults },
  { name: 'Mojeek', endpoint: 'https://www.mojeek.com/search?q=', queryParam: 'q', parse: parseMojeekResults },
  { name: 'Qwant', endpoint: 'https://www.qwant.com/?q=', queryParam: 'q', parse: parseQwantResults },
  { name: 'SearXNG (searx.be)', endpoint: 'https://searx.be/search?q=', queryParam: 'q', parse: parseSearXNGResults },
]

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

    let lastError: Error | null = null

    for (const engine of SEARCH_ENGINES) {
      for (let attempt = 0; attempt <= SEARCH_RETRIES_PER_ENGINE; attempt++) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(new Error(`${engine.name} search timed out`)), REQUEST_TIMEOUT_MS)
        const abort = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })

        try {
          const url = `${engine.endpoint}${encodeURIComponent(normalized)}`
          const response = await this.fetcher(url, {
            headers: { 'user-agent': USER_AGENT, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`${engine.name} search failed with status ${response.status}`)
          const html = await responseBody(response)
          const results = engine.parse(html, maxResults)
          if (results.length > 0) return results
          lastError = new Error(`${engine.name} returned no results`)
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
        } finally {
          clearTimeout(timeout)
          signal?.removeEventListener('abort', abort)
        }

        if (attempt < SEARCH_RETRIES_PER_ENGINE) {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
        }
      }
    }

    throw lastError ?? new Error('All search engines failed')
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
          signal: controller.signal,
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

export { parseDuckDuckGoResults, parseBraveResults, parseStartpageResults, parseMojeekResults, parseQwantResults, parseSearXNGResults }