const { getProductTags } = require('./productTags');

function normalizeTag(tag) {
  return String(tag || '').trim().toLowerCase();
}

function hasTag(tags, targetTag) {
  const normalizedTarget = normalizeTag(targetTag);
  return (tags || []).some((t) => normalizeTag(t) === normalizedTarget);
}

/**
 * Looks up each distinct product's tags on the order ONCE (cached and
 * retried - see lib/productTags.js) and classifies every line item against
 * each of `targetTags` (e.g. "Supplier-Thibault", "Supplier-Kimpex") -
 * case-insensitive, whitespace-trimmed. One lookup pass regardless of how
 * many target tags are checked, so an order with items for multiple
 * distributors never doubles the Shopify Admin API calls (or, for a
 * product whose lookup keeps failing, the retries).
 *
 * "Unresolved" (tag lookup failed after retries) is a property of the
 * PRODUCT, not of any one target tag - reported once per line item, not
 * once per tag, so a single failed lookup doesn't get logged/alerted
 * multiple times over just because more than one distributor tag was being
 * checked for. It's deliberately NOT treated as "matches no tag" (which
 * would silently drop the item from every distributor) and must never
 * abort the rest of the order.
 *
 * Returns { itemsByTag: Map<string, lineItem[]>, unresolvedItems: lineItem[] }.
 * Each unresolved line item carries an extra `_tagLookupError` (the final
 * error message after retries were exhausted).
 */
async function getLineItemsByTags(order, targetTags) {
  const lineItems = order.line_items || [];
  const productIds = [...new Set(lineItems.map((li) => li.product_id).filter((id) => id != null))];

  const tagsByProductId = new Map();
  const unresolvedErrorsByProductId = new Map();

  for (const productId of productIds) {
    try {
      const tags = await getProductTags(productId);
      tagsByProductId.set(productId, tags);
    } catch (err) {
      unresolvedErrorsByProductId.set(productId, err.message);
    }
  }

  const itemsByTag = new Map();
  for (const targetTag of targetTags) {
    const matchingProductIds = new Set();
    for (const [productId, tags] of tagsByProductId) {
      if (hasTag(tags, targetTag)) matchingProductIds.add(productId);
    }
    itemsByTag.set(
      targetTag,
      lineItems.filter((li) => matchingProductIds.has(li.product_id))
    );
  }

  const unresolvedItems = lineItems
    .filter((li) => unresolvedErrorsByProductId.has(li.product_id))
    .map((li) => ({ ...li, _tagLookupError: unresolvedErrorsByProductId.get(li.product_id) }));

  return { itemsByTag, unresolvedItems };
}

module.exports = { getLineItemsByTags, hasTag, normalizeTag };
