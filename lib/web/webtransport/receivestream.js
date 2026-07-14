'use strict'

const { webidl } = require('../webidl')
const { kConstruct } = require('../../core/symbols')
const { kEnumerableProperty } = require('../../core/util')
const { createUnvalidatedWebTransportError } = require('./error')
const { sessionStates } = require('./constants')

/**
 * An internal accessor for the private state of a WebTransportReceiveStream,
 * assigned in the static initialization block of the class.
 * @type {(stream: WebTransportReceiveStream) => object}
 */
let getReceiveStreamState

/**
 * The underlying source and the shared box used to pass values between the
 * create procedure and the constructor, as the underlying source must be
 * passed to super() before the instance exists.
 * @type {{ source: object, box: object }|null}
 */
let sideChannel = null

/**
 * "Set maxBytes to an implementation-defined size." (see the pull bytes
 * procedure). 16384 bytes is used when the reader did not provide a view.
 */
const defaultReadSize = 16384

/**
 * A WebTransportReceiveStream is a ReadableStream providing incoming
 * streaming features with an incoming unidirectional or bidirectional
 * WebTransport stream.
 *
 * It is a ReadableStream of Uint8Array that can be read from, to consume
 * data received from the server. WebTransportReceiveStream is a readable
 * byte stream, and hence it allows its consumers to use a BYOB reader as
 * well as a default reader.
 * @see https://w3c.github.io/webtransport/#receive-stream
 */
class WebTransportReceiveStream extends ReadableStream {
  /**
   * The internal slots of this WebTransportReceiveStream.
   * @see https://w3c.github.io/webtransport/#receive-stream-internal-slots
   */
  #state

  static {
    getReceiveStreamState = (stream) => stream.#state
  }

  /**
   * "A WebTransportReceiveStream is always created by the create
   *  procedure."
   * @see https://w3c.github.io/webtransport/#webtransportreceivestream-create
   */
  constructor (sentinel = undefined) {
    if (sentinel !== kConstruct) {
      throw new TypeError('Illegal constructor')
    }

    // 4. Set up with byte reading support stream with pullAlgorithm set to
    //    pullAlgorithm and cancelAlgorithm set to cancelAlgorithm.
    super(sideChannel.source)

    this.#state = sideChannel.box
    webidl.util.markAsUncloneable(this)
  }

  /**
   * Gathers stats specific to this WebTransportReceiveStream’s
   * performance, and reports the result asynchronously.
   * @see https://w3c.github.io/webtransport/#dom-webtransportreceivestream-getstats
   * @returns {Promise<import('../../../types/webtransport').WebTransportReceiveStreamStats>}
   */
  getStats () {
    webidl.brandCheck(this, WebTransportReceiveStream)

    // 1. Let transport be this.[[Transport]].
    const state = this.#state

    // 2. Let p be a new promise.
    // 3. Run the following steps in parallel:
    //    3.1. Let gatheredStats be the list of stats specific to this
    //         WebTransportReceiveStream needed to populate the dictionary
    //         members of WebTransportReceiveStreamStats accurately.
    //    3.2. Queue a network task with transport to run the following
    //         steps:
    //         3.2.1. Let stats be a new WebTransportReceiveStreamStats
    //                object.
    //         3.2.2. For each member member of stats that the user agent
    //                wishes to expose, set member to the the corresponding
    //                entry in gatheredStats.
    //         3.2.3. Resolve p with stats.
    // 4. Return p.
    return state.internalStream.getStats().then((gatheredStats) => ({
      bytesReceived: gatheredStats.bytesReceived,
      bytesRead: state.bytesRead
    }))
  }

  /**
   * To create a WebTransportReceiveStream, with an incoming unidirectional
   * or bidirectional WebTransport stream internalStream and a WebTransport
   * transport, run these steps:
   * @see https://w3c.github.io/webtransport/#webtransportreceivestream-create
   * @param {object} internalStream a TransportStream from ./transport/session
   * @param {import('./sendgroup').TransportContext} transport
   * @returns {WebTransportReceiveStream}
   */
  static createWebTransportReceiveStream (internalStream, transport) {
    // 1. Let stream be a new WebTransportReceiveStream, with:
    //    [[InternalStream]]: internalStream
    //    [[Transport]]: transport
    const box = {
      internalStream,
      transport,
      bytesRead: 0,
      controller: null
    }

    /** @type {WebTransportReceiveStream} */
    let stream

    // 2. Let pullAlgorithm be an action that pulls bytes from stream.
    // 3. Let cancelAlgorithm be an action that cancels stream with reason,
    //    given reason.
    const source = {
      // The start algorithm is not a part of the create procedure; it is
      // only used to get a reference to the stream's controller, which the
      // streams specification accesses through internal slots.
      start (controller) {
        box.controller = controller
      },
      pull () {
        return pullBytes(stream, box)
      },
      cancel (reason) {
        return cancelReceiveStream(stream, box, reason)
      },
      type: 'bytes',
      autoAllocateChunkSize: defaultReadSize
    }

    // 4. Set up with byte reading support stream with pullAlgorithm set to
    //    pullAlgorithm and cancelAlgorithm set to cancelAlgorithm.
    //    (performed by the constructor)
    sideChannel = { source, box }
    try {
      stream = new WebTransportReceiveStream(kConstruct)
    } finally {
      sideChannel = null
    }

    // Whenever a WebTransport stream associated with a
    // WebTransportReceiveStream stream gets a sending aborted signal from
    // the server, run these steps:
    // @see https://w3c.github.io/webtransport/#webtransportreceivestream-sending-aborted
    internalStream.onReset((code) => {
      sendingAborted(stream, box, code)
    })

    // 5. Append stream to transport.[[ReceiveStreams]].
    transport.receiveStreams.add(stream)

    // 6. Return stream.
    return stream
  }
}

/**
 * To pull bytes from a WebTransportReceiveStream stream, run these steps.
 * @see https://w3c.github.io/webtransport/#pull-bytes
 * @param {WebTransportReceiveStream} stream
 * @param {object} state the stream's internal slots
 * @returns {Promise<undefined>}
 */
function pullBytes (stream, state) {
  // 1. Let transport be stream.[[Transport]].
  const transport = state.transport

  // 2. Let internalStream be stream.[[InternalStream]].
  const internalStream = state.internalStream

  // 3. Let promise be a new promise.
  const promise = Promise.withResolvers()

  // 4. Let buffer, offset, and maxBytes be null.
  // 5. If stream’s current BYOB request view for stream is not null:
  //    5.1. Set offset to stream’s current BYOB request view.[[ByteOffset]].
  //    5.2. Set maxBytes to stream’s current BYOB request view’s byte
  //         length.
  //    5.3. Set buffer to stream’s current BYOB request view’s underlying
  //         buffer.
  // 6. Otherwise:
  //    6.1. Set offset to 0.
  //    6.2. Set maxBytes to an implementation-defined size.
  //    6.3. Set buffer be a new ArrayBuffer with maxBytes size. If
  //         allocating the ArrayBuffer fails, return a promise rejected
  //         with a RangeError.
  // Note: because the underlying source sets autoAllocateChunkSize, a BYOB
  // request is also present when the consumer used a default reader, with
  // a view of the implementation-defined size from step 6.2; steps 5 and 6
  // therefore collapse into using the BYOB request's view.
  const byobRequest = state.controller.byobRequest
  const view = byobRequest.view

  // 7. Run the following steps in parallel:
  //    7.1. Write the bytes that area read from internalStream into buffer
  //         with offset offset, up to maxBytes bytes. Wait until either at
  //         least one byte is read or FIN is received. Let read be the
  //         number of read bytes, and let hasReceivedFIN be whether FIN
  //         was accompanied.
  internalStream.readInto(view).then(({ read, hasReceivedFIN }) => {
    //  7.3. Queue a network task with transport to run these steps:
    //       7.3.1. If read > 0:
    if (read > 0) {
      //     7.3.1.1. Set view to a new Uint8Array with buffer, offset and
      //              read.
      //     7.3.1.2. Enqueue view into stream.
      state.bytesRead += read
      byobRequest.respond(read)
    }

    //       7.3.2. If hasReceivedFIN is true:
    if (hasReceivedFIN) {
      //     7.3.2.1. Remove stream from transport.[[ReceiveStreams]].
      transport.receiveStreams.delete(stream)

      //     7.3.2.2. Close stream.
      state.controller.close()
      if (read === 0) {
        byobRequest.respond(0)
      }
    }

    //       7.3.3. Resolve promise with undefined.
    promise.resolve(undefined)
  }, () => {
    //  7.2. If the previous step failed, abort the remaining steps.
    // Note: We don’t reject promise here because we handle network errors
    // elsewhere, and those steps error stream, which rejects any read
    // requests awaiting this pull.
  })

  // 8. Return promise.
  return promise.promise
}

/**
 * To cancel a WebTransportReceiveStream stream with reason, run these
 * steps.
 * @see https://w3c.github.io/webtransport/#webtransportreceivestream-cancel
 * @param {WebTransportReceiveStream} stream
 * @param {object} state the stream's internal slots
 * @param {*} reason
 * @returns {Promise<undefined>}
 */
function cancelReceiveStream (stream, state, reason) {
  // 1. Let transport be stream.[[Transport]].
  const transport = state.transport

  // 2. Let internalStream be stream.[[InternalStream]].
  const internalStream = state.internalStream

  // 3. Let promise be a new promise.
  const promise = Promise.withResolvers()

  // 4. Let code be 0.
  let code = 0

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

  // 8. Remove stream from transport.[[SendStreams]].
  transport.sendStreams.delete(stream)

  // 9. Run the following steps in parallel:
  //    9.1. Abort receiving on internalStream with code.
  internalStream.stopSendingWithCode(code)

  //    9.2. Queue a network task with transport to run these steps:
  //         9.2.1. Remove stream from transport.[[ReceiveStreams]].
  transport.receiveStreams.delete(stream)

  //         9.2.2. Resolve promise with undefined.
  promise.resolve(undefined)

  // 10. Return promise.
  return promise.promise
}

/**
 * Whenever a WebTransport stream associated with a
 * WebTransportReceiveStream stream gets a sending aborted signal from the
 * server, run these steps:
 * @see https://w3c.github.io/webtransport/#webtransportreceivestream-sending-aborted
 * @param {WebTransportReceiveStream} stream
 * @param {object} state the stream's internal slots
 * @param {number} code
 */
function sendingAborted (stream, state, code) {
  // 1. Let transport be stream.[[Transport]].
  const transport = state.transport

  // 2. Let code be the application protocol error code attached to the
  //    sending aborted signal. (given)

  // 3. Queue a network task with transport to run these steps:
  //    3.1. If transport.[[State]] is "closed" or "failed", abort these
  //         steps.
  if (transport.state === sessionStates.closed || transport.state === sessionStates.failed) {
    return
  }

  //    3.2. Remove stream from transport.[[ReceiveStreams]].
  transport.receiveStreams.delete(stream)

  //    3.3. Let error be a newly created WebTransportError whose source is
  //         "stream" and streamErrorCode is code.
  const error = createUnvalidatedWebTransportError(
    'The server aborted sending on this stream',
    'stream',
    code
  )

  //    3.4. Error stream with error.
  state.controller.error(error)
}

const { createWebTransportReceiveStream } = WebTransportReceiveStream
delete WebTransportReceiveStream.createWebTransportReceiveStream

Object.defineProperties(WebTransportReceiveStream.prototype, {
  getStats: kEnumerableProperty,
  [Symbol.toStringTag]: {
    value: 'WebTransportReceiveStream',
    writable: false,
    enumerable: false,
    configurable: true
  }
})

webidl.is.WebTransportReceiveStream = webidl.util.MakeTypeAssertion(WebTransportReceiveStream)

module.exports = {
  WebTransportReceiveStream,
  createWebTransportReceiveStream,
  getReceiveStreamState
}
