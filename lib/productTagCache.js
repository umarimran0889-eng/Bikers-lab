// Short-lived in-memory cache of product_id -> tags, so an order with
// repeat/frequent SKUs doesn't re-hit the Shopify Admin API every time.
//
// Deliberately in-memory, not file-based: a project-relative cache file
// can never work reliably on a read-only, ephemeral serverless filesystem
// (e.g. Vercel - writes fail, and even if they didn't, /tmp isn't shared
// across invocations or instances anyway). This is purely a performance
// optimization (skip a redundant lookup within the same warm instance),
// not a correctness requirement, so resetting on every cold start / each
// instance having its own cache is a fully acceptable trade-off.
const TTL_MS = 60 * 60 * 1000; // 1 hour

const cache = new Map();

function getCachedTags(productId) {
  const key = String(productId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.tags;
}

function setCachedTags(productId, tags) {
  cache.set(String(productId), { tags, fetchedAt: Date.now() });
}

module.exports = { getCachedTags, setCachedTags, TTL_MS };
