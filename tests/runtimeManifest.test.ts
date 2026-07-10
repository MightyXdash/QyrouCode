import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getRuntimeArtifact,
  validateRuntimeArtifacts,
  type RuntimeArtifact
} from '../src/shared/runtimeManifest.js'

const baseArtifact: RuntimeArtifact = {
  id: 'llama.cpp-b9999-linux-x64-cpu',
  release: 'b9999',
  platform: 'linux',
  architecture: 'x64',
  backend: 'cpu',
  sourceUrl: 'https://github.com/ggml-org/llama.cpp/releases/download/b9999/llama-b9999-bin-ubuntu-x64.tar.gz',
  sha256: 'a'.repeat(64),
  executablePath: 'llama-server',
  companionLibraries: []
}

test('accepts a pinned runtime artifact and selects it by platform, architecture, and backend', () => {
  const artifacts = validateRuntimeArtifacts([baseArtifact])

  assert.equal(getRuntimeArtifact(artifacts, 'linux', 'x64', 'cpu'), baseArtifact)
  assert.equal(getRuntimeArtifact(artifacts, 'linux', 'arm64', 'cpu'), undefined)
})

test('rejects unpinned runtime URLs and hashes', () => {
  assert.throws(
    () => validateRuntimeArtifacts([{ ...baseArtifact, sourceUrl: 'http://example.test/llama.tar.gz' }]),
    /HTTPS/
  )
  assert.throws(
    () => validateRuntimeArtifacts([{ ...baseArtifact, sha256: 'not-a-sha256' }]),
    /SHA-256/
  )
})

test('rejects unsafe executable paths and duplicate runtime identities', () => {
  assert.throws(
    () => validateRuntimeArtifacts([{ ...baseArtifact, executablePath: '../llama-server' }]),
    /relative path/
  )
  assert.throws(
    () => validateRuntimeArtifacts([baseArtifact, { ...baseArtifact, id: 'duplicate-id' }]),
    /Duplicate runtime artifact/
  )
})
