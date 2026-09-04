const fixtures = require('../fixtures/product-tags.json');

/**
 * Drop-in stand-in for lib/shopifyAdminClient.js, used for local testing so
 * you don't need real Shopify Admin API credentials wired up yet. Reads
 * canned tags from fixtures/product-tags.json, keyed by product_id.
 *
 * A fixture entry of the form { "__simulateError": "some message" } (instead
 * of a tags array) makes this throw every time, to exercise the
 * retry/unresolved-item handling in lib/productTags.js /
 * lib/mapOrderToThibault.js without needing a real flaky API.
 *
 * Selection between this and the real client is automatic - see
 * lib/productTags.js - so no code change is needed to "go live" later,
 * just set SHOPIFY_SHOP_DOMAIN + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.
 */
async function fetchProductTags(productId) {
  const entry = fixtures[String(productId)];

  if (entry === undefined) {
    console.warn(
      `[shopify-admin-mock] No stubbed tags for product_id ${productId} in fixtures/product-tags.json - treating as untagged.`
    );
    return [];
  }

  if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.__simulateError) {
    throw new Error(entry.__simulateError);
  }

  return entry;
}

module.exports = { fetchProductTags };
