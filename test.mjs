import stream from 'node:stream'
import { Request } from './index.js'
import assert from 'node:assert'

const body = stream.Readable.from('a=1')
const { signal } = new AbortController()
const request = new Request('https://a', {
    body,
    method: 'POST',
    redirect: 'manual',
    headers: {
    b: '2'
    },
    follow: 3,
    compress: false,
    signal,
    duplex: 'half'
})
const cl = request.clone()
assert.strictEqual(cl.method, 'POST')
assert.strictEqual(cl.redirect, 'manual')
assert.strictEqual(cl.headers.get('b'), '2')
assert.strictEqual(cl.method, 'POST')
// Clone body shouldn't be the same body
assert.notDeepEqual(cl.body, body)
Promise.all([cl.text(), request.text()]).then(results => {
    assert.strictEqual(results[0], 'a=1')
    assert.strictEqual(results[1], 'a=1')
})
