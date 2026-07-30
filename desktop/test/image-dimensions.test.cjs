const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MAX_IMAGE_PIXELS,
  assertImagePixelLimit,
  imageDimensions,
  inspectImageDimensions,
} = require('../src/image-dimensions.cjs')

function png(width, height) {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function jpeg(width, height) {
  const bytes = Buffer.alloc(11)
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08])
  bytes.writeUInt16BE(height, 7)
  bytes.writeUInt16BE(width, 9)
  return bytes
}

function webpChunk(type, payload) {
  const padding = payload.length & 1
  const bytes = Buffer.alloc(20 + payload.length + padding)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WEBP', 8, 'ascii')
  bytes.write(type, 12, 'ascii')
  bytes.writeUInt32LE(payload.length, 16)
  payload.copy(bytes, 20)
  return bytes
}

function vp8x(width, height) {
  const payload = Buffer.alloc(10)
  payload.writeUIntLE(width - 1, 4, 3)
  payload.writeUIntLE(height - 1, 7, 3)
  return webpChunk('VP8X', payload)
}

function vp8(width, height) {
  const payload = Buffer.alloc(10)
  payload.set([0x9d, 0x01, 0x2a], 3)
  payload.writeUInt16LE(width, 6)
  payload.writeUInt16LE(height, 8)
  return webpChunk('VP8 ', payload)
}

function vp8l(width, height) {
  const widthBits = width - 1
  const heightBits = height - 1
  const payload = Buffer.from([
    0x2f,
    widthBits & 0xff,
    ((widthBits >> 8) & 0x3f) | ((heightBits & 0x03) << 6),
    (heightBits >> 2) & 0xff,
    (heightBits >> 10) & 0x0f,
  ])
  return webpChunk('VP8L', payload)
}

test('reads dimensions from PNG, JPEG, and every WebP bitstream header', () => {
  assert.deepEqual(imageDimensions(png(640, 480)), { width: 640, height: 480 })
  assert.deepEqual(imageDimensions(jpeg(1920, 1080)), { width: 1920, height: 1080 })
  assert.deepEqual(imageDimensions(vp8x(4096, 2160)), { width: 4096, height: 2160 })
  assert.deepEqual(imageDimensions(vp8(1280, 720)), { width: 1280, height: 720 })
  assert.deepEqual(imageDimensions(vp8l(321, 654)), { width: 321, height: 654 })
})

test('rejects malformed or truncated image headers without decoding', () => {
  assert.throws(() => imageDimensions(png(0, 10)), {
    message: 'LOCAL_ATTACHMENT_TYPE_UNSUPPORTED',
  })
  assert.throws(() => imageDimensions(jpeg(20, 10).subarray(0, 8)), {
    message: 'LOCAL_ATTACHMENT_TYPE_UNSUPPORTED',
  })
  assert.throws(() => imageDimensions(vp8x(20, 10).subarray(0, 22)), {
    message: 'LOCAL_ATTACHMENT_TYPE_UNSUPPORTED',
  })
  assert.throws(() => imageDimensions(Buffer.from('not-an-image')), {
    message: 'LOCAL_ATTACHMENT_TYPE_UNSUPPORTED',
  })
})

test('enforces the pixel limit without multiplying attacker-controlled dimensions', () => {
  assert.deepEqual(
    inspectImageDimensions(png(8192, 4096)),
    { width: 8192, height: 4096 },
  )
  assert.equal(8192 * 4096, MAX_IMAGE_PIXELS)
  assert.throws(() => inspectImageDimensions(png(8193, 4096)), {
    message: 'LOCAL_ATTACHMENT_TOO_LARGE',
  })
  assert.throws(() => assertImagePixelLimit({ width: 0xffffffff, height: 0xffffffff }), {
    message: 'LOCAL_ATTACHMENT_TOO_LARGE',
  })
})
