import { WebSocket } from './index.js'

import { WebSocketServer } from 'ws'

const server = new WebSocketServer()

server.on('connection', (socket) => {
  socket.on('message', (_data, _isBinary) => {
    socket.send('')
  })
})

await new Promise((resolve, _reject) => {
  server.on('listening', resolve)
})

const ws = new WebSocket(`http://localhost:${server.address().port}`)

ws.addEventListener('open', () => {
  ws.send('Hi')
})

ws.addEventListener('message', () => {
  console.log('ok')
  ws.close()
  server.close()
})

ws.addEventListener('error', (err) => {
  process.nextTick(() => {
    throw err
  })
})
