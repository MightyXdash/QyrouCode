import type { LocalToolCall } from './localCompletionClient'

interface ToolCallShape {
  name?: unknown
  arguments?: unknown
  parameters?: unknown
  input?: unknown
}

const TOOL_NAME_PATTERN = '[A-Za-z_][\\w.-]*'

function asArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function normalizeShape(value: unknown, index: number): LocalToolCall | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as ToolCallShape
  if (typeof candidate.name !== 'string' || !candidate.name) return undefined
  return {
    id: `healed_call_${index + 1}`,
    name: candidate.name,
    arguments: asArguments(candidate.arguments ?? candidate.parameters ?? candidate.input)
  }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return undefined }
}

function jsonCalls(value: string): LocalToolCall[] {
  const parsed = parseJson(value.trim())
  const candidates = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  return candidates.map(normalizeShape).filter((call): call is LocalToolCall => call !== undefined)
}

function taggedJsonCalls(value: string): LocalToolCall[] {
  const calls: LocalToolCall[] = []
  const pattern = /<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/g
  for (const match of value.matchAll(pattern)) {
    const call = normalizeShape(parseJson(match[1]), calls.length)
    if (call) calls.push(call)
  }
  return calls
}

function functionXmlCalls(value: string): LocalToolCall[] {
  const calls: LocalToolCall[] = []
  const pattern = new RegExp(`<function(?:=(${TOOL_NAME_PATTERN})|\\s+name="(${TOOL_NAME_PATTERN})")>([\\s\\S]*?)<\\/function>`, 'g')
  for (const match of value.matchAll(pattern)) {
    const args: Record<string, unknown> = {}
    const parameterPattern = /<(?:parameter|param)(?:=([\w.-]+)|\s+name="([\w.-]+)")>([\s\S]*?)<\/(?:parameter|param)>/g
    for (const parameter of match[3].matchAll(parameterPattern)) {
      const raw = parameter[3].trim()
      args[parameter[1] ?? parameter[2]] = parseJson(raw) ?? raw
    }
    calls.push({ id: `healed_call_${calls.length + 1}`, name: match[1] ?? match[2], arguments: args })
  }
  return calls
}

function glmCalls(value: string): LocalToolCall[] {
  const calls: LocalToolCall[] = []
  const pattern = new RegExp(`<tool_call>\\s*(${TOOL_NAME_PATTERN})([\\s\\S]*?)<\\/tool_call>`, 'g')
  for (const match of value.matchAll(pattern)) {
    if (match[2].trimStart().startsWith('{')) continue
    const args: Record<string, unknown> = {}
    const argumentPattern = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g
    for (const argument of match[2].matchAll(argumentPattern)) {
      const raw = argument[2].trim()
      args[argument[1].trim()] = parseJson(raw) ?? raw
    }
    calls.push({ id: `healed_call_${calls.length + 1}`, name: match[1], arguments: args })
  }
  return calls
}

function mistralCalls(value: string): LocalToolCall[] {
  const trigger = value.lastIndexOf('[TOOL_CALLS]')
  if (trigger === -1) return []
  const body = value.slice(trigger + '[TOOL_CALLS]'.length).trim()
  const direct = jsonCalls(body.replace(/<\/s>\s*$/, ''))
  if (direct.length) return direct
  const calls: LocalToolCall[] = []
  const pattern = new RegExp(`(${TOOL_NAME_PATTERN})(?:\\[CALL_ID\\][^\\s\\[]+)?(?:\\[ARGS\\])?\\s*({[^\\r\\n]*})`, 'g')
  for (const match of body.matchAll(pattern)) {
    calls.push({ id: `healed_call_${calls.length + 1}`, name: match[1], arguments: asArguments(match[2]) })
  }
  return calls
}

function gemmaCalls(value: string): LocalToolCall[] {
  const calls: LocalToolCall[] = []
  const pattern = new RegExp(`(?:<\\|tool_call>\\s*)?call\\s*:\\s*(${TOOL_NAME_PATTERN})\\s*({[^\\r\\n]*})(?:<tool_call\\|>)?`, 'g')
  for (const match of value.matchAll(pattern)) {
    const normalized = match[2]
      .replace(/<\|"\|>/g, '"')
      .replace(/([{,]\s*)([A-Za-z_][\w.-]*)(\s*:)/g, '$1"$2"$3')
      .replace(/'([^']*)'/g, (_, content: string) => JSON.stringify(content))
    calls.push({ id: `healed_call_${calls.length + 1}`, name: match[1], arguments: asArguments(normalized) })
  }
  return calls
}

function envelopeCalls(value: string): LocalToolCall[] {
  const calls: LocalToolCall[] = []
  const deepSeekPattern = new RegExp(`<｜tool▁call▁begin｜>(?:function<｜tool▁sep｜>)?(${TOOL_NAME_PATTERN})<｜tool▁sep｜>\\s*(?:\`\`\`json\\s*)?({[\\s\\S]*?})(?:\\s*\`\`\`)?<｜tool▁call▁end｜>`, 'g')
  for (const match of value.matchAll(deepSeekPattern)) {
    calls.push({ id: `healed_call_${calls.length + 1}`, name: match[1], arguments: asArguments(match[2]) })
  }
  const kimiPattern = new RegExp(`<\\|tool_call_begin\\|>(?:functions\\.)?(${TOOL_NAME_PATTERN})(?::\\d+)?<\\|tool_call_argument_begin\\|>\\s*({[\\s\\S]*?})<\\|tool_call_end\\|>`, 'g')
  for (const match of value.matchAll(kimiPattern)) {
    calls.push({ id: `healed_call_${calls.length + 1}`, name: match[1], arguments: asArguments(match[2]) })
  }
  return calls
}

function pythonTagCalls(value: string): LocalToolCall[] {
  const calls: LocalToolCall[] = []
  const jsonStart = value.indexOf('<|python_tag|>')
  if (jsonStart === -1) return calls
  const body = value.slice(jsonStart + '<|python_tag|>'.length).trim()
  const direct = jsonCalls(body)
  if (direct.length) return direct
  const pattern = new RegExp(`(${TOOL_NAME_PATTERN})\\s*\\.\\s*call\\(([^)]*)\\)`, 'g')
  for (const match of body.matchAll(pattern)) {
    const args: Record<string, unknown> = {}
    for (const pair of match[2].split(/,\s*(?=[A-Za-z_]\w*\s*=)/)) {
      const separator = pair.indexOf('=')
      if (separator === -1) continue
      const key = pair.slice(0, separator).trim()
      const raw = pair.slice(separator + 1).trim().replace(/^'|'$/g, '"')
      args[key] = parseJson(raw) ?? raw
    }
    calls.push({ id: `healed_call_${calls.length + 1}`, name: match[1], arguments: args })
  }
  return calls
}

export function parseHealedToolCalls(value: string, allowedNames?: ReadonlySet<string>): LocalToolCall[] {
  const parsers = [taggedJsonCalls, functionXmlCalls, glmCalls, mistralCalls, envelopeCalls, pythonTagCalls, gemmaCalls, jsonCalls]
  for (const parser of parsers) {
    const calls = parser(value).filter((call) => !allowedNames || allowedNames.has(call.name))
    if (calls.length) return calls
  }
  return []
}

export function stripToolCallMarkup(value: string): string {
  const signals = ['<tool_call>', '<function=', '<function name=', '<|python_tag|>', '[TOOL_CALLS]', '<|tool_call>', '<｜tool▁calls▁begin｜>', '<｜tool▁call▁begin｜>', '<|tool_calls_section_begin|>', '<|tool_call_begin|>']
  const offsets = signals.map((signal) => value.indexOf(signal)).filter((offset) => offset >= 0)
  if (!offsets.length) return value.trim()
  return value.slice(0, Math.min(...offsets)).trim()
}
