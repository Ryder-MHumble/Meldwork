const assert = require('node:assert/strict')
const test = require('node:test')
const { Readable } = require('node:stream')

const {
  createAttachmentService,
} = require('../../src/attachments/attachment-service.cjs')

function serviceFor(store) {
  return createAttachmentService({
    getStore: () => store,
    getSnapshot: () => ({ messages: [] }),
    nativeImage: {},
  })
}

test('attachment file import rejects non-array values before touching storage', () => {
  let imports = 0
  const service = serviceFor({
    importFile: () => { imports += 1 },
  })

  for (const value of [null, undefined, 'image.png']) {
    assert.throws(() => service.importFiles(value), {
      message: 'LOCAL_ATTACHMENT_INPUT_INVALID',
    })
  }
  assert.equal(imports, 0)
})

test('non-image buffer import returns metadata without rereading stored bytes', () => {
  const metadata = {
    id: 'attachment-1', name: 'briefing.mp3', mimeType: 'audio/mpeg', size: 4,
  }
  const service = serviceFor({
    importBuffer: () => metadata,
    readWithMetadata: () => { throw new Error('unexpected reread') },
    discard: () => {},
  })

  assert.deepEqual(service.importBuffer({
    bytes: [0x49, 0x44, 0x33, 0x04],
    name: 'briefing.mp3',
    mimeType: 'audio/mpeg',
  }), metadata)
})

test('media protocol streams only the requested byte range', async () => {
  const bytes = Buffer.from('0123456789')
  const ranges = []
  let handler
  const service = serviceFor({
    readWithMetadata: () => { throw new Error('unexpected full-file read') },
    openMedia: () => ({
      metadata: {
        id: 'attachment-1', name: 'briefing.mp3', mimeType: 'audio/mpeg', size: bytes.length,
      },
      stream: range => {
        ranges.push(range)
        return Readable.from(bytes.subarray(range.start, range.end + 1))
      },
      close: () => {},
    }),
  })
  service.registerProtocol({
    handle: (_scheme, callback) => { handler = callback },
  })

  const response = await handler({
    url: 'meldwork-media://attachment/attachment-1',
    headers: new Headers({ range: 'bytes=3-6' }),
  })

  assert.equal(response.status, 206)
  assert.equal(response.headers.get('Content-Range'), 'bytes 3-6/10')
  assert.equal(response.headers.get('Content-Length'), '4')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from('3456'))
  assert.deepEqual(ranges, [{ start: 3, end: 6 }])
})
