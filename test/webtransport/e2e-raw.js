'use strict'

// End-to-end tests for the raw-QUIC transport backend (the undici-only
// `node: { alpn }` option), against an in-process node:quic server.
//
// These tests require a Node.js build configured with --experimental-quic
// and the --experimental-quic CLI flag, e.g.:
//   node --experimental-quic node_modules/.bin/borp -p "test/webtransport/*.js"
// They skip everywhere else.

const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createPrivateKey, X509Certificate } = require('node:crypto')
const { lookup } = require('node:dns/promises')
const { hasQuic } = require('../utils/webtransport')
const { WebTransport, WebTransportError } = require('../..')
const { computeCertificateHash } = require('../../lib/web/webtransport/util')

const skip = hasQuic() ? false : 'node:quic is not available (build node with --experimental-quic and pass --experimental-quic)'

const ALPN = 'undici-wt-test'

const key = createPrivateKey(readFileSync(join(__dirname, '../fixtures/key.pem')))
const cert = readFileSync(join(__dirname, '../fixtures/cert.pem'))

async function startServer (onsession) {
  const { listen } = require('node:quic')
  const { address } = await lookup('localhost')
  const endpoint = await listen(onsession, {
    endpoint: { address: { address, port: 0 } },
    alpn: ALPN,
    keys: key,
    certs: cert
  })
  return endpoint
}

function clientOptions (extra = {}) {
  return {
    node: { alpn: ALPN, ca: cert },
    ...extra
  }
}

test('WebTransport over raw QUIC', { skip }, async (t) => {
  await t.test('session establishment', async (t) => {
    const endpoint = await startServer(() => {})
    t.after(() => endpoint.close())

    const wt = new WebTransport(`https://localhost:${endpoint.address.port}`, clientOptions())
    await wt.ready
    t.assert.strictEqual(wt.reliability, 'supports-unreliable')
    t.assert.strictEqual(wt.protocol, '')
    t.assert.strictEqual(wt.responseHeaders, null)
    wt.close()
    await wt.closed
  })

  await t.test('bidirectional stream echo', async (t) => {
    const endpoint = await startServer((session) => {
      session.onstream = async (stream) => {
        const writer = stream.writer
        for await (const batch of stream) {
          for (const chunk of batch) {
            writer.writeSync(chunk)
          }
        }
        await writer.end()
      }
    })
    t.after(() => endpoint.close())

    const wt = new WebTransport(`https://localhost:${endpoint.address.port}`, clientOptions())
    await wt.ready

    const bidi = await wt.createBidirectionalStream()
    const writer = bidi.writable.getWriter()
    await writer.write(new TextEncoder().encode('hello webtransport'))
    await writer.close()

    let received = ''
    const decoder = new TextDecoder()
    for await (const chunk of bidi.readable) {
      received += decoder.decode(chunk, { stream: true })
    }
    t.assert.strictEqual(received, 'hello webtransport')

    wt.close()
    await wt.closed
  })

  await t.test('unidirectional streams in both directions', async (t) => {
    const endpoint = await startServer((session) => {
      session.onstream = async (stream) => {
        // Echo the incoming unidirectional stream's bytes onto a new
        // server-initiated unidirectional stream.
        const chunks = []
        for await (const batch of stream) {
          chunks.push(...batch)
        }
        const out = await session.createUnidirectionalStream()
        const writer = out.writer
        for (const chunk of chunks) {
          writer.writeSync(chunk)
        }
        await writer.end()
      }
    })
    t.after(() => endpoint.close())

    const wt = new WebTransport(`https://localhost:${endpoint.address.port}`, clientOptions())
    await wt.ready

    const sendStream = await wt.createUnidirectionalStream()
    const writer = sendStream.getWriter()
    await writer.write(new TextEncoder().encode('uni'))
    await writer.close()

    // The echoed stream arrives via incomingUnidirectionalStreams.
    const reader = wt.incomingUnidirectionalStreams.getReader()
    const { value: receiveStream } = await reader.read()

    let received = ''
    const decoder = new TextDecoder()
    for await (const chunk of receiveStream) {
      received += decoder.decode(chunk, { stream: true })
    }
    t.assert.strictEqual(received, 'uni')

    wt.close()
    await wt.closed
  })

  await t.test('datagram round-trip', async (t) => {
    const endpoint = await startServer((session) => {
      session.ondatagram = (datagram) => {
        session.sendDatagram(Uint8Array.from(datagram)).catch(() => {})
      }
    })
    t.after(() => endpoint.close())

    const wt = new WebTransport(`https://localhost:${endpoint.address.port}`, clientOptions())
    await wt.ready

    const writer = wt.datagrams.createWritable().getWriter()
    const reader = wt.datagrams.readable.getReader()
    await writer.write(new TextEncoder().encode('ping'))

    const { value } = await reader.read()
    t.assert.strictEqual(new TextDecoder().decode(value), 'ping')

    wt.close()
    await wt.closed
  })

  await t.test('close sends the close code to the server', async (t) => {
    const serverClosed = Promise.withResolvers()
    const endpoint = await startServer((session) => {
      session.closed.then(
        () => serverClosed.resolve(null),
        (err) => serverClosed.resolve(err)
      )
    })
    t.after(() => endpoint.close())

    const wt = new WebTransport(`https://localhost:${endpoint.address.port}`, clientOptions())
    await wt.ready

    wt.close({ closeCode: 42, reason: 'done' })
    const closeInfo = await wt.closed
    t.assert.strictEqual(closeInfo.closeCode, 42)
    t.assert.strictEqual(closeInfo.reason, 'done')

    const serverError = await serverClosed.promise
    t.assert.strictEqual(serverError?.errorCode, 42n)
  })

  await t.test('server-initiated close resolves closed with the code', async (t) => {
    const endpoint = await startServer((session) => {
      session.opened.then(() => {
        session.close({ type: 'application', code: 7, reason: 'bye' })
      })
    })
    t.after(() => endpoint.close())

    const wt = new WebTransport(`https://localhost:${endpoint.address.port}`, clientOptions())
    await wt.ready

    const closeInfo = await wt.closed
    t.assert.strictEqual(closeInfo.closeCode, 7)
  })

  await t.test('writable abort surfaces the stream error code at the peer', async (t) => {
    const serverReset = Promise.withResolvers()
    const endpoint = await startServer((session) => {
      session.onstream = (stream) => {
        stream.onreset = (error) => serverReset.resolve(error)
        // Consume so the reset is observed.
        ;(async () => { for await (const _ of stream) {} })().catch(() => {}) // eslint-disable-line no-unused-vars
      }
    })
    t.after(() => endpoint.close())

    const wt = new WebTransport(`https://localhost:${endpoint.address.port}`, clientOptions())
    await wt.ready

    const bidi = await wt.createBidirectionalStream()
    const writer = bidi.writable.getWriter()
    await writer.write(new Uint8Array([1]))
    await writer.abort(new WebTransportError('goodbye', { streamErrorCode: 99 }))

    const error = await serverReset.promise
    t.assert.strictEqual(error?.errorCode, 99n)

    wt.close()
    await wt.closed
  })

  await t.test('getStats returns connection stats', async (t) => {
    const endpoint = await startServer(() => {})
    t.after(() => endpoint.close())

    const wt = new WebTransport(`https://localhost:${endpoint.address.port}`, clientOptions())
    await wt.ready

    const stats = await wt.getStats()
    t.assert.ok(stats.bytesSent > 0)
    t.assert.ok(stats.bytesReceived > 0)
    t.assert.strictEqual(typeof stats.smoothedRtt, 'number')
    t.assert.strictEqual(typeof stats.datagrams.droppedIncoming, 'number')

    wt.close()
    await wt.closed
  })

  await t.test('serverCertificateHashes: mismatched hash fails the session', async (t) => {
    const endpoint = await startServer(() => {})
    t.after(() => endpoint.close())

    const wt = new WebTransport(`https://localhost:${endpoint.address.port}`, {
      node: { alpn: ALPN },
      serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(32) }]
    })
    await t.assert.rejects(wt.ready, WebTransportError)
  })

  await t.test('serverCertificateHashes: correct hash of a non-conforming certificate fails', async (t) => {
    // The fixture certificate does not satisfy the custom certificate
    // requirements (its validity period exceeds two weeks / it may use an
    // RSA key), so even a matching hash must be rejected.
    const endpoint = await startServer(() => {})
    t.after(() => endpoint.close())

    const hash = computeCertificateHash(new X509Certificate(cert))
    const wt = new WebTransport(`https://localhost:${endpoint.address.port}`, {
      node: { alpn: ALPN },
      serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }]
    })
    await t.assert.rejects(wt.ready, WebTransportError)
  })
})
