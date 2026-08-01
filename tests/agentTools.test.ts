import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentToolbox } from '../src/main/agentTools.js'
import type { AgentTerminalController } from '../src/main/terminalManager.js'

const terminalController = {} as AgentTerminalController

test('non-web tools require a compact UI message while web tools do not', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-tools-'))
  try {
    const tools = new AgentToolbox({ projectPath })
    for (const definition of tools.definitions) {
      const parameters = definition.parameters as { properties: Record<string, unknown>; required: string[] }
      if (definition.name === 'web_search' || definition.name === 'web_fetch' || definition.name === 'cur_task_state') {
        assert.equal(parameters.properties.ui_message, undefined)
        assert.ok(!parameters.required.includes('ui_message'))
      } else {
        const uiMessage = parameters.properties.ui_message as { type?: string; required?: string[]; properties?: Record<string, unknown> }
        assert.equal(uiMessage.type, 'object')
        assert.deepEqual(uiMessage.required, ['uim_prt', 'uim_pat'])
        assert.deepEqual(Object.keys(uiMessage.properties ?? {}), ['uim_prt', 'uim_pat'])
        assert.ok(parameters.required.includes('ui_message'))
      }
    }
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('visible terminal tools are available only to the root toolbox with a terminal controller', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-tools-'))
  try {
    const rootNames = new Set(new AgentToolbox({ projectPath, terminalController }).definitions.map((tool) => tool.name))
    const ordinaryNames = new Set(new AgentToolbox({ projectPath }).definitions.map((tool) => tool.name))
    const readOnlyNames = new Set(new AgentToolbox({ projectPath, terminalController, readOnly: true }).definitions.map((tool) => tool.name))
    for (const name of ['terminal_create', 'terminal_run', 'terminal_read', 'terminal_wait', 'terminal_request_user_input', 'open_url', 'launch_app']) {
      assert.equal(rootNames.has(name), true)
      assert.equal(ordinaryNames.has(name), false)
      assert.equal(readOnlyNames.has(name), false)
    }
    assert.equal(rootNames.has('terminal_show'), false)
    const rootDefinitions = new Map(new AgentToolbox({ projectPath, terminalController }).definitions.map((tool) => [tool.name, tool]))
    const runParameters = rootDefinitions.get('terminal_run')?.parameters as { properties: Record<string, unknown>; required: string[] }
    const launchParameters = rootDefinitions.get('launch_app')?.parameters as { properties: Record<string, unknown>; required: string[] }
    assert.equal(runParameters.properties.user_message, undefined)
    assert.equal(runParameters.required.includes('user_message'), false)
    assert.equal(launchParameters.required.includes('user_message'), true)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('coding tools read, search, edit, write, and patch inside the workspace', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-tools-'))
  try {
    writeFileSync(join(projectPath, 'app.ts'), 'export const value = 1\n', 'utf8')
    const tools = new AgentToolbox({ projectPath })
    assert.match(await tools.execute('read', { filePath: 'app.ts' }), /1: export const value = 1/)
    assert.equal(await tools.execute('edit', { filePath: 'app.ts', oldString: 'value = 1', newString: 'value = 2' }), 'Updated app.ts')
    assert.match(await tools.execute('grep', { pattern: 'value = 2', include: '**/*.ts' }), /app\.ts:1/)
    assert.match(await tools.execute('glob', { pattern: '**/*.ts' }), /app\.ts/)
    await tools.execute('write', { filePath: 'src/new.ts', content: 'export const added = true\n' })
    await tools.execute('apply_patch', { patch: '*** Begin Patch\n*** Update File: src/new.ts\n@@\n-export const added = true\n+export const added = false\n*** Add File: note.txt\n+done\n*** End Patch' })
    assert.equal(readFileSync(join(projectPath, 'src', 'new.ts'), 'utf8'), 'export const added = false\n')
    assert.equal(readFileSync(join(projectPath, 'note.txt'), 'utf8'), 'done')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('coding tools block workspace escapes and destructive commands', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-tools-'))
  try {
    const tools = new AgentToolbox({ projectPath })
    await assert.rejects(tools.execute('read', { filePath: '../secret.txt' }), /outside the workspace/)
    await assert.rejects(tools.execute('bash', { command: 'git reset --hard' }), /blocked/)
    await assert.rejects(tools.execute('view_file', { path: '../secret.txt' }), /outside the workspace/)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('view tools dispatch by format and redact env values', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-tools-'))
  try {
    writeFileSync(join(projectPath, 'data.json'), '{"b":2,"a":1}', 'utf8')
    writeFileSync(join(projectPath, 'app.log'), 'one\ntwo\nthree\n', 'utf8')
    writeFileSync(join(projectPath, '.env'), 'SECRET=supersecret\n', 'utf8')
    const tools = new AgentToolbox({ projectPath })
    assert.equal(await tools.execute('view_file', { path: 'data.json' }), '{\n  "b": 2,\n  "a": 1\n}')
    assert.equal(await tools.execute('view_text', { path: 'app.log', offset: 2, limit: 1 }), '2: two')
    assert.equal(await tools.execute('view_log', { path: 'app.log', offset: 1, limit: 2 }), '1: one\n2: two')
    const envOutput = await tools.execute('view_env', { path: '.env' })
    assert.ok(envOutput.includes('SECRET'))
    assert.ok(!envOutput.includes('supersecret'))
    const envViaFile = await tools.execute('view_file', { path: '.env' })
    assert.ok(envViaFile.includes('SECRET'))
    assert.ok(!envViaFile.includes('supersecret'))
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('view_image captures an image for consumption with vision', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-tools-'))
  try {
    writeFileSync(join(projectPath, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]))
    const tools = new AgentToolbox({ projectPath })
    const result = await tools.execute('view_image', { path: 'shot.png' })
    assert.match(result, /Loaded image for review/)
    const image = tools.consumeImage()
    assert.ok(image)
    assert.ok(image.dataUrl.startsWith('data:image/png;base64,'))
    assert.equal(image.alt, 'shot.png')
    assert.equal(tools.consumeImage(), undefined)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('view_screenshot is available only with a capture callback', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'supracode-tools-'))
  try {
    const plain = new AgentToolbox({ projectPath })
    assert.ok(!plain.definitions.some((tool) => tool.name === 'view_screenshot'))
    await assert.rejects(plain.execute('view_screenshot', {}), /unavailable/)
    let captured = false
    const tools = new AgentToolbox({
      projectPath,
      captureScreenshot: async () => {
        captured = true
        return 'data:image/png;base64,QUJD'
      }
    })
    assert.ok(tools.definitions.some((tool) => tool.name === 'view_screenshot'))
    const result = await tools.execute('view_screenshot', {})
    assert.match(result, /Captured the embedded browser panel/)
    assert.equal(captured, true)
    const image = tools.consumeImage()
    assert.ok(image)
    assert.equal(image.dataUrl, 'data:image/png;base64,QUJD')
    assert.equal(image.alt, 'Browser screenshot')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})
