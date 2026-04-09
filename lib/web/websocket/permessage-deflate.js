'use strict'

const { createInflateRaw, Z_DEFAULT_WINDOWBITS } = require('node:zlib')
const { isValidClientWindowBits } = require('./util')
const { MessageSizeExceededError } = require('../../core/errors')

const tail = Buffer.from([0x00, 0x00, 0xff, 0xff])
const kBuffer = Symbol('kBuffer')
const kLength = Symbol('kLength')

// Default maximum decompressed message size: 128 MB
const kDefaultMaxDecompressedSize = 128 * 1024 * 1024
// Maximum expansion ratio for estimated size check (conservative DEFLATE upper bound)
const kMaxExpansionRatio = 10

class PerMessageDeflate {
  /** @type {import('node:zlib').InflateRaw} */
  #inflate

  #options = {}

  /** @type {number} */
  #maxDecompressedSize

  /** @type {boolean} */
  #aborted = false

  /** @type {Function|null} */
  #currentCallback = null

  /**
   * @param {Map<string, string>} extensions
   * @param {{ maxPayloadSize?: number }} [options]
   */
  constructor (extensions, options = {}) {
    this.#options.serverNoContextTakeover = extensions.has('server_no_context_takeover')
    this.#options.serverMaxWindowBits = extensions.get('server_max_window_bits')
    // 0 disables the limit
    this.#maxDecompressedSize = options.maxPayloadSize ?? kDefaultMaxDecompressedSize
  }

  /**
   * Check if compressed payload could exceed the decompressed size limit.
   * Uses a conservative expansion ratio estimate for early rejection.
   * @param {number} compressedLength
   * @returns {boolean} true if the message should be rejected
   */
  #exceedsEstimatedLimit (compressedLength) {
    // 0 disables the limit
    if (this.#maxDecompressedSize <= 0) return false
    return compressedLength * kMaxExpansionRatio > this.#maxDecompressedSize
  }

  /**
   * Decompress a compressed payload.
   * @param {Buffer} chunk Compressed data
   * @param {boolean} fin Final fragment flag
   * @param {Function} callback Callback function
   * @param {number} [compressedLength] Compressed payload length for estimated size check
   */
  decompress (chunk, fin, callback, compressedLength) {
    // An endpoint uses the following algorithm to decompress a message.
    // 1.  Append 4 octets of 0x00 0x00 0xff 0xff to the tail end of the
    //     payload of the message.
    // 2.  Decompress the resulting data using DEFLATE.

    // Early rejection based on estimated expansion
    if (compressedLength != null && this.#exceedsEstimatedLimit(compressedLength)) {
      callback(new MessageSizeExceededError())
      return
    }

    if (this.#aborted) {
      callback(new MessageSizeExceededError())
      return
    }

    if (!this.#inflate) {
      let windowBits = Z_DEFAULT_WINDOWBITS

      if (this.#options.serverMaxWindowBits) { // empty values default to Z_DEFAULT_WINDOWBITS
        if (!isValidClientWindowBits(this.#options.serverMaxWindowBits)) {
          callback(new Error('Invalid server_max_window_bits'))
          return
        }

        windowBits = Number.parseInt(this.#options.serverMaxWindowBits)
      }

      try {
        this.#inflate = createInflateRaw({ windowBits })
      } catch (err) {
        callback(err)
        return
      }
      this.#inflate[kBuffer] = []
      this.#inflate[kLength] = 0

      this.#inflate.on('data', (data) => {
        if (this.#aborted) {
          return
        }

        this.#inflate[kLength] += data.length

        // 0 disables the limit
        if (this.#maxDecompressedSize > 0 && this.#inflate[kLength] > this.#maxDecompressedSize) {
          this.#aborted = true
          this.#inflate.removeAllListeners()
          this.#inflate.destroy()
          this.#inflate = null

          if (this.#currentCallback) {
            const cb = this.#currentCallback
            this.#currentCallback = null
            cb(new MessageSizeExceededError())
          }
          return
        }

        this.#inflate[kBuffer].push(data)
      })

      this.#inflate.on('error', (err) => {
        this.#inflate = null
        callback(err)
      })
    }

    this.#currentCallback = callback
    this.#inflate.write(chunk)
    if (fin) {
      this.#inflate.write(tail)
    }

    this.#inflate.flush(() => {
      if (this.#aborted || !this.#inflate) {
        return
      }

      const full = Buffer.concat(this.#inflate[kBuffer], this.#inflate[kLength])

      this.#inflate[kBuffer].length = 0
      this.#inflate[kLength] = 0
      this.#currentCallback = null

      callback(null, full)
    })
  }
}

module.exports = { PerMessageDeflate }
