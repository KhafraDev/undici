'use strict'

const { TransportSessionBase } = require('./session')

/**
 * A transport backend that carries the WebTransport API over a raw QUIC
 * session with a caller-chosen (non-"h3") ALPN.
 *
 * This backend is undici-specific: it does not implement the WebTransport
 * over HTTP/3 wire protocol and therefore does not interoperate with
 * standard WebTransport servers. It exists because node:quic's HTTP/3
 * application cannot carry WebTransport streams yet (incoming
 * unidirectional streams are consumed internally and stream data is
 * framed by nghttp3), while its raw QUIC application exposes exactly the
 * stream and datagram primitives WebTransport needs. It is selected with
 * the undici-only `WebTransportOptions.node.alpn` option and is primarily
 * used to exercise the complete WebTransport machinery against a
 * node:quic server.
 *
 * WebTransport application error codes are carried directly as QUIC
 * application error codes (they fit, as unsigned 32-bit integers, in the
 * 62-bit code space), so the inherited identity code mapping applies.
 */
class RawTransportSession extends TransportSessionBase {
  #alpn

  /**
   * @param {URL} url
   * @param {object} options see TransportSessionBase
   * @param {string} alpn the ALPN protocol identifier to negotiate
   */
  constructor (url, options, alpn) {
    super(url, options)
    this.#alpn = alpn
  }

  /**
   * Establishes the session: a raw QUIC connection is opened, and the
   * WebTransport session is considered established once the TLS handshake
   * completes.
   * @returns {Promise<{ protocol: string, responseHeaders: null, supportsUnreliable: boolean }>}
   */
  async connect () {
    const session = await this._openQuicSession({ alpn: this.#alpn })

    return {
      // There is no WebTransport subprotocol negotiation on this backend.
      protocol: '',
      responseHeaders: null,
      // Datagram support was negotiated iff the peer advertised a
      // max_datagram_frame_size transport parameter [RFC 9221].
      supportsUnreliable: session.maxDatagramSize > 0
    }
  }

  /**
   * Terminates the session, translating the WebTransportCloseInfo into an
   * application-level CONNECTION_CLOSE.
   * @param {{ closeCode: number, reason: string }} closeInfo
   */
  close ({ closeCode, reason }) {
    this.session?.close({ type: 'application', code: closeCode, reason })
      .then(
        () => this._settleClosed({ closeCode, reason }),
        () => this._settleClosed({ closeCode, reason })
      )
  }
}

module.exports = { RawTransportSession }
