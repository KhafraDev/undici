import { WPTRunner } from './runner/runner/runner.mjs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { fork } from 'child_process'
import { on } from 'events'

const { WPT_REPORT } = process.env

const serverPath = fileURLToPath(join(import.meta.url, '../server/server.mjs'))

const child = fork(serverPath, [], {
  stdio: ['pipe', 'pipe', 'pipe', 'ipc']
})

child.on('exit', (code) => process.exit(code))

for await (const [message] of on(child, 'message')) {
  if (message.server) {
    const runner = new WPTRunner('fetch', message.server, {
      appendReport: !!WPT_REPORT,
      reportPath: WPT_REPORT
    })

    runner.addInitScript(`
      const globalPropertyDescriptors = {
        writable: true,
        enumerable: false,
        configurable: true
      }

      const buffer = await import('node:buffer')
      const { fetch, File, FileReader, FormData, Headers, Request, Response } =
        await import('../../../../index.js')

      Object.defineProperties(globalThis, {
        fetch: {
          ...globalPropertyDescriptors,
          enumerable: true,
          value: fetch
        },
        File: {
          ...globalPropertyDescriptors,
          value: buffer.File ?? File
        },
        FormData: {
          ...globalPropertyDescriptors,
          value: FormData
        },
        Headers: {
          ...globalPropertyDescriptors,
          value: Headers
        },
        Request: {
          ...globalPropertyDescriptors,
          value: Request
        },
        Response: {
          ...globalPropertyDescriptors,
          value: Response
        },
        // Some fetch tests use FileReader.
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
