'use strict'

const { test } = require('node:test')
const { WebTransportDatagramDuplexStream, WebTransportDatagramsWritable } = require('../..')
const {
  createWebTransportDatagramDuplexStream,
  getDatagramsState,
  pullDatagrams,
  receiveDatagrams
} = require('../../lib/web/webtransport/datagrams')
const { makeMockContext } = require('../utils/webtransport')

function makeDatagramContext (readableType = undefined) {
  const ctx = makeMockContext()
  let controller
  const readable = new ReadableStream({
    start (c) { controller = c },
    pull () { return pullDatagrams(ctx) },
    ...(readableType === 'bytes' ? { type: 'bytes' } : {})
  }, { highWaterMark: 0 })
  ctx.datagrams = createWebTransportDatagramDuplexStream(ctx, readable, readableType)
  getDatagramsState(ctx.datagrams).readableController = controller
  return ctx
}

test('WebTransportDatagramDuplexStream', async (t) => {
  await t.test('cannot be constructed directly', (t) => {
    t.assert.throws(() => new WebTransportDatagramDuplexStream(), TypeError)
    t.assert.throws(() => new WebTransportDatagramsWritable(), TypeError)
  })

  await t.test('attribute validation', (t) => {
    const dg = makeDatagramContext().datagrams

    // 1. If value is negative or NaN, throw a RangeError.
    t.assert.throws(() => { dg.incomingMaxAge = -1 }, RangeError)
    t.assert.throws(() => { dg.outgoingMaxAge = NaN }, RangeError)

    // 2. If value is 0, set value to null.
    dg.incomingMaxAge = 0
    t.assert.strictEqual(dg.incomingMaxAge, null)
    dg.outgoingMaxAge = 0
    t.assert.strictEqual(dg.outgoingMaxAge, null)

    // 1. If value is < 1, set value to 1.
    dg.incomingMaxBufferedDatagrams = 0
    t.assert.strictEqual(dg.incomingMaxBufferedDatagrams, 1)
    dg.outgoingMaxBufferedDatagrams = 0
    t.assert.strictEqual(dg.outgoingMaxBufferedDatagrams, 1)

    t.assert.strictEqual(typeof dg.maxDatagramSize, 'number')
    t.assert.ok(dg.readable instanceof ReadableStream)
  })

  await t.test('writing datagrams sends them on the session', async (t) => {
    const ctx = makeDatagramContext()
    const writable = ctx.datagrams.createWritable()
    t.assert.ok(writable instanceof WebTransportDatagramsWritable)
    t.assert.ok(writable instanceof WritableStream)

    const writer = writable.getWriter()
    await writer.write(new Uint8Array([1, 2, 3]))
    t.assert.deepStrictEqual([...ctx.session.sent[0]], [1, 2, 3])

    // 2. If data is not a BufferSource object, then return a promise
    //    rejected with a TypeError.
    await t.assert.rejects(writer.write('nope'), TypeError)
  })

  await t.test('datagrams larger than maxDatagramSize are discarded', async (t) => {
    const ctx = makeDatagramContext()
    const writer = ctx.datagrams.createWritable().getWriter()

    // 4. If datagrams.[[OutgoingMaxDatagramSize]] is less than data’s
    //    [[ByteLength]], return a promise resolved with undefined.
    await writer.write(new Uint8Array(ctx.datagrams.maxDatagramSize + 1))
    t.assert.strictEqual(ctx.session.sent.length, 0)
  })

  await t.test('createWritable validates sendGroup and state', (t) => {
    const ctx = makeDatagramContext()

    // 3. If sendGroup is not null, and sendGroup.[[Transport]] is not
    //    this.[[Transport]], throw a TypeError.
    const { createWebTransportSendGroup } = require('../../lib/web/webtransport/sendgroup')
    const foreignGroup = createWebTransportSendGroup(makeMockContext())
    t.assert.throws(() => ctx.datagrams.createWritable({ sendGroup: foreignGroup }), TypeError)

    // 4. If transport.[[State]] is "closed" or "failed", throw an
    //    InvalidStateError.
    ctx.state = 'closed'
    t.assert.throws(() => ctx.datagrams.createWritable(), { name: 'InvalidStateError' })
  })

  await t.test('receiving datagrams', async (t) => {
    const ctx = makeDatagramContext()
    const reader = ctx.datagrams.readable.getReader()

    const pending = reader.read()
    ctx.session.incoming.push(new Uint8Array([9, 9]))
    receiveDatagrams(ctx)
    const result = await pending
    t.assert.deepStrictEqual([...result.value], [9, 9])
  })

  await t.test('incomingMaxAge expires datagrams', async (t) => {
    const ctx = makeDatagramContext()
    ctx.datagrams.incomingMaxAge = 0.01

    ctx.session.incoming.push(new Uint8Array([1]))
    receiveDatagrams(ctx)
    await new Promise((resolve) => setTimeout(resolve, 10))
    // 9.2. If more than duration milliseconds have passed since
    //      timestamp, then dequeue queue.
    receiveDatagrams(ctx)
    t.assert.strictEqual(getDatagramsState(ctx.datagrams).incomingDatagramsQueue.length, 0)
  })

  await t.test('incomingMaxBufferedDatagrams drops from the head of the queue', (t) => {
    const ctx = makeDatagramContext()
    ctx.datagrams.incomingMaxBufferedDatagrams = 2

    ctx.session.incoming.push(new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]))
    // 7./8. If toBeRemoved is positive, repeat dequeuing queue toBeRemoved
    //       (rounded down) times.
    receiveDatagrams(ctx)
    const queue = getDatagramsState(ctx.datagrams).incomingDatagramsQueue
    t.assert.deepStrictEqual(queue.map((c) => [...c.datagram]), [[2], [3]])
  })

  await t.test('bytes readable type supports BYOB readers', async (t) => {
    const ctx = makeDatagramContext('bytes')
    const reader = ctx.datagrams.readable.getReader({ mode: 'byob' })

    const pending = reader.read(new Uint8Array(10))
    ctx.session.incoming.push(new Uint8Array([7, 7, 7]))
    receiveDatagrams(ctx)
    const result = await pending
    t.assert.deepStrictEqual([...result.value], [7, 7, 7])
  })
})
