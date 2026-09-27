'use strict'

const { once } = require('node:events')
const { constants, createSecureServer } = require('node:http2')
const { test } = require('node:test')

const pem = require('@metcoder95/https-pem')

const { Client, fetch } = require('../..')
const { closeClientAndServerAsPromise } = require('../utils/node-http')

// https://github.com/nodejs/undici/issues/5912
test('fetch retries a string body on a new connection after GOAWAY refuses its stream', async (t) => {
  const server = createSecureServer(await pem.generate({ opts: { keySize: 2048 } }))
  let streams = 0
  let received = null

  server.on('session', (session) => {
    session.on('error', () => {})
  })
  server.on('stream', (stream) => {
    stream.on('error', () => {})

    if (++streams === 1) {
      stream.respond({ ':status': 200 })
      stream.end()
      return
    }

    // The POST is on stream 3, so GOAWAY(lastStreamID = 1) says it was not
    // processed. Node rewrites a lastStreamID of 0 to the last stream it
    // received, hence the GET before it.
    if (streams === 2) {
      stream.session.goaway(constants.NGHTTP2_NO_ERROR, 1)
      return
    }

    let body = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => { body += chunk })
    stream.on('end', () => {
      received = body
      stream.respond({ ':status': 200 })
      stream.end()
    })
  })

  server.listen(0)
  await once(server, 'listening')

  const origin = `https://localhost:${server.address().port}`
  const client = new Client(origin, {
    allowH2: true,
    connect: { rejectUnauthorized: false }
  })
  t.after(closeClientAndServerAsPromise(client, server))

  await (await fetch(origin, { dispatcher: client })).text()

  const response = await fetch(origin, {
    method: 'POST',
    body: 'foo=bar',
    dispatcher: client
  })

  t.assert.strictEqual(response.status, 200)
  t.assert.strictEqual(streams, 3)
  t.assert.strictEqual(received, 'foo=bar')
})
