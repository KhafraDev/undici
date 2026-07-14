'use strict'

const { webidl } = require('../webidl')
const { kConstruct } = require('../../core/symbols')
const { kEnumerableProperty, createInheritableDOMException } = require('../../core/util')

/**
 * WebTransportError is a subclass of DOMException that represents
 * - An error coming from the server or the network, or
 * - A reason for a client-initiated abort operation.
 * @see https://w3c.github.io/webtransport/#web-transport-error-interface
 */
class WebTransportError extends createInheritableDOMException() {
  /** @type {'stream'|'session'} */
  #source
  /** @type {number|null} */
  #streamErrorCode

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransporterror-webtransporterror
   * @param {string} [message='']
   * @param {import('../../../types/webtransport').WebTransportErrorOptions} [options={}]
   */
  constructor (message = '', options = {}) {
    if (options !== kConstruct) {
      message = webidl.converters.DOMString(message, 'WebTransportError', 'message')
    }

    // 1. Set this’s name to "WebTransportError".
    // 2. Set this’s message to message.
    super(message, 'WebTransportError')

    // Note: This name does not have a mapping to a legacy code, so this’s
    // code is 0.

    if (options === kConstruct) {
      return
    }

    options = webidl.converters.WebTransportErrorOptions(options, 'WebTransportError', 'options')

    // 3. Set this’s internal slots as follows:
    //    [[Source]]: options.source
    this.#source = options.source

    //    [[StreamErrorCode]]: options.streamErrorCode
    this.#streamErrorCode = options.streamErrorCode
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransporterror-source
   * @returns {'stream'|'session'}
   */
  get source () {
    // The getter steps are to return this’s [[Source]].
    return this.#source
  }

  /**
   * @see https://w3c.github.io/webtransport/#dom-webtransporterror-streamerrorcode
   * @returns {number|null}
   */
  get streamErrorCode () {
    // The getter steps are to return this’s [[StreamErrorCode]].
    return this.#streamErrorCode
  }

  /**
   * An internal factory that skips converting and validating the arguments.
   * @param {string} message
   * @param {'stream'|'session'} source
   * @param {number|null} streamErrorCode
   */
  static createUnvalidatedWebTransportError (message, source, streamErrorCode) {
    const error = new WebTransportError(message, kConstruct)
    error.#source = source
    error.#streamErrorCode = streamErrorCode
    return error
  }
}

const { createUnvalidatedWebTransportError } = WebTransportError
delete WebTransportError.createUnvalidatedWebTransportError

Object.defineProperties(WebTransportError.prototype, {
  source: kEnumerableProperty,
  streamErrorCode: kEnumerableProperty,
  [Symbol.toStringTag]: {
    value: 'WebTransportError',
    writable: false,
    enumerable: false,
    configurable: true
  }
})

/**
 * @see https://w3c.github.io/webtransport/#dom-webtransporterroroptions-streamerrorcode
 * [Clamp] unsigned long? streamErrorCode = null
 */
const clampedNullableUnsignedLongConverter = webidl.nullableConverter(
  (V, prefix, argument) => webidl.util.ConvertToInt(V, 32, 'unsigned', webidl.attributes.Clamp, prefix, argument)
)

// https://w3c.github.io/webtransport/#web-transport-error-interface
webidl.converters.WebTransportErrorOptions = webidl.dictionaryConverter([
  {
    key: 'source',
    converter: webidl.converters.DOMString,
    defaultValue: () => 'stream',
    // enum WebTransportErrorSource { "stream", "session" }
    allowedValues: ['stream', 'session']
  },
  {
    key: 'streamErrorCode',
    converter: clampedNullableUnsignedLongConverter,
    defaultValue: () => null
  }
])

webidl.is.WebTransportError = webidl.util.MakeTypeAssertion(WebTransportError)

module.exports = { WebTransportError, createUnvalidatedWebTransportError }
