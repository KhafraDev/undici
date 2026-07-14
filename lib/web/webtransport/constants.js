'use strict'

/**
 * The state of a WebTransport session, stored in the [[State]] internal slot.
 * "connecting", "connected", "draining", "closed", or "failed"
 * @see https://w3c.github.io/webtransport/#webtransport-internal-slots
 */
const sessionStates = {
  connecting: 'connecting',
  connected: 'connected',
  draining: 'draining',
  closed: 'closed',
  failed: 'failed'
}

/**
 * "WebTransport implementations MUST remap those error codes into the error
 *  range reserved for WT_APPLICATION_ERROR, where 0x00000000 corresponds to
 *  0x52e4a40fa8db, and 0xffffffff corresponds to 0x52e5ac983162."
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3-13#section-4.3
 */
const wtApplicationErrorFirst = 0x52e4a40fa8dbn
const wtApplicationErrorLast = 0x52e5ac983162n

/**
 * "The SETTINGS_WT_MAX_SESSIONS setting indicates that the specified
 *  endpoint supports WebTransport. ... The default value for the
 *  SETTINGS_WT_MAX_SESSIONS setting is "0", meaning that the endpoint is
 *  not willing to accept any WebTransport sessions."
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3-13#section-9.2
 */
const SETTINGS_WT_MAX_SESSIONS = 0x14e9cd29

/**
 * "To terminate a session with a detailed error message, an application
 *  MAY provide such a message for the WebTransport endpoint to send in an
 *  HTTP capsule [HTTP-DATAGRAM] of type WT_CLOSE_SESSION (0x2843)."
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3-13#section-6
 */
const WT_CLOSE_SESSION = 0x2843n

/**
 * "When a WebTransport server wishes to initiate a graceful shutdown of a
 *  session, it sends a WT_DRAIN_SESSION (0x78ae) capsule."
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3-13#section-4.6
 */
const WT_DRAIN_SESSION = 0x78aen

/**
 * H3_NO_ERROR: "No error. This is used when the connection or stream needs
 * to be closed, but there is no error to signal."
 * @see https://datatracker.ietf.org/doc/html/rfc9114#section-8.1
 */
const H3_NO_ERROR = 0x100n

/**
 * "the user agent MUST initially allow at least 100 incoming unidirectional
 *  streams from the server" / "The user agent MUST initially allow the
 *  server to create at least 100 bidirectional streams."
 * @see https://w3c.github.io/webtransport/#dom-webtransportoptions-anticipatedconcurrentincomingunidirectionalstreams
 * @see https://w3c.github.io/webtransport/#dom-webtransportoptions-anticipatedconcurrentincomingbidirectionalstreams
 */
const minInitialIncomingStreams = 100

/**
 * "the total length of the validity period MUST NOT exceed two weeks"
 * @see https://w3c.github.io/webtransport/#custom-certificate-requirements
 */
const maxCertificateValidityPeriodMs = 14 * 24 * 60 * 60 * 1000

/**
 * The code used for the one-time experimental warning emitted when the
 * WebTransport API is used.
 */
const experimentalWarningCode = 'UNDICI-WT'

module.exports = {
  sessionStates,
  wtApplicationErrorFirst,
  wtApplicationErrorLast,
  SETTINGS_WT_MAX_SESSIONS,
  WT_CLOSE_SESSION,
  WT_DRAIN_SESSION,
  H3_NO_ERROR,
  minInitialIncomingStreams,
  maxCertificateValidityPeriodMs,
  experimentalWarningCode
}
