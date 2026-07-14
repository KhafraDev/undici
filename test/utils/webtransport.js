'use strict'

/**
 * Returns whether the experimental node:quic module is usable in this
 * process. Requires a Node.js build configured with --experimental-quic
 * (reflected by process.features.quic) and the --experimental-quic CLI
 * flag.
 */
function hasQuic () {
  try {
    if (process.features.quic !== true) {
      return false
    }
    return typeof require('node:quic').connect === 'function'
  } catch {
    return false
  }
}

/**
 * A mock of the transport adapter's TransportStream interface
 * (lib/web/webtransport/transport/session.js) for exercising the stream
 * classes without a network.
 */
function makeMockInternalStream () {
  const written = []
  let onReset, onStopSending
  const incoming = []
  let fin = false
  let notify = null
  return {
    written,
    pushIncoming (bytes, isFin) {
      if (bytes) incoming.push(bytes)
      if (isFin) fin = true
      notify?.()
    },
    triggerReset (code) { onReset?.(code) },
    triggerStopSending (code) { onStopSending?.(code) },
    // TransportStream interface
    async write (bytes) { written.push(Buffer.from(bytes)) },
    async finish () { written.push('FIN') },
    resetWithCode (code, committedOffset) { written.push(['RESET', code, committedOffset]) },
    stopSendingWithCode (code) { written.push(['STOP_SENDING', code]) },
    async readInto (view) {
      while (incoming.length === 0 && !fin) {
        await new Promise((resolve) => { notify = resolve })
        notify = null
      }
      let read = 0
      if (incoming.length > 0) {
        const chunk = incoming[0]
        read = Math.min(chunk.length, view.length)
        view.set(chunk.subarray(0, read))
        if (read === chunk.length) incoming.shift()
        else incoming[0] = chunk.subarray(read)
      }
      return { read, hasReceivedFIN: fin && incoming.length === 0 }
    },
    async getStats () { return { bytesSent: 5, bytesAcknowledged: 3, bytesReceived: 7 } },
    onReset (cb) { onReset = cb },
    onStopSending (cb) { onStopSending = cb }
  }
}

/**
 * A mock of the [[Transport]] internal context shared by the WebTransport
 * classes (see TransportContext in lib/web/webtransport/sendgroup.js).
 */
function makeMockContext (state = 'connected') {
  const sent = []
  const incoming = []
  return {
    sendStreams: new Set(),
    receiveStreams: new Set(),
    state,
    datagrams: null,
    session: {
      sent,
      incoming,
      async sendDatagram (bytes) { sent.push(Buffer.from(bytes)) },
      takeDatagram () { return incoming.length ? incoming.shift() : null }
    }
  }
}

module.exports = {
  hasQuic,
  makeMockInternalStream,
  makeMockContext
}
