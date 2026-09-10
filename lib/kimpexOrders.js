const { getSupabaseClient } = require('./supabaseClient');

const TABLE = 'kimpex_pending_orders';

// Same defensive-by-design principle as lib/orderStatus.js: a Supabase
// outage, a bad key, a schema mismatch - none of it may ever throw back
// into the webhook handler or block order processing.

/**
 * Inserts one row per Kimpex-matched line item. `rows` should come from
 * lib/mapOrderToKimpex.js's buildKimpexOrderRows(). No-ops (logged) if
 * Supabase isn't configured/reachable, or if `rows` is empty.
 */
async function recordPendingKimpexOrders(rows) {
  if (!rows || rows.length === 0) return;

  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn(
      `[kimpex-orders] Supabase unavailable (not configured, or SUPABASE_MOCK=true) - skipping ${rows.length} pending Kimpex row(s).`
    );
    return;
  }

  try {
    const { error } = await supabase.from(TABLE).insert(
      rows.map((r) => ({
        shopify_order_id: r.shopifyOrderId,
        order_number: r.orderNumber,
        recipient_name: r.recipientName,
        ship_address_1: r.shipAddress1,
        ship_address_2: r.shipAddress2,
        ship_address_3: r.shipAddress3,
        ship_city: r.shipCity,
        ship_postal_code: r.shipPostalCode,
        ship_state: r.shipState,
        ship_country: r.shipCountry,
        buyer_phone_number: r.buyerPhoneNumber,
        buyer_email: r.buyerEmail,
        sku: r.sku,
        product_name: r.productName,
        quantity_purchased: r.quantityPurchased,
        item_price: r.itemPrice,
      }))
    );

    if (error) console.error(`[kimpex-orders] Failed to insert ${rows.length} pending row(s):`, error.message);
  } catch (err) {
    console.error(`[kimpex-orders] Unexpected error inserting pending rows:`, err.message);
  }
}

/**
 * Duplicate-order check for Kimpex, same reasoning as
 * lib/orderStatus.js's hasExistingStatusForOrder() - checks Supabase
 * rather than a local file (which can't persist reliably in a serverless
 * environment), and fails OPEN (returns false) if Supabase itself is
 * unavailable, since failing closed would risk silently dropping a real
 * new order instead.
 */
async function hasExistingKimpexOrderForShopifyOrder(shopifyOrderId) {
  const supabase = getSupabaseClient();
  if (!supabase) return false;

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('id')
      .eq('shopify_order_id', String(shopifyOrderId))
      .limit(1);

    if (error) {
      console.error(`[kimpex-orders] Failed to check existing rows for order ${shopifyOrderId}:`, error.message);
      return false;
    }
    return Boolean(data && data.length > 0);
  } catch (err) {
    console.error(`[kimpex-orders] Unexpected error checking existing rows for order ${shopifyOrderId}:`, err.message);
    return false;
  }
}

/** Returns every row not yet exported, oldest first (the export should process them in the order they came in). */
async function listPendingKimpexOrders() {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('exported', false)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[kimpex-orders] Failed to list pending rows:', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[kimpex-orders] Unexpected error listing pending rows:', err.message);
    return [];
  }
}

/** Returns the most recent `limit` rows (pending and exported), newest first - for the dashboard. */
async function listRecentKimpexOrders(limit = 100) {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[kimpex-orders] Failed to list recent rows:', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[kimpex-orders] Unexpected error listing recent rows:', err.message);
    return [];
  }
}

/** Marks the given row ids exported: true. Rows are kept, not deleted - a record of what was sent. */
async function markKimpexOrdersExported(ids) {
  if (!ids || ids.length === 0) return;
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase.from(TABLE).update({ exported: true }).in('id', ids);
    if (error) console.error(`[kimpex-orders] Failed to mark ${ids.length} row(s) exported:`, error.message);
  } catch (err) {
    console.error(`[kimpex-orders] Unexpected error marking rows exported:`, err.message);
  }
}

/** Deletes rows for a given shopify_order_id. Used by tests to clean up after themselves. */
async function deleteKimpexOrdersForShopifyOrder(shopifyOrderId) {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase.from(TABLE).delete().eq('shopify_order_id', String(shopifyOrderId));
    if (error) console.error(`[kimpex-orders] Failed to delete rows for order ${shopifyOrderId}:`, error.message);
  } catch (err) {
    console.error(`[kimpex-orders] Unexpected error deleting rows for order ${shopifyOrderId}:`, err.message);
  }
}

module.exports = {
  recordPendingKimpexOrders,
  hasExistingKimpexOrderForShopifyOrder,
  listPendingKimpexOrders,
  listRecentKimpexOrders,
  markKimpexOrdersExported,
  deleteKimpexOrdersForShopifyOrder,
  TABLE,
};
