import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  resolveModelArtifact,
  type ModelArtifact
} from '../src/main/modelResolver.js'

const artifact: ModelArtifact = {
  id: 'test-model',
  repository: 'example/test-model',
  revision: '0123456789abcdef0123456789abcdef01234567',
  filename: 'test-model.gguf',
  sizeBytes: 8,
  sha256: createHash('sha256').update(Buffer.from('GGUFtest')).digest('hex')
}

const createFixture = (): { hubPath: string; modelPath: string } => {
  const hubPath = mkdtempSync(join(tmpdir(), 'supracode-model-resolver-'))
  const snapshotsPath = join(
    hubPath,
    'models--example--test-model',
    'snapshots',
    artifact.revision
  )
  mkdirSync(snapshotsPath, { recursive: true })
  const modelPath = join(snapshotsPath, artifact.filename)
  writeFileSync(modelPath, Buffer.from('GGUFtest'))
  return { hubPath, modelPath }
}

test('resolves one exact GGUF artifact beneath its pinned cache snapshot', async () => {
  const { hubPath, modelPath } = createFixture()

  const resolved = await resolveModelArtifact(hubPath, artifact)

  assert.equal(resolved.path, realpathSync(modelPath))
  assert.equal(resolved.artifact, artifact)
  assert.equal(resolved.mmprojPath, undefined)
})

test('rejects missing, partial, and path-traversing model artifacts', async () => {
  const { hubPath, modelPath } = createFixture()

  await assert.rejects(resolveModelArtifact(hubPath, { ...artifact, filename: 'missing.gguf' }), /does not exist/)
  writeFileSync(modelPath + '.part', Buffer.from('GGUFtest'))
  await assert.rejects(resolveModelArtifact(hubPath, { ...artifact, filename: artifact.filename + '.part' }), /GGUF file/)
  await assert.rejects(resolveModelArtifact(hubPath, { ...artifact, filename: '../outside.gguf' }), /filename/)
})

test('rejects wrong GGUF headers, sizes, and hashes', async () => {
  const { hubPath, modelPath } = createFixture()

  writeFileSync(modelPath, Buffer.from('NOTGtest'))
  await assert.rejects(resolveModelArtifact(hubPath, artifact), /GGUF header/)
  writeFileSync(modelPath, Buffer.from('GGUFdifferent'))
  await assert.rejects(resolveModelArtifact(hubPath, artifact), /size/)
  writeFileSync(modelPath, Buffer.from('GGUFtest'))
  await assert.rejects(resolveModelArtifact(hubPath, { ...artifact, sha256: 'b'.repeat(64) }), /SHA-256/)
})

test('resolves and verifies the declared vision projector alongside the model', async () => {
  const { hubPath } = createFixture()
  const snapshotsPath = join(
    hubPath,
    'models--example--test-model',
    'snapshots',
    artifact.revision
  )
  const projectorPath = join(snapshotsPath, 'mmproj-vision-f16.gguf')
  const projectorBytes = Buffer.from('GGUFprojector')
  writeFileSync(projectorPath, projectorBytes)
  const projectorArtifact = {
    filename: 'mmproj-vision-f16.gguf',
    sizeBytes: projectorBytes.length,
    sha256: createHash('sha256').update(projectorBytes).digest('hex')
  }

  const resolved = await resolveModelArtifact(hubPath, { ...artifact, mmproj: projectorArtifact })
  assert.equal(resolved.mmprojPath, realpathSync(projectorPath))

  await assert.rejects(
    resolveModelArtifact(hubPath, { ...artifact, mmproj: { ...projectorArtifact, sizeBytes: 1 } }),
    /projector size/
  )
  await assert.rejects(
    resolveModelArtifact(hubPath, { ...artifact, mmproj: { ...projectorArtifact, sha256: 'c'.repeat(64) } }),
    /projector SHA-256/
  )
  await assert.rejects(
    resolveModelArtifact(hubPath, { ...artifact, mmproj: { ...projectorArtifact, filename: 'mmproj-missing.gguf' } }),
    /projector does not exist/
  )
})
