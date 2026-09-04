const { getCachedTags, setCachedTags } = require('./productTagCache');
const liveClient = require('./shopifyAdminClient');
const mockClient = require('./shopifyAdminMock');

// Shopify's standard Admin REST API rate limit is roughly 2 requests/second
// per store (leaky bucket). Lookups happen sequentially (see
// mapOrderToThibault.getThibaultLineItems), and this spacing is applied
// after each real network call so a multi-item order doesn't burst through
// the bucket. Cached and mocked lookups skip this entirely.
const REQUEST_SPACING_MS = 550;

// A 404/network blip on a single product lookup shouldn't take down the
// whole order - most transient failures don't survive a retry. 3 total
// attempts (1 initial + 2 retries), a few hundred ms apart. If it's still
// failing after this, the caller (getThibaultLineItems) treats it as
// "unresolved" - not "confirmed not Thibault" - see lib/mapOrderToThibault.js.
const TAG_LOOKUP_MAX_ATTEMPTS = 3;
const TAG_LOOKUP_RETRY_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMockMode() {
  const override = process.env.SHOPIFY_ADMIN_MOCK;
  if (override === 'true') return true;
  if (override === 'false') return false;
  // Auto-detect: use the mock client when real Admin API credentials aren't
  // configured, so local testing works out of the box. Once
  // SHOPIFY_SHOP_DOMAIN + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET are
  // set, real lookups (and real token fetching - see
  // lib/shopifyAdminAuth.js) kick in automatically with no code change.
  return !(
    process.env.SHOPIFY_SHOP_DOMAIN &&
    process.env.SHOPIFY_CLIENT_ID &&
    process.env.SHOPIFY_CLIENT_SECRET
  );
}

async function fetchWithRetry(client, productId) {
  let lastErr;
  for (let attempt = 1; attempt <= TAG_LOOKUP_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await client.fetchProductTags(productId);
    } catch (err) {
      lastErr = err;
      if (attempt < TAG_LOOKUP_MAX_ATTEMPTS) {
        console.warn(
          `[product-tags] Tag lookup for product ${productId} failed (attempt ${attempt}/${TAG_LOOKUP_MAX_ATTEMPTS}): ${err.message}. Retrying in ${TAG_LOOKUP_RETRY_DELAY_MS}ms...`
        );
        await sleep(TAG_LOOKUP_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

/**
 * Returns a product's tags (array of strings), using a short-lived local
 * cache (lib/productTagCache.js) to avoid redundant lookups for
 * frequently-ordered products, and retrying transient failures a couple of
 * times before giving up. Throws (does not swallow) if all attempts fail -
 * a failed result is never cached, since "unresolved" must not be confused
 * with "confirmed no tags" the next time this product is looked up.
 */
async function getProductTags(productId) {
  const cached = getCachedTags(productId);
  if (cached) return cached;

  const usingMock = isMockMode();
  const client = usingMock ? mockClient : liveClient;
  const tags = await fetchWithRetry(client, productId);

  if (!usingMock) {
    await sleep(REQUEST_SPACING_MS);
  }

  setCachedTags(productId, tags);
  return tags;
}

module.exports = {
  getProductTags,
  isMockMode,
  REQUEST_SPACING_MS,
  TAG_LOOKUP_MAX_ATTEMPTS,
  TAG_LOOKUP_RETRY_DELAY_MS,
};
