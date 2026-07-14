'use strict'

const { test } = require('node:test')
const { WebTransport, WebTransportError, WebTransportSendGroup, WebTransportDatagramDuplexStream } = require('../..')

test('WebTransport constructor', async (t) => {
  await t.test('requires at least one argument', (t) => {
    t.assert.throws(() => new WebTransport(), TypeError)
  })

  await t.test('throws a SyntaxError for invalid URLs', (t) => {
    // 3. If url is failure, throw a SyntaxError exception.
    t.assert.throws(() => new WebTransport('invalid url'), {
      name: 'SyntaxError',
      constructor: DOMException
    })
  })

  await t.test('throws a SyntaxError for non-https schemes', (t) => {
    // 4. If url’s scheme is not https, throw a SyntaxError exception.
    for (const url of ['http://example.com', 'wss://example.com', 'file:///a']) {
      t.assert.throws(() => new WebTransport(url), { name: 'SyntaxError' })
    }
  })

  await t.test('throws a SyntaxError when the URL has a fragment', (t) => {
    // 5. If url’s fragment is not null, throw a SyntaxError exception.
    t.assert.throws(() => new WebTransport('https://example.com/#frag'), { name: 'SyntaxError' })
    t.assert.throws(() => new WebTransport('https://example.com/#'), { name: 'SyntaxError' })
  })

  await t.test('throws a NotSupportedError when pooling is combined with certificate hashes', (t) => {
    // 8. If newConnection is "no" and serverCertificateHashes is not
    //    empty, then throw a NotSupportedError exception.
    t.assert.throws(() => new WebTransport('https://example.com', {
      allowPooling: true,
      serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(32) }]
    }), { name: 'NotSupportedError' })
  })

  await t.test('validates protocols', (t) => {
    // 13. If any of the values in protocols occur more than once, ...
    t.assert.throws(() => new WebTransport('https://example.com', { protocols: ['a', 'a'] }), { name: 'SyntaxError' })
    // ... have an isomorphic encoded length of 0 or exceeding 512 ...
    t.assert.throws(() => new WebTransport('https://example.com', { protocols: [''] }), { name: 'SyntaxError' })
    t.assert.throws(() => new WebTransport('https://example.com', { protocols: ['a'.repeat(513)] }), { name: 'SyntaxError' })
    // ... fail to match the requirements for elements that comprise the
    // value of the negotiated application protocol ...
    t.assert.throws(() => new WebTransport('https://example.com', { protocols: ['bäd'] }), { name: 'SyntaxError' })
  })

  await t.test('throws a TypeError when headers contain wt-available-protocols', (t) => {
    // 32.1. If ascii lowercase header’s name is "wt-available-protocols",
    //       then throw a TypeError.
    t.assert.throws(() => new WebTransport('https://example.com', {
      headers: { 'WT-Available-Protocols': 'x' }
    }), TypeError)
  })

  await t.test('validates enum members', (t) => {
    t.assert.throws(() => new WebTransport('https://example.com', { congestionControl: 'warp-speed' }), TypeError)
    t.assert.throws(() => new WebTransport('https://example.com', { datagramsReadableType: 'default' }), TypeError)
  })

  await t.test('initial attribute values', (t) => {
    const wt = new WebTransport('https://example.com', { congestionControl: 'throughput' })
    t.assert.strictEqual(wt.reliability, 'pending')
    t.assert.strictEqual(wt.congestionControl, 'throughput')
    t.assert.strictEqual(wt.protocol, '')
    t.assert.strictEqual(wt.responseHeaders, null)
    t.assert.strictEqual(wt.anticipatedConcurrentIncomingUnidirectionalStreams, null)
    t.assert.strictEqual(wt.anticipatedConcurrentIncomingBidirectionalStreams, null)
    t.assert.ok(wt.datagrams instanceof WebTransportDatagramDuplexStream)
    t.assert.ok(wt.incomingBidirectionalStreams instanceof ReadableStream)
    t.assert.ok(wt.incomingUnidirectionalStreams instanceof ReadableStream)
    t.assert.ok(wt.ready instanceof Promise)
    t.assert.ok(wt.closed instanceof Promise)
    t.assert.ok(wt.draining instanceof Promise)
    wt.ready.catch(() => {})
    wt.closed.catch(() => {})
    wt.close()
  })

  await t.test('anticipated stream count setters', (t) => {
    const wt = new WebTransport('https://example.com', {
      anticipatedConcurrentIncomingUnidirectionalStreams: 5,
      anticipatedConcurrentIncomingBidirectionalStreams: 6
    })
    t.assert.strictEqual(wt.anticipatedConcurrentIncomingUnidirectionalStreams, 5)
    t.assert.strictEqual(wt.anticipatedConcurrentIncomingBidirectionalStreams, 6)
    wt.anticipatedConcurrentIncomingUnidirectionalStreams = null
    wt.anticipatedConcurrentIncomingBidirectionalStreams = 7
    t.assert.strictEqual(wt.anticipatedConcurrentIncomingUnidirectionalStreams, null)
    t.assert.strictEqual(wt.anticipatedConcurrentIncomingBidirectionalStreams, 7)
    // [EnforceRange]
    t.assert.throws(() => { wt.anticipatedConcurrentIncomingUnidirectionalStreams = -1 }, TypeError)
    wt.ready.catch(() => {})
    wt.closed.catch(() => {})
    wt.close()
  })

  await t.test('supportsReliableOnly is a static returning false', (t) => {
    // WebTransport over HTTP/2 is not implemented.
    t.assert.strictEqual(WebTransport.supportsReliableOnly, false)
    t.assert.strictEqual(Object.hasOwn(WebTransport.prototype, 'supportsReliableOnly'), false)
  })

  await t.test('createSendGroup', (t) => {
    const wt = new WebTransport('https://example.com')
    const group = wt.createSendGroup()
    t.assert.ok(group instanceof WebTransportSendGroup)
    wt.ready.catch(() => {})
    wt.closed.catch(() => {})
    wt.close()
  })

  await t.test('brand checks', (t) => {
    t.assert.throws(() => Reflect.get(WebTransport.prototype, 'ready', {}), TypeError)
    t.assert.throws(() => WebTransport.prototype.close.call({}), TypeError)
  })
})

test('WebTransport session establishment failure', async (t) => {
  // On hosts without node:quic (or when the connection fails), the
  // constructor must still return and the failure must surface through
  // the specified network-error path.
  await t.test('ready and closed reject with a WebTransportError', async (t) => {
    const wt = new WebTransport('https://127.0.0.1:1')

    // 1.2. Let error be a newly created WebTransportError whose source is
    //      "session".
    // 1.3. Cleanup transport with error. (rejects [[Ready]] and [[Closed]])
    const [readyErr, closedErr] = await Promise.all([
      wt.ready.then(() => null, (e) => e),
      wt.closed.then(() => null, (e) => e)
    ])
    t.assert.ok(readyErr instanceof WebTransportError, `ready rejected with ${readyErr}`)
    t.assert.strictEqual(readyErr.source, 'session')
    t.assert.ok(closedErr instanceof WebTransportError)

    // 13. ... Otherwise, set transport.[[State]] to "failed".
    t.assert.throws(() => wt.createSendGroup(), { name: 'InvalidStateError' })
    await t.assert.rejects(wt.createBidirectionalStream(), { name: 'InvalidStateError' })
    await t.assert.rejects(wt.createUnidirectionalStream(), { name: 'InvalidStateError' })
    await t.assert.rejects(wt.getStats(), { name: 'InvalidStateError' })
    await t.assert.rejects(
      wt.exportKeyingMaterial(new Uint8Array(1), new Uint8Array(1), 64),
      { name: 'InvalidStateError' })
    t.assert.throws(() => wt.datagrams.createWritable(), { name: 'InvalidStateError' })

    // 17.5. Error incomingBidirectionalStreams with error.
    await t.assert.rejects(wt.incomingBidirectionalStreams.getReader().read(), WebTransportError)

    // 2. If transport.[[State]] is "closed" or "failed", then abort these
    //    steps. (close() is a no-op afterwards)
    wt.close()
  })

  await t.test('close() while connecting cleans up with an AbortError-free path', async (t) => {
    const wt = new WebTransport('https://example.com')
    // 3. If transport.[[State]] is "connecting": ... cleanup transport
    //    with error. ([[Ready]] rejects with a WebTransportError)
    wt.close()
    const readyErr = await wt.ready.then(() => null, (e) => e)
    t.assert.ok(readyErr instanceof WebTransportError)
    t.assert.strictEqual(readyErr.source, 'session')
    await t.assert.rejects(wt.closed, WebTransportError)
  })
})

test('WebTransport exportKeyingMaterial argument validation', async (t) => {
  const wt = new WebTransport('https://example.com')
  t.after(() => {
    wt.ready.catch(() => {})
    wt.closed.catch(() => {})
    wt.close()
  })

  // 2. If labelLength is more than 255, return a promise rejected with a
  //    RangeError.
  await t.assert.rejects(wt.exportKeyingMaterial(new Uint8Array(256), new Uint8Array(0), 64), RangeError)

  // 4. If contextLength is more than 255, return a promise rejected with
  //    a RangeError.
  await t.assert.rejects(wt.exportKeyingMaterial(new Uint8Array(1), new Uint8Array(256), 64), RangeError)

  // 5. If outputLength is 0 or more than an implementation-defined value
  //    ... return a promise rejected with a RangeError.
  await t.assert.rejects(wt.exportKeyingMaterial(new Uint8Array(1), new Uint8Array(1), 0), RangeError)
  await t.assert.rejects(wt.exportKeyingMaterial(new Uint8Array(1), new Uint8Array(1), 5000), RangeError)
})
