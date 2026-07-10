import assert from 'node:assert/strict'
import test from 'node:test'
import { INITIAL_MODEL_ARTIFACTS, getModelArtifact } from '../src/shared/modelManifest.js'

test('pins the first-run Qwen GGUF to an immutable revision, size, and SHA-256', () => {
  const artifact = getModelArtifact(INITIAL_MODEL_ARTIFACTS, 'qwen3_5_4b_q4km')

  assert.equal(artifact?.repository, 'hinny/Qwen3.5-4B-GGUF-Q4_K_M')
  assert.equal(artifact?.revision, '2ac4eb93304ceeba92a2776fec0f862e390b90c2')
  assert.equal(artifact?.filename, 'Qwen3.5-4B-Q4_K_M.gguf')
  assert.equal(artifact?.sizeBytes, 2707514080)
  assert.equal(artifact?.sha256, '26b1d83e22463de5cb72b7750bd8de229f9f99a989a63cb12783fd295467c9bd')
})
