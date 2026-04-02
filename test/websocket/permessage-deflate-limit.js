'use strict'

const { test } = require('node:test')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { WebSocketServer } = require('ws')
const { WebSocket, Agent } = require('../..')

test('Compressed message under limit decompresses successfully', async (t) => {
  const server = new WebSocketServer({
    port: 0,
    perMessageDeflate: true
  })

  t.after(() => server.close())

  await once(server, 'listening')

  server.on('connection', (ws) => {
    // Send 1 KB of data (well under any reasonable limit)
    ws.send(Buffer.alloc(1024, 0x41), { binary: true })
  })

  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`)

  const [event] = await once(client, 'message')
  t.assert.strictEqual(event.data.size, 1024)
  client.close()
})

test('Agent webSocketOptions.maxDecompressedMessageSize is read correctly', async (t) => {
  const customLimit = 128 * 1024 * 1024 // 128 MB
  const agent = new Agent({
    webSocket: {
      maxDecompressedMessageSize: customLimit
    }
  })

  t.after(() => agent.close())

  // Verify the option is stored and retrievable
  t.assert.strictEqual(agent.webSocketOptions.maxDecompressedMessageSize, customLimit)
})

test('Agent with default webSocketOptions uses 64 MB limit', async (t) => {
  const agent = new Agent()

  t.after(() => agent.close())

  // Default should be 64 MB
  t.assert.strictEqual(agent.webSocketOptions.maxDecompressedMessageSize, 64 * 1024 * 1024)
})

test('Custom maxDecompressedMessageSize allows messages under limit', async (t) => {
  const server = new WebSocketServer({
    port: 0,
    perMessageDeflate: true
  })

  t.after(() => server.close())
  await once(server, 'listening')

  const dataSize = 512 * 1024 // 512 KB

  server.on('connection', (ws) => {
    ws.send(Buffer.alloc(dataSize, 0x41), { binary: true })
  })

  // Set custom limit of 1 MB via Agent
  const agent = new Agent({
    webSocket: {
      maxDecompressedMessageSize: 1 * 1024 * 1024
    }
  })

  t.after(() => agent.close())

  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { dispatcher: agent })

  const [event] = await once(client, 'message')
  t.assert.strictEqual(event.data.size, dataSize, 'Message under limit should be received')
  client.close()
})

test('Messages at exactly the limit succeed', async (t) => {
  const limit = 1 * 1024 * 1024 // 1 MB
  const server = new WebSocketServer({
    port: 0,
    perMessageDeflate: true
  })

  t.after(() => server.close())
  await once(server, 'listening')

  server.on('connection', (ws) => {
    ws.send(Buffer.alloc(limit, 0x41), { binary: true })
  })

  const agent = new Agent({
    webSocket: {
      maxDecompressedMessageSize: limit
    }
  })

  t.after(() => agent.close())

  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { dispatcher: agent })

  const [event] = await once(client, 'message')
  t.assert.strictEqual(event.data.size, limit, 'Message at exactly the limit should succeed')
  client.close()
})

test('Messages over the limit are rejected', async (t) => {
  const limit = 1 * 1024 * 1024 // 1 MB
  const server = new WebSocketServer({
    port: 0,
    perMessageDeflate: true
  })

  t.after(() => server.close())
  await once(server, 'listening')

  let messageReceived = false
  let closeEvent = null

  server.on('connection', (ws) => {
    // Send 2 MB of data, which exceeds the 1 MB limit
    ws.send(Buffer.alloc(2 * 1024 * 1024, 0x41), { binary: true })
  })

  const agent = new Agent({
    webSocket: {
      maxDecompressedMessageSize: limit
    }
  })

  t.after(() => agent.close())

  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { dispatcher: agent })

  client.addEventListener('message', () => {
    messageReceived = true
  })

  client.addEventListener('close', (event) => {
    closeEvent = event
  })

  // Wait for connection to close (should happen when limit is exceeded)
  // Use Promise.race with a timeout to avoid hanging forever
  const closePromise = once(client, 'close')
  const timeoutPromise = sleep(5000)

  await Promise.race([closePromise, timeoutPromise])

  t.assert.strictEqual(messageReceived, false, 'Message over limit should be rejected')
  t.assert.ok(closeEvent !== null, 'Close event should have been emitted')
  t.assert.strictEqual(client.readyState, WebSocket.CLOSED, 'Connection should be closed after exceeding limit')
})

test('Limit can be disabled by setting maxDecompressedMessageSize to 0', async (t) => {
  const server = new WebSocketServer({
    port: 0,
    perMessageDeflate: true
  })

  t.after(() => server.close())
  await once(server, 'listening')

  const dataSize = 100 * 1024 * 1024 // 100 MB

  server.on('connection', (ws) => {
    ws.send(Buffer.alloc(dataSize, 0x41), { binary: true })
  })

  // Set limit to 0 (disabled)
  const agent = new Agent({
    webSocket: {
      maxDecompressedMessageSize: 0
    }
  })

  t.after(() => agent.close())

  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { dispatcher: agent })

  // Use Promise.race with timeout since large message takes time
  const messagePromise = once(client, 'message')
  const timeoutPromise = sleep(10000)

  const result = await Promise.race([messagePromise, timeoutPromise])

  if (result) {
    t.assert.strictEqual(result[0].data.size, dataSize, 'Large message should be received when limit is disabled')
    client.close()
  } else {
    t.fail('Test timed out waiting for large message')
  }
})
