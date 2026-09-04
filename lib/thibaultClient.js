const THIBAULT_ORDER_URL = 'https://api.importationsthibault.com/api/v1/order';

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
      items: [payload.item],
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

module.exports = { submitThibaultOrder, isLiveCallsEnabled, THIBAULT_ORDER_URL };
