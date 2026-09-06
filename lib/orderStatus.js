const { getSupabaseClient } = require('./supabaseClient');

const TABLE = 'order_status';

// Every function here is defensive by design: a Supabase outage, a bad key,
// a schema mismatch, whatever - none of it may ever throw back into the
// webhook handler or block order forwarding. Worst case, status tracking
// just silently doesn't happen for that call and it's logged.

/**
 * Inserts a 'pending' row for one Thibault-matched SKU, as soon as it's
 * identified - before the Thibault call is even attempted. Returns the
 * inserted row's id (needed to update it to sent/failed later), or null if
 * Supabase isn't configured/reachable.
 */
async function recordPendingStatus({ shopifyOrderId, orderNumber, sku, distributor = 'thibault' }) {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn(
      `[order-status] Supabase unavailable (not configured, or SUPABASE_MOCK=true) - skipping pending-row write for SKU ${sku}.`
    );
    return null;
  }

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        shopify_order_id: String(shopifyOrderId),
        order_number: orderNumber != null ? String(orderNumber) : null,
        sku,
        distributor,
        status: 'pending',
      })
      .select('id')
      .single();

    if (error) {
      console.error(`[order-status] Failed to insert pending row for SKU ${sku}:`, error.message);
      return null;
    }
    return data.id;
  } catch (err) {
    console.error(`[order-status] Unexpected error inserting pending row for SKU ${sku}:`, err.message);
    return null;
  }
}

/**
 * Marks a row 'sent'. When `simulated` is true (THIBAULT_LIVE_CALLS_ENABLED
 * is not "true"), the row is still marked sent but carries a note in
 * error_message clarifying no real call was made - so the dashboard never
 * implies a real Thibault order exists when it doesn't.
 */
async function markSent(id, { simulated = false } = {}) {
  if (id == null) return;
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase
      .from(TABLE)
      .update({
        status: 'sent',
        error_message: simulated
          ? 'Simulated - THIBAULT_LIVE_CALLS_ENABLED is not "true", no real call was made'
          : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) console.error(`[order-status] Failed to update row ${id} to sent:`, error.message);
  } catch (err) {
    console.error(`[order-status] Unexpected error updating row ${id} to sent:`, err.message);
  }
}

/** Marks a row 'failed', recording the error that came back from Thibault. */
async function markFailed(id, errorMessage) {
  if (id == null) return;
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase
      .from(TABLE)
      .update({
        status: 'failed',
        error_message: errorMessage ? String(errorMessage).slice(0, 2000) : 'Unknown error',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) console.error(`[order-status] Failed to update row ${id} to failed:`, error.message);
  } catch (err) {
    console.error(`[order-status] Unexpected error updating row ${id} to failed:`, err.message);
  }
}

/** Returns the most recent `limit` rows, newest first. Empty array if Supabase isn't configured/reachable. */
async function listRecentStatuses(limit = 100) {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[order-status] Failed to list recent statuses:', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[order-status] Unexpected error listing recent statuses:', err.message);
    return [];
  }
}

/** Fetches a single row by its id. Returns null if not found or Supabase is unavailable. */
async function getStatusById(id) {
  if (id == null) return null;
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).single();
    if (error) {
      console.error(`[order-status] Failed to fetch row ${id}:`, error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.error(`[order-status] Unexpected error fetching row ${id}:`, err.message);
    return null;
  }
}

/**
 * Marks a row 'confirmed' with Thibault's real order/invoice numbers, once
 * lib/thibaultClient.js's checkThibaultInvoice() finds a match. There's no
 * corresponding "mark not confirmed" - "not_confirmed" is just the row's
 * default state (a neutral/pending outcome, not an error), so a failed or
 * not-yet-found check simply leaves it as-is rather than writing anything.
 */
async function markConfirmed(id, { thibaultOrderNumber, thibaultInvoiceNumber } = {}) {
  if (id == null) return;
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase
      .from(TABLE)
      .update({
        confirmation: 'confirmed',
        thibault_order_number: thibaultOrderNumber != null ? String(thibaultOrderNumber) : null,
        thibault_invoice_number: thibaultInvoiceNumber != null ? String(thibaultInvoiceNumber) : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) console.error(`[order-status] Failed to mark row ${id} confirmed:`, error.message);
  } catch (err) {
    console.error(`[order-status] Unexpected error marking row ${id} confirmed:`, err.message);
  }
}

/** Updates a confirmed row's shipment/tracking info from lib/thibaultClient.js's getThibaultTracking(). */
async function updateTracking(id, { carrier, trackingPin, shippedAt } = {}) {
  if (id == null) return;
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase
      .from(TABLE)
      .update({
        tracking_carrier: carrier || null,
        tracking_pin: trackingPin || null,
        tracking_shipped_at: shippedAt || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) console.error(`[order-status] Failed to update tracking for row ${id}:`, error.message);
  } catch (err) {
    console.error(`[order-status] Unexpected error updating tracking for row ${id}:`, err.message);
  }
}

/**
 * Checks whether this Shopify order already has ANY order_status row - i.e.
 * it was already processed by an earlier webhook delivery (Shopify retries
 * on timeout). This is the duplicate-order check, replacing the old
 * file-based dedupe store: a project-relative file can never work
 * reliably in a serverless environment with a read-only, ephemeral
 * filesystem (e.g. Vercel), whereas this actually persists across
 * invocations and instances.
 *
 * Fails OPEN (returns false = "not yet processed") if Supabase is
 * unavailable/misconfigured, consistent with every other function in this
 * file never blocking order processing. The trade-off: if Supabase is down
 * at the exact moment of a genuine duplicate webhook delivery, that
 * duplicate won't be caught. This is intentional - failing closed instead
 * (treating "can't tell" as "assume duplicate, skip") would silently drop
 * real new orders whenever Supabase has a blip, which is worse.
 */
async function hasExistingStatusForOrder(shopifyOrderId) {
  const supabase = getSupabaseClient();
  if (!supabase) return false;

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('id')
      .eq('shopify_order_id', String(shopifyOrderId))
      .limit(1);

    if (error) {
      console.error(`[order-status] Failed to check existing status for order ${shopifyOrderId}:`, error.message);
      return false;
    }
    return Boolean(data && data.length > 0);
  } catch (err) {
    console.error(`[order-status] Unexpected error checking existing status for order ${shopifyOrderId}:`, err.message);
    return false;
  }
}

/** Deletes rows for a given shopify_order_id. Used by scripts/test-dashboard.js to clean up its own test rows. */
async function deleteStatusesForOrder(shopifyOrderId) {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase.from(TABLE).delete().eq('shopify_order_id', String(shopifyOrderId));
    if (error) console.error(`[order-status] Failed to delete rows for order ${shopifyOrderId}:`, error.message);
  } catch (err) {
    console.error(`[order-status] Unexpected error deleting rows for order ${shopifyOrderId}:`, err.message);
  }
}

module.exports = {
  recordPendingStatus,
  markSent,
  markFailed,
  getStatusById,
  markConfirmed,
  updateTracking,
  listRecentStatuses,
  hasExistingStatusForOrder,
  deleteStatusesForOrder,
  TABLE,
};
