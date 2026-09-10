const KIMPEX_TAG = 'supplier-kimpex';

/**
 * Builds one kimpex_pending_orders row per Kimpex-matched line item, using
 * real Shopify order + line item data. Field names here are the row shape
 * lib/kimpexOrders.js writes to Supabase (camelCase - mapped to the
 * table's snake_case columns there), which mirrors Kimpex's required
 * upload columns one-for-one (see kimpex_pending_orders / the "Orders"
 * xlsx template lib/kimpexExport.js generates).
 *
 * Two lessons confirmed directly from Kimpex's own upload documentation
 * (their B2B error list), the second one carried over from the same
 * mistake almost made with Thibault:
 * - shipState must be the 2-letter province/state code
 *   (shipping_address.province_code, e.g. "ON") - their docs: "Province
 *   does not match our data. We recommend entering the 2-letter code for
 *   the province or state. Example: QC for Quebec."
 * - shipCountry must be the 2-letter country code
 *   (shipping_address.country_code, e.g. "CA"), not the full name - their
 *   docs: "Country does not match our data. We recommend entering the
 *   2-letter country code. Example: CA for Canada."
 */
function buildKimpexOrderRows(order, items) {
  const addr = order.shipping_address || {};
  const recipientName =
    [addr.first_name, addr.last_name].filter(Boolean).join(' ') || addr.name || '';
  const orderNumber = String(order.name || order.order_number || order.id);
  const phone = addr.phone || order.phone || (order.customer && order.customer.phone) || '';
  const email = (order.customer && order.customer.email) || order.email || '';

  return items.map((li) => ({
    shopifyOrderId: String(order.id),
    orderNumber,
    recipientName,
    shipAddress1: addr.address1 || '',
    shipAddress2: addr.address2 || '',
    shipAddress3: '', // Shopify has no third shipping address line
    shipCity: addr.city || '',
    shipPostalCode: addr.zip || '',
    shipState: addr.province_code || '',
    shipCountry: addr.country_code || '',
    buyerPhoneNumber: phone,
    buyerEmail: email,
    sku: li.sku,
    productName: li.title || li.name || '',
    quantityPurchased: li.quantity,
    itemPrice: li.price != null ? Number(li.price) : null,
  }));
}

module.exports = { KIMPEX_TAG, buildKimpexOrderRows };
