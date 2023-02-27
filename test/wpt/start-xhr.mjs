import { WPTRunner } from './runner/runner/runner.mjs'
import { once } from 'events'

const { WPT_REPORT } = process.env

const runner = new WPTRunner('xhr/formdata', 'http://localhost:3333', {
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
  const { File } = await import('../../../../index.js')

  Object.defineProperties(globalThis, {
    File: {
      ...globalPropertyDescriptors,
      value: buffer.File ?? File
    }
  })
`)
runner.run()

await once(runner, 'completion')
