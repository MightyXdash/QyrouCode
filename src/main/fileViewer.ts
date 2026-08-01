import { readFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { basename, extname } from 'path'
import { parse as parseYaml } from 'yaml'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import readXlsxFile from 'read-excel-file/node'
import { PDFParse } from 'pdf-parse'
import { prepareImageDataUrl } from './imagePrep'

export const MAX_VIEW_TEXT_BYTES = 2 * 1024 * 1024
export const MAX_VIEW_OUTPUT_CHARACTERS = 48_000
export const MAX_VIEW_LOG_LINES = 2_000
export const MAX_VIEW_CSV_ROWS = 2_000
export const MAX_VIEW_ARCHIVE_ENTRIES = 500
export const MAX_VIEW_ARCHIVE_BYTES = 50 * 1024 * 1024
export const MAX_VIEW_HEX_BYTES = 8 * 1024
export const MAX_VIEW_HEX_ROW_BYTES = 16
export const MAX_VIEW_IMAGE_BYTES = 10 * 1024 * 1024

const ENV_FILE_PATTERN = /(?:^|[\\/])\.env(?:\.[^.]+)?$/i
const isEnvTemplate = (path: string): boolean => /\.env\.example$/i.test(path)
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.ico': 'image/x-icon'
}

export type ViewFileFormat = 'text' | 'json' | 'yaml' | 'csv' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'log' | 'hex' | 'archive' | 'env' | 'image'

export interface ViewFileOptions {
  offset?: number
  limit?: number
}

export const viewFormatForPath = (path: string): ViewFileFormat => {
  if (ENV_FILE_PATTERN.test(path) && !isEnvTemplate(path)) return 'env'
  const extension = extname(path).toLowerCase()
  switch (extension) {
    case '.json':
    case '.jsonc':
    case '.jsonl':
      return 'json'
    case '.yaml':
    case '.yml':
      return 'yaml'
    case '.csv':
    case '.tsv':
      return 'csv'
    case '.pdf':
      return 'pdf'
    case '.docx':
    case '.doc':
      return 'docx'
    case '.pptx':
    case '.ppt':
      return 'pptx'
    case '.xlsx':
    case '.xls':
      return 'xlsx'
    case '.log':
      return 'log'
    case '.zip':
    case '.tar':
    case '.tgz':
    case '.gz':
      return 'archive'
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
    case '.gif':
    case '.bmp':
    case '.tif':
    case '.tiff':
    case '.avif':
    case '.heic':
    case '.ico':
      return 'image'
    default:
      return 'text'
  }
}

export const truncateView = (value: string): string => {
  if (value.length <= MAX_VIEW_OUTPUT_CHARACTERS) return value
  return `${value.slice(0, MAX_VIEW_OUTPUT_CHARACTERS)}\n\n... output truncated (${value.length} characters total)`
}

const containsBinaryContent = (buffer: Buffer): boolean => buffer.includes(0)

export const viewTextFile = (path: string, options: ViewFileOptions = {}): string => {
  const buffer = readFileSync(path)
  if (buffer.length > MAX_VIEW_TEXT_BYTES) throw new Error('File exceeds the view size limit; use view_hex for a binary preview')
  const content = buffer.toString('utf8')
  if (containsBinaryContent(buffer) || content.includes('\uFFFD')) throw new Error('File is not valid UTF-8 text; use view_hex for a binary preview')
  const lines = content.endsWith('\n') ? content.slice(0, -1).split(/\r?\n/) : content.split(/\r?\n/)
  const offset = options.offset ?? 1
  const limit = options.limit ?? MAX_VIEW_LOG_LINES
  if (offset < 1 || limit < 1) throw new Error('offset and limit must be positive')
  const selected = lines.slice(offset - 1, offset - 1 + limit)
  return truncateView(selected.map((line, index) => `${offset + index}: ${line}`).join('\n'))
}

export const viewJsonFile = (path: string): string => {
  const content = readFileSync(path, 'utf8')
  const value = JSON.parse(content)
  return truncateView(JSON.stringify(value, null, 2))
}

export const viewYamlFile = (path: string): string => {
  const content = readFileSync(path, 'utf8')
  const value = parseYaml(content)
  return truncateView(JSON.stringify(value, null, 2))
}

export const viewEnvFile = (path: string): string => {
  const content = readFileSync(path, 'utf8')
  const entries: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (match) entries.push(`${match[1]} (value hidden, ${line.length - match[0].length} characters)`)
  }
  return entries.length ? entries.join('\n') : 'No variable definitions found.'
}

export const viewImageDataUrl = (path: string): string => {
  const buffer = readFileSync(path)
  if (buffer.length > MAX_VIEW_IMAGE_BYTES) throw new Error('Image exceeds the view size limit')
  const mimeType = IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()]
  if (!mimeType) throw new Error('Unsupported image format')
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
  try {
    return prepareImageDataUrl(dataUrl, { format: 'png' }).dataUrl
  } catch {
    return dataUrl
  }
}

const parseCsvLine = (line: string): string[] => {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else if (character === '"') quoted = false
      else current += character
    } else if (character === '"') quoted = true
    else if (character === ',') {
      cells.push(current)
      current = ''
    } else current += character
  }
  cells.push(current)
  return cells
}

const renderRows = (rows: readonly (readonly string[])[], rowLimit: number): string => {
  const selected = rows.slice(0, rowLimit)
  const output = selected.map((row) => row.map((cell) => {
    const normalized = cell.replace(/\s+/g, ' ').trim()
    return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized
  }).join(' | ')).join('\n')
  if (rows.length > selected.length) return `${output}\n... ${rows.length - selected.length} more rows`
  return output || '(empty table)'
}

export const viewCsvFile = (path: string): string => {
  const content = readFileSync(path, 'utf8')
  const rows = content.split(/\r?\n/).filter((line) => line.length > 0).map(parseCsvLine)
  return truncateView(renderRows(rows, MAX_VIEW_CSV_ROWS))
}

export const viewLogFile = (path: string, options: ViewFileOptions = {}): string => {
  const buffer = readFileSync(path)
  if (buffer.length > MAX_VIEW_TEXT_BYTES) throw new Error('Log file exceeds the view size limit')
  const content = buffer.toString('utf8')
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0)
  const limit = options.limit ?? MAX_VIEW_LOG_LINES
  const offset = Math.max(1, lines.length - limit + 1)
  const selected = lines.slice(Math.max(0, (options.offset ?? offset) - 1), Math.max(0, (options.offset ?? offset) - 1) + limit)
  const startLine = options.offset ?? offset
  return truncateView(selected.map((line, index) => `${startLine + index}: ${line}`).join('\n'))
}

export const viewHexFile = (path: string, options: ViewFileOptions = {}): string => {
  const buffer = readFileSync(path)
  const offset = Math.max(0, Math.min(buffer.length, options.offset ?? 0))
  const length = Math.min(MAX_VIEW_HEX_BYTES, buffer.length - offset)
  const rows: string[] = []
  for (let position = 0; position < length; position += MAX_VIEW_HEX_ROW_BYTES) {
    const chunk = buffer.subarray(offset + position, offset + position + MAX_VIEW_HEX_ROW_BYTES)
    const hex = [...chunk].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...chunk].map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('')
    rows.push(`${(offset + position).toString(16).padStart(8, '0')}  ${hex.padEnd(MAX_VIEW_HEX_ROW_BYTES * 3 - 1)}  ${ascii}`)
  }
  return truncateView(rows.join('\n') || '(empty file)')
}

export const viewPdfFile = async (path: string): Promise<string> => {
  const parser = new PDFParse({ data: readFileSync(path) })
  try {
    const result = await parser.getText()
    return truncateView(result.text.replace(/\n+-- \d+ of \d+ --\s*$/s, '').trim() || '(no extractable text)')
  } finally {
    await parser.destroy()
  }
}

export const viewDocxFile = async (path: string): Promise<string> => {
  const result = await mammoth.extractRawText({ buffer: readFileSync(path) })
  return truncateView(result.value.trim() || '(no extractable text)')
}

const extractPptxText = async (path: string): Promise<string> => {
  const archive = await JSZip.loadAsync(readFileSync(path))
  const slideFiles = Object.values(archive.files)
    .filter((file) => /^ppt\/slides\/slide\d+\.xml$/.test(file.name))
    .sort((left, right) => {
      const leftNumber = Number(left.name.match(/slide(\d+)\.xml$/)?.[1])
      const rightNumber = Number(right.name.match(/slide(\d+)\.xml$/)?.[1])
      return leftNumber - rightNumber
    })
  if (!slideFiles.length) throw new Error('The PPTX file contains no slides')
  const slides = await Promise.all(slideFiles.map(async (file) => {
    const xml = await file.async('string')
    const runs = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((match) => match[1])
    return runs.join(' ')
  }))
  return slides.map((slide, index) => `--- Slide ${index + 1} ---\n${slide.trim()}`).join('\n\n')
}

export const viewPptxFile = async (path: string): Promise<string> =>
  truncateView((await extractPptxText(path)).trim() || '(no extractable text)')

export const viewXlsxFile = async (path: string): Promise<string> => {
  const sheets = await readXlsxFile(readFileSync(path))
  const sections = sheets.map((sheet) => {
    const rows = sheet.data.map((row) => row.map((cell) => {
      if (cell === null || cell === undefined) return ''
      if (cell instanceof Date) return cell.toISOString()
      return String(cell)
    }))
    return `--- Sheet: ${sheet.sheet} ---\n${renderRows(rows, MAX_VIEW_CSV_ROWS)}`
  })
  return truncateView(sections.join('\n\n'))
}

interface TarEntry {
  name: string
  offset: number
  size: number
}

const parseTar = (buffer: Buffer): TarEntry[] => {
  const entries: TarEntry[] = []
  let position = 0
  while (position + 512 <= buffer.length) {
    const header = buffer.subarray(position, position + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim()
    const typeFlag = String.fromCharCode(header[156])
    let size = Number.parseInt(sizeField, 8)
    if (!Number.isFinite(size) || size < 0) break
    position += 512
    if (typeFlag === 'L') {
      entries.length = 0
      position += size
      continue
    }
    if (name) entries.push({ name, offset: position, size })
    position += size
    position += (512 - (position % 512)) % 512
  }
  return entries
}

const extractTarText = (buffer: Buffer): string => {
  const entries = parseTar(buffer)
  const previews = entries.slice(0, 30).flatMap((entry) => {
    if (entry.size === 0) return []
    const data = buffer.subarray(entry.offset, entry.offset + Math.min(entry.size, MAX_VIEW_TEXT_BYTES))
    if (containsBinaryContent(data)) return [`${entry.name} (${entry.size} bytes, binary)`]
    return [`--- ${entry.name} ---\n${data.toString('utf8').slice(0, 2_000)}`]
  })
  return previews.length ? previews.join('\n\n') : '(empty archive)'
}

export const viewArchiveFile = async (path: string): Promise<string> => {
  const buffer = readFileSync(path)
  if (buffer.length > MAX_VIEW_ARCHIVE_BYTES) throw new Error('Archive exceeds the view size limit')
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return extractTarText(gunzipSync(buffer))
  if (buffer.toString('ascii', 257, 262) === 'ustar') return extractTarText(buffer)
  const archive = await JSZip.loadAsync(buffer)
  const entries = Object.values(archive.files).filter((file) => !file.dir).slice(0, MAX_VIEW_ARCHIVE_ENTRIES)
  const previews = await Promise.all(entries.map(async (file) => {
    const content = Buffer.from(await file.async('uint8array'))
    if (content.length > MAX_VIEW_TEXT_BYTES) return `${file.name} (${content.length} bytes, too large to preview)`
    if (containsBinaryContent(content)) return `${file.name} (${content.length} bytes, binary)`
    return `--- ${file.name} ---\n${content.toString('utf8').slice(0, 2_000)}`
  }))
  const extra = Object.keys(archive.files).filter((name) => !archive.files[name].dir).length - entries.length
  return truncateView(`${previews.join('\n\n')}${extra > 0 ? `\n\n... ${extra} more archive entries` : ''}`)
}

export const viewFile = async (path: string, options: ViewFileOptions = {}): Promise<string> => {
  switch (viewFormatForPath(path)) {
    case 'json':
      return viewJsonFile(path)
    case 'yaml':
      return viewYamlFile(path)
    case 'csv':
      return viewCsvFile(path)
    case 'log':
      return viewLogFile(path, options)
    case 'pdf':
      return viewPdfFile(path)
    case 'docx':
      return viewDocxFile(path)
    case 'pptx':
      return viewPptxFile(path)
    case 'xlsx':
      return viewXlsxFile(path)
    case 'archive':
      return viewArchiveFile(path)
    case 'env':
      return viewEnvFile(path)
    case 'hex':
      return viewHexFile(path, options)
    case 'image':
      throw new Error('Use view_image for image files')
    default:
      return viewTextFile(path, options)
  }
}

export const extractFileText = async (path: string): Promise<string | undefined> => {
  const format = viewFormatForPath(path)
  if (format === 'image') return undefined
  const buffer = readFileSync(path)
  if (buffer.length > MAX_VIEW_ARCHIVE_BYTES) return undefined
  switch (format) {
    case 'pdf':
      return viewPdfFile(path)
    case 'docx':
      return viewDocxFile(path)
    case 'pptx':
      return viewPptxFile(path)
    case 'xlsx':
      return viewXlsxFile(path)
    case 'csv':
      return viewCsvFile(path)
    case 'yaml':
      return viewYamlFile(path)
    case 'json':
      return viewJsonFile(path)
    case 'archive':
      if (buffer[0] === 0x1f && buffer[1] === 0x8b) return extractTarText(gunzipSync(buffer))
      if (buffer.toString('ascii', 257, 262) === 'ustar') return extractTarText(buffer)
      return extractZipEntriesText(buffer)
    case 'env':
      return viewEnvFile(path)
    case 'log':
      return viewLogFile(path)
    default:
      if (containsBinaryContent(buffer)) return viewHexFile(path)
      return readFileSync(path, 'utf8')
  }
}

const extractZipEntriesText = async (buffer: Buffer): Promise<string> => {
  const archive = await JSZip.loadAsync(buffer)
  const entries = Object.values(archive.files).filter((file) => !file.dir).slice(0, MAX_VIEW_ARCHIVE_ENTRIES)
  const texts = await Promise.all(entries.map(async (file) => {
    const content = Buffer.from(await file.async('uint8array'))
    if (content.length > MAX_VIEW_TEXT_BYTES) return `${file.name} (${content.length} bytes, too large to preview)`
    if (containsBinaryContent(content)) return `${file.name} (${content.length} bytes, binary)`
    return `--- ${file.name} ---\n${content.toString('utf8').slice(0, 4_000)}`
  }))
  const extra = Object.keys(archive.files).filter((name) => !archive.files[name].dir).length - entries.length
  return truncateView(`${texts.join('\n\n')}${extra > 0 ? `\n\n... ${extra} more archive entries` : ''}`)
}
