import assert from 'node:assert/strict'
import test from 'node:test'
import { FIRST_LOAD_CONTEXT_TOKENS, backendAppearsInDeviceList, buildLlamaServerArgs, type LlamaLaunchProfile } from '../src/shared/llama.js'

const baseProfile: LlamaLaunchProfile = {
  platform: 'darwin',
  backend: 'metal',
  modelPath: '/models/code.gguf',
  contextTokens: 72000,
  logicalCpuCount: 12,
  availableMemoryBytes: 32 * 1024 ** 3,
  modelSizeBytes: 8 * 1024 ** 3
}

test('keeps the first model-load profile conservative until onboarding settings are applied', () => {
  assert.equal(FIRST_LOAD_CONTEXT_TOKENS, 8192)
})

test('configures accelerated inference with bounded batching and quantized KV cache', () => {
  const args = buildLlamaServerArgs(baseProfile)
  assert.deepEqual(args.slice(0, 2), ['--model', baseProfile.modelPath])
  assert.ok(args.includes('auto'))
  assert.ok(args.includes('q8_0'))
  assert.ok(args.includes('--cont-batching'))
  assert.equal(args[args.indexOf('--threads') + 1], '6')
})

test('recognizes numbered CUDA and Vulkan devices from llama-server probes', () => {
  assert.equal(backendAppearsInDeviceList('cuda', 'Available devices:\n  CUDA0: NVIDIA GeForce RTX 4090'), true)
  assert.equal(backendAppearsInDeviceList('vulkan', 'Available devices:\n  Vulkan1: NVIDIA GeForce RTX 3090'), true)
  assert.equal(backendAppearsInDeviceList('cuda', 'Available devices:\n  CPU: 32 cores'), false)
})

test('allows an isolated port for auxiliary model runtimes', () => {
  const args = buildLlamaServerArgs({ ...baseProfile, port: 39282 })
  assert.equal(args[args.indexOf('--port') + 1], '39282')
})

test('uses CPU and NUMA configuration for Linux CPU inference', () => {
  const args = buildLlamaServerArgs({ ...baseProfile, platform: 'linux', backend: 'cpu' })
  assert.equal(args[args.indexOf('--n-gpu-layers') + 1], '0')
  assert.equal(args[args.indexOf('--numa') + 1], 'distribute')
})

test('reduces batch memory when the model and context approach available memory', () => {
  const args = buildLlamaServerArgs({
    ...baseProfile,
    contextTokens: 256000,
    availableMemoryBytes: 12 * 1024 ** 3,
    modelSizeBytes: 11 * 1024 ** 3
  })
  assert.equal(args[args.indexOf('--batch-size') + 1], '1024')
  assert.equal(args[args.indexOf('--ubatch-size') + 1], '256')
})
