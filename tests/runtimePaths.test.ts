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
  backend: 'cpu',
  sourceUrl: 'https://example.test/runtime.tar.gz',
  sha256: 'a'.repeat(64),
  executablePath: 'llama-server',
  companionLibraries: []
}

test('derives development and packaged runtime paths from the same artifact identity', () => {
  assert.equal(
    developmentRuntimeDirectory('/workspace/SupraCode', artifact),
    join('/workspace/SupraCode', 'vendor', 'llama.cpp', 'linux-x64')
  )
  assert.equal(
    packagedRuntimeExecutable('/opt/SupraCode/resources', artifact),
    join('/opt/SupraCode/resources', 'llama.cpp', 'linux-x64', 'llama-server')
  )
})
