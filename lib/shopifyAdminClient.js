const { getAccessToken } = require('./shopifyAdminAuth');

const DEFAULT_API_VERSION = '2024-10';

/**
 * Fetches a single product's tags from the real Shopify Admin API.
 * Requires SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET
 * (see lib/shopifyAdminAuth.js for how the short-lived access token is
 * obtained and cached). The underlying token only needs the
 * `read_products` scope - this is a read-only lookup.
 */
async function fetchProductTags(productId) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || DEFAULT_API_VERSION;

  if (!shop) {
    throw new Error('SHOPIFY_SHOP_DOMAIN must be set to look up product tags');
  }

  const token = await getAccessToken();

  const url = `https://${shop}/admin/api/${apiVersion}/products/${productId}.json?fields=id,tags`;
  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token },
  });

  const text = await res.text();

  if (!res.ok) {
    const err = new Error(`Shopify Admin API responded with ${res.status} for product ${productId}`);
    err.status = res.status;
    err.response = text;
    throw err;
  }

  const data = JSON.parse(text);
  const tagsString = (data.product && data.product.tags) || '';
  return tagsString
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

module.exports = { fetchProductTags };
