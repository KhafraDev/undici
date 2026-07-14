'use strict'

const { webidl } = require('../webidl')
const { kEnumerableProperty } = require('../../core/util')
const { environmentSettingsObject } = require('../fetch/util')
const { Headers, setHeadersGuard } = require('../fetch/headers')
const { sessionStates, experimentalWarningCode } = require('./constants')
const { WebTransportError, createUnvalidatedWebTransportError } = require('./error')
const { createWebTransportSendGroup, getSendGroupTransport } = require('./sendgroup')
const { createWebTransportSendStream, getSendStreamState } = require('./sendstream')
const { createWebTransportReceiveStream, getReceiveStreamState } = require('./receivestream')
const { createWebTransportBidirectionalStream } = require('./bidirectionalstream')
const {
  createWebTransportDatagramDuplexStream,
  getDatagramsState,
  getDatagramsWritableState,
  pullDatagrams,
  receiveDatagrams,
  sendDatagrams
} = require('./datagrams')
const { Http3TransportSession } = require('./transport/backend-h3')
const { RawTransportSession } = require('./transport/backend-raw')

let emittedExperimentalWarning = false

/**
 * @see https://w3c.github.io/webtransport/#web-transport
 */
class WebTransport {
  /**
   * The internal slots of this WebTransport, shared (as the [[Transport]]
   * of the other interfaces of this specification) with the objects this
   * WebTransport owns.
   * @type {import('./sendgroup').TransportContext}
   */
  #ctx

  /**
   * When the WebTransport() constructor is invoked, the user agent MUST
   * run the following steps:
   * @see https://w3c.github.io/webtransport/#dom-webtransport-webtransport
   * @param {string} url
   * @param {import('../../../types/webtransport').WebTransportOptions} [options={}]
   */
  constructor (url, options = {}) {
    webidl.util.markAsUncloneable(this)

    const prefix = 'WebTransport constructor'
    webidl.argumentLengthCheck(arguments, 1, prefix)

    url = webidl.converters.USVString(url, prefix, 'url')
    options = webidl.converters.WebTransportOptions(options, prefix, 'options')

    if (!emittedExperimentalWarning) {
      process.emitWarning('WebTransport is experimental! Expect it to change at any time!', {
        code: experimentalWarningCode
      })
      emittedExperimentalWarning = true
    }

    // 1. Let baseURL be this’s relevant settings object’s API base URL.
    const baseURL = environmentSettingsObject.settingsObject.baseUrl

    // 2. Let url be the URL record resulting from parsing url with
    //    baseURL.
    let urlRecord
    try {
      urlRecord = new URL(url, baseURL)
    } catch (e) {
      // 3. If url is failure, throw a SyntaxError exception.
      throw new DOMException(`Invalid WebTransport URL: ${e.message}`, 'SyntaxError')
    }

    // 4. If url’s scheme is not https, throw a SyntaxError exception.
    if (urlRecord.protocol !== 'https:') {
      throw new DOMException('WebTransport URLs must use the https scheme', 'SyntaxError')
    }

    // 5. If url’s fragment is not null, throw a SyntaxError exception.
    if (urlRecord.hash !== '' || urlRecord.href.endsWith('#')) {
      throw new DOMException('WebTransport URLs must not contain a fragment', 'SyntaxError')
    }

    // 6. Let newConnection be "no" if options’s allowPooling is true;
    //    otherwise "yes-and-dedicated".
    const newConnection = options.allowPooling ? 'no' : 'yes-and-dedicated'

    // 7. Let serverCertificateHashes be options’s serverCertificateHashes.
    const serverCertificateHashes = options.serverCertificateHashes

    // 8. If newConnection is "no" and serverCertificateHashes is not
    //    empty, then throw a NotSupportedError exception.
    if (newConnection === 'no' && serverCertificateHashes.length !== 0) {
      throw new DOMException(
        'serverCertificateHashes cannot be used with allowPooling', 'NotSupportedError')
    }

    // 9. Let requireUnreliable be options’s requireUnreliable.
    const requireUnreliable = options.requireUnreliable

    // 10. Let congestionControl be options’s congestionControl.
    let congestionControl = options.congestionControl

    // 11. If congestionControl is not "default", and the user agent does
    //     not support any congestion control algorithms that optimize for
    //     congestionControl, as allowed by [RFC9002] Section 7, then set
    //     congestionControl to "default".
    // Note: node:quic supports 'cubic' (throughput) and 'bbr'
    // (low-latency), so requested preferences are kept.
    congestionControl = congestionControl ?? 'default'

    // 12. Let protocols be options’s protocols.
    const protocols = options.protocols

    // 13. If any of the values in protocols occur more than once, fail to
    //     match the requirements for elements that comprise the value of
    //     the negotiated application protocol as defined by the
    //     WebTransport protocol, or have an isomorphic encoded length of
    //     0 or exceeding 512, throw a SyntaxError exception.
    //     [WEB-TRANSPORT-OVERVIEW] Section 3.1.
    validateProtocols(protocols)

    // 14. Let anticipatedConcurrentIncomingUnidirectionalStreams be
    //     options’s anticipatedConcurrentIncomingUnidirectionalStreams.
    const anticipatedConcurrentIncomingUnidirectionalStreams =
      options.anticipatedConcurrentIncomingUnidirectionalStreams

    // 15. Let anticipatedConcurrentIncomingBidirectionalStreams be
    //     options’s anticipatedConcurrentIncomingBidirectionalStreams.
    const anticipatedConcurrentIncomingBidirectionalStreams =
      options.anticipatedConcurrentIncomingBidirectionalStreams

    // 16. Let datagramsReadableType be options’s datagramsReadableType.
    const datagramsReadableType = options.datagramsReadableType

    // 18. Let transport be a newly constructed WebTransport object, with:
    //     [[SendStreams]]: an empty ordered set
    //     [[ReceiveStreams]]: an empty ordered set
    //     [[IncomingBidirectionalStreams]]: a new ReadableStream
    //     [[IncomingUnidirectionalStreams]]: a new ReadableStream
    //     [[State]]: "connecting"
    //     [[Ready]]: a new promise
    //     [[Reliability]]: "pending"
    //     [[CongestionControl]]: congestionControl
    //     [[AnticipatedConcurrentIncomingUnidirectionalStreams]]:
    //       anticipatedConcurrentIncomingUnidirectionalStreams
    //     [[AnticipatedConcurrentIncomingBidirectionalStreams]]:
    //       anticipatedConcurrentIncomingBidirectionalStreams
    //     [[ResponseHeaders]]: null
    //     [[Protocol]]: an empty string
    //     [[Closed]]: a new promise
    //     [[Draining]]: a new promise
    //     [[Datagrams]]: undefined
    //     [[Session]]: null
    //     [[NewConnection]]: newConnection
    //     [[RequireUnreliable]]: requireUnreliable
    const ctx = this.#ctx = {
      transport: this,
      sendStreams: new Set(),
      receiveStreams: new Set(),
      incomingBidirectionalStreams: null,
      incomingUnidirectionalStreams: null,
      incomingBidirectionalStreamsController: null,
      incomingUnidirectionalStreamsController: null,
      state: sessionStates.connecting,
      ready: Promise.withResolvers(),
      reliability: 'pending',
      congestionControl,
      anticipatedConcurrentIncomingUnidirectionalStreams,
      anticipatedConcurrentIncomingBidirectionalStreams,
      responseHeaders: null,
      protocol: '',
      closed: Promise.withResolvers(),
      draining: Promise.withResolvers(),
      datagrams: undefined,
      session: null,
      newConnection,
      requireUnreliable,
      // Queues and waiters connecting the transport backend's incoming
      // streams to the pull algorithms below.
      incomingBidirectionalStreamsQueue: [],
      incomingUnidirectionalStreamsQueue: [],
      incomingStreamWaiters: new Set()
    }

    // 17. Let incomingDatagrams be a new ReadableStream.
    // 20. Let pullDatagramsAlgorithm be an action that runs pullDatagrams
    //     with transport.
    // 21. If datagramsReadableType is "bytes", set up with byte reading
    //     support incomingDatagrams with pullAlgorithm set to
    //     pullDatagramsAlgorithm, and highWaterMark set to 0. Otherwise,
    //     set up incomingDatagrams with pullAlgorithm set to
    //     pullDatagramsAlgorithm, and highWaterMark set to 0.
    let incomingDatagramsController
    const incomingDatagrams = new ReadableStream({
      start (controller) {
        incomingDatagramsController = controller
      },
      pull () {
        return pullDatagrams(ctx)
      },
      ...(datagramsReadableType === 'bytes' ? { type: 'bytes' } : {})
    }, { highWaterMark: 0 })

    // 19. Set transport.[[Datagrams]] to the result of creating a
    //     WebTransportDatagramDuplexStream, with transport,
    //     incomingDatagrams and datagramsReadableType.
    ctx.datagrams = createWebTransportDatagramDuplexStream(ctx, incomingDatagrams, datagramsReadableType)
    getDatagramsState(ctx.datagrams).readableController = incomingDatagramsController

    // 22. Let pullBidirectionalStreamAlgorithm be an action that runs
    //     pullBidirectionalStream with transport.
    // 23. Set up transport.[[IncomingBidirectionalStreams]] with
    //     pullAlgorithm set to pullBidirectionalStreamAlgorithm, and
    //     highWaterMark set to 0.
    ctx.incomingBidirectionalStreams = new ReadableStream({
      start (controller) {
        ctx.incomingBidirectionalStreamsController = controller
      },
      pull () {
        return pullBidirectionalStream(ctx)
      }
    }, { highWaterMark: 0 })

    // 24. Let pullUnidirectionalStreamAlgorithm be an action that runs
    //     pullUnidirectionalStream with transport.
    // 25. Set up transport.[[IncomingUnidirectionalStreams]] with
    //     pullAlgorithm set to pullUnidirectionalStreamAlgorithm, and
    //     highWaterMark set to 0.
    ctx.incomingUnidirectionalStreams = new ReadableStream({
      start (controller) {
        ctx.incomingUnidirectionalStreamsController = controller
      },
      pull () {
        return pullUnidirectionalStream(ctx)
      }
    }, { highWaterMark: 0 })

    // 26. Let client be transport’s relevant settings object.
    // 27. Let origin be client’s origin.
    const origin = environmentSettingsObject.settingsObject.origin

    // 28. Let request be a new request whose URL is url, client is
    //     client, service-workers mode is "none", referrer is
    //     "no-referrer", mode is "webtransport", credentials mode is
    //     "omit", cache mode is "no-store", policy container is client’s
    //     policy container, destination is "", origin is origin,
    //     WebTransport-hash list is serverCertificateHashes and redirect
    //     mode is "error".
    // 29. Set request’s method to "CONNECT", and set the method’s
    //     associated :protocol pseudo-header to "webtransport".
    // Note: undici's fetch stack has no HTTP/3 transport, so the request
    // is not routed through fetch; the CONNECT request and the
    // WebTransport-specific "obtain a connection" behavior are realized
    // directly by the transport backend below.

    // 30. Let headers be a new Headers object filled with
    //     options["headers"].
    const headers = new Headers(options.headers)

    // 31. Let requestHeaders be a new Headers object whose header list is
    //     request’s header list and guard is "request".
    const requestHeaders = new Headers()
    setHeadersGuard(requestHeaders, 'request')

    // 32. For each header of headers’s header list:
    for (const header of headers) {
      // 32.1. If ascii lowercase header’s name is
      //       "wt-available-protocols", then throw a TypeError.
      if (header[0].toLowerCase() === 'wt-available-protocols') {
        throw new TypeError('The wt-available-protocols header cannot be set')
      }

      // 32.2. append header to requestHeaders.
      requestHeaders.append(header[0], header[1])
    }

    // 33. If protocols is not empty, set a structured field value with
    //     (WT-Available-Protocols, a structured header list whose members
    //     are the structured header string items in protocols in order)
    //     in request’s header list.
    // (serialized by the HTTP/3 backend when it builds the CONNECT
    // request)

    // 34. Fetch request, with useParallelQueue set to true, and
    //     processResponse set to the following steps given a response:
    //     34.1. Process a WebTransport fetch response with response and
    //           transport.
    const backendOptions = {
      serverCertificateHashes,
      congestionControl,
      anticipatedConcurrentIncomingUnidirectionalStreams,
      anticipatedConcurrentIncomingBidirectionalStreams,
      requestHeaders: [...requestHeaders],
      protocols,
      origin
    }

    // The transport backend: WebTransport over HTTP/3 by default; the
    // undici-only `node: { alpn }` option selects the raw QUIC backend,
    // which carries the WebTransport API over a plain QUIC session with a
    // custom ALPN (see ./transport/backend-raw.js for why it exists).
    const session = options.node?.alpn !== undefined && options.node.alpn !== 'h3'
      ? new RawTransportSession(urlRecord, backendOptions, options.node.alpn)
      : new Http3TransportSession(urlRecord, backendOptions)
    ctx.session = session

    session.onIncomingBidirectionalStream((internalStream) => {
      ctx.incomingBidirectionalStreamsQueue.push(internalStream)
      wakeIncomingStreamWaiters(ctx)
    })
    session.onIncomingUnidirectionalStream((internalStream) => {
      ctx.incomingUnidirectionalStreamsQueue.push(internalStream)
      wakeIncomingStreamWaiters(ctx)
    })

    // "The user agent SHOULD run receiveDatagrams for any WebTransport
    //  object whose [[State]] is "connected" as soon as reasonably
    //  possible whenever the algorithm can make progress."
    session.onDatagramsAvailable(() => {
      if (ctx.state === sessionStates.connected || ctx.state === sessionStates.draining) {
        receiveDatagrams(ctx)
      }
    })

    // "Session starts draining" resolves [[Draining]]. (The specification
    // defines no numbered steps for this; see the "Protocol Mappings"
    // section: over HTTP/3 an incoming WT_DRAIN_SESSION capsule or GOAWAY
    // frame starts draining.)
    session.onDraining(() => {
      if (ctx.state === sessionStates.connected) {
        ctx.state = sessionStates.draining
        ctx.draining.resolve(undefined)
      }
    })

    // Session termination not initiated by the client, and connection
    // errors, surface through the backend's closed promise (§ 6.6; see
    // sessionTerminated / connectionErrored below).
    session.closed.then(
      (closeInfo) => sessionTerminated(ctx, closeInfo.closeCode, closeInfo.reason),
      (error) => connectionErrored(ctx, error)
    )

    initializeWebTransportOverHttp(ctx, session)

    // 35. Return transport.
  }

  /**
   * Gathers stats for this WebTransport’s underlying connection and
   * reports the result asynchronously.
   * @see https://w3c.github.io/webtransport/#dom-webtransport-getstats
   * @returns {Promise<import('../../../types/webtransport').WebTransportConnectionStats>}
   */
  getStats () {
    webidl.brandCheck(this, WebTransport)

    // 1. Let transport be this.
    const ctx = this.#ctx

    // 2. Let p be a new promise.
    // 3. If transport.[[State]] is "failed", reject p with an
    //    InvalidStateError and abort these steps.
    if (ctx.state === sessionStates.failed) {
      return Promise.reject(new DOMException('The WebTransport session failed', 'InvalidStateError'))
    }

    // 4. Run the following steps in parallel:
    //    4.1. If transport.[[State]] is "connecting", wait until it
    //         changes.
    const gather = () => {
      // 4.2. If transport.[[State]] is "failed", abort these steps after
      //      queueing a network task with transport to reject p with an
      //      InvalidStateError.
      if (ctx.state === sessionStates.failed) {
        throw new DOMException('The WebTransport session failed', 'InvalidStateError')
      }

      // 4.3. If transport.[[State]] is "closed", abort these steps after
      //      queueing a network task with transport to resolve p with the
      //      most recent stats available for the connection.
      // 4.4. Let gatheredStats be the list of stats specific to the
      //      underlying connection needed to populate the dictionary
      //      members of WebTransportConnectionStats and
      //      WebTransportDatagramStats accurately.
      const gatheredStats = ctx.session.getStats()
      const datagramsState = getDatagramsState(ctx.datagrams)

      // 4.5. If transport.[[NewConnection]] is "no", then remove from
      //      gatheredStats all stats not marked as pooled connection
      //      stats. (Connections are never pooled by this implementation;
      //      [[NewConnection]] is always "yes-and-dedicated" here since
      //      allowPooling has no effect without connection pooling.)

      // 4.6. Queue a network task with transport to run the following
      //      steps:
      //      4.6.1. Let stats be a new WebTransportConnectionStats object.
      //      4.6.2. Let datagramStats be a new WebTransportDatagramStats
      //             object.
      //      4.6.3. Set stats["datagrams"] to datagramStats.
      //      4.6.4. For each member member of stats and datagramStats
      //             that the user agent wishes to expose, set member to
      //             the the corresponding entry in gatheredStats.
      //      4.6.5. Resolve p with stats.
      return {
        bytesSent: gatheredStats?.bytesSent ?? 0,
        packetsSent: gatheredStats?.packetsSent ?? 0,
        bytesLost: gatheredStats?.bytesLost ?? 0,
        packetsLost: gatheredStats?.packetsLost ?? 0,
        bytesReceived: gatheredStats?.bytesReceived ?? 0,
        packetsReceived: gatheredStats?.packetsReceived ?? 0,
        smoothedRtt: gatheredStats?.smoothedRtt ?? 0,
        rttVariation: gatheredStats?.rttVariation ?? 0,
        minRtt: gatheredStats?.minRtt ?? 0,
        datagrams: {
          droppedIncoming: datagramsState.droppedIncoming,
          expiredIncoming: datagramsState.expiredIncoming,
          expiredOutgoing: datagramsState.expiredOutgoing,
          lostOutgoing: gatheredStats?.datagramsLost ?? 0
        },
        estimatedSendRate: null,
        atSendCapacity: false
      }
    }

    // 5. Return p.
    if (ctx.state === sessionStates.connecting) {
      return ctx.ready.promise.then(gather, () => {
        throw new DOMException('The WebTransport session failed', 'InvalidStateError')
      })
    }
    try {
      return Promise.resolve(gather())
    } catch (err) {
      return Promise.reject(err)
    }
  }

  /**
   * Exports keying material from a TLS Keying Material Exporter for the
   * TLS session uniquely associated with this WebTransport’s underlying
   * connection.
   * @see https://w3c.github.io/webtransport/#dom-webtransport-exportkeyingmaterial
   * @param {ArrayBuffer|ArrayBufferView} label
   * @param {ArrayBuffer|ArrayBufferView} context
   * @param {number} outputLength
   * @returns {Promise<Uint8Array>}
   */
  exportKeyingMaterial (label, context, outputLength) {
    webidl.brandCheck(this, WebTransport)

    const prefix = 'WebTransport.exportKeyingMaterial'
    webidl.argumentLengthCheck(arguments, 3, prefix)

    label = webidl.converters.BufferSource(label, prefix, 'label')
    context = webidl.converters.BufferSource(context, prefix, 'context')
    outputLength = webidl.converters['unsigned long'](outputLength, prefix, 'outputLength')

    // 1. Let labelLength be label.byte length.
    const labelLength = label.byteLength

    // 2. If labelLength is more than 255, return a promise rejected with
    //    a RangeError.
    if (labelLength > 255) {
      return Promise.reject(new RangeError('label must not be longer than 255 bytes'))
    }

    // 3. Let contextLength be context.byte length.
    const contextLength = context.byteLength

    // 4. If contextLength is more than 255, return a promise rejected
    //    with a RangeError.
    if (contextLength > 255) {
      return Promise.reject(new RangeError('context must not be longer than 255 bytes'))
    }

    // 5. If outputLength is 0 or more than an implementation-defined
    //    value—which must be at least 4096—return a promise rejected with
    //    a RangeError.
    if (outputLength === 0 || outputLength > 4096) {
      return Promise.reject(new RangeError('outputLength must be between 1 and 4096'))
    }

    // 6. If this.[[State]] is "closed" or "failed", return a promise
    //    rejected with an InvalidStateError.
    const ctx = this.#ctx
    if (ctx.state === sessionStates.closed || ctx.state === sessionStates.failed) {
      return Promise.reject(new DOMException('The WebTransport session is closed', 'InvalidStateError'))
    }

    // 7. Let transport be this.
    // 8. Let p be a new promise.
    // 9. Run the following steps in parallel ...
    //    9.1. Let keyingMaterial be a Uint8Array that is produced by
    //         invoking a TLS key exporter, as defined in
    //         [WEB-TRANSPORT-OVERVIEW] Section 4.1, with label, context,
    //         and outputLength.
    // Deviation: node:quic does not expose the TLS keying material
    // exporter [RFC8446 Section 7.5], so the promise is rejected with a
    // NotSupportedError instead.
    //    9.2. Queue a network task with transport to resolve p with
    //         keyingMaterial.
    // 10. Return p.
    return ctx.session.exportKeyingMaterial(label, context, outputLength)
  }

  /**
   * On getting, it MUST return this’s [[Ready]].
   * @see https://w3c.github.io/webtransport/#dom-webtransport-ready
   * @returns {Promise<undefined>}
   */
  get ready () {
    webidl.brandCheck(this, WebTransport)
    return this.#ctx.ready.promise
  }

  /**
   * The getter steps are to return this’s [[Reliability]].
   * @see https://w3c.github.io/webtransport/#dom-webtransport-reliability
   * @returns {'pending'|'reliable-only'|'supports-unreliable'}
   */
  get reliability () {
    webidl.brandCheck(this, WebTransport)
    return this.#ctx.reliability
  }

  /**
   * The getter steps are to return this’s [[CongestionControl]].
   * @see https://w3c.github.io/webtransport/#dom-webtransport-congestioncontrol
   * @returns {'default'|'throughput'|'low-latency'}
   */
  get congestionControl () {
    webidl.brandCheck(this, WebTransport)
    return this.#ctx.congestionControl
  }

  /**
   * The getter steps are to return this’s
   * [[AnticipatedConcurrentIncomingUnidirectionalStreams]].
   * @see https://w3c.github.io/webtransport/#dom-webtransport-anticipatedconcurrentincomingunidirectionalstreams
   * @returns {number|null}
   */
  get anticipatedConcurrentIncomingUnidirectionalStreams () {
    webidl.brandCheck(this, WebTransport)
    return this.#ctx.anticipatedConcurrentIncomingUnidirectionalStreams
  }

  /**
   * The setter steps, given value, are to set this’s
   * [[AnticipatedConcurrentIncomingUnidirectionalStreams]] to value.
   * @param {number|null} value
   */
  set anticipatedConcurrentIncomingUnidirectionalStreams (value) {
    webidl.brandCheck(this, WebTransport)
    value = webidl.converters['unsigned short? [EnforceRange]'](
      value, 'WebTransport.anticipatedConcurrentIncomingUnidirectionalStreams', 'value')
    this.#ctx.anticipatedConcurrentIncomingUnidirectionalStreams = value
  }

  /**
   * The getter steps are to return this’s
   * [[AnticipatedConcurrentIncomingBidirectionalStreams]].
   * @see https://w3c.github.io/webtransport/#dom-webtransport-anticipatedconcurrentincomingbidirectionalstreams
   * @returns {number|null}
   */
  get anticipatedConcurrentIncomingBidirectionalStreams () {
    webidl.brandCheck(this, WebTransport)
    return this.#ctx.anticipatedConcurrentIncomingBidirectionalStreams
  }

  /**
   * The setter steps, given value, are to set this’s
   * [[AnticipatedConcurrentIncomingBidirectionalStreams]] to value.
   * @param {number|null} value
   */
  set anticipatedConcurrentIncomingBidirectionalStreams (value) {
    webidl.brandCheck(this, WebTransport)
    value = webidl.converters['unsigned short? [EnforceRange]'](
      value, 'WebTransport.anticipatedConcurrentIncomingBidirectionalStreams', 'value')
    this.#ctx.anticipatedConcurrentIncomingBidirectionalStreams = value
  }

  /**
   * The getter steps are to return this’s [[ResponseHeaders]].
   * @see https://w3c.github.io/webtransport/#dom-webtransport-responseheaders
   * @returns {Headers|null}
   */
  get responseHeaders () {
    webidl.brandCheck(this, WebTransport)
    return this.#ctx.responseHeaders
  }

  /**
   * The getter steps are to return this’s [[Protocol]].
   * @see https://w3c.github.io/webtransport/#dom-webtransport-protocol
   * @returns {string}
   */
  get protocol () {
    webidl.brandCheck(this, WebTransport)
    return this.#ctx.protocol
  }

  /**
   * On getting, it MUST return this’s [[Closed]].
   * @see https://w3c.github.io/webtransport/#dom-webtransport-closed
   * @returns {Promise<import('../../../types/webtransport').WebTransportCloseInfo>}
   */
  get closed () {
    webidl.brandCheck(this, WebTransport)
    return this.#ctx.closed.promise
  }

  /**
   * On getting, it MUST return this’s [[Draining]].
   * @see https://w3c.github.io/webtransport/#dom-webtransport-draining
   * @returns {Promise<undefined>}
   */
  get draining () {
    webidl.brandCheck(this, WebTransport)
    return this.#ctx.draining.promise
  }

  /**
   * Terminates the WebTransport session associated with the WebTransport
   * object.
   * @see https://w3c.github.io/webtransport/#dom-webtransport-close
   * @param {import('../../../types/webtransport').WebTransportCloseInfo} [closeInfo={}]
   */
  close (closeInfo = {}) {
    webidl.brandCheck(this, WebTransport)

    closeInfo = webidl.converters.WebTransportCloseInfo(closeInfo, 'WebTransport.close', 'closeInfo')

    // 1. Let transport be this.
    const ctx = this.#ctx

    // 2. If transport.[[State]] is "closed" or "failed", then abort these
    //    steps.
    if (ctx.state === sessionStates.closed || ctx.state === sessionStates.failed) {
      return
    }

    // 3. If transport.[[State]] is "connecting":
    if (ctx.state === sessionStates.connecting) {
      // 3.1. Let error be a newly created WebTransportError whose source
      //      is "session".
      const error = createUnvalidatedWebTransportError(
        'The WebTransport session was closed while connecting', 'session', null)

      // 3.2. Cleanup transport with error.
      cleanup(ctx, error)
      ctx.session.destroy(error)

      // 3.3. Abort these steps.
      return
    }

    // 4. Let session be transport.[[Session]].
    const session = ctx.session

    // 5. Let code be closeInfo.closeCode.
    const code = closeInfo.closeCode

    // 6. Let reasonString be the maximal code unit prefix of
    //    closeInfo.reason where the length of the UTF-8 encoded prefix
    //    doesn’t exceed 1024.
    // 7. Let reason be reasonString, UTF-8 encoded.
    const reason = maximalCodeUnitPrefix(closeInfo.reason, 1024)

    // 8. In parallel, terminate session with code and reason.
    session.close({ closeCode: code, reason })

    // 9. Cleanup transport with AbortError and closeInfo.
    cleanup(ctx, new DOMException('The WebTransport session was closed', 'AbortError'), closeInfo)
  }

  /**
   * A single duplex stream for sending and receiving datagrams over this
   * session.
   * @see https://w3c.github.io/webtransport/#dom-webtransport-datagrams
   * @returns {import('./datagrams').WebTransportDatagramDuplexStream}
   */
  get datagrams () {
    webidl.brandCheck(this, WebTransport)

    // 1. Return this’s [[Datagrams]].
    return this.#ctx.datagrams
  }

  /**
   * Creates a WebTransportBidirectionalStream object for an outgoing
   * bidirectional stream.
   * @see https://w3c.github.io/webtransport/#dom-webtransport-createbidirectionalstream
   * @param {import('../../../types/webtransport').WebTransportSendStreamOptions} [options={}]
   * @returns {Promise<import('./bidirectionalstream').WebTransportBidirectionalStream>}
   */
  createBidirectionalStream (options = {}) {
    webidl.brandCheck(this, WebTransport)

    try {
      options = webidl.converters.WebTransportSendStreamOptions(
        options, 'WebTransport.createBidirectionalStream', 'options')
    } catch (err) {
      return Promise.reject(err)
    }

    return createOutgoingStream(this.#ctx, options, 'bidi')
  }

  /**
   * Returns a ReadableStream of WebTransportBidirectionalStreams that
   * have been received from the server.
   * @see https://w3c.github.io/webtransport/#dom-webtransport-incomingbidirectionalstreams
   * @returns {ReadableStream}
   */
  get incomingBidirectionalStreams () {
    webidl.brandCheck(this, WebTransport)

    // 1. Return this’s [[IncomingBidirectionalStreams]].
    return this.#ctx.incomingBidirectionalStreams
  }

  /**
   * Creates a WebTransportSendStream for an outgoing unidirectional
   * stream.
   * @see https://w3c.github.io/webtransport/#dom-webtransport-createunidirectionalstream
   * @param {import('../../../types/webtransport').WebTransportSendStreamOptions} [options={}]
   * @returns {Promise<import('./sendstream').WebTransportSendStream>}
   */
  createUnidirectionalStream (options = {}) {
    webidl.brandCheck(this, WebTransport)

    try {
      options = webidl.converters.WebTransportSendStreamOptions(
        options, 'WebTransport.createUnidirectionalStream', 'options')
    } catch (err) {
      return Promise.reject(err)
    }

    return createOutgoingStream(this.#ctx, options, 'uni')
  }

  /**
   * A ReadableStream of unidirectional streams, each represented by a
   * WebTransportReceiveStream, that have been received from the server.
   * @see https://w3c.github.io/webtransport/#dom-webtransport-incomingunidirectionalstreams
   * @returns {ReadableStream}
   */
  get incomingUnidirectionalStreams () {
    webidl.brandCheck(this, WebTransport)

    // 1. Return this.[[IncomingUnidirectionalStreams]].
    return this.#ctx.incomingUnidirectionalStreams
  }

  /**
   * Creates a WebTransportSendGroup.
   * @see https://w3c.github.io/webtransport/#dom-webtransport-createsendgroup
   * @returns {import('./sendgroup').WebTransportSendGroup}
   */
  createSendGroup () {
    webidl.brandCheck(this, WebTransport)

    // 1. If this.[[State]] is "closed" or "failed", throw an
    //    InvalidStateError.
    const ctx = this.#ctx
    if (ctx.state === sessionStates.closed || ctx.state === sessionStates.failed) {
      throw new DOMException('The WebTransport session is closed', 'InvalidStateError')
    }

    // 2. Return the result of creating a WebTransportSendGroup with this.
    return createWebTransportSendGroup(ctx)
  }

  /**
   * Returns true if the user agent supports WebTransport sessions over
   * exclusively reliable connections, otherwise false.
   * @see https://w3c.github.io/webtransport/#dom-webtransport-supportsreliableonly
   * @returns {boolean}
   */
  static get supportsReliableOnly () {
    // WebTransport over HTTP/2 [WEB-TRANSPORT-HTTP2] is not implemented.
    return false
  }
}

/**
 * Validates the protocols option of the WebTransport constructor:
 *
 * "13. If any of the values in protocols occur more than once, fail to
 *  match the requirements for elements that comprise the value of the
 *  negotiated application protocol as defined by the WebTransport
 *  protocol, or have an isomorphic encoded length of 0 or exceeding 512,
 *  throw a SyntaxError exception. [WEB-TRANSPORT-OVERVIEW] Section 3.1."
 * @param {string[]} protocols
 */
function validateProtocols (protocols) {
  const seen = new Set()
  for (const protocol of protocols) {
    if (seen.has(protocol)) {
      throw new DOMException('protocols must not contain duplicates', 'SyntaxError')
    }
    seen.add(protocol)

    if (protocol.length === 0 || protocol.length > 512) {
      throw new DOMException(
        'protocols entries must have an isomorphic encoded length of 1 to 512', 'SyntaxError')
    }

    // Application protocol names are carried as structured field strings
    // ([WEB-TRANSPORT-OVERVIEW] Section 3.1), which are limited to ASCII
    // printable characters ([RFC 9651] Section 3.3.3).
    for (let i = 0; i < protocol.length; ++i) {
      const code = protocol.charCodeAt(i)
      if (code < 0x20 || code > 0x7e) {
        throw new DOMException(
          `protocols entries must only contain printable ASCII characters, found "${protocol[i]}"`,
          'SyntaxError')
      }
    }
  }
}

/**
 * "Let reasonString be the maximal code unit prefix of closeInfo.reason
 *  where the length of the UTF-8 encoded prefix doesn’t exceed 1024."
 * @param {string} reason
 * @param {number} maxBytes
 * @returns {string}
 */
function maximalCodeUnitPrefix (reason, maxBytes) {
  if (Buffer.byteLength(reason, 'utf8') <= maxBytes) {
    return reason
  }
  let bytes = 0
  let end = 0
  for (const codePoint of reason) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + codePointBytes > maxBytes) {
      break
    }
    bytes += codePointBytes
    end += codePoint.length
  }
  return reason.slice(0, end)
}

/**
 * The equivalent of fetching the CONNECT request ("obtain a WebTransport
 * connection") followed by "process a WebTransport fetch response",
 * realized by the transport backend.
 * @see https://w3c.github.io/webtransport/#webtransport-obtain-a-connection
 * @see https://w3c.github.io/webtransport/#webtransport-process-fetch-response
 * @param {object} ctx
 * @param {object} session the transport backend
 */
async function initializeWebTransportOverHttp (ctx, session) {
  let result
  try {
    // To obtain a WebTransport connection ... let connection be the
    // result of obtaining a connection with networkPartitionKey, url,
    // false, newConnection, requireUnreliable and webTransportHashes.
    // ... Wait for connection to receive the first SETTINGS frame ...
    // (realized by the backend; over HTTP/3 node:quic enforces
    // SETTINGS_ENABLE_CONNECT_PROTOCOL before the Extended CONNECT is
    // sent, and SETTINGS_H3_DATAGRAM gates datagram support)
    result = await session.connect()
  } catch (err) {
    // To process a WebTransport fetch response ...
    // 1. If response is a network error, then abort the remaining steps
    //    and queue a network task with transport to run these steps:
    //    1.1. If transport.[[State]] is "closed" or "failed", then abort
    //         these steps.
    if (ctx.state === sessionStates.closed || ctx.state === sessionStates.failed) {
      return
    }

    //    1.2. Let error be a newly created WebTransportError whose source
    //         is "session".
    const error = createUnvalidatedWebTransportError(
      `WebTransport session establishment failed: ${err.message}`, 'session', null)

    //    1.3. Cleanup transport with error.
    cleanup(ctx, error)
    return
  }

  // 6. Queue a network task with transport to run these steps:
  //    6.1. Assert: this’s [[Datagrams]]’s [[OutgoingMaxDatagramSize]] is
  //         an integer.
  //    6.2. If transport.[[State]] is not "connecting":
  if (ctx.state !== sessionStates.connecting) {
    // 6.2.1. In parallel, terminate session.
    session.destroy(new Error('The WebTransport object is no longer connecting'))

    // 6.2.2. Abort these steps.
    return
  }

  //    6.3. Set transport.[[State]] to "connected".
  ctx.state = sessionStates.connected

  //    6.4. Set transport.[[Session]] to session.
  // (ctx.session was assigned in the constructor; the underlying QUIC
  // session now exists)

  //    6.5. Let responseHeaders be a copy of response’s header list.
  //    6.6. Delete "wt-protocol" from responseHeaders.
  //    6.7. Set transport.[[ResponseHeaders]] to a new Headers object,
  //         whose header list is responseHeaders and guard is
  //         "immutable".
  if (result.responseHeaders !== null) {
    const responseHeaders = new Headers()
    for (const [name, value] of result.responseHeaders) {
      if (name.toLowerCase() === 'wt-protocol') {
        continue
      }
      responseHeaders.append(name, value)
    }
    setHeadersGuard(responseHeaders, 'immutable')
    ctx.responseHeaders = responseHeaders
  }

  //    6.8. Set transport.[[Protocol]] to either the string value of the
  //         negotiated application protocol if present, following
  //         [WEB-TRANSPORT-OVERVIEW] Section 3.1, or "" if not present.
  ctx.protocol = result.protocol

  //    6.9. If the connection is an HTTP/3 connection, set
  //         transport.[[Reliability]] to "supports-unreliable".
  //    6.10. If the connection is an HTTP/2 connection
  //          [WEB-TRANSPORT-HTTP2], set transport’s [[Reliability]] to
  //          "reliable-only".
  ctx.reliability = 'supports-unreliable'

  // 6.1 (see above): the maximum outgoing datagram size is now known.
  const datagramsState = getDatagramsState(ctx.datagrams)
  datagramsState.outgoingMaxDatagramSize = session.maxDatagramSize

  //    6.11. Resolve transport.[[Ready]] with undefined.
  ctx.ready.resolve(undefined)

  // "Once the transport’s [[State]] becomes "connected", it will start
  //  sending the queued datagrams."
  for (const writable of datagramsState.writables) {
    sendDatagrams(ctx, writable)
  }
}

/**
 * The shared implementation of the createBidirectionalStream and
 * createUnidirectionalStream methods; their steps are identical except
 * for the type of stream created.
 * @see https://w3c.github.io/webtransport/#dom-webtransport-createbidirectionalstream
 * @see https://w3c.github.io/webtransport/#dom-webtransport-createunidirectionalstream
 * @param {object} ctx
 * @param {object} options the converted WebTransportSendStreamOptions
 * @param {'bidi'|'uni'} type
 */
async function createOutgoingStream (ctx, options, type) {
  // 1. Let sendGroup be options’s sendGroup.
  const sendGroup = options.sendGroup

  // 2. If sendGroup is not null, and sendGroup.[[Transport]] is not this,
  //    return a promise rejected with a TypeError.
  if (sendGroup !== null && getSendGroupTransport(sendGroup) !== ctx) {
    throw new TypeError('The given WebTransportSendGroup belongs to a different WebTransport')
  }

  // 3. If this.[[State]] is "closed" or "failed", return a promise
  //    rejected with an InvalidStateError.
  if (ctx.state === sessionStates.closed || ctx.state === sessionStates.failed) {
    throw new DOMException('The WebTransport session is closed', 'InvalidStateError')
  }

  // 4. Let sendOrder be options’s sendOrder.
  const sendOrder = options.sendOrder

  // 5. Let waitUntilAvailable be options’s waitUntilAvailable.
  const waitUntilAvailable = options.waitUntilAvailable

  // 6. Let p be a new promise.
  // 7. Let transport be this.
  // 8. Run the following steps in parallel, but abort when transport’s
  //    [[State]] becomes "closed" or "failed", and instead queue a
  //    network task with transport to reject p with an InvalidStateError:
  let internalStream
  try {
    // 8.1. Let streamId be a new stream ID that is valid and unique for
    //      transport.[[Session]], as defined in [QUIC] Section 19.11. If
    //      one is not immediately available due to exhaustion, either
    //      wait for it to become available if waitUntilAvailable is true,
    //      or if waitUntilAvailable is false, abort these steps after
    //      queueing a network task with transport to reject p with a
    //      QuotaExceededError whose requested and quota are both null.
    // 8.2. Let internalStream be the result of creating a bidirectional
    //      stream (or an outgoing unidirectional stream) with
    //      transport.[[Session]] and streamId.
    internalStream = type === 'bidi'
      ? await ctx.session.createBidirectionalStream()
      : await ctx.session.createUnidirectionalStream()
  } catch (err) {
    if (ctx.state === sessionStates.closed || ctx.state === sessionStates.failed) {
      throw new DOMException('The WebTransport session is closed', 'InvalidStateError')
    }
    throw createUnvalidatedWebTransportError(
      `Failed to create a WebTransport stream: ${err.message}`, 'session', null)
  }

  // 8.1 (continued): node:quic queues stream creation while stream IDs
  // are exhausted (the stream stays "pending"); when waitUntilAvailable
  // is false a pending stream is rejected immediately.
  if (!waitUntilAvailable && internalStream.pending === true) {
    internalStream.resetWithCode(0, 0)
    throw new DOMException('No stream ID is available', 'QuotaExceededError')
  }

  // 8.3. Queue a network task with transport to run the following steps:
  //      8.3.1. If transport.[[State]] is "closed" or "failed", reject p
  //             with an InvalidStateError and abort these steps.
  if (ctx.state === sessionStates.closed || ctx.state === sessionStates.failed) {
    throw new DOMException('The WebTransport session is closed', 'InvalidStateError')
  }

  //      8.3.2. Let stream be the result of creating a
  //             WebTransportBidirectionalStream (or WebTransportSendStream)
  //             with internalStream, transport, sendGroup, and sendOrder.
  //      8.3.3. Resolve p with stream.
  // 9. Return p.
  return type === 'bidi'
    ? createWebTransportBidirectionalStream(internalStream, ctx, sendGroup, sendOrder)
    : createWebTransportSendStream(internalStream, ctx, sendGroup, sendOrder)
}

/**
 * To pullBidirectionalStream, given a WebTransport object transport, run
 * these steps.
 * @see https://w3c.github.io/webtransport/#pullbidirectionalstream
 * @param {object} ctx
 * @returns {Promise<undefined>}
 */
async function pullBidirectionalStream (ctx) {
  // 1. If transport.[[State]] is "connecting", then return the result of
  //    performing the following steps upon fulfillment of
  //    transport.[[Ready]]:
  //    1.1. Return the result of pullBidirectionalStream with transport.
  if (ctx.state === sessionStates.connecting) {
    await ctx.ready.promise
    return pullBidirectionalStream(ctx)
  }

  // 2. If transport.[[State]] is not "connected", then return a new
  //    rejected promise with an InvalidStateError.
  if (ctx.state !== sessionStates.connected && ctx.state !== sessionStates.draining) {
    throw new DOMException('The WebTransport session is not connected', 'InvalidStateError')
  }

  // 3. Let session be transport.[[Session]].
  // 4. Let p be a new promise.
  // 5. Run the following steps in parallel:
  //    5.1. Wait until there is an available incoming bidirectional
  //         stream in session.
  //    5.2. Let internalStream be the result of receiving a bidirectional
  //         stream from session.
  const internalStream = await nextIncomingStream(ctx, ctx.incomingBidirectionalStreamsQueue)

  //    5.3. Queue a network task with transport to run these steps:
  //         5.3.1. Let stream be the result of creating a
  //                WebTransportBidirectionalStream with internalStream
  //                and transport.
  const stream = createWebTransportBidirectionalStream(internalStream, ctx, null, 0)

  //         5.3.2. Enqueue stream to
  //                transport.[[IncomingBidirectionalStreams]].
  ctx.incomingBidirectionalStreamsController.enqueue(stream)

  //         5.3.3. Resolve p with undefined.
  // 6. Return p.
}

/**
 * To pullUnidirectionalStream, given a WebTransport object transport, run
 * these steps.
 * @see https://w3c.github.io/webtransport/#pullunidirectionalstream
 * @param {object} ctx
 * @returns {Promise<undefined>}
 */
async function pullUnidirectionalStream (ctx) {
  // 1. If transport.[[State]] is "connecting", then return the result of
  //    performing the following steps upon fulfillment of
  //    transport.[[Ready]]:
  //    1.1. Return the result of pullUnidirectionalStream with transport.
  if (ctx.state === sessionStates.connecting) {
    await ctx.ready.promise
    return pullUnidirectionalStream(ctx)
  }

  // 2. If transport.[[State]] is not "connected", then return a new
  //    rejected promise with an InvalidStateError.
  if (ctx.state !== sessionStates.connected && ctx.state !== sessionStates.draining) {
    throw new DOMException('The WebTransport session is not connected', 'InvalidStateError')
  }

  // 3. Let session be transport.[[Session]].
  // 4. Let p be a new promise.
  // 5. Run the following steps in parallel:
  //    5.1. Wait until there is an available incoming unidirectional
  //         stream in session.
  //    5.2. Let internalStream be the result of receiving an incoming
  //         unidirectional stream from session.
  const internalStream = await nextIncomingStream(ctx, ctx.incomingUnidirectionalStreamsQueue)

  //    5.3. Queue a network task with transport to run these steps:
  //         5.3.1. Let stream be the result of creating a
  //                WebTransportReceiveStream with internalStream and
  //                transport.
  const stream = createWebTransportReceiveStream(internalStream, ctx)

  //         5.3.2. Enqueue stream to
  //                transport.[[IncomingUnidirectionalStreams]].
  ctx.incomingUnidirectionalStreamsController.enqueue(stream)

  //         5.3.3. Resolve p with undefined.
  // 6. Return p.
}

/**
 * Waits until the given incoming stream queue is non-empty and takes its
 * first element.
 * @param {object} ctx
 * @param {object[]} queue
 */
async function nextIncomingStream (ctx, queue) {
  while (queue.length === 0) {
    const waiter = Promise.withResolvers()
    ctx.incomingStreamWaiters.add(waiter)
    await waiter.promise
  }
  return queue.shift()
}

function wakeIncomingStreamWaiters (ctx) {
  for (const waiter of ctx.incomingStreamWaiters) {
    waiter.resolve()
  }
  ctx.incomingStreamWaiters.clear()
}

/**
 * To cleanup a WebTransport transport with error and optionally
 * closeInfo, run these steps:
 * @see https://w3c.github.io/webtransport/#webtransport-cleanup
 * @param {object} ctx
 * @param {import('./error').WebTransportError|DOMException} error
 * @param {{ closeCode: number, reason: string }} [closeInfo]
 */
function cleanup (ctx, error, closeInfo = undefined) {
  // 1. Let sendStreams be a copy of transport.[[SendStreams]].
  const sendStreams = [...ctx.sendStreams]

  // 2. Let receiveStreams be a copy of transport.[[ReceiveStreams]].
  const receiveStreams = [...ctx.receiveStreams]

  // 3. Let outgoingDatagramWritables be
  //    transport.[[Datagrams]].[[Writables]].
  const datagramsState = getDatagramsState(ctx.datagrams)
  const outgoingDatagramWritables = [...datagramsState.writables]

  // 4. Let incomingDatagrams be transport.[[Datagrams]].[[Readable]].
  const incomingDatagramsController = datagramsState.readableController

  // 5. Let ready be transport.[[Ready]].
  const ready = ctx.ready

  // 6. Let closed be transport.[[Closed]].
  const closed = ctx.closed

  // 7. Let incomingBidirectionalStreams be
  //    transport.[[IncomingBidirectionalStreams]].
  const incomingBidirectionalStreamsController = ctx.incomingBidirectionalStreamsController

  // 8. Let incomingUnidirectionalStreams be
  //    transport.[[IncomingUnidirectionalStreams]].
  const incomingUnidirectionalStreamsController = ctx.incomingUnidirectionalStreamsController

  // 9. Set transport.[[SendStreams]] to an empty set.
  ctx.sendStreams.clear()

  // 10. Set transport.[[ReceiveStreams]] to an empty set.
  ctx.receiveStreams.clear()

  // 11. Set transport.[[Datagrams]].[[OutgoingDatagramsQueue]] to an
  //     empty queue.
  for (const writable of outgoingDatagramWritables) {
    getDatagramsWritableState(writable).outgoingDatagramsQueue.length = 0
  }

  // 12. Set transport.[[Datagrams]].[[IncomingDatagramsQueue]] to an
  //     empty queue.
  datagramsState.incomingDatagramsQueue.length = 0

  // 13. If closeInfo is given, then set transport.[[State]] to "closed".
  //     Otherwise, set transport.[[State]] to "failed".
  ctx.state = closeInfo !== undefined ? sessionStates.closed : sessionStates.failed

  // 14. For each stream in sendStreams, run the following steps:
  for (const stream of sendStreams) {
    const streamState = getSendStreamState(stream)

    // 14.1. If stream.[[PendingOperation]] is not null, reject
    //       stream.[[PendingOperation]] with error.
    if (streamState.pendingOperation !== null) {
      const pendingOperation = streamState.pendingOperation
      streamState.pendingOperation = null
      pendingOperation.reject(error)
    }

    // 14.2. Error stream with error.
    streamState.controller.error(error)
  }

  // 15. For each stream in receiveStreams, error stream with error.
  for (const stream of receiveStreams) {
    getReceiveStreamState(stream).controller.error(error)
  }

  // 16. If closeInfo is given, then:
  if (closeInfo !== undefined) {
    // 16.1. Resolve closed with closeInfo.
    closed.resolve(closeInfo)

    // 16.2. Assert: ready is settled.

    // 16.3. Close incomingBidirectionalStreams.
    try {
      incomingBidirectionalStreamsController.close()
    } catch {
      // Already closed or errored.
    }

    // 16.4. Close incomingUnidirectionalStreams.
    try {
      incomingUnidirectionalStreamsController.close()
    } catch {
      // Already closed or errored.
    }

    // 16.5. For each writable in outgoingDatagramWritables, close
    //       writable.
    for (const writable of outgoingDatagramWritables) {
      // A WritableStream cannot be closed from the outside while it is
      // locked to a writer; erroring is the closest observable behavior
      // in that case.
      try {
        writable.close().catch(() => {})
      } catch {
        getDatagramsWritableState(writable).controller.error(error)
      }
    }

    // 16.6. Close incomingDatagrams.
    try {
      incomingDatagramsController.close()
      incomingDatagramsController.byobRequest?.respond(0)
    } catch {
      // Already closed or errored.
    }
  } else {
    // 17. Otherwise:
    // 17.1. Reject closed with error.
    closed.reject(error)

    // 17.2. Set closed.[[PromiseIsHandled]] to true.
    closed.promise.catch(() => {})

    // 17.3. Reject ready with error.
    ready.reject(error)

    // 17.4. Set ready.[[PromiseIsHandled]] to true.
    ready.promise.catch(() => {})

    // 17.5. Error incomingBidirectionalStreams with error.
    incomingBidirectionalStreamsController.error(error)

    // 17.6. Error incomingUnidirectionalStreams with error.
    incomingUnidirectionalStreamsController.error(error)

    // 17.7. For each writable in outgoingDatagramWritables, error
    //       writable with error.
    for (const writable of outgoingDatagramWritables) {
      getDatagramsWritableState(writable).controller.error(error)
    }

    // 17.8. Error incomingDatagrams with error.
    incomingDatagramsController.error(error)
  }

  // Wake any pending incoming stream pulls so they observe the state
  // change.
  wakeIncomingStreamWaiters(ctx)
}

/**
 * Whenever a WebTransport session which is associated with a WebTransport
 * transport is terminated with optionally code and reasonBytes, run these
 * steps:
 * @see https://w3c.github.io/webtransport/#web-transport-termination
 * @param {object} ctx
 * @param {number|undefined} code
 * @param {string|undefined} reason
 */
function sessionTerminated (ctx, code, reason) {
  // 1. Queue a network task with transport to run these steps:
  //    1.1. If transport.[[State]] is "closed" or "failed", abort these
  //         steps.
  if (ctx.state === sessionStates.closed || ctx.state === sessionStates.failed) {
    return
  }

  //    1.2. Let error be a newly created WebTransportError whose source
  //         is "session".
  const error = createUnvalidatedWebTransportError(
    'The WebTransport session was terminated', 'session', null)

  //    1.3. Let closeInfo be a new WebTransportCloseInfo.
  const closeInfo = { closeCode: 0, reason: '' }

  //    1.4. If code is given, set closeInfo’s closeCode to code.
  if (code !== undefined) {
    closeInfo.closeCode = code
  }

  //    1.5. If reasonBytes is given, set closeInfo’s reason to
  //         reasonBytes, UTF-8 decoded.
  if (reason !== undefined) {
    closeInfo.reason = reason
  }

  //    1.6. Cleanup transport with error and closeInfo.
  cleanup(ctx, error, closeInfo)
}

/**
 * Whenever a WebTransport transport’s underlying connection gets a
 * connection error, run these steps:
 * @see https://w3c.github.io/webtransport/#web-transport-termination
 * @param {object} ctx
 * @param {Error} cause
 */
function connectionErrored (ctx, cause) {
  // 1. Queue a network task with transport to run these steps:
  //    1.1. If transport.[[State]] is "closed" or "failed", abort these
  //         steps.
  if (ctx.state === sessionStates.closed || ctx.state === sessionStates.failed) {
    return
  }

  //    1.2. Let error be a newly created WebTransportError whose source
  //         is "session".
  const error = createUnvalidatedWebTransportError(
    `The WebTransport connection failed: ${cause?.message ?? 'unknown error'}`, 'session', null)

  //    1.3. Cleanup transport with error.
  cleanup(ctx, error)
}

Object.defineProperties(WebTransport.prototype, {
  getStats: kEnumerableProperty,
  exportKeyingMaterial: kEnumerableProperty,
  ready: kEnumerableProperty,
  reliability: kEnumerableProperty,
  congestionControl: kEnumerableProperty,
  anticipatedConcurrentIncomingUnidirectionalStreams: kEnumerableProperty,
  anticipatedConcurrentIncomingBidirectionalStreams: kEnumerableProperty,
  responseHeaders: kEnumerableProperty,
  protocol: kEnumerableProperty,
  closed: kEnumerableProperty,
  draining: kEnumerableProperty,
  close: kEnumerableProperty,
  datagrams: kEnumerableProperty,
  createBidirectionalStream: kEnumerableProperty,
  incomingBidirectionalStreams: kEnumerableProperty,
  createUnidirectionalStream: kEnumerableProperty,
  incomingUnidirectionalStreams: kEnumerableProperty,
  createSendGroup: kEnumerableProperty,
  [Symbol.toStringTag]: {
    value: 'WebTransport',
    writable: false,
    enumerable: false,
    configurable: true
  }
})

webidl.is.WebTransport = webidl.util.MakeTypeAssertion(WebTransport)

/**
 * [EnforceRange] unsigned short, nullable
 */
webidl.converters['unsigned short? [EnforceRange]'] = webidl.nullableConverter(
  (V, prefix, argument) =>
    webidl.converters['unsigned short'](V, prefix, argument, webidl.attributes.EnforceRange)
)

// https://w3c.github.io/webtransport/#dictdef-webtransporthash
webidl.converters.WebTransportHash = webidl.dictionaryConverter([
  {
    key: 'algorithm',
    converter: webidl.converters.DOMString,
    required: true
  },
  {
    key: 'value',
    converter: webidl.converters.BufferSource,
    required: true
  }
])

webidl.converters['sequence<WebTransportHash>'] = webidl.sequenceConverter(
  webidl.converters.WebTransportHash
)

webidl.converters['sequence<DOMString>'] = webidl.sequenceConverter(
  webidl.converters.DOMString
)

// The undici-only `node` member of WebTransportOptions.
webidl.converters.WebTransportNodeOptions = webidl.dictionaryConverter([
  {
    key: 'alpn',
    converter: webidl.converters.DOMString
  }
])

// https://w3c.github.io/webtransport/#dictdef-webtransportoptions
webidl.converters.WebTransportOptions = webidl.dictionaryConverter([
  {
    key: 'allowPooling',
    converter: webidl.converters.boolean,
    defaultValue: () => false
  },
  {
    key: 'anticipatedConcurrentIncomingBidirectionalStreams',
    converter: webidl.converters['unsigned short? [EnforceRange]'],
    defaultValue: () => null
  },
  {
    key: 'anticipatedConcurrentIncomingUnidirectionalStreams',
    converter: webidl.converters['unsigned short? [EnforceRange]'],
    defaultValue: () => null
  },
  {
    key: 'congestionControl',
    converter: webidl.converters.DOMString,
    defaultValue: () => 'default',
    // enum WebTransportCongestionControl { "default", "throughput", "low-latency" }
    allowedValues: ['default', 'throughput', 'low-latency']
  },
  {
    key: 'datagramsReadableType',
    converter: webidl.converters.DOMString,
    // enum ReadableStreamType { "bytes" }
    // https://streams.spec.whatwg.org/#enumdef-readablestreamtype
    allowedValues: ['bytes']
  },
  {
    key: 'headers',
    converter: webidl.converters.HeadersInit,
    defaultValue: () => ({})
  },
  {
    // undici only
    key: 'node',
    converter: webidl.converters.WebTransportNodeOptions
  },
  {
    key: 'protocols',
    converter: webidl.converters['sequence<DOMString>'],
    defaultValue: () => []
  },
  {
    key: 'requireUnreliable',
    converter: webidl.converters.boolean,
    defaultValue: () => false
  },
  {
    key: 'serverCertificateHashes',
    converter: webidl.converters['sequence<WebTransportHash>'],
    defaultValue: () => []
  }
])

// https://w3c.github.io/webtransport/#dictdef-webtransportcloseinfo
webidl.converters.WebTransportCloseInfo = webidl.dictionaryConverter([
  {
    key: 'closeCode',
    converter: webidl.converters['unsigned long'],
    defaultValue: () => 0
  },
  {
    key: 'reason',
    converter: webidl.converters.USVString,
    defaultValue: () => ''
  }
])

// https://w3c.github.io/webtransport/#dictdef-webtransportsendstreamoptions
// dictionary WebTransportSendStreamOptions : WebTransportSendOptions
webidl.converters.WebTransportSendStreamOptions = webidl.dictionaryConverter([
  {
    key: 'sendGroup',
    converter: webidl.converters['WebTransportSendGroup?'],
    defaultValue: () => null
  },
  {
    key: 'sendOrder',
    converter: webidl.converters['long long'],
    defaultValue: () => 0
  },
  {
    key: 'waitUntilAvailable',
    converter: webidl.converters.boolean,
    defaultValue: () => false
  }
])

module.exports = { WebTransport }
