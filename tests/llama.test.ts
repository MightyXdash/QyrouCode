import assert from 'node:assert/strict'
import test from 'node:test'
import { archSupportsVision, backendAppearsInDeviceList, buildLlamaServerArgs, inferReasoningFormat, llamaRuntimeProfileMatches, type LlamaLaunchProfile } from '../src/shared/llama.js'
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../src/shared/settings.js'

const baseProfile: LlamaLaunchProfile = {
  platform: 'darwin',
  backend: 'metal',
  modelPath: '/models/code.gguf',
  contextTokens: 72000,
  logicalCpuCount: 12,
  availableMemoryBytes: 32 * 1024 ** 3,
  modelSizeBytes: 8 * 1024 ** 3
}

test('defaults the context window to 48K until onboarding settings are applied', () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW_TOKENS, 48000)
})

test('configures accelerated inference with bounded batching and quantized KV cache', () => {
  const args = buildLlamaServerArgs(baseProfile)
  assert.deepEqual(args.slice(0, 2), ['--model', baseProfile.modelPath])
  assert.equal(args[args.indexOf('--ctx-size') + 1], String(baseProfile.contextTokens))
  assert.ok(args.includes('auto'))
  assert.ok(args.includes('q8_0'))
  assert.ok(args.includes('--cont-batching'))
  assert.equal(args[args.indexOf('--threads') + 1], '6')
})

test('restarts the same model when the selected context window changes', () => {
  const status = {
    state: 'ready' as const,
    modelPath: baseProfile.modelPath,
    contextTokens: baseProfile.contextTokens
  }

  assert.equal(llamaRuntimeProfileMatches(status, baseProfile.modelPath, baseProfile.contextTokens), true)
  assert.equal(llamaRuntimeProfileMatches(status, baseProfile.modelPath, 256000), false)
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

test('detects vision-capable architectures from server probes', () => {
  assert.equal(archSupportsVision(['qwen2vl']), true)
  assert.equal(archSupportsVision(['gemma3']), true)
  assert.equal(archSupportsVision(['qwen2.5']), false)
  assert.equal(archSupportsVision(undefined), false)
  assert.equal(archSupportsVision(['llava', 'clip']), true)
})

test('selects the reasoning format from the model family', () => {
  assert.equal(inferReasoningFormat('/models/qwen3.5-4b-q4.gguf'), 'qwen3')
  assert.equal(inferReasoningFormat('gemma-4-26B.gguf'), 'gemma3')
  assert.equal(inferReasoningFormat('/models/deepseek-r1.gguf'), 'deepseek')
  assert.equal(inferReasoningFormat(undefined), 'deepseek')
})
