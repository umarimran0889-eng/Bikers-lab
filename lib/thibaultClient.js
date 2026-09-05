const THIBAULT_ORDER_URL = 'https://api.importationsthibault.com/api/v1/order';
const THIBAULT_INVOICES_URL = 'https://api.importationsthibault.com/api/v1/invoices';
const THIBAULT_TRACKING_URL = 'https://api.importationsthibault.com/api/v1/tracking';

/**
 * Safety gate: real calls to Thibault's live Order API only happen when
 * THIBAULT_LIVE_CALLS_ENABLED is exactly "true". Unset/anything else means
 * simulated - this defaults OFF on purpose, since a real call here places a
 * real order with a real supplier. Flip it only when actually ready to test
 * against their live system.
 */
function isLiveCallsEnabled() {
  return process.env.THIBAULT_LIVE_CALLS_ENABLED === 'true';
}

/**
 * Submits one order payload to Thibault's Order API.
 *
 * When THIBAULT_LIVE_CALLS_ENABLED is not "true", this makes NO network
 * call at all - it logs what would have been sent and returns a simulated
 * success response shaped like Thibault's documented response (`items`,
 * `order_number`, etc.), marked with `simulated: true` so callers/logs can
 * tell it apart from a real confirmation.
 *
 * When live calls are enabled, throws on non-2xx responses; the error
 * carries `status` and `response` (Thibault's parsed error body, when
 * available) so callers can log details like a blocked postal code.
 */
async function submitThibaultOrder(payload, { token = process.env.THIBAULT_API_TOKEN } = {}) {
  if (!isLiveCallsEnabled()) {
    console.warn(
      `[thibault-client] THIBAULT_LIVE_CALLS_ENABLED is not "true" - simulating POST ${THIBAULT_ORDER_URL} ` +
        `instead of making a real call. Payload that would have been sent: ${JSON.stringify(payload)}`
    );
    return {
      simulated: true,
      order_number: `SIMULATED-${Date.now()}`,
      items: Array.isArray(payload.item) ? payload.item : [payload.item],
      subtotal: null,
      fees: null,
      taxes: null,
      total: null,
    };
  }

  if (!token) {
    throw new Error('THIBAULT_API_TOKEN is not set');
  }

  const res = await fetch(THIBAULT_ORDER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const err = new Error(`Thibault API responded with ${res.status}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }

  return data;
}

/**
 * GET helper shared by the read-only invoices/tracking lookups. Treats a
 * 404 as "no matches" (Thibault's docs don't specify what a no-match
 * response looks like, so this covers the common convention); any other
 * non-2xx is a real error and throws, carrying `status`/`response` like
 * submitThibaultOrder's errors do.
 */
async function thibaultGet(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (res.status === 404) return { items: [] };

  if (!res.ok) {
    const err = new Error(`Thibault API responded with ${res.status}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }

  return data;
}

/**
 * Looks up whether Thibault has an invoice for this customer_refs value
 * (the same value sent as `customer_refs` in the original order payload) -
 * GET /api/v1/invoices?customer_refs={ref}, read-only, never creates or
 * modifies anything on Thibault's side.
 *
 * When THIBAULT_LIVE_CALLS_ENABLED is not "true", returns "not found"
 * without any network call - there's no real Thibault order to check
 * against anyway while calls are simulated.
 *
 * Returns { found: false } or { found: true, orderNumber, invoiceNumber, raw }.
 * "Not found" is a neutral/pending outcome, not an error - only a genuine
 * API failure throws.
 */
async function checkThibaultInvoice(customerRefs, { token = process.env.THIBAULT_API_TOKEN } = {}) {
  if (!isLiveCallsEnabled()) {
    return { found: false, simulated: true };
  }
  if (!token) {
    throw new Error('THIBAULT_API_TOKEN is not set');
  }

  const url = `${THIBAULT_INVOICES_URL}?customer_refs=${encodeURIComponent(customerRefs)}`;
  const data = await thibaultGet(url, token);
  const items = (data && data.items) || [];
  if (items.length === 0) return { found: false };

  const document = items[0].document || {};
  return {
    found: true,
    orderNumber: document.order,
    invoiceNumber: document.invoice,
    raw: items[0],
  };
}

/**
 * Fetches shipment/tracking info for a confirmed Thibault order number -
 * GET /api/v1/tracking?order={orderNumber}, read-only.
 *
 * When THIBAULT_LIVE_CALLS_ENABLED is not "true", returns "not found"
 * without any network call.
 *
 * Returns { found: false } or
 * { found: true, carrier, trackingPin, shippedAt, raw }. `shippedAt` is an
 * ISO string derived from Thibault's `label_date` (Unix epoch seconds), or
 * null if not present.
 */
async function getThibaultTracking(orderNumber, { token = process.env.THIBAULT_API_TOKEN } = {}) {
  if (!isLiveCallsEnabled()) {
    return { found: false, simulated: true };
  }
  if (!token) {
    throw new Error('THIBAULT_API_TOKEN is not set');
  }

  const url = `${THIBAULT_TRACKING_URL}?order=${encodeURIComponent(orderNumber)}`;
  const data = await thibaultGet(url, token);
  const items = (data && data.items) || [];
  if (items.length === 0) return { found: false };

  const shipment = (items[0].shipment && items[0].shipment[0]) || null;
  if (!shipment) return { found: false };

  return {
    found: true,
    carrier: shipment.carrier || null,
    trackingPin: shipment.pin || null,
    shippedAt: shipment.label_date ? new Date(shipment.label_date * 1000).toISOString() : null,
    raw: items[0],
  };
}

module.exports = {
  submitThibaultOrder,
  checkThibaultInvoice,
  getThibaultTracking,
  isLiveCallsEnabled,
  THIBAULT_ORDER_URL,
  THIBAULT_INVOICES_URL,
  THIBAULT_TRACKING_URL,
};
