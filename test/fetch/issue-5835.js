'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { FormData, Response } = require('../..')

// https://github.com/nodejs/undici/issues/5835
test('a FormData body with an errored Blob part rejects the read', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undici-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const file = path.join(dir, 'a')
  fs.writeFileSync(file, 'hello')

  const form = new FormData()
  form.append('file', await fs.openAsBlob(file), 'a')
  // Changing the file invalidates the file-backed Blob, so its stream() errors.
  fs.appendFileSync(file, ' more')

  await t.assert.rejects(new Response(form).text(), { name: 'NotReadableError' })
})
