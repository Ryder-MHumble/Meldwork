const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createAttachmentRecord,
  normalizeReferences,
  parseAttachmentRecord,
  toBuffer,
  validateAttachment,
  validateStoredAttachment,
} = require('../src/attachment-records.cjs')

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
])

test('roundtrips a sanitized attachment record without filesystem state', () => {
  const bytes = toBuffer([...PNG])
  const type = validateAttachment(bytes, '../../private\\portrait?.PNG', 'image/png', true)
  const { metadata, document } = createAttachmentRecord(
    'attachment-1',
    '../../private\\portrait?.PNG',
    bytes,
    type,
  )
  const parsed = parseAttachmentRecord(Buffer.from(JSON.stringify(document)), metadata.id)

  assert.deepEqual(metadata, {
    id: 'attachment-1',
    name: 'portrait_.png',
    mimeType: 'image/png',
    size: PNG.length,
  })
  assert.deepEqual(parsed.metadata, metadata)
  assert.doesNotThrow(() => validateStoredAttachment(bytes, parsed.document))
})

test('rejects malformed metadata and checksum changes with the stable tamper code', () => {
  const type = validateAttachment(PNG, 'image.png', 'image/png', true)
  const { document } = createAttachmentRecord('attachment-1', 'image.png', PNG, type)

  assert.throws(
    () => parseAttachmentRecord(Buffer.from('{"version":1}'), 'attachment-1'),
    { message: 'LOCAL_ATTACHMENT_TAMPERED' },
  )
  const changed = Buffer.from(PNG)
  changed[changed.length - 1] ^= 0xff
  assert.throws(
    () => validateStoredAttachment(changed, document),
    { message: 'LOCAL_ATTACHMENT_TAMPERED' },
  )
})

test('keeps reference count and duplicate validation in the record layer', () => {
  assert.deepEqual(normalizeReferences(['attachment-1', { id: 'attachment-2' }]), [
    'attachment-1', 'attachment-2',
  ])
  assert.throws(
    () => normalizeReferences(['attachment-1', 'attachment-1']),
    { message: 'LOCAL_ATTACHMENT_REFERENCE_INVALID' },
  )
  assert.throws(
    () => normalizeReferences(Array.from({ length: 5 }, (_, index) => `attachment-${index}`)),
    { message: 'LOCAL_ATTACHMENT_COUNT_LIMIT' },
  )
})
