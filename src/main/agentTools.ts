import { spawn } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import type { LocalToolDefinition } from './localCompletionClient'
import { availableSkills } from './agentPrompt'
import { formatWebSearchResults, NoApiWebClient, type WebFetchFormat } from './webSearch'

export interface AgentTaskRequest {
  description: string
  prompt: string
  subagentType: 'general' | 'explore'
}

export interface AgentToolboxOptions {
  projectPath: string
  signal?: AbortSignal
  readOnly?: boolean
  runTask?: (request: AgentTaskRequest) => Promise<string>
  webClient?: NoApiWebClient
}

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'low' | 'medium' | 'high'
}

interface PatchOperation {
  type: 'add' | 'delete' | 'update'
  path: string
  moveTo?: string
  lines: string[]
}

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_CHARACTERS = 48_000
const MAX_WALK_FILES = 10_000
const MAX_GREP_MATCHES = 200
const DEFAULT_READ_LINES = 2_000
const MAX_READ_LINES = 4_000
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const MAX_COMMAND_TIMEOUT_MS = 600_000
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.test-dist'])
const DANGEROUS_COMMAND = /(?:\brm\s+-rf\s+(?:\/|~)|\bRemove-Item\b[^\r\n]*-Recurse[^\r\n]*(?:[A-Za-z]:\\|\s\/)|\b(?:shutdown|reboot|format)\b|\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f))/i
const READ_ONLY_COMMAND = /^\s*(?:git\s+(?:status|diff|log|show|branch|rev-parse|ls-files)\b|rg\b|grep\b|find\b|ls\b|pwd\b|cat\b|head\b|tail\b|wc\b|Get-ChildItem\b|Get-Content\b|Select-String\b)/i
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch'])
const TASK_STATE_TOOL_NAME = 'cur_task_state'
const UI_MESSAGE_PROPERTY = {
  type: 'object',
  description: 'Required user-facing activity labels for this tool. Do not place a message directly under ui_message.',
  properties: {
    uim_prt: { type: 'string', description: 'Present-continuous first-person label describing the action in progress, such as “I’m reading the file”. Stay under six words.' },
    uim_pat: { type: 'string', description: 'Past-tense label describing the completed action. Stay under six words.' }
  },
  required: ['uim_prt', 'uim_pat'],
  additionalProperties: false
}

const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): LocalToolDefinition => {
  const generatesUiMessage = !WEB_TOOL_NAMES.has(name) && name !== TASK_STATE_TOOL_NAME
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: generatesUiMessage ? { ui_message: UI_MESSAGE_PROPERTY, ...properties } : properties,
      required: generatesUiMessage ? ['ui_message', ...required] : required,
      additionalProperties: false
    }
  }
}

const TOOL_DEFINITIONS: readonly LocalToolDefinition[] = [
  definition(TASK_STATE_TOOL_NAME, 'Share a user-visible update after thinking and before a meaningful tool-based substep. Call this only when the task state materially changes. Prefer neutral state language and do not default to first person.', {
    message: { type: 'string', description: 'A natural roughly 60–65-word user-facing task-state update. Prefer neutral phrasing; use first person only when genuinely natural. This is guidance, not a strict measured limit.' }
  }, ['message']),
  definition('read', 'Read a UTF-8 text file with line numbers. Use this before editing an existing file.', {
    filePath: { type: 'string', description: 'Workspace-relative or absolute file path' },
    offset: { type: 'integer', minimum: 1, description: 'First one-based line to return' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, description: 'Maximum lines to return' }
  }, ['filePath']),
  definition('list', 'List files and directories at a workspace path.', {
    path: { type: 'string', description: 'Workspace-relative directory, defaults to workspace root' },
    depth: { type: 'integer', minimum: 1, maximum: 8, description: 'Recursive depth, defaults to 2' }
  }),
  definition('glob', 'Find workspace files by glob pattern such as src/**/*.ts.', {
    pattern: { type: 'string' },
    path: { type: 'string', description: 'Workspace-relative search directory' }
  }, ['pattern']),
  definition('grep', 'Search text files with a JavaScript regular expression and return file paths, line numbers, and matching lines.', {
    pattern: { type: 'string' },
    path: { type: 'string', description: 'Workspace-relative search path' },
    include: { type: 'string', description: 'Optional file glob such as **/*.tsx' }
  }, ['pattern']),
  definition('edit', 'Perform an exact string replacement in a file already read during this run. The match must be unique unless replaceAll is true.', {
    filePath: { type: 'string' },
    oldString: { type: 'string' },
    newString: { type: 'string' },
    replaceAll: { type: 'boolean' }
  }, ['filePath', 'oldString', 'newString']),
  definition('write', 'Create or fully overwrite a UTF-8 file inside the workspace.', {
    filePath: { type: 'string' },
    content: { type: 'string' }
  }, ['filePath', 'content']),
  definition('apply_patch', 'Apply a safe stripped-down patch using *** Begin Patch, Add File, Update File, Delete File, optional Move to, and @@ hunks.', {
    patch: { type: 'string' }
  }, ['patch']),
  definition('bash', 'Run a non-interactive shell command in the workspace. Use this for builds, tests, package scripts, git inspection, and utilities.', {
    command: { type: 'string' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_COMMAND_TIMEOUT_MS }
  }, ['command']),
  definition('web_search', 'Search the public web through DuckDuckGo without an API key. Returns titles, URLs, and short snippets.', {
    query: { type: 'string' },
    maxResults: { type: 'integer', minimum: 1, maximum: 10 }
  }, ['query']),
  definition('web_fetch', 'Fetch a public HTTP or HTTPS page and return readable content. Private and loopback addresses are blocked.', {
    url: { type: 'string' },
    format: { type: 'string', enum: ['text', 'markdown', 'html'] }
  }, ['url']),
  definition('todo_write', 'Create or replace the structured task list for a multi-step coding session. Keep exactly one item in progress while work remains.', {
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] }
        },
        required: ['content', 'status', 'priority'],
        additionalProperties: false
      }
    }
  }, ['todos']),
  definition('todo_read', 'Read the current structured task list.', {}),
  definition('skill', 'Load a project skill by name when its specialized workflow matches the task.', {
    name: { type: 'string' }
  }, ['name']),
  definition('task', 'Launch a recursive local-model subagent for a concrete autonomous research or implementation task.', {
    description: { type: 'string', description: 'Short task label' },
    prompt: { type: 'string', description: 'Detailed instructions and expected result' },
    subagentType: { type: 'string', enum: ['general', 'explore'] }
  }, ['description', 'prompt', 'subagentType'])
]

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARACTERS) return value
  return `${value.slice(0, MAX_OUTPUT_CHARACTERS)}\n\n... output truncated (${value.length} characters total)`
}

function globPattern(value: string): RegExp {
  const normalized = value.replace(/\\/g, '/')
  let source = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]
    if (character === '*' && normalized[index + 1] === '*') {
      source += normalized[index + 2] === '/' ? '(?:.*/)?' : '.*'
      index += normalized[index + 2] === '/' ? 2 : 1
    } else if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

function stringArgument(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name]
  if (typeof value === 'string' && (!required || value.length > 0)) return value
  if (!required && value === undefined) return ''
  throw new Error(`${name} must be a ${required ? 'non-empty ' : ''}string`)
}

function integerArgument(args: Record<string, unknown>, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = args[name] ?? fallback
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  return Number(value)
}

function parsePatch(value: string): PatchOperation[] {
  const lines = value.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') throw new Error('Patch must start with *** Begin Patch and end with *** End Patch')
  const operations: PatchOperation[] = []
  let current: PatchOperation | undefined
  for (const line of lines.slice(1, -1)) {
    const header = line.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/)
    if (header) {
      current = { type: header[1].toLowerCase() as PatchOperation['type'], path: header[2].trim(), lines: [] }
      operations.push(current)
      continue
    }
    if (!current) {
      if (line) throw new Error('Patch content appeared before a file header')
      continue
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/)
    if (move && current.type === 'update') current.moveTo = move[1].trim()
    else current.lines.push(line)
  }
  if (!operations.length) throw new Error('Patch did not contain a file operation')
  return operations
}

function applyUpdate(content: string, lines: string[]): string {
  const hunks: string[][] = []
  let current: string[] | undefined
  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = []
      hunks.push(current)
    } else if (line === '*** End of File') continue
    else if (current) current.push(line)
  }
  if (!hunks.length) throw new Error('Update operation requires at least one @@ hunk')
  let next = content.replace(/\r\n/g, '\n')
  for (const hunk of hunks) {
    const oldValue = hunk.filter((line) => line.startsWith(' ') || line.startsWith('-')).map((line) => line.slice(1)).join('\n')
    const newValue = hunk.filter((line) => line.startsWith(' ') || line.startsWith('+')).map((line) => line.slice(1)).join('\n')
    const first = next.indexOf(oldValue)
    if (first === -1) throw new Error('Patch hunk did not match the target file')
    if (next.indexOf(oldValue, first + oldValue.length) !== -1) throw new Error('Patch hunk matched more than once; include more context')
    next = `${next.slice(0, first)}${newValue}${next.slice(first + oldValue.length)}`
  }
  return next
}

export class AgentToolbox {
  readonly definitions: readonly LocalToolDefinition[]
  private readonly root: string
  private readonly rootRealPath: string
  private readonly webClient: NoApiWebClient
  private readonly readPaths = new Set<string>()
  private todos: TodoItem[] = []

  constructor(private readonly options: AgentToolboxOptions) {
    this.root = resolve(options.projectPath)
    if (!existsSync(this.root) || !statSync(this.root).isDirectory()) throw new Error('Agent workspace does not exist')
    this.rootRealPath = realpathSync(this.root)
    this.webClient = options.webClient ?? new NoApiWebClient()
    const mutable = new Set(['edit', 'write', 'apply_patch'])
    this.definitions = TOOL_DEFINITIONS.filter((tool) => !options.readOnly || !mutable.has(tool.name))
      .filter((tool) => tool.name !== 'task' || options.runTask)
  }

  private path(value = '.'): string {
    const target = resolve(this.root, value)
    const relation = relative(this.root, target)
    if (relation.startsWith(`..${sep}`) || relation === '..' || isAbsolute(relation)) throw new Error('Path is outside the workspace')
    let ancestor = target
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
    const realAncestor = realpathSync(ancestor)
    const realRelation = relative(this.rootRealPath, realAncestor)
    if (realRelation.startsWith(`..${sep}`) || realRelation === '..' || isAbsolute(realRelation)) throw new Error('Path resolves outside the workspace')
    return target
  }

  private files(start: string): string[] {
    if (!existsSync(start)) return []
    if (lstatSync(start).isFile()) return [start]
    const files: string[] = []
    const pending = [start]
    while (pending.length && files.length < MAX_WALK_FILES) {
      const directory = pending.pop() as string
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const path = resolve(directory, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(path)
        } else if (entry.isFile()) files.push(path)
        if (files.length >= MAX_WALK_FILES) break
      }
    }
    return files
  }

  private relativePath(path: string): string {
    return relative(this.root, path).replace(/\\/g, '/') || '.'
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    this.options.signal?.throwIfAborted()
    switch (name) {
      case TASK_STATE_TOOL_NAME: return 'Current task state shared with the user.'
      case 'read': return this.read(args)
      case 'list': return this.list(args)
      case 'glob': return this.glob(args)
      case 'grep': return this.grep(args)
      case 'edit': return this.edit(args)
      case 'write': return this.write(args)
      case 'apply_patch': return this.applyPatch(args)
      case 'bash': return this.bash(args)
      case 'web_search': return formatWebSearchResults(await this.webClient.search(stringArgument(args, 'query'), integerArgument(args, 'maxResults', 5, 1, 10), this.options.signal))
      case 'web_fetch': return truncate(await this.webClient.fetch(stringArgument(args, 'url'), (args['format'] ?? 'markdown') as WebFetchFormat, this.options.signal))
      case 'todo_write': return this.writeTodos(args)
      case 'todo_read': return this.readTodos()
      case 'skill': return this.skill(args)
      case 'task': return this.task(args)
      default: throw new Error(`Unknown tool: ${name}`)
    }
  }

  private read(args: Record<string, unknown>): string {
    const path = this.path(stringArgument(args, 'filePath'))
    if (/\.env(?:\.|$)/i.test(path) && !/\.env\.example$/i.test(path)) throw new Error('Reading environment secret files is blocked')
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error('File does not exist')
    if (statSync(path).size > MAX_FILE_BYTES) throw new Error('File exceeds the read size limit')
    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    const offset = integerArgument(args, 'offset', 1, 1, Math.max(lines.length, 1))
    const limit = integerArgument(args, 'limit', DEFAULT_READ_LINES, 1, MAX_READ_LINES)
    this.readPaths.add(path)
    return truncate(lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`).join('\n'))
  }

  private list(args: Record<string, unknown>): string {
    const start = this.path(stringArgument(args, 'path', false) || '.')
    const depth = integerArgument(args, 'depth', 2, 1, 8)
    if (!existsSync(start) || !statSync(start).isDirectory()) throw new Error('Directory does not exist')
    const output: string[] = []
    const visit = (directory: string, level: number): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '.git') continue
        const path = resolve(directory, entry.name)
        output.push(`${'  '.repeat(level)}${entry.name}${entry.isDirectory() ? '/' : ''}`)
        if (entry.isDirectory() && !entry.isSymbolicLink() && level + 1 < depth && !IGNORED_DIRECTORIES.has(entry.name)) visit(path, level + 1)
      }
    }
    visit(start, 0)
    return truncate(output.join('\n') || '(empty directory)')
  }

  private glob(args: Record<string, unknown>): string {
    const start = this.path(stringArgument(args, 'path', false) || '.')
    const pattern = globPattern(stringArgument(args, 'pattern'))
    const matches = this.files(start).map((path) => this.relativePath(path)).filter((path) => pattern.test(path) || pattern.test(path.slice(this.relativePath(start).length + 1))).sort()
    return truncate(matches.join('\n') || 'No files matched the pattern.')
  }

  private grep(args: Record<string, unknown>): string {
    const start = this.path(stringArgument(args, 'path', false) || '.')
    const expression = new RegExp(stringArgument(args, 'pattern'))
    const include = typeof args['include'] === 'string' && args['include'] ? globPattern(args['include']) : undefined
    const matches: string[] = []
    for (const path of this.files(start)) {
      const relativePath = this.relativePath(path)
      if (include && !include.test(relativePath)) continue
      const stats = statSync(path)
      if (stats.size > MAX_FILE_BYTES) continue
      let content: string
      try { content = readFileSync(path, 'utf8') } catch { continue }
      if (content.includes('\0')) continue
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        expression.lastIndex = 0
        if (expression.test(line)) matches.push(`${relativePath}:${index + 1}: ${line}`)
        if (matches.length >= MAX_GREP_MATCHES) return truncate(`${matches.join('\n')}\n... match limit reached`)
      }
    }
    return matches.join('\n') || 'No matches found.'
  }

  private assertMutable(): void {
    if (this.options.readOnly) throw new Error('This subagent is read-only')
  }

  private edit(args: Record<string, unknown>): string {
    this.assertMutable()
    const path = this.path(stringArgument(args, 'filePath'))
    if (!this.readPaths.has(path)) throw new Error('Read the file before editing it')
    const oldString = stringArgument(args, 'oldString')
    const newString = stringArgument(args, 'newString', false)
    const content = readFileSync(path, 'utf8')
    const first = content.indexOf(oldString)
    if (first === -1) throw new Error('oldString not found in content')
    const replaceAll = args['replaceAll'] === true
    if (!replaceAll && content.indexOf(oldString, first + oldString.length) !== -1) throw new Error('Found multiple matches for oldString. Include more context or set replaceAll.')
    writeFileSync(path, replaceAll ? content.split(oldString).join(newString) : `${content.slice(0, first)}${newString}${content.slice(first + oldString.length)}`, 'utf8')
    return `Updated ${this.relativePath(path)}`
  }

  private write(args: Record<string, unknown>): string {
    this.assertMutable()
    const path = this.path(stringArgument(args, 'filePath'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, stringArgument(args, 'content', false), 'utf8')
    return `Wrote ${this.relativePath(path)}`
  }

  private applyPatch(args: Record<string, unknown>): string {
    this.assertMutable()
    const operations = parsePatch(stringArgument(args, 'patch'))
    const writes = new Map<string, string>()
    const deletes = new Set<string>()
    for (const operation of operations) {
      const path = this.path(operation.path)
      if (operation.type === 'add') {
        if (existsSync(path)) throw new Error(`Add target already exists: ${operation.path}`)
        if (operation.lines.some((line) => !line.startsWith('+'))) throw new Error('Every added-file content line must start with +')
        writes.set(path, operation.lines.map((line) => line.slice(1)).join('\n'))
      } else if (operation.type === 'delete') {
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Delete target does not exist: ${operation.path}`)
        deletes.add(path)
      } else {
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Update target does not exist: ${operation.path}`)
        const target = operation.moveTo ? this.path(operation.moveTo) : path
        writes.set(target, applyUpdate(readFileSync(path, 'utf8'), operation.lines))
        if (target !== path) deletes.add(path)
      }
    }
    for (const [path, content] of writes) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf8')
    }
    for (const path of deletes) if (!writes.has(path) && existsSync(path)) rmSync(path)
    return `Applied ${operations.length} patch operation${operations.length === 1 ? '' : 's'}`
  }

  private bash(args: Record<string, unknown>): Promise<string> {
    const command = stringArgument(args, 'command')
    if (DANGEROUS_COMMAND.test(command)) throw new Error('Command is blocked because it can destructively remove system or repository data')
    if (this.options.readOnly && !READ_ONLY_COMMAND.test(command)) throw new Error('Exploration subagents may only run read-only inspection commands')
    const timeoutMs = integerArgument(args, 'timeoutMs', DEFAULT_COMMAND_TIMEOUT_MS, 1, MAX_COMMAND_TIMEOUT_MS)
    const executable = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
    const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command]
    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, shellArgs, { cwd: this.root, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill(), timeoutMs)
      const abort = () => child.kill()
      this.options.signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => { stdout = truncate(stdout + chunk.toString()) })
      child.stderr.on('data', (chunk: Buffer) => { stderr = truncate(stderr + chunk.toString()) })
      child.once('error', reject)
      child.once('exit', (code) => {
        clearTimeout(timer)
        this.options.signal?.removeEventListener('abort', abort)
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
        resolvePromise(truncate(`${output || '(no output)'}\n\nExit code: ${code ?? 'terminated'}`))
      })
    })
  }

  private writeTodos(args: Record<string, unknown>): string {
    const value = args['todos']
    if (!Array.isArray(value)) throw new Error('todos must be an array')
    const todos = value.map((item) => {
      if (!item || typeof item !== 'object') throw new Error('Each todo must be an object')
      const candidate = item as Partial<TodoItem>
      if (typeof candidate.content !== 'string' || !['pending', 'in_progress', 'completed', 'cancelled'].includes(candidate.status ?? '') || !['low', 'medium', 'high'].includes(candidate.priority ?? '')) throw new Error('Invalid todo item')
      return candidate as TodoItem
    })
    if (todos.filter((todo) => todo.status === 'in_progress').length > 1) throw new Error('Only one todo may be in progress')
    this.todos = todos
    return this.readTodos()
  }

  private readTodos(): string {
    return this.todos.length ? this.todos.map((todo, index) => `${index + 1}. [${todo.status}] (${todo.priority}) ${todo.content}`).join('\n') : 'No todos have been recorded.'
  }

  private skill(args: Record<string, unknown>): string {
    const name = stringArgument(args, 'name')
    const skill = availableSkills(this.root).find((candidate) => candidate.name === name)
    if (!skill) throw new Error(`Unknown skill: ${name}`)
    return truncate(readFileSync(skill.path, 'utf8'))
  }

  private task(args: Record<string, unknown>): Promise<string> {
    if (!this.options.runTask) throw new Error('Subagents are unavailable')
    const subagentType = args['subagentType']
    if (subagentType !== 'general' && subagentType !== 'explore') throw new Error('subagentType must be general or explore')
    return this.options.runTask({
      description: stringArgument(args, 'description'),
      prompt: stringArgument(args, 'prompt'),
      subagentType
    })
  }
}
