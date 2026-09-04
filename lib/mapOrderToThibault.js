const { getProductTags } = require('./productTags');

const THIBAULT_TAG = 'supplier-thibault';

function normalizeTag(tag) {
  return String(tag || '').trim().toLowerCase();
}

function hasThibaultTag(tags) {
  return (tags || []).some((t) => normalizeTag(t) === THIBAULT_TAG);
}

/**
 * Determines which of the order's line items belong to Thibault, by looking
 * up each distinct product's tags via the Shopify Admin API (cached and
 * retried - see lib/productTags.js) and checking for "Supplier-Thibault"
 * (case-insensitive, whitespace-trimmed).
 *
 * Shopify's orders/create webhook payload doesn't include per-line-item
 * product tags, so this requires a lookup per distinct product on the
 * order. Lookups run sequentially (not in parallel) to stay within
 * Shopify's Admin API rate limit - see lib/productTags.js.
 *
 * If a product's tag lookup still fails after retries, that line item is
 * "unresolved" - deliberately NOT treated as confirmed non-Thibault (which
 * would silently drop it) and NOT allowed to abort the rest of the order
 * (which would delay/lose items that resolved fine). Every other line item
 * is still matched/excluded normally.
 *
 * Returns { matchedItems, unresolvedItems } - both arrays of line items.
 * Each unresolved line item carries an extra `_tagLookupError` (the final
 * error message after retries were exhausted) for logging/alerting.
 */
async function getThibaultLineItems(order) {
  const lineItems = order.line_items || [];
  const productIds = [...new Set(lineItems.map((li) => li.product_id).filter((id) => id != null))];

  const thibaultProductIds = new Set();
  const unresolvedErrorsByProductId = new Map();

  for (const productId of productIds) {
    try {
      const tags = await getProductTags(productId);
      if (hasThibaultTag(tags)) thibaultProductIds.add(productId);
    } catch (err) {
      unresolvedErrorsByProductId.set(productId, err.message);
    }
  }

  const matchedItems = lineItems.filter((li) => thibaultProductIds.has(li.product_id));
  const unresolvedItems = lineItems
    .filter((li) => unresolvedErrorsByProductId.has(li.product_id))
    .map((li) => ({ ...li, _tagLookupError: unresolvedErrorsByProductId.get(li.product_id) }));

  return { matchedItems, unresolvedItems };
}

function buildShipTo(order) {
  const addr = order.shipping_address || {};
  const contact =
    [addr.first_name, addr.last_name].filter(Boolean).join(' ') || addr.name || '';

  return {
    company: addr.company || '',
    contact,
    line1: addr.address1 || '',
    line2: addr.address2 || '',
    city: addr.city || '',
    zip: addr.zip || '',
    phone: addr.phone || order.phone || (order.customer && order.customer.phone) || '',
    // Thibault's docs specify ISO 3166-2:CA (province/state code) and mark
    // this required for drop-ship orders.
    state: addr.province_code || '',
  };
}

function buildNote(order) {
  const parts = [`Shopify Order ${order.name || order.order_number || order.id}`];
  if (order.note) parts.push(order.note);
  return parts.join(' | ');
}

/**
 * Builds one Thibault Order API payload per (already-filtered) Thibault line
 * item. Thibault's documented request body only supports a single
 * {sku, qty} under "item" (not an array), so an order with multiple
 * Thibault SKUs results in multiple POST /api/v1/order calls, one per SKU.
 *
 * `items` should be the result of getThibaultLineItems(order).
 * Returns an array of { sku, shopifyLineItemId, payload }.
 */
function buildThibaultOrderPayloads(order, items, { testMode } = {}) {
  const shipTo = buildShipTo(order);
  const note = buildNote(order);
  const customerRefs = String(order.name || order.order_number || order.id);

  const resolvedTestMode =
    testMode !== undefined ? testMode : process.env.THIBAULT_TEST_MODE === 'true';

  return items.map((li) => ({
    sku: li.sku,
    shopifyLineItemId: li.id,
    payload: {
      test_mode: resolvedTestMode,
      item: { sku: li.sku, qty: li.quantity },
      no_backorder: false,
      customer_refs: customerRefs,
      note,
      ship_to: shipTo,
      dropship: true,
    },
  }));
}

module.exports = {
  getThibaultLineItems,
  buildThibaultOrderPayloads,
  hasThibaultTag,
  normalizeTag,
  THIBAULT_TAG,
};
