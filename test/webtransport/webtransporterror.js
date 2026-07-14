'use strict'

const { test } = require('node:test')
const { WebTransportError } = require('../..')

test('WebTransportError', async (t) => {
  await t.test('is a DOMException subclass', (t) => {
    const error = new WebTransportError()
    t.assert.ok(error instanceof DOMException)
    t.assert.ok(error instanceof Error)
  })

  await t.test('constructor steps', (t) => {
    const error = new WebTransportError('boom', { source: 'session', streamErrorCode: 42 })

    // 1. Set this’s name to "WebTransportError".
    t.assert.strictEqual(error.name, 'WebTransportError')

    // 2. Set this’s message to message.
    t.assert.strictEqual(error.message, 'boom')

    // 3. Set this’s internal slots ...
    t.assert.strictEqual(error.source, 'session')
    t.assert.strictEqual(error.streamErrorCode, 42)

    // Note: This name does not have a mapping to a legacy code, so this’s
    // code is 0.
    t.assert.strictEqual(error.code, 0)
  })

  await t.test('defaults', (t) => {
    const error = new WebTransportError()
    t.assert.strictEqual(error.message, '')
    // WebTransportErrorSource source = "stream"
    t.assert.strictEqual(error.source, 'stream')
    // [Clamp] unsigned long? streamErrorCode = null
    t.assert.strictEqual(error.streamErrorCode, null)
  })

  await t.test('streamErrorCode is [Clamp] unsigned long', (t) => {
    t.assert.strictEqual(new WebTransportError('', { streamErrorCode: 42.7 }).streamErrorCode, 43)
    t.assert.strictEqual(new WebTransportError('', { streamErrorCode: -5 }).streamErrorCode, 0)
    t.assert.strictEqual(new WebTransportError('', { streamErrorCode: 2 ** 32 + 5 }).streamErrorCode, 2 ** 32 - 1)
  })

  await t.test('source must be a WebTransportErrorSource', (t) => {
    t.assert.throws(() => new WebTransportError('', { source: 'bogus' }), TypeError)
  })

  await t.test('has a toStringTag', (t) => {
    t.assert.strictEqual(Object.prototype.toString.call(new WebTransportError()), '[object WebTransportError]')
  })
})
