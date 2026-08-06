import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  developmentRuntimeDirectory,
  packagedRuntimeExecutable
} from '../src/main/runtimePaths.js'
import type { RuntimeArtifact } from '../src/shared/runtimeManifest.js'

const artifact: RuntimeArtifact = {
  id: 'runtime',
  release: 'b1',
  platform: 'linux',
  architecture: 'x64',
  backend: 'cuda',
  sourceUrl: 'https://example.test/runtime.tar.gz',
  sha256: 'a'.repeat(64),
  executablePath: 'llama-server',
  companionLibraries: []
}

test('keeps accelerated runtime paths distinct by backend', () => {
  assert.equal(
    developmentRuntimeDirectory('/workspace/QyrouCode', artifact),
    join('/workspace/QyrouCode', 'vendor', 'llama.cpp', 'linux-x64-cuda')
  )
  assert.equal(
    packagedRuntimeExecutable('/opt/QyrouCode/resources', artifact),
    join('/opt/QyrouCode/resources', 'llama.cpp', 'linux-x64-cuda', 'llama-server')
  )
})

test('keeps the CPU fallback separate from accelerated runtimes', () => {
  assert.equal(
    developmentRuntimeDirectory('/workspace/QyrouCode', { ...artifact, backend: 'cpu' }),
    join('/workspace/QyrouCode', 'vendor', 'llama.cpp', 'linux-x64-cpu')
  )
})
