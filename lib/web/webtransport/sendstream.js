'use strict'

const { webidl } = require('../webidl')
const { kConstruct } = require('../../core/symbols')
const { kEnumerableProperty } = require('../../core/util')
const { getSendGroupTransport } = require('./sendgroup')
const { createUnvalidatedWebTransportError } = require('./error')
const { sessionStates } = require('./constants')

/**
 * An internal accessor for the private state of a WebTransportSendStream,
 * assigned in the static initialization block of the class.
 * @type {(stream: WebTransportSendStream) => object}
 */
let getSendStreamState

/**
 * The underlying sink and the shared box used to pass values between the
 * create procedure and the constructor, as the underlying sink must be
 * passed to super() before the instance exists.
 * @type {{ sink: object, box: object }|null}
 */
let sideChannel = null

/**
 * A WebTransportSendStream is a WritableStream providing outgoing streaming
 * features with an outgoing unidirectional or bidirectional WebTransport
 * stream.
 *
 * It is a WritableStream of Uint8Array that can be written to, to send data
 * to the server.
 * @see https://w3c.github.io/webtransport/#send-stream
 */
class WebTransportSendStream extends WritableStream {
  /**
   * The internal slots of this WebTransportSendStream.
   * @see https://w3c.github.io/webtransport/#send-stream-internal-slots
   */
  #state

  static {
    getSendStreamState = (stream) => stream.#state
  }

  /**
   * "A WebTransportSendStream is always created by the create procedure."
   * @see https://w3c.github.io/webtransport/#webtransportsendstream-create
   */
  constructor (sentinel = undefined) {
    if (sentinel !== kConstruct) {
      throw new TypeError('Illegal constructor')
    }

    // 5. Set up stream with writeAlgorithm set to writeAlgorithm,
    //    closeAlgorithm set to closeAlgorithm, abortAlgorithm set to
    //    abortAlgorithm.
    super(sideChannel.sink)

    this.#state = sideChannel.box
    webidl.util.markAsUncloneable(this)
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportsendstream-sendgroup
   * @returns {import('./sendgroup').WebTransportSendGroup|null}
   */
  get sendGroup () {
    webidl.brandCheck(this, WebTransportSendStream)

    // The getter steps are:
    // 1. Return this’s [[SendGroup]].
    return this.#state.sendGroup
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportsendstream-sendgroup
   * @param {import('./sendgroup').WebTransportSendGroup|null} value
   */
  set sendGroup (value) {
    webidl.brandCheck(this, WebTransportSendStream)

    value = webidl.converters['WebTransportSendGroup?'](value, 'WebTransportSendStream.sendGroup', 'value')

    // The setter steps, given value, are:
    // 1. If value is non-null, and value.[[Transport]] is not
    //    this.[[Transport]], throw an InvalidStateError.
    if (value !== null && getSendGroupTransport(value) !== this.#state.transport) {
      throw new DOMException(
        'The given WebTransportSendGroup belongs to a different WebTransport',
        'InvalidStateError'
      )
    }

    // 2. Set this.[[SendGroup]] to value.
    this.#state.sendGroup = value
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportsendstream-sendorder
   * @returns {number}
   */
  get sendOrder () {
    webidl.brandCheck(this, WebTransportSendStream)

    // The getter steps are:
    // 1. Return this’s [[SendOrder]].
    return this.#state.sendOrder
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportsendstream-sendorder
   * @param {number} value
   */
  set sendOrder (value) {
    webidl.brandCheck(this, WebTransportSendStream)

    value = webidl.converters['long long'](value, 'WebTransportSendStream.sendOrder', 'value')

    // The setter steps, given value, are:
    // 1. Set this.[[SendOrder]] to value.
    this.#state.sendOrder = value
  }

  /**
   * Gathers stats specific to this WebTransportSendStream’s performance,
   * and reports the result asynchronously.
   * @see https://w3c.github.io/webtransport/#dom-webtransportsendstream-getstats
   * @returns {Promise<import('../../../types/webtransport').WebTransportSendStreamStats>}
   */
  getStats () {
    webidl.brandCheck(this, WebTransportSendStream)

    // 1. Let transport be this.[[Transport]].
    const state = this.#state

    // 2. Let p be a new promise.
    // 3. Run the following steps in parallel:
    //    3.1. Let gatheredStats be the list of stats specific to this
    //         WebTransportSendStream needed to populate the dictionary
    //         members of WebTransportSendStreamStats accurately.
    //    3.2. Queue a network task with transport to run the following
    //         steps:
    //         3.2.1. Let stats be a new WebTransportSendStreamStats object.
    //         3.2.2. For each member member of stats that the user agent
    //                wishes to expose, set member to the the corresponding
    //                entry in gatheredStats.
    //         3.2.3. Resolve p with stats.
    // 4. Return p.
    return state.internalStream.getStats().then((gatheredStats) => ({
      bytesWritten: state.bytesWritten,
      bytesSent: gatheredStats.bytesSent,
      bytesAcknowledged: gatheredStats.bytesAcknowledged
    }))
  }

  /**
   * Creates a WebTransportWriter for this stream.
   * @see https://w3c.github.io/webtransport/#dom-webtransportsendstream-getwriter
   * @returns {WebTransportWriter}
   */
  getWriter () {
    webidl.brandCheck(this, WebTransportSendStream)

    // When getWriter is called, return the result of creating a
    // WebTransportWriter with this.
    return createWebTransportWriter(this)
  }

  /**
   * To create a WebTransportSendStream, with an outgoing unidirectional or
   * bidirectional WebTransport stream internalStream, a WebTransport
   * transport, sendGroup, and a sendOrder, run these steps:
   * @see https://w3c.github.io/webtransport/#webtransportsendstream-create
   * @param {object} internalStream a TransportStream from ./transport/session
   * @param {import('./sendgroup').TransportContext} transport
   * @param {import('./sendgroup').WebTransportSendGroup|null} sendGroup
   * @param {number} sendOrder
   * @returns {WebTransportSendStream}
   */
  static createWebTransportSendStream (internalStream, transport, sendGroup, sendOrder) {
    // 1. Let stream be a new WebTransportSendStream, with:
    //    [[InternalStream]]: internalStream
    //    [[PendingOperation]]: null
    //    [[Transport]]: transport
    //    [[SendGroup]]: sendGroup
    //    [[SendOrder]]: sendOrder
    //    [[AtomicWriteRequests]]: An empty ordered set of promises
    //    [[InsideSynchronousAtomicWrite]]: false
    //    [[BytesWritten]]: 0
    //    [[CommittedOffset]]: 0
    const box = {
      internalStream,
      transport,
      sendGroup,
      sendOrder,
      pendingOperation: null,
      atomicWriteRequests: new Set(),
      insideSynchronousAtomicWrite: false,
      bytesWritten: 0,
      committedOffset: 0,
      controller: null
    }

    /** @type {WebTransportSendStream} */
    let stream

    // 2. Let writeAlgorithm be an action that writes chunk to stream,
    //    given chunk.
    // 3. Let closeAlgorithm be an action that closes stream.
    // 4. Let abortAlgorithm be an action that aborts stream with reason,
    //    given reason.
    const sink = {
      // The start algorithm is not a part of the create procedure; it is
      // only used to get a reference to the stream's controller, which the
      // streams specification accesses through internal slots.
      start (controller) {
        box.controller = controller
      },
      write (chunk) {
        return writeToSendStream(stream, box, chunk)
      },
      close () {
        return closeSendStream(stream, box)
      },
      abort (reason) {
        return abortSendStream(stream, box, reason)
      }
    }

    // 5. Set up stream with writeAlgorithm set to writeAlgorithm,
    //    closeAlgorithm set to closeAlgorithm, abortAlgorithm set to
    //    abortAlgorithm. (performed by the constructor)
    sideChannel = { sink, box }
    try {
      stream = new WebTransportSendStream(kConstruct)
    } finally {
      sideChannel = null
    }

    // 6. Let abortSignal be stream’s
    //    [[controller]].[[abortController]].[[signal]].
    const abortSignal = box.controller.signal

    // 7. Add the following steps to abortSignal.
    abortSignal.addEventListener('abort', () => {
      // 7.1. Let pendingOperation be stream.[[PendingOperation]].
      const pendingOperation = box.pendingOperation

      // 7.2. If pendingOperation is null, then abort these steps.
      if (pendingOperation === null) {
        return
      }

      // 7.3. Set stream.[[PendingOperation]] to null.
      box.pendingOperation = null

      // 7.4. Let reason be abortSignal’s abort reason.
      const reason = abortSignal.reason

      // 7.5. Let promise be the result of aborting stream with reason.
      const promise = abortSendStream(stream, box, reason)

      // 7.6. Upon fulfillment of promise, reject pendingOperation with
      //      reason.
      promise.then(() => pendingOperation.reject(reason))
    }, { once: true })

    // Whenever a WebTransport stream associated with a
    // WebTransportSendStream stream gets a receiving aborted signal from
    // the server, run these steps:
    // @see https://w3c.github.io/webtransport/#webtransportsendstream-receiving-aborted
    internalStream.onStopSending((code) => {
      receivingAborted(stream, box, code)
    })

    // 8. Append stream to transport.[[SendStreams]].
    transport.sendStreams.add(stream)

    // 9. Return stream.
    return stream
  }
}

/**
 * To write chunk to a WebTransportSendStream stream, run these steps:
 * @see https://w3c.github.io/webtransport/#webtransportsendstream-write
 * @param {WebTransportSendStream} stream
 * @param {object} state the stream's internal slots
 * @param {*} chunk
 * @returns {Promise<undefined>}
 */
function writeToSendStream (stream, state, chunk) {
  // 1. Let transport be stream.[[Transport]].

  // 2. If chunk is not a BufferSource, return a promise rejected with a
  //    TypeError.
  if (!webidl.is.BufferSource(chunk)) {
    return Promise.reject(new TypeError('chunk must be a BufferSource'))
  }

  // 3. Let promise be a new promise.
  const promise = Promise.withResolvers()

  // 4. Let bytes be a copy of the byte sequence which chunk represents.
  const bytes = webidl.util.getCopyOfBytesHeldByBufferSource(chunk)

  // 5. If bytes length is 0, resolve promise with undefined and return
  //    promise.
  if (bytes.length === 0) {
    promise.resolve(undefined)
    return promise.promise
  }

  // 6. Set stream.[[PendingOperation]] to promise.
  state.pendingOperation = promise

  // 7. Let inFlightWriteRequest be stream.inFlightWriteRequest.
  // 8. Let atomic be true if stream.[[AtomicWriteRequests]] contains
  //    inFlightWriteRequest or stream.[[InsideSynchronousAtomicWrite]] is
  //    true, otherwise false.
  // Note: inFlightWriteRequest is an internal slot of WritableStream that
  // is not reachable through public APIs. It is only needed for step 9.1
  // below, which this implementation cannot perform (see there), so only
  // [[InsideSynchronousAtomicWrite]] is consulted.

  // 9. Run the following steps in parallel:
  //    9.1. If atomic is true and the current flow control window is too
  //         small for bytes to be sent in its entirety, then abort the
  //         remaining steps and queue a network task with transport to run
  //         these sub-steps:
  //         9.1.1. Set stream.[[PendingOperation]] to null.
  //         9.1.2. Abort all atomic write requests on stream.
  // Deviation: node:quic does not expose the stream's flow control window
  // to JavaScript, so an atomic write that does not fit inside the current
  // flow control window cannot be detected; the write proceeds as a
  // regular write instead. (The "abort all atomic write requests"
  // procedure is therefore unreachable and not implemented.)

  //    9.2. Otherwise, send bytes on stream.[[InternalStream]] and wait
  //         for the operation to complete. This sending MUST follow the
  //         send-order rules.
  state.internalStream.write(bytes).then(
    () => {
      // 9.4. Otherwise, queue a network task with transport to run these
      //      steps:
      //      9.4.1. Set stream.[[PendingOperation]] to null.
      state.pendingOperation = null

      //      9.4.2. Add the length of bytes to stream.[[BytesWritten]].
      state.bytesWritten += bytes.length

      //      9.4.3. If stream.[[AtomicWriteRequests]] contains
      //             inFlightWriteRequest, remove inFlightWriteRequest.
      // Note: performed in the reaction steps of atomicWrite instead, as
      // inFlightWriteRequest is not reachable through public APIs.

      //      9.4.4. Resolve promise with undefined.
      promise.resolve(undefined)
    },
    () => {
      // 9.3. If the previous step failed due to a network error, abort the
      //      remaining steps.
      // Note: We don’t reject promise here because we handle network
      // errors elsewhere, and those steps reject
      // stream.[[PendingOperation]].
    }
  )

  // 10. Return promise.
  return promise.promise
}

/**
 * To close a WebTransportSendStream stream, run these steps:
 * @see https://w3c.github.io/webtransport/#webtransportsendstream-close
 * @param {WebTransportSendStream} stream
 * @param {object} state the stream's internal slots
 * @returns {Promise<undefined>}
 */
function closeSendStream (stream, state) {
  // 1. Let transport be stream.[[Transport]].
  const transport = state.transport

  // 2. Let promise be a new promise.
  const promise = Promise.withResolvers()

  // 3. Remove stream from transport.[[SendStreams]].
  transport.sendStreams.delete(stream)

  // 4. Set stream.[[PendingOperation]] to promise.
  state.pendingOperation = promise

  // 5. Run the following steps in parallel:
  //    5.1. Send FIN on stream.[[InternalStream]] and wait for the
  //         operation to complete.
  //    5.2. Wait for stream.[[InternalStream]] to enter the "all data
  //         committed" state. [QUIC]
  state.internalStream.finish().then(() => {
    //  5.3. Queue a network task with transport to run these steps:
    //       5.3.1. Set stream.[[PendingOperation]] to null.
    state.pendingOperation = null

    //       5.3.2. Resolve promise with undefined.
    promise.resolve(undefined)
  }, () => {
    // As in the write procedure, failures are handled by the error paths,
    // which reject stream.[[PendingOperation]].
  })

  // 6. Return promise.
  return promise.promise
}

/**
 * To abort a WebTransportSendStream stream with reason, run these steps:
 * @see https://w3c.github.io/webtransport/#webtransportsendstream-abort
 * @param {WebTransportSendStream} stream
 * @param {object} state the stream's internal slots
 * @param {*} reason
 * @returns {Promise<undefined>}
 */
function abortSendStream (stream, state, reason) {
  // 1. Let transport be stream.[[Transport]].
  const transport = state.transport

  // 2. Let promise be a new promise.
  const promise = Promise.withResolvers()

  // 3. Let code be 0.
  let code = 0

  // 4. Remove stream from transport.[[SendStreams]].
  transport.sendStreams.delete(stream)

  // 5. If reason is a WebTransportError and reason.[[StreamErrorCode]] is
  //    not null, then set code to reason.[[StreamErrorCode]].
  if (webidl.is.WebTransportError(reason) && reason.streamErrorCode !== null) {
    code = reason.streamErrorCode
  }

  // 6. If code < 0, then set code to 0.
  if (code < 0) {
    code = 0
  }

  // 7. If code > 4294967295, then set code to 4294967295.
  if (code > 4294967295) {
    code = 4294967295
  }

  // 8. Let committedOffset be stream.[[CommittedOffset]].
  const committedOffset = state.committedOffset

  // 9. Run the following steps in parallel:
  //    9.1. Abort sending on stream.[[InternalStream]] with code and
  //         committedOffset.
  state.internalStream.resetWithCode(code, committedOffset)

  //    9.2. Queue a network task with transport to resolve promise with
  //         undefined.
  promise.resolve(undefined)

  // 10. Return promise.
  return promise.promise
}

/**
 * Whenever a WebTransport stream associated with a WebTransportSendStream
 * stream gets a receiving aborted signal from the server, run these steps:
 * @see https://w3c.github.io/webtransport/#webtransportsendstream-receiving-aborted
 * @param {WebTransportSendStream} stream
 * @param {object} state the stream's internal slots
 * @param {number} code
 */
function receivingAborted (stream, state, code) {
  // 1. Let transport be stream.[[Transport]].
  const transport = state.transport

  // 2. Let code be the application protocol error code attached to the
  //    receiving aborted signal. (given)

  // 3. Queue a network task with transport to run these steps:
  //    3.1. If transport.[[State]] is "closed" or "failed", abort these
  //         steps.
  if (transport.state === sessionStates.closed || transport.state === sessionStates.failed) {
    return
  }

  //    3.2. Remove stream from transport.[[SendStreams]].
  transport.sendStreams.delete(stream)

  //    3.3. Let error be a newly created WebTransportError whose source is
  //         "stream" and streamErrorCode is code.
  const error = createUnvalidatedWebTransportError(
    'The server aborted receiving on this stream',
    'stream',
    code
  )

  //    3.4. If stream.[[PendingOperation]] is not null, reject
  //         stream.[[PendingOperation]] with error.
  if (state.pendingOperation !== null) {
    const pendingOperation = state.pendingOperation
    state.pendingOperation = null
    pendingOperation.reject(error)
  }

  //    3.5. Error stream with error.
  state.controller.error(error)
}

/**
 * WebTransportWriter is a subclass of WritableStreamDefaultWriter that
 * adds two methods.
 * @see https://w3c.github.io/webtransport/#web-transport-writer-interface
 */
class WebTransportWriter extends WritableStreamDefaultWriter {
  /**
   * The WebTransportSendStream this writer was created with.
   * @type {WebTransportSendStream}
   */
  #stream

  /**
   * "A WebTransportWriter is always created by the create procedure."
   * @see https://w3c.github.io/webtransport/#webtransportwriter-create
   */
  constructor (stream = undefined, sentinel = undefined) {
    if (sentinel !== kConstruct) {
      throw new TypeError('Illegal constructor')
    }

    // 2. Set up writer for stream.
    super(stream)

    this.#stream = stream
    webidl.util.markAsUncloneable(this)
  }

  /**
   * The atomicWrite method will reject if the chunk given to it could not
   * be sent in its entirety within the flow control window that is current
   * at the time of sending.
   * @see https://w3c.github.io/webtransport/#dom-webtransportwriter-atomicwrite
   * @param {*} chunk
   * @returns {Promise<undefined>}
   */
  atomicWrite (chunk = undefined) {
    webidl.brandCheck(this, WebTransportWriter)

    // 1. Let stream be this.stream.
    // 2. If stream is undefined, return a promise rejected with a
    //    TypeError.
    // Note: this.[[Stream]] is set to undefined when the writer's lock is
    // released; the public observation of that state is that the
    // desiredSize getter throws a TypeError.
    try {
      this.desiredSize // eslint-disable-line no-unused-expressions
    } catch {
      return Promise.reject(new TypeError('The writer is not attached to a stream'))
    }

    const stream = this.#stream
    const state = getSendStreamState(stream)

    // 3. Set stream.[[InsideSynchronousAtomicWrite]] to true.
    state.insideSynchronousAtomicWrite = true

    // 4. Let p be the result of writing chunk to this.
    const p = WritableStreamDefaultWriter.prototype.write.call(this, chunk)

    // 5. Set stream.[[InsideSynchronousAtomicWrite]] to false.
    state.insideSynchronousAtomicWrite = false

    // 6. Append p to stream.[[AtomicWriteRequests]].
    state.atomicWriteRequests.add(p)

    // 7. Return the result of reacting to p with the following steps:
    return p.then(
      () => {
        // 7.1. If stream.[[AtomicWriteRequests]] contains p, remove p.
        state.atomicWriteRequests.delete(p)

        // 7.3. Return undefined.
        return undefined
      },
      (r) => {
        // 7.1. If stream.[[AtomicWriteRequests]] contains p, remove p.
        state.atomicWriteRequests.delete(p)

        // 7.2. If p was rejected with reason r, then return a promise
        //      rejected with r.
        throw r
      }
    )
  }

  /**
   * The commit method will update the [[CommittedOffset]] of a stream to
   * match the number of bytes written to that stream ([[BytesWritten]]).
   * This ensures that those bytes will be delivered to a peer reliably,
   * even after writing is aborted, causing the stream to abort sending.
   * @see https://w3c.github.io/webtransport/#dom-webtransportwriter-commit
   */
  commit () {
    webidl.brandCheck(this, WebTransportWriter)

    const stream = this.#stream
    const state = getSendStreamState(stream)

    // When commit is called for stream, the user agent MUST run the
    // following steps:
    // 1. Set stream.[[CommittedOffset]] to the value of
    //    stream.[[BytesWritten]].
    state.committedOffset = state.bytesWritten
  }
}

/**
 * To create a WebTransportWriter, with a WebTransportSendStream stream,
 * run these steps:
 * @see https://w3c.github.io/webtransport/#webtransportwriter-create
 * @param {WebTransportSendStream} stream
 * @returns {WebTransportWriter}
 */
function createWebTransportWriter (stream) {
  // 1. Let writer be a new WebTransportWriter.
  // 2. Set up writer for stream. (performed by the constructor)
  const writer = new WebTransportWriter(stream, kConstruct)

  // 3. Return writer.
  return writer
}

const { createWebTransportSendStream } = WebTransportSendStream
delete WebTransportSendStream.createWebTransportSendStream

Object.defineProperties(WebTransportSendStream.prototype, {
  sendGroup: kEnumerableProperty,
  sendOrder: kEnumerableProperty,
  getStats: kEnumerableProperty,
  getWriter: kEnumerableProperty,
  [Symbol.toStringTag]: {
    value: 'WebTransportSendStream',
    writable: false,
    enumerable: false,
    configurable: true
  }
})

Object.defineProperties(WebTransportWriter.prototype, {
  atomicWrite: kEnumerableProperty,
  commit: kEnumerableProperty,
  [Symbol.toStringTag]: {
    value: 'WebTransportWriter',
    writable: false,
    enumerable: false,
    configurable: true
  }
})

webidl.is.WebTransportSendStream = webidl.util.MakeTypeAssertion(WebTransportSendStream)
webidl.is.WebTransportWriter = webidl.util.MakeTypeAssertion(WebTransportWriter)

module.exports = {
  WebTransportSendStream,
  WebTransportWriter,
  createWebTransportSendStream,
  getSendStreamState
}
