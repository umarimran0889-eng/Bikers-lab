// Tag-based line item matching (getLineItemsByTags, normalizeTag, hasTag)
// now lives in lib/lineItemTagging.js, shared with lib/mapOrderToKimpex.js -
// both distributors are matched by product tag the same way, in a single
// lookup pass per order. This module keeps only what's Thibault-specific:
// the tag name itself, and building Thibault's Order API payload shape.
const THIBAULT_TAG = 'supplier-thibault';

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

/**
 * Checks the two ship_to fields Thibault's docs explicitly mark "Required
 * for drop-ship dealer": state (province code) and zip. Catching a missing
 * required field before sending avoids a wasted, confusingly generic
 * E016/E017 ("Shipping address details are invalid in the request body" -
 * both codes share that exact description, so Thibault's own error doesn't
 * say which sub-field failed) round-trip when we can already tell it's
 * missing.
 */
function validateShipTo(shipTo) {
  const issues = [];
  if (!shipTo.zip) issues.push('ship_to.zip is required for drop-ship orders but is missing');
  if (!shipTo.state) issues.push('ship_to.state is required for drop-ship orders but is missing');
  return issues;
}

function buildNote(order) {
  const parts = [`Shopify Order ${order.name || order.order_number || order.id}`];
  if (order.note) parts.push(order.note);
  return parts.join(' | ');
}

/**
 * Builds one Thibault Order API payload per (already-filtered) Thibault line
 * item - one POST /api/v1/order call per SKU, so an order with multiple
 * Thibault SKUs results in multiple calls. `item` is sent as an array
 * (`[{ sku, qty }]`) even though each call only ever carries a single
 * entry, per Thibault's expected request shape.
 *
 * `items` should be the Thibault-tagged line items from
 * lib/lineItemTagging.js's getLineItemsByTags(order, [THIBAULT_TAG]).
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
      item: [{ sku: li.sku, qty: li.quantity }],
      no_backorder: false,
      customer_refs: customerRefs,
      note,
      ship_to: shipTo,
      dropship: true,
    },
  }));
}

module.exports = {
  buildThibaultOrderPayloads,
  validateShipTo,
  THIBAULT_TAG,
};
