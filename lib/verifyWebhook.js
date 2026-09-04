const crypto = require('crypto');

/**
 * Verifies a Shopify webhook's X-Shopify-Hmac-Sha256 header against the raw
 * request body. Shopify signs the *raw* (unparsed) body, so callers must
 * pass the exact bytes received, not a re-serialized JSON string.
 *
 * @param {Buffer|string} rawBody - the exact raw request body
 * @param {string} hmacHeader - value of the X-Shopify-Hmac-Sha256 header
 * @param {string} secret - SHOPIFY_WEBHOOK_SECRET
 * @returns {boolean}
 */
function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret || !rawBody) return false;

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  const digestBuffer = Buffer.from(digest, 'utf8');
  const headerBuffer = Buffer.from(hmacHeader, 'utf8');

  // timingSafeEqual throws if buffers differ in length, so guard first.
  // The length check itself does leak length info, but that's true of the
  // header value already being sent in the clear - it's not the secret.
  if (digestBuffer.length !== headerBuffer.length) return false;

  return crypto.timingSafeEqual(digestBuffer, headerBuffer);
}

module.exports = { verifyShopifyWebhook };
