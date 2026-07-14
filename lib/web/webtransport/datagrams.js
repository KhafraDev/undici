'use strict'

const { webidl } = require('../webidl')
const { kConstruct } = require('../../core/symbols')
const { kEnumerableProperty } = require('../../core/util')
const { getSendGroupTransport } = require('./sendgroup')
const { sessionStates } = require('./constants')

/**
 * An internal accessor for the private state of a
 * WebTransportDatagramDuplexStream, assigned in the static initialization
 * block of the class.
 * @type {(stream: WebTransportDatagramDuplexStream) => object}
 */
let getDatagramsState

/**
 * An internal accessor for the private state of a
 * WebTransportDatagramsWritable, assigned in the static initialization
 * block of the class.
 * @type {(stream: WebTransportDatagramsWritable) => object}
 */
let getDatagramsWritableState

/**
 * The underlying sink and the shared box used to pass values between the
 * create procedure and the constructor, as the underlying sink must be
 * passed to super() before the instance exists.
 * @type {{ sink: object, box: object }|null}
 */
let sideChannel = null

/**
 * The implementation-defined values used for the
 * [[IncomingMaxBufferedDatagrams]] and [[OutgoingMaxBufferedDatagrams]]
 * internal slots.
 */
const defaultMaxBufferedDatagrams = 128

/**
 * The implementation-defined expiration duration used when
 * [[IncomingDatagramsExpirationDuration]] or
 * [[OutgoingDatagramsExpirationDuration]] is null: datagrams do not expire.
 */
const defaultExpirationDuration = Infinity

/**
 * The implementation-defined initial value of the
 * [[OutgoingMaxDatagramSize]] internal slot. It is updated from the
 * underlying session once the session is established.
 */
const defaultOutgoingMaxDatagramSize = 1024

/**
 * A WebTransportDatagramsWritable is a WritableStream providing outgoing
 * streaming features to send datagrams.
 * @see https://w3c.github.io/webtransport/#datagram-writable
 */
class WebTransportDatagramsWritable extends WritableStream {
  /**
   * The internal slots of this WebTransportDatagramsWritable.
   * @see https://w3c.github.io/webtransport/#datagram-writable-internal-slots
   */
  #state

  static {
    getDatagramsWritableState = (stream) => stream.#state
  }

  constructor (sentinel = undefined) {
    if (sentinel !== kConstruct) {
      throw new TypeError('Illegal constructor')
    }

    // 3. Set up stream with writeAlgorithm set to writeDatagramsAlgorithm.
    super(sideChannel.sink)

    this.#state = sideChannel.box
    webidl.util.markAsUncloneable(this)
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramswritable-sendgroup
   * @returns {import('./sendgroup').WebTransportSendGroup|null}
   */
  get sendGroup () {
    webidl.brandCheck(this, WebTransportDatagramsWritable)

    // The getter steps are:
    // 1. Return this’s [[SendGroup]].
    return this.#state.sendGroup
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramswritable-sendgroup
   * @param {import('./sendgroup').WebTransportSendGroup|null} value
   */
  set sendGroup (value) {
    webidl.brandCheck(this, WebTransportDatagramsWritable)

    value = webidl.converters['WebTransportSendGroup?'](value, 'WebTransportDatagramsWritable.sendGroup', 'value')

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
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramswritable-sendorder
   * @returns {number}
   */
  get sendOrder () {
    webidl.brandCheck(this, WebTransportDatagramsWritable)

    // The getter steps are:
    // 1. Return this’s [[SendOrder]].
    return this.#state.sendOrder
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramswritable-sendorder
   * @param {number} value
   */
  set sendOrder (value) {
    webidl.brandCheck(this, WebTransportDatagramsWritable)

    value = webidl.converters['long long'](value, 'WebTransportDatagramsWritable.sendOrder', 'value')

    // The setter steps, given value, are:
    // 1. Set this.[[SendOrder]] to value.
    this.#state.sendOrder = value
  }

  /**
   * To create a WebTransportDatagramsWritable, given a WebTransport
   * transport, a sendGroup, and a sendOrder, perform the following steps.
   * @see https://w3c.github.io/webtransport/#webtransportdatagramswritable-create
   * @param {import('./sendgroup').TransportContext} transport
   * @param {import('./sendgroup').WebTransportSendGroup|null} sendGroup
   * @param {number} sendOrder
   * @returns {WebTransportDatagramsWritable}
   */
  static createWebTransportDatagramsWritable (transport, sendGroup, sendOrder) {
    // 1. Let stream be a new WebTransportDatagramsWritable, with:
    //    [[OutgoingDatagramsQueue]]: an empty queue
    //    [[Transport]]: transport
    //    [[SendGroup]]: sendGroup
    //    [[SendOrder]]: sendOrder
    const box = {
      outgoingDatagramsQueue: [],
      transport,
      sendGroup,
      sendOrder,
      sending: false,
      controller: null
    }

    /** @type {WebTransportDatagramsWritable} */
    let stream

    // 2. Let writeDatagramsAlgorithm be an action that runs writeDatagrams
    //    with transport and stream.
    const sink = {
      // The start algorithm only captures a reference to the stream's
      // controller, which the cleanup procedure of the WebTransport object
      // needs in order to error the stream.
      start (controller) {
        box.controller = controller
      },
      write (data) {
        return writeDatagrams(transport, stream, data)
      }
    }

    // 3. Set up stream with writeAlgorithm set to writeDatagramsAlgorithm.
    //    (performed by the constructor)
    sideChannel = { sink, box }
    try {
      stream = new WebTransportDatagramsWritable(kConstruct)
    } finally {
      sideChannel = null
    }

    // 4. Return stream.
    return stream
  }
}

/**
 * The writeDatagrams algorithm is given a transport and writable as
 * parameters and data as input. It is defined by running the following
 * steps:
 * @see https://w3c.github.io/webtransport/#writedatagrams
 * @param {import('./sendgroup').TransportContext} transport
 * @param {WebTransportDatagramsWritable} writable
 * @param {*} data
 * @returns {Promise<undefined>}
 */
function writeDatagrams (transport, writable, data) {
  const writableState = getDatagramsWritableState(writable)

  // 1. Let timestamp be a timestamp representing now.
  const timestamp = Date.now()

  // 2. If data is not a BufferSource object, then return a promise
  //    rejected with a TypeError.
  if (!webidl.is.BufferSource(data)) {
    return Promise.reject(new TypeError('data must be a BufferSource'))
  }

  // 3. Let datagrams be transport.[[Datagrams]].
  const datagrams = getDatagramsState(transport.datagrams)

  // 4. If datagrams.[[OutgoingMaxDatagramSize]] is less than data’s
  //    [[ByteLength]], return a promise resolved with undefined.
  if (datagrams.outgoingMaxDatagramSize < data.byteLength) {
    return Promise.resolve(undefined)
  }

  // 5. Let promise be a new promise.
  const promise = Promise.withResolvers()

  // 6. Let bytes be a copy of bytes which data represents.
  const bytes = webidl.util.getCopyOfBytesHeldByBufferSource(data)

  // 7. Let chunk be a tuple of bytes, timestamp and promise.
  const chunk = { bytes, timestamp, promise }

  // 8. Enqueue chunk to writable.[[OutgoingDatagramsQueue]].
  writableState.outgoingDatagramsQueue.push(chunk)

  // 9. If the length of writable.[[OutgoingDatagramsQueue]] is less than
  //    datagrams.[[OutgoingMaxBufferedDatagrams]], then resolve promise
  //    with undefined.
  if (writableState.outgoingDatagramsQueue.length < datagrams.outgoingMaxBufferedDatagrams) {
    promise.resolve(undefined)
  }

  // "The user agent MUST, for any WebTransport object whose [[State]] is
  //  "connecting" or "connected", run sendDatagrams on a subset
  //  (determined by send-order rules) of its associated
  //  WebTransportDatagramsWritable objects, and SHOULD do so as soon as
  //  reasonably possible whenever the algorithm can make progress."
  sendDatagrams(transport, writable)

  // 10. Return promise.
  return promise.promise
}

/**
 * To sendDatagrams, given a WebTransport object transport and a
 * WebTransportDatagramsWritable object writable, queue a network task with
 * transport to run the following steps:
 * @see https://w3c.github.io/webtransport/#senddatagrams
 * @param {import('./sendgroup').TransportContext} transport
 * @param {WebTransportDatagramsWritable} writable
 */
async function sendDatagrams (transport, writable) {
  const writableState = getDatagramsWritableState(writable)

  // Only one instance of the algorithm runs at a time per writable; a
  // running instance already drains the whole queue.
  if (writableState.sending) {
    return
  }
  writableState.sending = true

  try {
    // 1. Let queue be a copy of writable.[[OutgoingDatagramsQueue]].
    // Note: The above copy, as well as the queueing of a network task to
    // run these steps, can be optimized. (the queue is used directly)
    const queue = writableState.outgoingDatagramsQueue

    // 2. Let maxSize be transport.[[Datagrams]].[[OutgoingMaxDatagramSize]].
    const datagrams = getDatagramsState(transport.datagrams)
    const maxSize = datagrams.outgoingMaxDatagramSize

    // 3. Let duration be
    //    transport.[[Datagrams]].[[OutgoingDatagramsExpirationDuration]].
    let duration = datagrams.outgoingDatagramsExpirationDuration

    // 4. If duration is null, then set duration to an
    //    implementation-defined value.
    if (duration === null) {
      duration = defaultExpirationDuration
    }

    // 5. Run the following steps in parallel:
    //    5.1. While queue is not empty:
    while (queue.length !== 0) {
      // 5.1.1. Let bytes, timestamp and promise be queue’s first element.
      const { timestamp, promise } = queue[0]

      // 5.1.2. If more than duration milliseconds have passed since
      //        timestamp, then:
      if (Date.now() - timestamp > duration) {
        // 5.1.2.1. Remove the first element from queue.
        queue.shift()
        datagrams.expiredOutgoing += 1

        // 5.1.2.2. Queue a network task with transport to resolve promise
        //          with undefined.
        promise.resolve(undefined)
      } else {
        // 5.1.3. Otherwise, break this loop.
        break
      }
    }

    // 5.2. If transport.[[State]] is not "connected", then return.
    if (transport.state !== sessionStates.connected) {
      return
    }

    // 5.3. While queue is not empty:
    while (queue.length !== 0) {
      // 5.3.1. Let bytes, timestamp and promise be queue’s first element.
      const { bytes, promise } = queue[0]

      // 5.3.2. If bytes’s length ≤ maxSize:
      if (bytes.length <= maxSize) {
        // 5.3.2.1. If it is not possible to send bytes to the network
        //          immediately, then break this loop.
        // Note: node:quic queues the datagram internally; whether it can
        // be sent immediately is not observable.

        // 5.3.2.2. Send a datagram, with transport.[[Session]] and bytes.
        await transport.session.sendDatagram(bytes)
      }

      // 5.3.3. Remove the first element from queue.
      queue.shift()

      // 5.3.4. Queue a network task with transport to resolve promise with
      //        undefined.
      promise.resolve(undefined)
    }
  } finally {
    writableState.sending = false
  }
}

/**
 * A WebTransportDatagramDuplexStream is a generic duplex stream.
 * @see https://w3c.github.io/webtransport/#datagram-duplex-stream
 */
class WebTransportDatagramDuplexStream {
  /**
   * The internal slots of this WebTransportDatagramDuplexStream.
   * @see https://w3c.github.io/webtransport/#datagram-duplex-stream-internal-slots
   */
  #state

  static {
    getDatagramsState = (stream) => stream.#state
  }

  constructor (sentinel = undefined) {
    if (sentinel !== kConstruct) {
      throw new TypeError('Illegal constructor')
    }
    webidl.util.markAsUncloneable(this)
  }

  /**
   * Creates a WebTransportDatagramsWritable.
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-createwritable
   * @param {import('../../../types/webtransport').WebTransportSendOptions} [options={}]
   * @returns {WebTransportDatagramsWritable}
   */
  createWritable (options = {}) {
    webidl.brandCheck(this, WebTransportDatagramDuplexStream)

    options = webidl.converters.WebTransportSendOptions(options, 'WebTransportDatagramDuplexStream.createWritable', 'options')

    // 1. Let transport be WebTransport object associated with this.
    const transport = this.#state.transport

    // 2. Let sendGroup be options’s sendGroup.
    const sendGroup = options.sendGroup

    // 3. If sendGroup is not null, and sendGroup.[[Transport]] is not
    //    this.[[Transport]], throw a TypeError.
    if (sendGroup !== null && getSendGroupTransport(sendGroup) !== transport) {
      throw new TypeError('The given WebTransportSendGroup belongs to a different WebTransport')
    }

    // 4. If transport.[[State]] is "closed" or "failed", throw an
    //    InvalidStateError.
    if (transport.state === sessionStates.closed || transport.state === sessionStates.failed) {
      throw new DOMException('The WebTransport session is closed', 'InvalidStateError')
    }

    // 5. Let sendOrder be options’s sendOrder.
    const sendOrder = options.sendOrder

    // 6. Return the result of creating a WebTransportDatagramsWritable
    //    with transport, sendGroup and sendOrder.
    const writable = createWebTransportDatagramsWritable(transport, sendGroup, sendOrder)

    // The [[Writables]] internal slot holds the WebTransportDatagramsWritable
    // streams associated with this duplex stream, on which the user agent
    // runs sendDatagrams.
    this.#state.writables.add(writable)

    return writable
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-readable
   * @returns {ReadableStream}
   */
  get readable () {
    webidl.brandCheck(this, WebTransportDatagramDuplexStream)

    // The getter steps are:
    // 1. Return this.[[Readable]].
    return this.#state.readable
  }

  /**
   * The maximum size data that may be passed to a
   * WebTransportDatagramsWritable.
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-maxdatagramsize
   * @returns {number}
   */
  get maxDatagramSize () {
    webidl.brandCheck(this, WebTransportDatagramDuplexStream)

    // The getter steps are to return this.[[OutgoingMaxDatagramSize]].
    return this.#state.outgoingMaxDatagramSize
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-incomingmaxage
   * @returns {number|null}
   */
  get incomingMaxAge () {
    webidl.brandCheck(this, WebTransportDatagramDuplexStream)

    // The getter steps are:
    // 1. Return this.[[IncomingDatagramsExpirationDuration]].
    return this.#state.incomingDatagramsExpirationDuration
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-incomingmaxage
   * @param {number|null} value
   */
  set incomingMaxAge (value) {
    webidl.brandCheck(this, WebTransportDatagramDuplexStream)

    value = webidl.converters['unrestricted double?'](value, 'WebTransportDatagramDuplexStream.incomingMaxAge', 'value')

    // The setter steps, given value, are:
    // 1. If value is negative or NaN, throw a RangeError.
    if (value < 0 || Number.isNaN(value)) {
      throw new RangeError('incomingMaxAge must not be negative or NaN')
    }

    // 2. If value is 0, set value to null.
    if (value === 0) {
      value = null
    }

    // 3. Set this.[[IncomingDatagramsExpirationDuration]] to value.
    this.#state.incomingDatagramsExpirationDuration = value
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-outgoingmaxage
   * @returns {number|null}
   */
  get outgoingMaxAge () {
    webidl.brandCheck(this, WebTransportDatagramDuplexStream)

    // The getter steps are:
    // 1. Return this’s [[OutgoingDatagramsExpirationDuration]].
    return this.#state.outgoingDatagramsExpirationDuration
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-outgoingmaxage
   * @param {number|null} value
   */
  set outgoingMaxAge (value) {
    webidl.brandCheck(this, WebTransportDatagramDuplexStream)

    value = webidl.converters['unrestricted double?'](value, 'WebTransportDatagramDuplexStream.outgoingMaxAge', 'value')

    // The setter steps, given value, are:
    // 1. If value is negative or NaN, throw a RangeError.
    if (value < 0 || Number.isNaN(value)) {
      throw new RangeError('outgoingMaxAge must not be negative or NaN')
    }

    // 2. If value is 0, set value to null.
    if (value === 0) {
      value = null
    }

    // 3. Set this.[[OutgoingDatagramsExpirationDuration]] to value.
    this.#state.outgoingDatagramsExpirationDuration = value
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-incomingmaxbuffereddatagrams
   * @returns {number}
   */
  get incomingMaxBufferedDatagrams () {
    webidl.brandCheck(this, WebTransportDatagramDuplexStream)

    // The getter steps are:
    // 1. Return this.[[IncomingMaxBufferedDatagrams]].
    return this.#state.incomingMaxBufferedDatagrams
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-incomingmaxbuffereddatagrams
   * @param {number} value
   */
  set incomingMaxBufferedDatagrams (value) {
    webidl.brandCheck(this, WebTransportDatagramDuplexStream)

    value = webidl.converters['unsigned long'](value, 'WebTransportDatagramDuplexStream.incomingMaxBufferedDatagrams', 'value')

    // The setter steps, given value, are:
    // 1. If value is < 1, set value to 1.
    if (value < 1) {
      value = 1
    }

    // 2. Set this.[[IncomingMaxBufferedDatagrams]] to value.
    this.#state.incomingMaxBufferedDatagrams = value
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-outgoingmaxbuffereddatagrams
   * @returns {number}
   */
  get outgoingMaxBufferedDatagrams () {
    webidl.brandCheck(this, WebTransportDatagramDuplexStream)

    // The getter steps are:
    // 1. Return this.[[OutgoingMaxBufferedDatagrams]].
    return this.#state.outgoingMaxBufferedDatagrams
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-outgoingmaxbuffereddatagrams
   * @param {number} value
   */
  set outgoingMaxBufferedDatagrams (value) {
    webidl.brandCheck(this, WebTransportDatagramDuplexStream)

    value = webidl.converters['unsigned long'](value, 'WebTransportDatagramDuplexStream.outgoingMaxBufferedDatagrams', 'value')

    // The setter steps, given value, are:
    // 1. If value is < 1, set value to 1.
    if (value < 1) {
      value = 1
    }

    // 2. Set this.[[OutgoingMaxBufferedDatagrams]] to value.
    this.#state.outgoingMaxBufferedDatagrams = value
  }

  /**
   * To create a WebTransportDatagramDuplexStream given a WebTransport
   * transport, a readable and readableType, perform the following steps.
   * @see https://w3c.github.io/webtransport/#webtransportdatagramduplexstream-create
   * @param {import('./sendgroup').TransportContext} transport
   * @param {ReadableStream} readable
   * @param {string|undefined} readableType
   * @returns {WebTransportDatagramDuplexStream}
   */
  static createWebTransportDatagramDuplexStream (transport, readable, readableType) {
    // 1. Let stream be a new WebTransportDatagramDuplexStream, with:
    //    [[Transport]]: transport
    //    [[Readable]]: readable
    //    [[ReadableType]]: readableType
    //    [[Writables]]: an empty ordered set.
    //    [[IncomingDatagramsQueue]]: an empty queue
    //    [[IncomingDatagramsPullPromise]]: null
    //    [[IncomingMaxBufferedDatagrams]]: an implementation-defined value
    //    [[IncomingDatagramsExpirationDuration]]: null
    //    [[OutgoingMaxBufferedDatagrams]]: an implementation-defined value
    //    [[OutgoingDatagramsExpirationDuration]]: null
    //    [[OutgoingMaxDatagramSize]]: an implementation-defined integer.
    const stream = new WebTransportDatagramDuplexStream(kConstruct)
    stream.#state = {
      transport,
      readable,
      readableType,
      writables: new Set(),
      incomingDatagramsQueue: [],
      incomingDatagramsPullPromise: null,
      incomingMaxBufferedDatagrams: defaultMaxBufferedDatagrams,
      incomingDatagramsExpirationDuration: null,
      outgoingMaxBufferedDatagrams: defaultMaxBufferedDatagrams,
      outgoingDatagramsExpirationDuration: null,
      outgoingMaxDatagramSize: defaultOutgoingMaxDatagramSize,
      // The controller of [[Readable]], captured by the caller when
      // setting up readable.
      readableController: null,
      // Counters for the WebTransportDatagramStats dictionary.
      droppedIncoming: 0,
      expiredIncoming: 0,
      expiredOutgoing: 0
    }

    // 2. Return stream.
    return stream
  }
}

/**
 * To pullDatagrams, given a WebTransport object transport, run these
 * steps:
 * @see https://w3c.github.io/webtransport/#pulldatagrams
 * @param {import('./sendgroup').TransportContext} transport
 * @returns {Promise<undefined>}
 */
function pullDatagrams (transport) {
  // 1. Let datagrams be transport.[[Datagrams]].
  const datagrams = getDatagramsState(transport.datagrams)

  // 2. Assert: datagrams.[[IncomingDatagramsPullPromise]] is null.
  if (datagrams.incomingDatagramsPullPromise !== null) {
    throw new TypeError('Assertion failed: [[IncomingDatagramsPullPromise]] is not null')
  }

  // 3. Let queue be datagrams.[[IncomingDatagramsQueue]].
  const queue = datagrams.incomingDatagramsQueue

  // 4. If queue is empty, then:
  if (queue.length === 0) {
    // 4.1. Set datagrams.[[IncomingDatagramsPullPromise]] to a new promise.
    datagrams.incomingDatagramsPullPromise = Promise.withResolvers()

    // 4.2. Return datagrams.[[IncomingDatagramsPullPromise]].
    return datagrams.incomingDatagramsPullPromise.promise
  }

  // 5. Let datagram and timestamp be the result of dequeuing queue.
  const { datagram } = queue.shift()

  // 6. If datagrams.[[ReadableType]] is "bytes", then:
  if (datagrams.readableType === 'bytes') {
    // 6.1. If datagrams.[[Readable]]’s current BYOB request view is not
    //      null, then:
    const byobRequest = datagrams.readableController.byobRequest
    if (byobRequest !== null && byobRequest.view !== null) {
      // 6.1.1. Let view be datagrams.[[Readable]]’s current BYOB request
      //        view.
      const view = byobRequest.view

      // 6.1.2. If view’s byte length is less than the size of datagram,
      //        return a promise rejected with a RangeError.
      if (view.byteLength < datagram.length) {
        return Promise.reject(new RangeError('The BYOB request view is smaller than the datagram'))
      }

      // 6.1.3. Let elementSize be the element size specified in the typed
      //        array constructors table for view.[[TypedArrayName]]. If
      //        view does not have a [[TypedArrayName]] internal slot (i.e.
      //        it is a DataView), let elementSize be 0.
      const elementSize = ArrayBuffer.isView(view) && !(view instanceof DataView)
        ? view.constructor.BYTES_PER_ELEMENT
        : 0

      // 6.1.4. If elementSize is not 1, return a promise rejected with a
      //        TypeError.
      if (elementSize !== 1) {
        return Promise.reject(new TypeError('The BYOB request view must have an element size of 1'))
      }

      // 6.2. Pull from bytes datagram into datagrams.[[Readable]].
      view.set(datagram)
      byobRequest.respond(datagram.length)
      return Promise.resolve(undefined)
    }

    // 6.2. Pull from bytes datagram into datagrams.[[Readable]].
    datagrams.readableController.enqueue(datagram)
  } else {
    // 7. Otherwise:
    //    7.1. Let chunk be a new Uint8Array object representing datagram.
    const chunk = datagram

    //    7.2. Enqueue chunk to transport.[[Datagrams]].[[Readable]].
    datagrams.readableController.enqueue(chunk)
  }

  // 8. Return a promise resolved with undefined.
  return Promise.resolve(undefined)
}

/**
 * To receiveDatagrams, given a WebTransport object transport, run these
 * steps:
 * @see https://w3c.github.io/webtransport/#receivedatagrams
 * @param {import('./sendgroup').TransportContext} transport
 */
function receiveDatagrams (transport) {
  const datagrams = getDatagramsState(transport.datagrams)

  // 1. Let timestamp be a timestamp representing now.
  let timestamp = Date.now()

  // 2. Let queue be datagrams.[[IncomingDatagramsQueue]].
  const queue = datagrams.incomingDatagramsQueue

  // 3. Let duration be datagrams.[[IncomingDatagramsExpirationDuration]].
  let duration = datagrams.incomingDatagramsExpirationDuration

  // 4. If duration is null, then set duration to an implementation-defined
  //    value.
  if (duration === null) {
    duration = defaultExpirationDuration
  }

  // 5. Let session be transport.[[Session]].
  const session = transport.session

  // 6. While there are available incoming datagrams on session:
  let datagram
  while ((datagram = session.takeDatagram()) !== null) {
    // 6.1. Let datagram be the result of receiving a datagram with
    //      session.
    // 6.2. Let timestamp be a timestamp representing now.
    timestamp = Date.now()

    // 6.3. Let chunk be a pair of datagram and timestamp.
    const chunk = { datagram, timestamp }

    // 6.4. Enqueue chunk to queue.
    queue.push(chunk)
  }

  // 7. Let toBeRemoved be the length of queue minus
  //    datagrams.[[IncomingMaxBufferedDatagrams]].
  const toBeRemoved = queue.length - datagrams.incomingMaxBufferedDatagrams

  // 8. If toBeRemoved is positive, repeat dequeuing queue toBeRemoved
  //    (rounded down) times.
  if (toBeRemoved > 0) {
    queue.splice(0, Math.floor(toBeRemoved))
    datagrams.droppedIncoming += Math.floor(toBeRemoved)
  }

  // 9. While queue is not empty:
  while (queue.length !== 0) {
    // 9.1. Let bytes and timestamp be queue’s first element.
    const head = queue[0]

    // 9.2. If more than duration milliseconds have passed since timestamp,
    //      then dequeue queue.
    if (Date.now() - head.timestamp > duration) {
      queue.shift()
      datagrams.expiredIncoming += 1
    } else {
      // 9.3. Otherwise, break this loop.
      break
    }
  }

  // 10. If queue is not empty and
  //     datagrams.[[IncomingDatagramsPullPromise]] is non-null, then:
  if (queue.length !== 0 && datagrams.incomingDatagramsPullPromise !== null) {
    // 10.1. Let bytes and timestamp be the result of dequeuing queue.
    const { datagram: bytes } = queue.shift()

    // 10.2. Let promise be datagrams.[[IncomingDatagramsPullPromise]].
    const promise = datagrams.incomingDatagramsPullPromise

    // 10.3. Set datagrams.[[IncomingDatagramsPullPromise]] to null.
    datagrams.incomingDatagramsPullPromise = null

    // 10.4. Queue a network task with transport to run the following
    //       steps:
    //       10.4.1. Let chunk be a new Uint8Array object representing
    //               bytes.
    const chunk = bytes

    //       10.4.2. Enqueue chunk to datagrams.[[Readable]].
    datagrams.readableController.enqueue(chunk)

    //       10.4.3. Resolve promise with undefined.
    promise.resolve(undefined)
  }
}

const { createWebTransportDatagramsWritable } = WebTransportDatagramsWritable
delete WebTransportDatagramsWritable.createWebTransportDatagramsWritable

const { createWebTransportDatagramDuplexStream } = WebTransportDatagramDuplexStream
delete WebTransportDatagramDuplexStream.createWebTransportDatagramDuplexStream

Object.defineProperties(WebTransportDatagramsWritable.prototype, {
  sendGroup: kEnumerableProperty,
  sendOrder: kEnumerableProperty,
  [Symbol.toStringTag]: {
    value: 'WebTransportDatagramsWritable',
    writable: false,
    enumerable: false,
    configurable: true
  }
})

Object.defineProperties(WebTransportDatagramDuplexStream.prototype, {
  createWritable: kEnumerableProperty,
  readable: kEnumerableProperty,
  maxDatagramSize: kEnumerableProperty,
  incomingMaxAge: kEnumerableProperty,
  outgoingMaxAge: kEnumerableProperty,
  incomingMaxBufferedDatagrams: kEnumerableProperty,
  outgoingMaxBufferedDatagrams: kEnumerableProperty,
  [Symbol.toStringTag]: {
    value: 'WebTransportDatagramDuplexStream',
    writable: false,
    enumerable: false,
    configurable: true
  }
})

webidl.is.WebTransportDatagramsWritable = webidl.util.MakeTypeAssertion(WebTransportDatagramsWritable)
webidl.is.WebTransportDatagramDuplexStream = webidl.util.MakeTypeAssertion(WebTransportDatagramDuplexStream)

// https://w3c.github.io/webtransport/#dictdef-webtransportsendoptions
webidl.converters.WebTransportSendOptions = webidl.dictionaryConverter([
  {
    key: 'sendGroup',
    converter: webidl.converters['WebTransportSendGroup?'],
    defaultValue: () => null
  },
  {
    key: 'sendOrder',
    converter: webidl.converters['long long'],
    defaultValue: () => 0
  }
])

/**
 * unrestricted double, nullable
 * @see https://webidl.spec.whatwg.org/#es-unrestricted-double
 */
webidl.converters['unrestricted double?'] = webidl.nullableConverter((V) => {
  // 1. Let x be ? ToNumber(V).
  // 2. Return the IDL unrestricted double value that has the same numeric
  //    value as x.
  return Number(V)
})

module.exports = {
  WebTransportDatagramsWritable,
  WebTransportDatagramDuplexStream,
  createWebTransportDatagramsWritable,
  createWebTransportDatagramDuplexStream,
  getDatagramsState,
  getDatagramsWritableState,
  writeDatagrams,
  sendDatagrams,
  pullDatagrams,
  receiveDatagrams
}
