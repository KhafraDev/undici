'use strict'

/**
 * The lazily-loaded node:quic module, or null if it is unavailable.
 * `undefined` means no load has been attempted yet.
 * @type {typeof import('node:quic')|null|undefined}
 */
let quic

/**
 * Loads the experimental node:quic module if it is available.
 *
 * node:quic is only present when the Node.js binary was configured with
 * `--experimental-quic` (which requires an OpenSSL with QUIC support,
 * reflected in `process.features.quic`) and the process was started with
 * the `--experimental-quic` CLI flag.
 * @returns {typeof import('node:quic')|null}
 */
function tryLoadQuic () {
  if (quic !== undefined) {
    return quic
  }

  try {
    if (process.features.quic !== true) {
      quic = null
      return quic
    }
    const mod = require('node:quic')
    quic = typeof mod?.connect === 'function' ? mod : null
  } catch {
    quic = null
  }

  return quic
}

module.exports = {
  tryLoadQuic
}
