import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGgufContextLimit } from '../src/main/gguf.js'

const writeGguf = (keys: Array<{ key: string; type: number; payload: Buffer }>): string => {
  const header = Buffer.alloc(24)
  header.write('GGUF', 0, 'ascii')
  header.writeUInt32LE(3, 4)
  header.writeBigUInt64LE(0n, 10)
  header.writeBigUInt64LE(BigInt(keys.length), 16)
  const body = Buffer.concat(keys.flatMap(({ key, type, payload }) => {
    const keyLength = Buffer.alloc(8)
    keyLength.writeBigUInt64LE(BigInt(key.length), 0)
    const typeBuffer = Buffer.alloc(4)
    typeBuffer.writeUInt32LE(type, 0)
    return [keyLength, Buffer.from(key, 'utf8'), typeBuffer, payload]
  }))
  const directory = mkdtempSync(join(tmpdir(), 'qyroucode-gguf-'))
  const path = join(directory, 'test.gguf')
  writeFileSync(path, Buffer.concat([header, body]))
  return path
}

const stringValue = (value: string): Buffer => {
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(value.length), 0)
  return Buffer.concat([length, Buffer.from(value, 'utf8')])
}

const u32Value = (value: number): Buffer => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value, 0)
  return buffer
}

const u8Value = (value: number): Buffer => {
  const buffer = Buffer.alloc(1)
  buffer.writeUInt8(value, 0)
  return buffer
}

test('reads llama.context_length from GGUF metadata', async () => {
  const path = writeGguf([
    { key: 'general.architecture', type: 8, payload: stringValue('qwen2vl') },
    { key: 'llama.context_length', type: 4, payload: u32Value(131072) },
    { key: 'general.name', type: 8, payload: stringValue('test model') }
  ])
  assert.equal(await readGgufContextLimit(path), 131072)
})

test('scans past one-byte scalar metadata', async () => {
  const path = writeGguf([
    { key: 'general.quantization_version', type: 0, payload: u8Value(2) },
    { key: 'general.use_mmap', type: 7, payload: u8Value(1) },
    { key: 'llama.context_length', type: 4, payload: u32Value(32768) }
  ])
  assert.equal(await readGgufContextLimit(path), 32768)
})

test('skips array metadata values while scanning', async () => {
  const arrayValue = Buffer.concat([
    u32Value(8),
    (() => {
      const count = Buffer.alloc(8)
      count.writeBigUInt64LE(2n, 0)
      return count
    })(),
    stringValue('alpha'),
    stringValue('beta')
  ])
  const path = writeGguf([
    { key: 'general.file_type', type: 9, payload: arrayValue },
    { key: 'llama.context_length', type: 4, payload: u32Value(65536) }
  ])
  assert.equal(await readGgufContextLimit(path), 65536)
})

test('ignores values that cannot hold the context length', async () => {
  const path = writeGguf([
    { key: 'general.rope_freq_scale', type: 6, payload: Buffer.alloc(4) },
    { key: 'llama.context_length', type: 4, payload: u32Value(32000) }
  ])
  assert.equal(await readGgufContextLimit(path), 32000)
})

test('returns undefined when the context length key is absent', async () => {
  const path = writeGguf([{ key: 'general.name', type: 8, payload: stringValue('text only') }])
  assert.equal(await readGgufContextLimit(path), undefined)
})

test('returns undefined for invalid GGUF headers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qyroucode-gguf-'))
  const badPath = join(directory, 'bad.gguf')
  writeFileSync(badPath, 'NOTAGGUF')
  assert.equal(await readGgufContextLimit(badPath), undefined)

  const futureVersion = Buffer.alloc(24)
  futureVersion.write('GGUF', 0, 'ascii')
  futureVersion.writeUInt32LE(99, 4)
  const futurePath = join(directory, 'future.gguf')
  writeFileSync(futurePath, futureVersion)
  assert.equal(await readGgufContextLimit(futurePath), undefined)
})
