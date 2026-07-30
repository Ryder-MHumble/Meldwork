const MAX_IMAGE_PIXELS = 32 * 1024 * 1024

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
])

function imageError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function unsupported() {
  throw imageError('LOCAL_ATTACHMENT_TYPE_UNSUPPORTED')
}

function validDimensions(width, height) {
  if (!Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(height) || height <= 0) {
    unsupported()
  }
  return { width, height }
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    unsupported()
  }
  return validDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
}

function jpegDimensions(bytes) {
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) unsupported()
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) unsupported()
    const marker = bytes[offset]
    offset += 1

    if (marker === 0x00 || marker === 0xda || marker === 0xd9) unsupported()
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 2 > bytes.length) unsupported()

    const segmentLength = bytes.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) unsupported()
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) unsupported()
      return validDimensions(
        bytes.readUInt16BE(offset + 5),
        bytes.readUInt16BE(offset + 3),
      )
    }
    offset += segmentLength
  }
  unsupported()
}

function uint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function webpChunkDimensions(bytes, chunkType, payloadOffset, chunkSize) {
  if (chunkType === 'VP8X') {
    if (chunkSize < 10) unsupported()
    return validDimensions(
      uint24LE(bytes, payloadOffset + 4) + 1,
      uint24LE(bytes, payloadOffset + 7) + 1,
    )
  }
  if (chunkType === 'VP8 ') {
    if (chunkSize < 10
        || bytes[payloadOffset + 3] !== 0x9d
        || bytes[payloadOffset + 4] !== 0x01
        || bytes[payloadOffset + 5] !== 0x2a) {
      unsupported()
    }
    return validDimensions(
      bytes.readUInt16LE(payloadOffset + 6) & 0x3fff,
      bytes.readUInt16LE(payloadOffset + 8) & 0x3fff,
    )
  }
  if (chunkType === 'VP8L') {
    if (chunkSize < 5 || bytes[payloadOffset] !== 0x2f) unsupported()
    const b1 = bytes[payloadOffset + 1]
    const b2 = bytes[payloadOffset + 2]
    const b3 = bytes[payloadOffset + 3]
    const b4 = bytes[payloadOffset + 4]
    return validDimensions(
      1 + b1 + ((b2 & 0x3f) << 8),
      1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
    )
  }
  return null
}

function webpDimensions(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF'
      || bytes.toString('ascii', 8, 12) !== 'WEBP') {
    unsupported()
  }
  const riffEnd = bytes.readUInt32LE(4) + 8
  if (riffEnd > bytes.length || riffEnd < 20) unsupported()

  let offset = 12
  while (offset + 8 <= riffEnd) {
    const chunkType = bytes.toString('ascii', offset, offset + 4)
    const chunkSize = bytes.readUInt32LE(offset + 4)
    const payloadOffset = offset + 8
    const chunkEnd = payloadOffset + chunkSize
    if (chunkEnd > riffEnd) unsupported()
    const dimensions = webpChunkDimensions(bytes, chunkType, payloadOffset, chunkSize)
    if (dimensions) return dimensions
    offset = chunkEnd + (chunkSize & 1)
  }
  unsupported()
}

function imageDimensions(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null
  if (!bytes) unsupported()
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return pngDimensions(bytes)
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegDimensions(bytes)
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return webpDimensions(bytes)
  }
  unsupported()
}

function assertImagePixelLimit(dimensions, maxPixels = MAX_IMAGE_PIXELS) {
  const { width, height } = validDimensions(dimensions?.width, dimensions?.height)
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) unsupported()
  if (width > Math.floor(maxPixels / height)) {
    throw imageError('LOCAL_ATTACHMENT_TOO_LARGE')
  }
  return { width, height }
}

function inspectImageDimensions(bytes, maxPixels = MAX_IMAGE_PIXELS) {
  return assertImagePixelLimit(imageDimensions(bytes), maxPixels)
}

module.exports = {
  MAX_IMAGE_PIXELS,
  assertImagePixelLimit,
  imageDimensions,
  inspectImageDimensions,
}
