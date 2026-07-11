import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentToolbox } from '../src/main/agentTools.js'

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
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})
