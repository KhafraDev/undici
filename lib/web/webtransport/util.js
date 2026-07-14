'use strict'

const { createHash, timingSafeEqual } = require('node:crypto')
const {
  wtApplicationErrorFirst,
  wtApplicationErrorLast,
  maxCertificateValidityPeriodMs
} = require('./constants')

/**
 * "def webtransport_code_to_http_code(n):
 *      return first + n + floor(n / 0x1e)"
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3-13#section-4.3
 * @param {number} n a WebTransport application error code (unsigned 32-bit)
 * @returns {bigint} the corresponding HTTP/3 error code
 */
function webtransportCodeToHttpCode (n) {
  const code = BigInt(n)
  return wtApplicationErrorFirst + code + code / 0x1en
}

/**
 * "def http_code_to_webtransport_code(h):
 *      assert(first <= h <= last)
 *      assert((h - 0x21) % 0x1f != 0)
 *      shifted = h - first
 *      return shifted - floor(shifted / 0x1f)"
 *
 * "Note that there are codepoints inside that range of form
 *  "0x1f * N + 0x21" that are reserved by Section 8.1 of [HTTP3]; those
 *  have to be skipped when mapping the error codes"
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3-13#section-4.3
 * @param {bigint} h an HTTP/3 error code
 * @returns {number|null} the corresponding WebTransport application error
 * code, or null if h is not inside the WT_APPLICATION_ERROR range or is a
 * reserved codepoint.
 */
function httpCodeToWebtransportCode (h) {
  if (h < wtApplicationErrorFirst || h > wtApplicationErrorLast) {
    return null
  }
  if ((h - 0x21n) % 0x1fn === 0n) {
    return null
  }
  const shifted = h - wtApplicationErrorFirst
  return Number(shifted - shifted / 0x1fn)
}

/**
 * To compute a certificate hash, given a certificate, perform the
 * following steps:
 * @see https://w3c.github.io/webtransport/#compute-a-certificate-hash
 * @param {import('node:crypto').X509Certificate} certificate
 * @returns {Buffer}
 */
function computeCertificateHash (certificate) {
  // 1. Let cert be certificate, represented as a DER encoding of
  //    Certificate message defined in [RFC5280].
  const cert = certificate.raw

  // 2. Compute the SHA-256 hash of cert and return the computed value.
  return createHash('sha256').update(cert).digest()
}

/**
 * To verify a certificate hash, given a certificate chain and an array of
 * hashes hashes, perform the following steps:
 * @see https://w3c.github.io/webtransport/#verify-a-certificate-hash
 * @param {import('node:crypto').X509Certificate} leafCertificate the first
 * certificate in certificate chain (the leaf certificate)
 * @param {{ algorithm: string, value: Uint8Array }[]} hashes
 * @returns {boolean}
 */
function verifyCertificateHash (leafCertificate, hashes) {
  // 1. Let certificate be the first certificate in certificate chain (the
  //    leaf certificate).
  const certificate = leafCertificate

  // 2. Let referenceHash be the result of computing a certificate hash
  //    with certificate.
  const referenceHash = computeCertificateHash(certificate)

  // 3. For every hash hash in hashes:
  for (const hash of hashes) {
    // 3.1. If hash.value is not null and hash.algorithm is an ASCII
    //      case-insensitive match with "sha-256":
    if (hash.value != null && hash.algorithm.toLowerCase() === 'sha-256') {
      // 3.1.1. Let hashValue be the byte sequence which hash.value
      //        represents.
      const hashValue = hash.value

      // 3.1.2. If hashValue is equal to referenceHash, return true.
      if (
        hashValue.byteLength === referenceHash.byteLength &&
        timingSafeEqual(hashValue, referenceHash)
      ) {
        return true
      }
    }
  }

  // 4. Return false.
  return false
}

/**
 * "The custom certificate requirements are as follows: the certificate
 *  MUST be an X.509v3 certificate as defined in [RFC5280], the key used in
 *  the Subject Public Key field MUST be one of the allowed public key
 *  algorithms, the current time MUST be within the validity period of the
 *  certificate as defined in Section 4.1.2.5 of [RFC5280] and the total
 *  length of the validity period MUST NOT exceed two weeks."
 *
 * "The exact list of allowed public key algorithms used in the Subject
 *  Public Key Info field (and, as a consequence, in the TLS
 *  CertificateVerify message) is implementation-defined; however, it MUST
 *  include ECDSA with the secp256r1 (NIST P-256) named group ([RFC3279],
 *  Section 2.3.5; [RFC8422]) to provide an interoperable default. It MUST
 *  NOT contain RSA keys ([RFC3279], Section 2.3.1)."
 * @see https://w3c.github.io/webtransport/#custom-certificate-requirements
 * @param {import('node:crypto').X509Certificate} certificate
 * @returns {boolean}
 */
function satisfiesCustomCertificateRequirements (certificate) {
  // The key used in the Subject Public Key field MUST be one of the
  // allowed public key algorithms; it MUST include ECDSA with the
  // secp256r1 (NIST P-256) named group and MUST NOT contain RSA keys.
  const { asymmetricKeyType, asymmetricKeyDetails } = certificate.publicKey
  switch (asymmetricKeyType) {
    case 'ec': {
      const allowedNamedCurves = ['prime256v1', 'secp384r1', 'secp521r1']
      if (!allowedNamedCurves.includes(asymmetricKeyDetails?.namedCurve)) {
        return false
      }
      break
    }
    case 'ed25519':
    case 'ed448':
      break
    default:
      // Notably 'rsa' and 'rsa-pss'.
      return false
  }

  const validFrom = certificate.validFromDate.getTime()
  const validTo = certificate.validToDate.getTime()
  const now = Date.now()

  // The current time MUST be within the validity period of the certificate
  // as defined in Section 4.1.2.5 of [RFC5280]
  if (now < validFrom || now > validTo) {
    return false
  }

  // and the total length of the validity period MUST NOT exceed two weeks.
  if (validTo - validFrom > maxCertificateValidityPeriodMs) {
    return false
  }

  return true
}

/**
 * Encodes a number as a QUIC variable-length integer.
 * @see https://datatracker.ietf.org/doc/html/rfc9000#section-16
 * @param {bigint} value
 * @returns {Uint8Array}
 */
function encodeVarint (value) {
  if (value < 0x40n) {
    return Uint8Array.of(Number(value))
  } else if (value < 0x4000n) {
    const v = Number(value)
    return Uint8Array.of(0x40 | (v >>> 8), v & 0xff)
  } else if (value < 0x40000000n) {
    const v = Number(value)
    return Uint8Array.of(
      0x80 | (v >>> 24),
      (v >>> 16) & 0xff,
      (v >>> 8) & 0xff,
      v & 0xff
    )
  } else if (value < 0x4000000000000000n) {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigUint64(0, value)
    bytes[0] |= 0xc0
    return bytes
  }
  throw new RangeError('value does not fit in a variable-length integer')
}

/**
 * Decodes a QUIC variable-length integer from the start of bytes.
 * @see https://datatracker.ietf.org/doc/html/rfc9000#section-16
 * @param {Uint8Array} bytes
 * @returns {{ value: bigint, length: number }|null} the decoded value and
 * the number of bytes consumed, or null if bytes does not contain a whole
 * variable-length integer.
 */
function decodeVarint (bytes) {
  if (bytes.length === 0) {
    return null
  }
  // The QUIC variable-length integer encoding reserves the two most
  // significant bits of the first byte to encode the base-2 logarithm of
  // the integer encoding length in bytes.
  const length = 1 << (bytes[0] >>> 6)
  if (bytes.length < length) {
    return null
  }
  let value = BigInt(bytes[0] & 0x3f)
  for (let i = 1; i < length; ++i) {
    value = (value << 8n) | BigInt(bytes[i])
  }
  return { value, length }
}

module.exports = {
  webtransportCodeToHttpCode,
  httpCodeToWebtransportCode,
  computeCertificateHash,
  verifyCertificateHash,
  satisfiesCustomCertificateRequirements,
  encodeVarint,
  decodeVarint
}
