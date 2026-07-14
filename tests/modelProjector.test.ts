import assert from 'node:assert/strict'
import test from 'node:test'
import { getExternalProjectorSource, isModelProjectorFile, isModelWeightsFile, selectModelProjectorFile } from '../src/shared/modelProjector.js'

test('distinguishes model weights from multimodal projectors', () => {
  assert.equal(isModelWeightsFile('Qwen3.5-4B-Q4_K_M.gguf'), true)
  assert.equal(isModelWeightsFile('mmproj-BF16.gguf'), false)
  assert.equal(isModelProjectorFile('vision/projector-model.gguf'), true)
})

test('selects the preferred bundled projector without mutating the model tree', () => {
  const tree = [
    { path: 'mmproj-F32.gguf', size: 3 },
    { path: 'mmproj-BF16.gguf', size: 2 },
    { path: 'mmproj-F16.gguf', size: 1 }
  ]

  assert.equal(selectModelProjectorFile(tree), 'mmproj-F16.gguf')
  assert.deepEqual(tree.map((entry) => entry.path), ['mmproj-F32.gguf', 'mmproj-BF16.gguf', 'mmproj-F16.gguf'])
})

test('provides external projectors for vision models whose weights repositories omit them', () => {
  assert.deepEqual(getExternalProjectorSource('hinny/Qwen3.5-4B-GGUF-Q4_K_M'), {
    repository: 'unsloth/Qwen3.5-4B-GGUF',
    path: 'mmproj-BF16.gguf'
  })
  assert.equal(getExternalProjectorSource('google/gemma-4-E2B-it-qat-q4_0-gguf'), undefined)
})
