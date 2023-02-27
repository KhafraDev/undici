import { WPTRunner } from './runner/runner/runner.mjs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { fork } from 'child_process'
import { on } from 'events'

const serverPath = fileURLToPath(join(import.meta.url, '../server/server.mjs'))

const child = fork(serverPath, [], {
  stdio: ['pipe', 'pipe', 'pipe', 'ipc']
})

child.on('exit', (code) => process.exit(code))

for await (const [message] of on(child, 'message')) {
  if (message.server) {
    const runner = new WPTRunner('FileAPI', message.server)
    runner.addInitScript(`
      const globalPropertyDescriptors = {
        writable: true,
        enumerable: false,
        configurable: true
      }

      const buffer = await import('node:buffer')
      const { File, FileReader } = await import('../../../../index.js')

      Object.defineProperties(globalThis, {
        File: {
          ...globalPropertyDescriptors,
          value: buffer.File ?? File
        },
        FileReader: {
          ...globalPropertyDescriptors,
          value: FileReader
        }
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
