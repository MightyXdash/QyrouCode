import { nativeImage, type NativeImage } from 'electron'

export const MAX_IMAGE_LONG_EDGE = 1280
export const IMAGE_JPEG_QUALITY = 85
export const IMAGE_QUALITY_FLOOR = 60
export const MAX_PREPARED_IMAGE_BYTES = 10 * 1024 * 1024
export const VISUAL_TOKEN_PATCH_PIXELS = 28

export interface PreparedImage {
  dataUrl: string
  mimeType: string
  width: number
  height: number
  bytes: number
}

export interface PrepareImageOptions {
  maxEdge?: number
  format?: 'png' | 'jpeg'
  quality?: number
  maxBytes?: number
}

export const estimateVisualTokens = (width: number, height: number): number =>
  Math.max(1, Math.ceil(width / VISUAL_TOKEN_PATCH_PIXELS) * Math.ceil(height / VISUAL_TOKEN_PATCH_PIXELS))

const encode = (image: NativeImage, format: 'png' | 'jpeg', quality: number): Buffer =>
  format === 'png' ? image.toPNG() : image.toJPEG(quality)

export const prepareNativeImage = (image: NativeImage, options: PrepareImageOptions = {}): PreparedImage => {
  const maxEdge = options.maxEdge ?? MAX_IMAGE_LONG_EDGE
  const format = options.format ?? 'jpeg'
  const quality = options.quality ?? IMAGE_JPEG_QUALITY
  const maxBytes = options.maxBytes ?? MAX_PREPARED_IMAGE_BYTES
  const source = image.getSize()
  let prepared = image
  if (Math.max(source.width, source.height) > maxEdge) {
    const scale = maxEdge / Math.max(source.width, source.height)
    prepared = image.resize({ width: Math.max(1, Math.round(source.width * scale)), quality: 'best' })
  }
  const size = prepared.getSize()
  let effectiveQuality = quality
  let bytes = encode(prepared, format, effectiveQuality).length
  if (bytes > maxBytes) {
    for (let candidate = quality - 5; candidate >= IMAGE_QUALITY_FLOOR; candidate -= 5) {
      bytes = encode(prepared, format, candidate).length
      if (bytes <= maxBytes) {
        effectiveQuality = candidate
        break
      }
    }
    if (bytes > maxBytes) throw new Error('The prepared image still exceeds the size limit after compression')
  }
  const buffer = encode(prepared, format, effectiveQuality)
  return {
    dataUrl: `data:image/${format === 'png' ? 'png' : 'jpeg'};base64,${buffer.toString('base64')}`,
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
    width: size.width,
    height: size.height,
    bytes: buffer.length
  }
}

export const prepareImageDataUrl = (dataUrl: string, options?: PrepareImageOptions): PreparedImage => {
  const match = /^data:image\/[a-zA-Z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new Error('Image attachments must be base64 data URLs')
  const image = nativeImage.createFromBuffer(Buffer.from(match[1], 'base64'))
  if (image.isEmpty()) throw new Error('The attached image could not be decoded')
  return prepareNativeImage(image, options)
}
