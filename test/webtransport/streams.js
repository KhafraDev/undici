'use strict'

const { test } = require('node:test')
const {
  WebTransportSendStream,
  WebTransportReceiveStream,
  WebTransportWriter,
  WebTransportBidirectionalStream,
  WebTransportSendGroup,
  WebTransportError
} = require('../..')
const { createWebTransportBidirectionalStream } = require('../../lib/web/webtransport/bidirectionalstream')
const { createWebTransportSendGroup } = require('../../lib/web/webtransport/sendgroup')
const { makeMockInternalStream, makeMockContext } = require('../utils/webtransport')

test('WebTransport stream interfaces', async (t) => {
  await t.test('cannot be constructed directly', (t) => {
    for (const Class of [WebTransportSendStream, WebTransportReceiveStream, WebTransportWriter, WebTransportBidirectionalStream, WebTransportSendGroup]) {
      t.assert.throws(() => new Class(), TypeError, Class.name)
    }
  })

  await t.test('WebTransportBidirectionalStream wires readable/writable', (t) => {
    const ctx = makeMockContext()
    const bidi = createWebTransportBidirectionalStream(makeMockInternalStream(), ctx, null, 0)
    t.assert.ok(bidi.readable instanceof WebTransportReceiveStream)
    t.assert.ok(bidi.readable instanceof ReadableStream)
    t.assert.ok(bidi.writable instanceof WebTransportSendStream)
    t.assert.ok(bidi.writable instanceof WritableStream)
    // 8. Append stream to transport.[[SendStreams]]. / 5. Append stream
    //    to transport.[[ReceiveStreams]].
    t.assert.ok(ctx.sendStreams.has(bidi.writable))
    t.assert.ok(ctx.receiveStreams.has(bidi.readable))
  })

  await t.test('write path', async (t) => {
    const ctx = makeMockContext()
    const mock = makeMockInternalStream()
    const bidi = createWebTransportBidirectionalStream(mock, ctx, null, 0)
    const writer = bidi.writable.getWriter()

    // getWriter(): "return the result of creating a WebTransportWriter
    // with this".
    t.assert.ok(writer instanceof WebTransportWriter)
    t.assert.ok(writer instanceof WritableStreamDefaultWriter)

    await writer.write(new Uint8Array([1, 2, 3]))
    await writer.atomicWrite(new Uint8Array([4, 5]))
    // 5. If bytes length is 0, resolve promise with undefined ...
    await writer.write(new Uint8Array(0))
    t.assert.deepStrictEqual(mock.written.map(String), ['\x01\x02\x03', '\x04\x05'])

    // 2. If chunk is not a BufferSource, return a promise rejected with a
    //    TypeError.
    await t.assert.rejects(writer.write('text'), TypeError)

    // close sends FIN
    await writer.close()
    t.assert.strictEqual(mock.written.at(-1), 'FIN')
  })

  await t.test('getStats', async (t) => {
    const ctx = makeMockContext()
    const mock = makeMockInternalStream()
    const bidi = createWebTransportBidirectionalStream(mock, ctx, null, 0)
    await bidi.writable.getWriter().write(new Uint8Array(5))
    const sendStats = await bidi.writable.getStats()
    t.assert.deepStrictEqual(sendStats, { bytesWritten: 5, bytesSent: 5, bytesAcknowledged: 3 })
    const receiveStats = await bidi.readable.getStats()
    t.assert.deepStrictEqual(receiveStats, { bytesReceived: 7, bytesRead: 0 })
  })

  await t.test('sendGroup and sendOrder attributes', async (t) => {
    const ctx = makeMockContext()
    const bidi = createWebTransportBidirectionalStream(makeMockInternalStream(), ctx, null, 0)
    const group = createWebTransportSendGroup(ctx)

    t.assert.strictEqual(bidi.writable.sendGroup, null)
    bidi.writable.sendGroup = group
    t.assert.strictEqual(bidi.writable.sendGroup, group)

    bidi.writable.sendOrder = 42
    t.assert.strictEqual(bidi.writable.sendOrder, 42)

    // 1. If value is non-null, and value.[[Transport]] is not
    //    this.[[Transport]], throw an InvalidStateError.
    const otherGroup = createWebTransportSendGroup(makeMockContext())
    t.assert.throws(() => { bidi.writable.sendGroup = otherGroup }, { name: 'InvalidStateError' })

    // WebTransportSendGroup.getStats() aggregates over its streams.
    await bidi.writable.getWriter().write(new Uint8Array(5))
    const stats = await group.getStats()
    t.assert.deepStrictEqual(stats, { bytesWritten: 5, bytesSent: 5, bytesAcknowledged: 3 })
  })

  await t.test('read path with a default reader', async (t) => {
    const ctx = makeMockContext()
    const mock = makeMockInternalStream()
    const bidi = createWebTransportBidirectionalStream(mock, ctx, null, 0)
    const reader = bidi.readable.getReader()

    mock.pushIncoming(new Uint8Array([9, 8, 7]), false)
    const first = await reader.read()
    t.assert.deepStrictEqual([...first.value], [9, 8, 7])

    mock.pushIncoming(new Uint8Array([6]), true)
    const second = await reader.read()
    t.assert.deepStrictEqual([...second.value], [6])

    // 7.3.2.2. Close stream. (on FIN)
    const third = await reader.read()
    t.assert.strictEqual(third.done, true)
    t.assert.strictEqual(ctx.receiveStreams.has(bidi.readable), false)
  })

  await t.test('read path with a BYOB reader', async (t) => {
    const ctx = makeMockContext()
    const mock = makeMockInternalStream()
    const bidi = createWebTransportBidirectionalStream(mock, ctx, null, 0)
    // "WebTransportReceiveStream is a readable byte stream, and hence it
    //  allows its consumers to use a BYOB reader"
    const reader = bidi.readable.getReader({ mode: 'byob' })
    mock.pushIncoming(new Uint8Array([1, 2, 3, 4]), false)
    const result = await reader.read(new Uint8Array(2))
    t.assert.deepStrictEqual([...result.value], [1, 2])
  })

  await t.test('peer RESET_STREAM errors the readable with a WebTransportError', async (t) => {
    const ctx = makeMockContext()
    const mock = makeMockInternalStream()
    const bidi = createWebTransportBidirectionalStream(mock, ctx, null, 0)
    const reader = bidi.readable.getReader()

    // 3.3. Let error be a newly created WebTransportError whose source is
    //      "stream" and streamErrorCode is code.
    mock.triggerReset(77)
    const err = await reader.read().then(() => null, (e) => e)
    t.assert.ok(err instanceof WebTransportError)
    t.assert.strictEqual(err.source, 'stream')
    t.assert.strictEqual(err.streamErrorCode, 77)
    // 3.2. Remove stream from transport.[[ReceiveStreams]].
    t.assert.strictEqual(ctx.receiveStreams.has(bidi.readable), false)
  })

  await t.test('peer STOP_SENDING errors the writable with a WebTransportError', async (t) => {
    const ctx = makeMockContext()
    const mock = makeMockInternalStream()
    const bidi = createWebTransportBidirectionalStream(mock, ctx, null, 0)

    mock.triggerStopSending(88)
    const err = await bidi.writable.getWriter().write(new Uint8Array([1])).then(() => null, (e) => e)
    t.assert.ok(err instanceof WebTransportError)
    t.assert.strictEqual(err.source, 'stream')
    t.assert.strictEqual(err.streamErrorCode, 88)
    t.assert.strictEqual(ctx.sendStreams.has(bidi.writable), false)
  })

  await t.test('abort carries the WebTransportError streamErrorCode', async (t) => {
    const ctx = makeMockContext()
    const mock = makeMockInternalStream()
    const bidi = createWebTransportBidirectionalStream(mock, ctx, null, 0)

    // 5. If reason is a WebTransportError and reason.[[StreamErrorCode]]
    //    is not null, then set code to reason.[[StreamErrorCode]].
    await bidi.writable.abort(new WebTransportError('bye', { streamErrorCode: 99 }))
    t.assert.deepStrictEqual(mock.written, [['RESET', 99, 0]])
  })

  await t.test('readable cancel carries the WebTransportError streamErrorCode', async (t) => {
    const ctx = makeMockContext()
    const mock = makeMockInternalStream()
    const bidi = createWebTransportBidirectionalStream(mock, ctx, null, 0)

    // 9.1. Abort receiving on internalStream with code.
    await bidi.readable.cancel(new WebTransportError('enough', { streamErrorCode: 11 }))
    t.assert.deepStrictEqual(mock.written, [['STOP_SENDING', 11]])
  })

  await t.test('WebTransportWriter.commit updates the committed offset', async (t) => {
    const ctx = makeMockContext()
    const mock = makeMockInternalStream()
    const bidi = createWebTransportBidirectionalStream(mock, ctx, null, 0)
    const writer = bidi.writable.getWriter()

    await writer.write(new Uint8Array(10))
    // 1. Set stream.[[CommittedOffset]] to the value of
    //    stream.[[BytesWritten]].
    writer.commit()
    writer.releaseLock()

    await bidi.writable.abort(new WebTransportError('x', { streamErrorCode: 1 }))
    // The committedOffset (second element) reflects the committed bytes.
    t.assert.deepStrictEqual(mock.written.at(-1), ['RESET', 1, 10])
  })

  await t.test('atomicWrite on a released writer rejects with a TypeError', async (t) => {
    const ctx = makeMockContext()
    const bidi = createWebTransportBidirectionalStream(makeMockInternalStream(), ctx, null, 0)
    const writer = bidi.writable.getWriter()
    writer.releaseLock()

    // 2. If stream is undefined, return a promise rejected with a
    //    TypeError.
    await t.assert.rejects(writer.atomicWrite(new Uint8Array(1)), TypeError)
  })
})
