import { WPTRunner } from './runner/runner/runner.mjs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { fork } from 'child_process'
import { on } from 'events'

if (process.env.CI) {
  // TODO(@KhafraDev): figure out *why* these tests are flaky in the CI.
  // process.exit(0)
}

const serverPath = fileURLToPath(join(import.meta.url, '../server/websocket.mjs'))

const child = fork(serverPath, [], {
  stdio: ['pipe', 'pipe', 'pipe', 'ipc']
})

child.on('exit', (code) => process.exit(code))

for await (const [message] of on(child, 'message')) {
  if (message.server) {
    const runner = new WPTRunner('websockets', message.server)
    runner.addInitScript(`
      const globalPropertyDescriptors = {
        writable: true,
        enumerable: false,
        configurable: true
      }

      const { CloseEvent } = await import('../../../../lib/websocket/events.js')
      const { WebSocket } = await import('../../../../lib/websocket/websocket.js')

      Object.defineProperties(globalThis, {
        WebSocket: {
          ...globalPropertyDescriptors,
          value: WebSocket
        },
        CloseEvent: {
          ...globalPropertyDescriptors,
          value: CloseEvent
        },
      })
    `)
    runner.run()

    runner.once('completion', () => {
      if (child.connected) {
        child.send('shutdown')
      }
    })
  }
}
