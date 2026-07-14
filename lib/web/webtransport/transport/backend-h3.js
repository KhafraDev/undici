'use strict'

const { TransportSessionBase } = require('./session')
const {
  webtransportCodeToHttpCode,
  httpCodeToWebtransportCode,
  encodeVarint,
  decodeVarint
} = require('../util')
const {
  WT_CLOSE_SESSION,
  WT_DRAIN_SESSION,
  H3_NO_ERROR
} = require('../constants')

/**
 * The default transport backend: WebTransport over HTTP/3
 * (draft-ietf-webtrans-http3), on top of node:quic's HTTP/3 application
 * (nghttp3), which is selected by negotiating the "h3" ALPN.
 *
 * Supported on this backend today:
 * - session establishment: the Extended CONNECT request
 *   (":method: CONNECT" with ":protocol: webtransport", [RFC 9220]),
 *   including subprotocol negotiation and response headers;
 * - datagrams, with the HTTP/3 Datagram quarter-stream-ID framing
 *   [RFC 9297] applied in JavaScript;
 * - session termination and draining via the WT_CLOSE_SESSION /
 *   WT_DRAIN_SESSION capsules on the CONNECT stream (capsules travel in
 *   HTTP/3 DATA frames, which nghttp3 produces and parses for us), plus
 *   draining via HTTP/3 GOAWAY.
 *
 * NOT supported on this backend today — node:quic's HTTP/3 application
 * cannot carry WebTransport streams in either direction: incoming
 * unidirectional streams are consumed internally by nghttp3
 * (node/src/quic/http3.cc ReceiveStreamOpen), all incoming bidirectional
 * stream bytes are parsed as HTTP/3 frames, and all outgoing bytes are
 * framed by nghttp3, so the WebTransport stream signal can neither be
 * sent nor received. Stream creation therefore fails until node:quic
 * gains WebTransport support, and incoming WebTransport streams never
 * arrive.
 */
class Http3TransportSession extends TransportSessionBase {
  /** @type {import('node:quic').QuicStream|null} */
  #connectStream = null
  #connectWriter = null
  /** The encoded quarter stream ID prefix for outgoing HTTP datagrams. */
  #datagramPrefix = null
  /** @type {bigint|null} */
  #quarterStreamId = null
  #closeInfoFromCapsule = null

  /**
   * @param {URL} url
   * @param {object} options see TransportSessionBase, plus:
   * @param {[string, string][]} options.requestHeaders header name/value
   * pairs to add to the CONNECT request
   * @param {string[]} options.protocols the WebTransport subprotocols to
   * offer, already validated and serialized-ready
   */
  async connect () {
    const session = await this._openQuicSession({
      alpn: 'h3',
      application: {
        // SETTINGS_ENABLE_CONNECT_PROTOCOL [RFC 9220]
        enableConnectProtocol: true,
        // SETTINGS_H3_DATAGRAM [RFC 9297]
        enableDatagrams: true
      }
    })

    // "Session starts draining" - over HTTP/3 a GOAWAY frame drains the
    // connection and every WebTransport session on it.
    session.ongoaway = () => {
      this._signalDraining()
    }

    // In order for a client to send an Extended CONNECT request the
    // server must have sent SETTINGS_ENABLE_CONNECT_PROTOCOL with a value
    // of 1 [RFC 9220]. The server's SETTINGS frame arrives shortly after
    // the handshake; node:quic surfaces it via the onapplication callback.
    const settingsReceived = Promise.withResolvers()
    session.onapplication = () => {
      settingsReceived.resolve()
    }

    const { url, options } = this

    // The CONNECT stream must remain open for the lifetime of the session
    // (it carries capsules), so the request headers cannot be passed to
    // createBidirectionalStream(): that would mark them terminal (no body)
    // and close the stream's write side. Instead the stream is created
    // bare, its writer is initialized (attaching a streaming body source),
    // and the headers are sent explicitly below.
    const stream = await session.createBidirectionalStream()
    this.#connectStream = stream
    this.#connectWriter = stream.writer

    // HTTP Datagrams are associated with the CONNECT stream through the
    // quarter stream ID: "the value of the CONNECT stream's stream ID
    // divided by four" [RFC 9297].
    this.#quarterStreamId = BigInt(stream.id) / 4n
    this.#datagramPrefix = encodeVarint(this.#quarterStreamId)

    const responseReceived = Promise.withResolvers()
    stream.onheaders = (headers) => {
      responseReceived.resolve(headers)
    }

    /**
     * The Extended CONNECT request of WebTransport over HTTP/3:
     * ":method" = "CONNECT", ":protocol" = "webtransport",
     * ":scheme" = "https", ":authority" and ":path" from the URL.
     * @see https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3-13#section-3.3
     */
    const headers = {
      ':method': 'CONNECT',
      ':protocol': 'webtransport',
      ':scheme': 'https',
      ':authority': url.host,
      ':path': `${url.pathname}${url.search}`
    }
    for (const [name, value] of options.requestHeaders) {
      headers[name] = value
    }
    if (options.protocols.length > 0) {
      // "set a structured field value with (WT-Available-Protocols, a
      //  structured header list whose members are the structured header
      //  string items in protocols in order) in request's header list."
      headers['wt-available-protocols'] = serializeProtocolsList(options.protocols)
    }

    try {
      stream.sendHeaders(headers)
    } catch {
      // The server's SETTINGS frame has not arrived yet; wait for it and
      // retry once.
      await settingsReceived.promise
      stream.sendHeaders(headers)
    }

    const responseHeaders = await responseReceived.promise

    // "A successful (2xx) response indicates that the server has accepted
    //  the WebTransport session"; "the WebTransport session (along with
    //  the CONNECT stream) is terminated" on any other status.
    const status = Number(responseHeaders[':status'])
    if (!(status >= 200 && status <= 299)) {
      const error = new Error(`The server rejected the WebTransport session with status ${status}`)
      session.destroy(error)
      throw error
    }

    // Read the CONNECT stream for capsules (session termination and
    // draining travel as WT_CLOSE_SESSION / WT_DRAIN_SESSION capsules in
    // the stream's DATA frames).
    this.#readCapsules(stream)

    return {
      // "Set transport.[[Protocol]] to either the string value of the
      //  negotiated application protocol if present ... or "" if not
      //  present."
      protocol: parseProtocolItem(responseHeaders['wt-protocol']),
      responseHeaders: normalizeResponseHeaders(responseHeaders),
      // "If the connection is an HTTP/3 connection, set
      //  transport.[[Reliability]] to "supports-unreliable"."
      supportsUnreliable: true
    }
  }

  /**
   * The stream error code mapping of WebTransport over HTTP/3.
   * @param {number} code
   * @returns {bigint}
   */
  mapCodeToWire (code) {
    return webtransportCodeToHttpCode(code)
  }

  /**
   * @param {bigint} code
   * @returns {number|null}
   */
  mapCodeFromWire (code) {
    return httpCodeToWebtransportCode(code)
  }

  /**
   * A peer CONNECTION_CLOSE at the HTTP/3 layer. H3_NO_ERROR is a clean
   * connection shutdown; the WebTransport session close information, when
   * any, was carried by a WT_CLOSE_SESSION capsule before it.
   * @param {import('node:quic').QuicError} err
   */
  _handleApplicationClose (err) {
    if (this.#closeInfoFromCapsule !== null || err.errorCode === H3_NO_ERROR) {
      this._settleClosed(this.#closeInfoFromCapsule ?? { closeCode: 0, reason: '' })
    } else {
      this._failClosed(err)
    }
  }

  /**
   * Reads and parses capsules from the CONNECT stream.
   * @see https://datatracker.ietf.org/doc/html/rfc9297#section-3.2
   * @param {import('node:quic').QuicStream} stream
   */
  async #readCapsules (stream) {
    let buffer = new Uint8Array(0)
    try {
      for await (const batch of stream) {
        for (const chunk of batch) {
          if (buffer.byteLength === 0) {
            buffer = chunk
          } else {
            const next = new Uint8Array(buffer.byteLength + chunk.byteLength)
            next.set(buffer, 0)
            next.set(chunk, buffer.byteLength)
            buffer = next
          }
        }

        // Capsule { Capsule Type (i), Capsule Length (i), Capsule Value (..) }
        while (true) {
          const type = decodeVarint(buffer)
          if (type === null) break
          const length = decodeVarint(buffer.subarray(type.length))
          if (length === null) break
          const headerLength = type.length + length.length
          if (buffer.byteLength < headerLength + Number(length.value)) break
          const value = buffer.subarray(headerLength, headerLength + Number(length.value))
          buffer = buffer.subarray(headerLength + Number(length.value))
          this.#handleCapsule(type.value, value)
        }
      }
      // "Cleanly terminating a CONNECT stream without a WT_CLOSE_SESSION
      //  capsule SHALL be semantically equivalent to terminating it with
      //  a WT_CLOSE_SESSION capsule that has an error code of 0 and an
      //  empty error string."
      this.#closeInfoFromCapsule ??= { closeCode: 0, reason: '' }
      this._settleClosed(this.#closeInfoFromCapsule)
      this.session.close({ type: 'application', code: H3_NO_ERROR })
        .catch(() => {})
    } catch {
      // Errors on the CONNECT stream terminate the session through the
      // session.closed path.
    }
  }

  /**
   * @param {bigint} type
   * @param {Uint8Array} value
   */
  #handleCapsule (type, value) {
    if (type === WT_CLOSE_SESSION) {
      // WT_CLOSE_SESSION Capsule {
      //   Type (i) = WT_CLOSE_SESSION,
      //   Length (i),
      //   Application Error Code (32),
      //   Application Error Message (..8192),
      // }
      if (value.byteLength < 4) return
      const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
      const closeCode = view.getUint32(0)
      const reason = new TextDecoder().decode(value.subarray(4))
      this.#closeInfoFromCapsule = { closeCode, reason }
      this._settleClosed(this.#closeInfoFromCapsule)
    } else if (type === WT_DRAIN_SESSION) {
      // "After sending or receiving either a WT_DRAIN_SESSION capsule or
      //  a GOAWAY frame, an endpoint MAY continue using the session and
      //  MAY open new streams."
      this._signalDraining()
    }
    // Unknown capsule types are ignored.
  }

  /**
   * Terminates the session: "an application MAY provide such a message
   * for the WebTransport endpoint to send in an HTTP capsule of type
   * WT_CLOSE_SESSION (0x2843)". "An endpoint that sends a
   * WT_CLOSE_SESSION capsule MUST immediately send a FIN on the CONNECT
   * Stream."
   * @param {{ closeCode: number, reason: string }} closeInfo
   */
  close ({ closeCode, reason }) {
    const reasonBytes = new TextEncoder().encode(reason)
    const payloadLength = 4 + reasonBytes.byteLength
    const type = encodeVarint(WT_CLOSE_SESSION)
    const length = encodeVarint(BigInt(payloadLength))

    const capsule = new Uint8Array(type.byteLength + length.byteLength + payloadLength)
    capsule.set(type, 0)
    capsule.set(length, type.byteLength)
    new DataView(capsule.buffer).setUint32(type.byteLength + length.byteLength, closeCode)
    capsule.set(reasonBytes, type.byteLength + length.byteLength + 4)

    this.#closeInfoFromCapsule ??= { closeCode, reason }
    try {
      this.#connectWriter.writeSync(capsule)
      this.#connectWriter.endSync()
    } catch {
      // The CONNECT stream is already gone; the connection close below
      // still terminates the session.
    }

    this.session?.close({ type: 'application', code: H3_NO_ERROR }).then(
      () => this._settleClosed(this.#closeInfoFromCapsule),
      () => this._settleClosed(this.#closeInfoFromCapsule)
    )
  }

  /**
   * WebTransport streams cannot be carried over node:quic's HTTP/3
   * application yet; see the class documentation.
   */
  async createBidirectionalStream () {
    throw new Error(
      'WebTransport streams over HTTP/3 are not supported: node:quic ' +
      'does not implement WebTransport stream framing'
    )
  }

  async createUnidirectionalStream () {
    throw new Error(
      'WebTransport streams over HTTP/3 are not supported: node:quic ' +
      'does not implement WebTransport stream framing'
    )
  }

  /**
   * Under the HTTP/3 application, peer-initiated streams surfaced by
   * node:quic are HTTP/3 request streams, not WebTransport streams;
   * WebTransport's incoming streams cannot be observed (nghttp3 consumes
   * them), so peer streams are not surfaced as incoming WebTransport
   * streams.
   */
  _receiveWireStream (stream) {}

  /**
   * "The WebTransport datagram payload is sent unmodified in the "HTTP
   *  Datagram Payload" field of an HTTP Datagram (Section 2.1 of
   *  [HTTP-DATAGRAM])" whose format is:
   *  HTTP/3 Datagram { Quarter Stream ID (i), HTTP Datagram Payload (..) }
   * @see https://datatracker.ietf.org/doc/html/rfc9297#section-2.1
   * @param {Uint8Array} bytes
   */
  async sendDatagram (bytes) {
    const prefix = this.#datagramPrefix
    const framed = new Uint8Array(prefix.byteLength + bytes.byteLength)
    framed.set(prefix, 0)
    framed.set(bytes, prefix.byteLength)
    await this.session.sendDatagram(framed)
  }

  /**
   * Strips and validates the Quarter Stream ID framing of an incoming
   * HTTP/3 Datagram; datagrams for other streams are dropped.
   * @param {Uint8Array} datagram
   */
  _receiveWireDatagram (datagram) {
    const quarterStreamId = decodeVarint(datagram)
    if (quarterStreamId === null || quarterStreamId.value !== this.#quarterStreamId) {
      return
    }
    this._bufferDatagram(datagram.subarray(quarterStreamId.length))
  }

  /**
   * The maximum outgoing datagram payload size, accounting for the
   * Quarter Stream ID framing.
   * @returns {number}
   */
  get maxDatagramSize () {
    const max = this.session?.maxDatagramSize ?? 0
    const overhead = this.#datagramPrefix?.byteLength ?? 1
    return max > overhead ? max - overhead : 0
  }
}

/**
 * Serializes the WebTransport subprotocol names as an [RFC 9651]
 * structured field list of strings, for the WT-Available-Protocols
 * request header.
 * @param {string[]} protocols
 * @returns {string}
 */
function serializeProtocolsList (protocols) {
  return protocols
    .map((p) => `"${p.replace(/([\\"])/g, '\\$1')}"`)
    .join(', ')
}

/**
 * Parses a single [RFC 9651] structured field string item, as found in
 * the WT-Protocol response header. Returns '' when absent or malformed.
 * @param {string|string[]|undefined} value
 * @returns {string}
 */
function parseProtocolItem (value) {
  if (Array.isArray(value)) {
    value = value[0]
  }
  if (typeof value !== 'string') {
    return ''
  }
  value = value.trim()
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') {
    return ''
  }
  return value.slice(1, -1).replace(/\\([\\"])/g, '$1')
}

/**
 * Converts the header object surfaced by node:quic into a list of header
 * name/value pairs, without HTTP/3 pseudo-headers.
 * @param {Record<string, string|string[]>} headers
 * @returns {[string, string][]}
 */
function normalizeResponseHeaders (headers) {
  const result = []
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':')) {
      continue
    }
    if (Array.isArray(value)) {
      for (const v of value) {
        result.push([name, v])
      }
    } else {
      result.push([name, value])
    }
  }
  return result
}

module.exports = { Http3TransportSession }
