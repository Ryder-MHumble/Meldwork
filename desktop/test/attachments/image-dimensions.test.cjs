const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MAX_IMAGE_PIXELS,
  assertImagePixelLimit,
  imageDimensions,
  inspectImageDimensions,
} = require('../../src/attachments/image-dimensions.cjs')

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

const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
])

test('reads dimensions from PNG and JPEG headers', () => {
  assert.deepEqual(imageDimensions(png(640, 480)), { width: 640, height: 480 })
  assert.deepEqual(imageDimensions(jpeg(1920, 1080)), { width: 1920, height: 1080 })
})

test('rejects unsupported, malformed, or truncated image headers without decoding', () => {
  assert.throws(() => imageDimensions(png(0, 10)), {
    message: 'LOCAL_ATTACHMENT_TYPE_UNSUPPORTED',
  })
  assert.throws(() => imageDimensions(jpeg(20, 10).subarray(0, 8)), {
    message: 'LOCAL_ATTACHMENT_TYPE_UNSUPPORTED',
  })
  assert.throws(() => imageDimensions(WEBP), {
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
