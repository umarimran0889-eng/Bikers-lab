/**
 * Logs a line item whose Thibault-tag status could not be determined - the
 * Shopify Admin product tag lookup failed even after retries (see
 * lib/productTags.js). Deliberately its own distinct log line prefix
 * (`[unresolved-item]`), not mixed in with normal forwarding logs:
 * "unresolved" (we don't know) is not the same as "confirmed not Thibault"
 * or "Thibault API rejected it", and needs a human to manually check
 * whether this item should have gone to Thibault.
 *
 * console.warn only - no file writes. A project-relative log file can
 * never work reliably on a read-only, ephemeral serverless filesystem (e.g.
 * Vercel); console output is captured by Vercel's own Logs dashboard
 * instead. Searching those logs for `[unresolved-item]` finds every one.
 */
function logUnresolvedItem({ orderId, orderName, productId, sku, lineItemId, error }) {
  const entry = {
    timestamp: new Date().toISOString(),
    orderId,
    orderName,
    productId,
    sku,
    lineItemId,
    error,
  };
  console.warn(`[unresolved-item] ${JSON.stringify(entry)}`);
}

module.exports = { logUnresolvedItem };
