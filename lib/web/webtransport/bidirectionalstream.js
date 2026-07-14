'use strict'

const { webidl } = require('../webidl')
const { kConstruct } = require('../../core/symbols')
const { kEnumerableProperty } = require('../../core/util')
const { createWebTransportReceiveStream } = require('./receivestream')
const { createWebTransportSendStream } = require('./sendstream')

/**
 * @see https://w3c.github.io/webtransport/#bidirectional-stream
 */
class WebTransportBidirectionalStream {
  /** @type {import('./receivestream').WebTransportReceiveStream} */
  #readable
  /** @type {import('./sendstream').WebTransportSendStream} */
  #writable
  /**
   * The WebTransport object owning this WebTransportBidirectionalStream.
   * @type {import('./sendgroup').TransportContext}
   */
  #transport

  constructor (sentinel = undefined) {
    if (sentinel !== kConstruct) {
      throw new TypeError('Illegal constructor')
    }
    webidl.util.markAsUncloneable(this)
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportbidirectionalstream-readable
   * @returns {import('./receivestream').WebTransportReceiveStream}
   */
  get readable () {
    webidl.brandCheck(this, WebTransportBidirectionalStream)

    // The getter steps are to return this’s [[Readable]].
    return this.#readable
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransportbidirectionalstream-writable
   * @returns {import('./sendstream').WebTransportSendStream}
   */
  get writable () {
    webidl.brandCheck(this, WebTransportBidirectionalStream)

    // The getter steps are to return this’s [[Writable]].
    return this.#writable
  }

  /**
   * To create a WebTransportBidirectionalStream with a bidirectional
   * WebTransport stream internalStream, a WebTransport object transport,
   * and a sendOrder, run these steps.
   * @see https://w3c.github.io/webtransport/#webtransportbidirectionalstream-create
   * @param {object} internalStream a TransportStream from ./transport/session
   * @param {import('./sendgroup').TransportContext} transport
   * @param {import('./sendgroup').WebTransportSendGroup|null} sendGroup
   * @param {number} sendOrder
   * @returns {WebTransportBidirectionalStream}
   */
  static createWebTransportBidirectionalStream (internalStream, transport, sendGroup, sendOrder) {
    // 1. Let readable be the result of creating a WebTransportReceiveStream
    //    with internalStream and transport.
    const readable = createWebTransportReceiveStream(internalStream, transport)

    // 2. Let writable be the result of creating a WebTransportSendStream
    //    with internalStream, transport, and sendOrder.
    const writable = createWebTransportSendStream(internalStream, transport, sendGroup, sendOrder)

    // 3. Let stream be a new WebTransportBidirectionalStream, with:
    //    [[Readable]]: readable
    //    [[Writable]]: writable
    //    [[Transport]]: transport
    const stream = new WebTransportBidirectionalStream(kConstruct)
    stream.#readable = readable
    stream.#writable = writable
    stream.#transport = transport

    // 4. Return stream.
    return stream
  }
}

const { createWebTransportBidirectionalStream } = WebTransportBidirectionalStream
delete WebTransportBidirectionalStream.createWebTransportBidirectionalStream

Object.defineProperties(WebTransportBidirectionalStream.prototype, {
  readable: kEnumerableProperty,
  writable: kEnumerableProperty,
  [Symbol.toStringTag]: {
    value: 'WebTransportBidirectionalStream',
    writable: false,
    enumerable: false,
    configurable: true
  }
})

webidl.is.WebTransportBidirectionalStream = webidl.util.MakeTypeAssertion(WebTransportBidirectionalStream)

module.exports = {
  WebTransportBidirectionalStream,
  createWebTransportBidirectionalStream
}
