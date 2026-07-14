'use strict'

const { webidl } = require('../webidl')
const { kConstruct } = require('../../core/symbols')
const { kEnumerableProperty } = require('../../core/util')

/**
 * @typedef {object} TransportContext The internal representation of the
 * WebTransport object that owns an interface object (its [[Transport]]
 * internal slot), shared between the classes of this implementation to
 * avoid circular requires.
 * @property {Set<import('./sendstream').WebTransportSendStream>} sendStreams the
 * WebTransport object's [[SendStreams]] internal slot
 * @property {Set<import('./receivestream').WebTransportReceiveStream>} receiveStreams the
 * WebTransport object's [[ReceiveStreams]] internal slot
 * @property {string} state the WebTransport object's [[State]] internal slot
 */

/**
 * A WebTransportSendGroup is an optional organizational object that tracks
 * transmission of data spread across many individual (typically strictly
 * ordered) WebTransportSendStreams.
 * @see https://w3c.github.io/webtransport/#sendGroup
 */
class WebTransportSendGroup {
  /**
   * The WebTransport object owning this WebTransportSendGroup.
   * @type {TransportContext}
   */
  #transport

  /**
   * "A WebTransportSendGroup is always created by the create procedure."
   * @see https://w3c.github.io/webtransport/#webtransportsendgroup-create
   */
  constructor (transport = undefined) {
    if (transport !== kConstruct) {
      throw new TypeError('Illegal constructor')
    }
    webidl.util.markAsUncloneable(this)
  }

  /**
   * Aggregates stats from all WebTransportSendStreams grouped under this
   * sendGroup, and reports the result asynchronously.
   * @see https://w3c.github.io/webtransport/#dom-webtransportsendgroup-getstats
   * @returns {Promise<import('../../../types/webtransport').WebTransportSendStreamStats>}
   */
  getStats () {
    webidl.brandCheck(this, WebTransportSendGroup)

    // 1. Let transport be this.[[Transport]].
    const transport = this.#transport

    // 2. Let p be a new promise.
    // 3. Let streams be all WebTransportSendStreams whose [[SendGroup]] is
    //    this.
    const streams = []
    for (const stream of transport.sendStreams) {
      if (stream.sendGroup === this) {
        streams.push(stream)
      }
    }

    // 4. Run the following steps in parallel:
    //    4.1. Let gatheredStats be the list of aggregated stats from all
    //         streams in streams needed to populate the dictionary members
    //         of WebTransportSendStreamStats accurately.
    //    4.2. Queue a network task with transport to run the following
    //         steps:
    //         4.2.1. Let stats be a new WebTransportSendStreamStats object.
    //         4.2.2. For each member member of stats that the user agent
    //                wishes to expose, set member to the the corresponding
    //                entry in gatheredStats.
    //         4.2.3. Resolve p with stats.
    // 5. Return p.
    return Promise.all(streams.map((stream) => stream.getStats())).then(
      (allStats) => {
        const stats = {
          bytesWritten: 0n,
          bytesSent: 0n,
          bytesAcknowledged: 0n
        }
        for (const streamStats of allStats) {
          stats.bytesWritten += BigInt(streamStats.bytesWritten)
          stats.bytesSent += BigInt(streamStats.bytesSent)
          stats.bytesAcknowledged += BigInt(streamStats.bytesAcknowledged)
        }
        return {
          bytesWritten: Number(stats.bytesWritten),
          bytesSent: Number(stats.bytesSent),
          bytesAcknowledged: Number(stats.bytesAcknowledged)
        }
      }
    )
  }

  /**
   * To create a WebTransportSendGroup, with a WebTransport transport, run
   * these steps:
   * @see https://w3c.github.io/webtransport/#webtransportsendgroup-create
   * @param {TransportContext} transport
   */
  static createWebTransportSendGroup (transport) {
    // 1. Let sendGroup be a new WebTransportSendGroup, with:
    //    [[Transport]]: transport
    const sendGroup = new WebTransportSendGroup(kConstruct)
    sendGroup.#transport = transport

    // 2. Return sendGroup.
    return sendGroup
  }

  /**
   * An internal helper to read the [[Transport]] internal slot of a
   * WebTransportSendGroup.
   * @param {WebTransportSendGroup} sendGroup
   * @returns {TransportContext}
   */
  static getSendGroupTransport (sendGroup) {
    return sendGroup.#transport
  }
}

const { createWebTransportSendGroup, getSendGroupTransport } = WebTransportSendGroup
delete WebTransportSendGroup.createWebTransportSendGroup
delete WebTransportSendGroup.getSendGroupTransport

Object.defineProperties(WebTransportSendGroup.prototype, {
  getStats: kEnumerableProperty,
  [Symbol.toStringTag]: {
    value: 'WebTransportSendGroup',
    writable: false,
    enumerable: false,
    configurable: true
  }
})

webidl.is.WebTransportSendGroup = webidl.util.MakeTypeAssertion(WebTransportSendGroup)

webidl.converters.WebTransportSendGroup = webidl.interfaceConverter(
  webidl.is.WebTransportSendGroup,
  'WebTransportSendGroup'
)

webidl.converters['WebTransportSendGroup?'] = webidl.nullableConverter(
  webidl.converters.WebTransportSendGroup
)

module.exports = {
  WebTransportSendGroup,
  createWebTransportSendGroup,
  getSendGroupTransport
}
