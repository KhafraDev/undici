'use strict'

const { lookup } = require('node:dns/promises')
const { isIP } = require('node:net')
const { tryLoadQuic } = require('./quic')
const {
  verifyCertificateHash,
  satisfiesCustomCertificateRequirements
} = require('../util')

/**
 * The registered symbol used by the experimental stream/iter protocol that
 * node:quic's stream writer implements. Calling it returns a promise that
 * resolves once the writer can accept more data, or null when no drain is
 * needed (or possible).
 */
const kDrainable = Symbol.for('Stream.drainableProtocol')

/**
 * @typedef {object} TransportStreamStats
 * @property {number} bytesSent
 * @property {number} bytesAcknowledged
 * @property {number} bytesReceived
 */

/**
 * An internal wrapper around a node:quic QuicStream exposing exactly the
 * operations the WebTransport algorithms need. All error codes crossing
 * this interface are WebTransport application error codes; mapping to and
 * from the wire (identity for raw QUIC, the WT_APPLICATION_ERROR range for
 * HTTP/3) is provided by the owning session.
 */
class QuicTransportStream {
  /** @type {import('node:quic').QuicStream} */
  #stream
  #mapCodeToWire
  #mapCodeFromWire
  /** Buffered incoming chunks not yet consumed by readInto. */
  #leftover = []
  /** Total buffered bytes in #leftover. */
  #leftoverBytes = 0
  #iterator = null
  #finReceived = false
  #readError = null
  #writer = null
  /** True once this side ended or reset the writable side itself. */
  #writeEndedLocally = false
  #onReset = null
  #onStopSending = null
  #resetDelivered = false

  /**
   * @param {import('node:quic').QuicStream} stream
   * @param {(code: number) => bigint} mapCodeToWire
   * @param {(code: bigint) => number|null} mapCodeFromWire
   */
  constructor (stream, mapCodeToWire, mapCodeFromWire) {
    this.#stream = stream
    this.#mapCodeToWire = mapCodeToWire
    this.#mapCodeFromWire = mapCodeFromWire

    // A RESET_STREAM from the peer is the "sending aborted signal coming
    // from the server" for the readable side.
    stream.onreset = (error) => {
      this.#deliverReset(error?.errorCode ?? 0n)
    }
  }

  get id () {
    return this.#stream.id
  }

  /** @returns {'bidi'|'uni'} */
  get direction () {
    return this.#stream.direction
  }

  #deliverReset (wireCode) {
    if (this.#resetDelivered) {
      return
    }
    this.#resetDelivered = true
    this.#onReset?.(this.#mapCodeFromWire(BigInt(wireCode)))
  }

  /**
   * Registers the callback invoked with the WebTransport application error
   * code when the peer aborts its sending side (RESET_STREAM).
   * @param {(code: number|null) => void} callback
   */
  onReset (callback) {
    this.#onReset = callback
  }

  /**
   * Registers the callback invoked when the peer signals it no longer
   * wants to receive data (STOP_SENDING).
   *
   * Deviation: node:quic handles an incoming STOP_SENDING frame entirely
   * internally (it ends the writable side without surfacing the frame's
   * error code to JavaScript), so this signal can only be detected when a
   * write fails, and the code delivered to the callback is always null.
   * @param {(code: number|null) => void} callback
   */
  onStopSending (callback) {
    this.#onStopSending = callback
  }

  /**
   * Reads received bytes into view, resolving once at least one byte was
   * read or FIN was received.
   * @param {Uint8Array} view
   * @returns {Promise<{ read: number, hasReceivedFIN: boolean }>}
   */
  async readInto (view) {
    while (this.#leftoverBytes === 0 && !this.#finReceived) {
      if (this.#readError !== null) {
        throw this.#readError
      }
      this.#iterator ??= this.#stream[Symbol.asyncIterator]()
      let result
      try {
        result = await this.#iterator.next()
      } catch (err) {
        // A peer RESET_STREAM surfaces both through the stream's onreset
        // callback (which fires first and carries the error code) and as
        // an ERR_QUIC_STREAM_RESET read error here.
        this.#readError = err
        throw err
      }
      if (result.done) {
        this.#finReceived = true
        break
      }
      // The stream's async iterator yields batches (arrays) of Uint8Array
      // chunks.
      for (const chunk of result.value) {
        this.#leftover.push(chunk)
        this.#leftoverBytes += chunk.byteLength
      }
    }

    let read = 0
    while (read < view.byteLength && this.#leftover.length > 0) {
      const chunk = this.#leftover[0]
      const take = Math.min(chunk.byteLength, view.byteLength - read)
      view.set(take === chunk.byteLength ? chunk : chunk.subarray(0, take), read)
      read += take
      this.#leftoverBytes -= take
      if (take === chunk.byteLength) {
        this.#leftover.shift()
      } else {
        this.#leftover[0] = chunk.subarray(take)
      }
    }

    return {
      read,
      hasReceivedFIN: this.#finReceived && this.#leftoverBytes === 0
    }
  }

  /**
   * Writes bytes to the stream, resolving once the bytes were accepted
   * (waiting for the send buffer to drain when necessary).
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  async write (bytes) {
    const writer = this.#writer ??= this.#stream.writer

    while (!writer.writeSync(bytes)) {
      const drained = writer[kDrainable]()
      if (drained === null) {
        // The writer is closed or errored. If this side did not end the
        // writable side itself, the peer asked us to stop sending
        // (STOP_SENDING), which node:quic applies without surfacing the
        // frame's error code.
        if (!this.#writeEndedLocally) {
          this.#onStopSending?.(null)
        }
        throw new Error('The stream is no longer writable')
      }
      await drained
    }
  }

  /**
   * Sends FIN and waits for the write side to finish.
   * @returns {Promise<void>}
   */
  async finish () {
    this.#writeEndedLocally = true
    const writer = this.#writer ??= this.#stream.writer
    await writer.end()
  }

  /**
   * Aborts sending on the stream (RESET_STREAM) with a WebTransport
   * application error code.
   *
   * Deviation: committedOffset is accepted for symmetry with the
   * specification, but node:quic does not implement the RESET_STREAM_AT
   * frame [RELIABLE-RESET], so the reliable-delivery offset cannot be
   * honored and a regular RESET_STREAM is sent instead.
   * @param {number} code
   * @param {number} committedOffset
   */
  resetWithCode (code, committedOffset) {
    if (this.#writeEndedLocally) {
      return
    }
    this.#writeEndedLocally = true
    this.#stream.resetStream(this.#mapCodeToWire(code))
  }

  /**
   * Aborts receiving on the stream (STOP_SENDING) with a WebTransport
   * application error code.
   * @param {number} code
   */
  stopSendingWithCode (code) {
    this.#stream.stopSending(this.#mapCodeToWire(code))
  }

  /**
   * @returns {Promise<TransportStreamStats>}
   */
  async getStats () {
    const stats = this.#stream.stats
    return {
      bytesSent: Number(stats.bytesSent),
      bytesAcknowledged: Number(stats.maxOffsetAcknowledged),
      bytesReceived: Number(stats.bytesReceived)
    }
  }
}

/**
 * The base class of the two WebTransport transport backends. It owns the
 * node:quic QuicSession and exposes exactly the operations the WebTransport
 * algorithms need. Subclasses implement the protocol-specific parts:
 * session establishment, error code mapping, datagram framing, and session
 * termination.
 */
class TransportSessionBase {
  /** @type {import('node:quic').QuicSession|null} */
  session = null
  /** @type {URL} */
  url
  /** @type {ReturnType<typeof Promise.withResolvers>} */
  #closed = Promise.withResolvers()
  #closedSettled = false
  #incomingDatagrams = []
  #onDatagramsAvailable = null
  #onIncomingBidirectionalStream = null
  #onIncomingUnidirectionalStream = null
  #onDraining = null
  #draining = false

  /**
   * @param {URL} url the parsed WebTransport URL
   * @param {object} options
   * @param {{ algorithm: string, value: Uint8Array }[]} options.serverCertificateHashes
   * @param {'default'|'throughput'|'low-latency'} options.congestionControl
   * @param {number|null} options.anticipatedConcurrentIncomingUnidirectionalStreams
   * @param {number|null} options.anticipatedConcurrentIncomingBidirectionalStreams
   */
  constructor (url, options) {
    this.url = url
    this.options = options
  }

  /**
   * A promise settled when the session terminates: resolved with
   * `{ closeCode, reason }` when the session terminated cleanly, rejected
   * with an error when it terminated due to a network error.
   */
  get closed () {
    return this.#closed.promise
  }

  /**
   * Maps a WebTransport application error code to the wire error code.
   * Identity by default (raw QUIC).
   * @param {number} code
   * @returns {bigint}
   */
  mapCodeToWire (code) {
    return BigInt(code)
  }

  /**
   * Maps a wire error code to a WebTransport application error code, or
   * null when the wire code has no WebTransport mapping.
   * @param {bigint} code
   * @returns {number|null}
   */
  mapCodeFromWire (code) {
    return code <= 0xffffffffn ? Number(code) : null
  }

  /**
   * Opens the underlying QuicSession. Since node:quic connects to a socket
   * address, the URL host is resolved with DNS first when it is not an IP
   * literal.
   * @param {object} sessionOptions extra options for quic.connect()
   * @returns {Promise<import('node:quic').QuicSession>}
   */
  async _openQuicSession (sessionOptions) {
    const quic = tryLoadQuic()
    if (quic === null) {
      throw new Error(
        'node:quic is not available. WebTransport requires a Node.js build ' +
        'with QUIC support, started with the --experimental-quic flag.'
      )
    }

    const { url, options } = this

    // https://url.spec.whatwg.org/#default-port - the url scheme is always
    // "https" whose default port is 443.
    const port = url.port === '' ? 443 : Number(url.port)
    // URL hosts serialize IPv6 literals in brackets.
    const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname
    const address = isIP(hostname) !== 0
      ? hostname
      : (await lookup(hostname)).address

    // "the user agent MUST initially allow at least 100 incoming
    //  unidirectional streams from the server" / "The user agent MUST
    //  initially allow the server to create at least 100 bidirectional
    //  streams." If not null, the anticipated numbers of concurrent
    //  incoming streams are taken into consideration.
    const initialMaxStreamsUni = Math.max(
      100, options.anticipatedConcurrentIncomingUnidirectionalStreams ?? 0)
    const initialMaxStreamsBidi = Math.max(
      100, options.anticipatedConcurrentIncomingBidirectionalStreams ?? 0)

    // congestionControl is "a hint to the user agent"; node:quic supports
    // multiple congestion control algorithms, chosen here per hint.
    let cc
    switch (options.congestionControl) {
      case 'throughput':
        cc = 'cubic'
        break
      case 'low-latency':
        cc = 'bbr'
        break
    }

    // "If supported and non-empty, the user agent SHALL deem a server
    //  certificate trusted if and only if it can successfully verify a
    //  certificate hash against serverCertificateHashes and satisfies
    //  custom certificate requirements. ... If empty, the user agent SHALL
    //  use certificate verification procedures it would use for normal
    //  fetch operations."
    const usesCertificateHashes = options.serverCertificateHashes.length > 0

    const session = await quic.connect({ address, port }, {
      servername: hostname,
      verifyPeer: usesCertificateHashes ? 'manual' : 'auto',
      transportParams: {
        initialMaxData: 15_728_640,
        initialMaxStreamDataBidiLocal: 6_291_456,
        initialMaxStreamDataBidiRemote: 6_291_456,
        initialMaxStreamDataUni: 6_291_456,
        initialMaxStreamsBidi,
        initialMaxStreamsUni,
        // Advertise support for receiving QUIC datagrams [RFC 9221].
        maxDatagramFrameSize: 65535
      },
      ...(cc !== undefined ? { cc } : {}),
      ...sessionOptions
    })
    this.session = session

    session.ondatagram = (datagram) => {
      this._receiveWireDatagram(datagram)
    }
    session.onstream = (stream) => {
      this._receiveWireStream(stream)
    }

    session.closed.then(
      () => this._settleClosed({ closeCode: 0, reason: '' }),
      (err) => {
        // A peer CONNECTION_CLOSE carrying an application error code is a
        // session termination initiated by the peer; other errors are
        // network errors.
        if (err?.type === 'application') {
          this._handleApplicationClose(err)
        } else {
          this._failClosed(err)
        }
      }
    )

    await session.opened

    if (usesCertificateHashes) {
      // To verify a certificate hash, given a certificate chain and an
      // array of hashes ... In addition the certificate must satisfy the
      // custom certificate requirements.
      const certificate = session.peerCertificate
      if (
        certificate === undefined ||
        !verifyCertificateHash(certificate, options.serverCertificateHashes) ||
        !satisfiesCustomCertificateRequirements(certificate)
      ) {
        const error = new Error('Server certificate verification failed')
        session.destroy(error)
        throw error
      }
    }

    return session
  }

  /**
   * Handles a peer-initiated CONNECTION_CLOSE with an application error
   * code. By default (raw QUIC) the code carries the WebTransport session
   * close code directly.
   * @param {import('node:quic').QuicError} err
   */
  _handleApplicationClose (err) {
    this._settleClosed({
      closeCode: err.errorCode <= 0xffffffffn ? Number(err.errorCode) : 0,
      reason: typeof err.message === 'string' ? err.message : ''
    })
  }

  _settleClosed (closeInfo) {
    if (this.#closedSettled) {
      return
    }
    this.#closedSettled = true
    this.#closed.resolve(closeInfo)
  }

  _failClosed (error) {
    if (this.#closedSettled) {
      return
    }
    this.#closedSettled = true
    this.#closed.reject(error)
  }

  /**
   * Handles a raw datagram received from the wire. Subclasses strip and
   * check protocol framing. The default implementation buffers the payload
   * as-is.
   * @param {Uint8Array} datagram
   */
  _receiveWireDatagram (datagram) {
    this._bufferDatagram(datagram)
  }

  _bufferDatagram (datagram) {
    this.#incomingDatagrams.push(datagram)
    this.#onDatagramsAvailable?.()
  }

  /**
   * Handles a stream initiated by the peer. Subclasses may intercept
   * protocol-internal streams. The default implementation surfaces the
   * stream as an incoming WebTransport stream.
   * @param {import('node:quic').QuicStream} stream
   */
  _receiveWireStream (stream) {
    const wrapped = new QuicTransportStream(
      stream,
      (code) => this.mapCodeToWire(code),
      (code) => this.mapCodeFromWire(code)
    )
    if (stream.direction === 'bidi') {
      this.#onIncomingBidirectionalStream?.(wrapped)
    } else {
      this.#onIncomingUnidirectionalStream?.(wrapped)
    }
  }

  _signalDraining () {
    if (this.#draining) {
      return
    }
    this.#draining = true
    this.#onDraining?.()
  }

  /**
   * "receiving a datagram with session": takes the next buffered incoming
   * datagram, or returns null when none are available.
   * @returns {Uint8Array|null}
   */
  takeDatagram () {
    return this.#incomingDatagrams.length !== 0
      ? this.#incomingDatagrams.shift()
      : null
  }

  /** @param {() => void} callback */
  onDatagramsAvailable (callback) {
    this.#onDatagramsAvailable = callback
  }

  /** @param {(stream: QuicTransportStream) => void} callback */
  onIncomingBidirectionalStream (callback) {
    this.#onIncomingBidirectionalStream = callback
  }

  /** @param {(stream: QuicTransportStream) => void} callback */
  onIncomingUnidirectionalStream (callback) {
    this.#onIncomingUnidirectionalStream = callback
  }

  /** @param {() => void} callback */
  onDraining (callback) {
    this.#onDraining = callback
  }

  /**
   * Opens an outgoing bidirectional WebTransport stream.
   * @returns {Promise<QuicTransportStream>}
   */
  async createBidirectionalStream () {
    const stream = await this.session.createBidirectionalStream()
    return new QuicTransportStream(
      stream,
      (code) => this.mapCodeToWire(code),
      (code) => this.mapCodeFromWire(code)
    )
  }

  /**
   * Opens an outgoing unidirectional WebTransport stream.
   * @returns {Promise<QuicTransportStream>}
   */
  async createUnidirectionalStream () {
    const stream = await this.session.createUnidirectionalStream()
    return new QuicTransportStream(
      stream,
      (code) => this.mapCodeToWire(code),
      (code) => this.mapCodeFromWire(code)
    )
  }

  /**
   * "Send a datagram, with transport.[[Session]] and bytes." Subclasses
   * add protocol framing.
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  async sendDatagram (bytes) {
    await this.session.sendDatagram(bytes)
  }

  /**
   * The maximum size of an outgoing datagram payload, accounting for any
   * protocol framing overhead, or 0 when datagrams are not supported.
   * @returns {number}
   */
  get maxDatagramSize () {
    return this.session?.maxDatagramSize ?? 0
  }

  /**
   * Gathers connection-level stats to populate
   * WebTransportConnectionStats. Time values from node:quic are in
   * nanoseconds and are converted to milliseconds.
   * @returns {import('node:quic').QuicSessionStats|null}
   */
  getStats () {
    if (this.session === null) {
      return null
    }
    const stats = this.session.stats
    return {
      bytesSent: Number(stats.bytesSent),
      packetsSent: Number(stats.pktSent),
      bytesLost: Number(stats.bytesLost),
      packetsLost: Number(stats.pktLost),
      bytesReceived: Number(stats.bytesRecv),
      packetsReceived: Number(stats.pktRecv),
      smoothedRtt: Number(stats.smoothedRtt) / 1e6,
      rttVariation: Number(stats.rttVar) / 1e6,
      minRtt: Number(stats.minRtt) / 1e6,
      datagramsSent: Number(stats.datagramsSent),
      datagramsReceived: Number(stats.datagramsReceived),
      datagramsAcknowledged: Number(stats.datagramsAcknowledged),
      datagramsLost: Number(stats.datagramsLost)
    }
  }

  /**
   * Exports TLS keying material [RFC8446 Section 7.5].
   * @returns {Promise<never>}
   */
  exportKeyingMaterial () {
    // node:quic does not expose the TLS exporter interface.
    return Promise.reject(new DOMException(
      'exportKeyingMaterial is not supported', 'NotSupportedError'))
  }

  /**
   * Hard teardown of the session.
   * @param {Error} [error]
   */
  destroy (error) {
    this.session?.destroy(error)
  }
}

module.exports = {
  QuicTransportStream,
  TransportSessionBase
}
