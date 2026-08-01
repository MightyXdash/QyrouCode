import type { FileHandle } from 'node:fs/promises'
import { open } from 'node:fs/promises'

const GGUF_MAGIC = 'GGUF'
const GGUF_HEADER_BYTES = 24
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

const GGUF_TYPE_STRING = 8
const GGUF_TYPE_ARRAY = 9

const FIXED_TYPE_SIZES: Record<number, number> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8
}

const readBytes = async (handle: FileHandle, position: number, length: number): Promise<Buffer> => {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset)
    if (bytesRead === 0) throw new Error('Unexpected end of GGUF metadata')
    offset += bytesRead
  }
  return buffer
}

const readU64 = (buffer: Buffer): number => {
  const value = buffer.readBigUInt64LE(0)
  if (value > MAX_SAFE_BIGINT) throw new Error('GGUF metadata value exceeds safe integer range')
  return Number(value)
}

const readScalar = (valueType: number, data: Buffer): number | undefined => {
  switch (valueType) {
    case 0:
    case 4:
    case 7:
      return data.readUInt32LE(0)
    case 1:
      return data.readInt8(0)
    case 2:
      return data.readUInt16LE(0)
    case 3:
      return data.readInt16LE(0)
    case 5:
    case 11:
      return data.readInt32LE(0)
    case 10:
      return Number(data.readBigUInt64LE(0))
    case 6:
    case 12:
      return undefined
    default:
      return undefined
  }
}

export const readGgufContextLimit = async (path: string): Promise<number | undefined> => {
  const handle = await open(path, 'r')
  try {
    let header: Buffer
    try {
      header = await readBytes(handle, 0, GGUF_HEADER_BYTES)
    } catch {
      return undefined
    }
    if (header.toString('ascii', 0, 4) !== GGUF_MAGIC) return undefined
    const version = header.readUInt32LE(4)
    if (version < 1 || version > 3) return undefined
    const kvCount = readU64(header.subarray(16, 24))
    let position = GGUF_HEADER_BYTES
    for (let i = 0; i < kvCount; i++) {
      const keyLength = readU64(await readBytes(handle, position, 8))
      position += 8
      const key = (await readBytes(handle, position, keyLength)).toString('utf8')
      position += keyLength
      const valueType = (await readBytes(handle, position, 4)).readUInt32LE(0)
      position += 4
      let value: number | undefined
      const fixedSize = FIXED_TYPE_SIZES[valueType]
      if (fixedSize !== undefined) {
        const data = await readBytes(handle, position, fixedSize)
        position += fixedSize
        value = readScalar(valueType, data)
      } else if (valueType === GGUF_TYPE_STRING) {
        const length = readU64(await readBytes(handle, position, 8))
        position += 8 + length
      } else if (valueType === GGUF_TYPE_ARRAY) {
        const elementType = (await readBytes(handle, position, 4)).readUInt32LE(0)
        position += 4
        const count = readU64(await readBytes(handle, position, 8))
        position += 8
        if (elementType === GGUF_TYPE_STRING) {
          for (let element = 0; element < count; element++) {
            const length = readU64(await readBytes(handle, position, 8))
            position += 8 + length
          }
        } else {
          const elementSize = FIXED_TYPE_SIZES[elementType]
          if (elementSize === undefined) return undefined
          position += count * elementSize
        }
      } else {
        return undefined
      }
      if (key === 'llama.context_length' && value !== undefined) return value
    }
    return undefined
  } finally {
    await handle.close()
  }
}
