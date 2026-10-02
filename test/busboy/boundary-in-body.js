'use strict'

const { test } = require('node:test')
const { Response } = require('../..')

test('a body containing the boundary without the preceding CRLF and -- is parsed', async (t) => {
  for (const value of ['boundary', 'the boundary', 'x--boundary y', 'a\r\nboundary']) {
    const response = new Response(
      '--boundary\r\n' +
      'Content-Disposition: form-data; name="field"\r\n' +
      '\r\n' +
      `${value}\r\n` +
      '--boundary\r\n' +
      'Content-Disposition: form-data; name="file"; filename="file.txt"\r\n' +
      '\r\n' +
      `${value}\r\n` +
      '--boundary--', {
        headers: {
          'content-type': 'multipart/form-data; boundary=boundary'
        }
      })

    const fd = await response.formData()
    t.assert.deepEqual(fd.get('field'), value)
    t.assert.deepEqual(await fd.get('file').text(), value)
  }
})
