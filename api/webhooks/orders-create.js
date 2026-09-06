const { verifyShopifyWebhook } = require('../../lib/verifyWebhook');
const { getThibaultLineItems, buildThibaultOrderPayloads } = require('../../lib/mapOrderToThibault');
const { submitThibaultOrder, checkThibaultInvoice } = require('../../lib/thibaultClient');
const { logEvent } = require('../../lib/logger');
const { logUnresolvedItem } = require('../../lib/unresolvedItemsLog');
const { sendFailureAlert } = require('../../lib/alerts');
const {
  recordPendingStatus,
  markSent,
  markFailed,
  markConfirmed,
  hasExistingStatusForOrder,
} = require('../../lib/orderStatus');

// IMPORTANT (production requirement, not just local): HMAC verification
// needs the exact raw bytes Shopify signed. On Vercel, plain Node.js
// functions (this is not Next.js - the `config.api.bodyParser` convention
// that used to be exported here is Next.js-only and does nothing here;
// it has been removed since it was silently inert) auto-populate
// `req.body` via a getter that parses - and thereby consumes - the raw
// request stream for Content-Type: application/json, BEFORE any of our
// code can read the original bytes ourselves. Once that happens, the raw
// bytes are gone; there is no way to recover them or reliably reconstruct
// Shopify's exact original serialization (key order/whitespace) from the
// parsed object, so HMAC verification can never succeed against a
// re-parsed body - not "sometimes fails", *never* succeeds.
//
// The fix is a required Vercel project Environment Variable:
// NODEJS_HELPERS=0 (Project Settings -> Environment Variables, for every
// environment this deploys to), which disables that auto-parsing so `req`
// stays the raw, unconsumed stream and our own readRawBody() below gets
// the genuine bytes - exactly like local dev (where nothing pre-parses
// the request) and exactly like scripts/test-raw-webhook-body.js, which
// exercises this real stream-reading path end-to-end.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function ordersCreateHandler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  let rawBody;
  if (Buffer.isBuffer(req.body)) {
    rawBody = req.body;
  } else if (typeof req.body === 'string') {
    rawBody = Buffer.from(req.body);
  } else if (req.body !== undefined) {
    // req.body is already a parsed object - Vercel's Node.js helpers ran
    // and consumed the raw stream before we got to it (see the note
    // above). The genuine bytes are unrecoverable at this point, so HMAC
    // verification against anything derived from this object would always
    // fail. Fail loudly and specifically here instead, so this shows up as
    // an actionable, named misconfiguration rather than a confusing
    // generic "HMAC verification failed".
    logEvent({
      level: 'error',
      message:
        'req.body was already parsed (Vercel Node.js helpers are active) - the raw request body is ' +
        'unavailable, so HMAC verification cannot run. Set NODEJS_HELPERS=0 in this environment\'s Vercel ' +
        'project settings.',
    });
    return sendJson(res, 500, { error: 'Server misconfigured: raw request body unavailable' });
  } else {
    rawBody = await readRawBody(req);
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!verifyShopifyWebhook(rawBody, hmacHeader, secret)) {
    logEvent({ level: 'warn', message: 'Webhook HMAC verification failed' });
    return sendJson(res, 401, { error: 'Invalid webhook signature' });
  }

  let order;
  try {
    order = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const orderId = order.id;

  // Catch-all safety net: anything unexpected past this point (a bug, an
  // I/O error, whatever) gets logged AND alerted, instead of failing
  // completely silently with just a stack trace in a terminal no one is
  // watching.
  try {
    return await processOrder({ req, res, order, orderId });
  } catch (err) {
    logEvent({
      level: 'error',
      orderId,
      message: 'Unhandled error in orders-create handler',
      error: err.message,
      stack: err.stack,
    });
    await sendFailureAlert('unhandled_error', {
      orderId,
      orderName: order.name || order.order_number,
      error: err.message,
      stack: err.stack,
    });
    if (!res.headersSent) {
      return sendJson(res, 500, { status: 'error', error: 'Internal Server Error' });
    }
  }
}

async function processOrder({ res, order, orderId }) {
  // Duplicate-order check: is there already an order_status row for this
  // Shopify order (Shopify retries webhooks on timeout)? Backed by
  // Supabase, not a local file - a file can never persist reliably across
  // serverless invocations/instances. Only orders with at least one
  // Thibault-matched SKU get a row in the first place, so an order with no
  // Thibault items will redundantly re-check tags on a retry rather than
  // short-circuit here - harmless (no duplicate Thibault submission risk),
  // just a little wasted work.
  if (await hasExistingStatusForOrder(orderId)) {
    logEvent({ level: 'info', orderId, message: 'Duplicate webhook delivery, already processed - skipping' });
    return sendJson(res, 200, { status: 'skipped', reason: 'duplicate' });
  }

  const { matchedItems, unresolvedItems } = await getThibaultLineItems(order);

  // "Unresolved" (tag lookup failed after retries) is distinct from
  // "confirmed not Thibault" - it must never be silently dropped, and must
  // never block matchedItems from being forwarded normally.
  for (const li of unresolvedItems) {
    logUnresolvedItem({
      orderId,
      orderName: order.name || order.order_number,
      productId: li.product_id,
      sku: li.sku,
      lineItemId: li.id,
      error: li._tagLookupError,
    });
    await sendFailureAlert('unresolved_item', {
      orderId,
      orderName: order.name || order.order_number,
      productId: li.product_id,
      sku: li.sku,
      lineItemId: li.id,
      lookupError: li._tagLookupError,
    });
  }

  if (matchedItems.length === 0) {
    logEvent({
      level: 'info',
      orderId,
      message: 'No confirmed Thibault line items on this order - skipping',
      unresolvedCount: unresolvedItems.length,
    });
    return sendJson(res, 200, {
      status: 'skipped',
      reason: 'no_thibault_items',
      unresolvedCount: unresolvedItems.length,
    });
  }

  const orderRequests = buildThibaultOrderPayloads(order, matchedItems);
  const results = [];

  // One POST /api/v1/order call per SKU - Thibault's documented request body
  // only supports a single {sku, qty} under "item", not an array of items.
  for (const { sku, payload } of orderRequests) {
    // Written as soon as this SKU is confirmed Thibault-bound, before the
    // Thibault call is even attempted - so it shows up on the dashboard as
    // "pending" immediately rather than only appearing once resolved.
    const statusId = await recordPendingStatus({
      shopifyOrderId: orderId,
      orderNumber: order.name || order.order_number,
      sku,
    });

    try {
      const response = await submitThibaultOrder(payload);
      const simulated = Boolean(response && response.simulated);
      logEvent({
        level: 'info',
        orderId,
        sku,
        message: simulated
          ? 'Simulated Thibault order (THIBAULT_LIVE_CALLS_ENABLED is not "true" - no real call was made)'
          : 'Forwarded to Thibault',
        simulated,
        thibaultOrderNumber: response && response.order_number,
      });
      await markSent(statusId, { simulated });
      results.push({
        sku,
        status: 'success',
        simulated,
        thibaultOrderNumber: response && response.order_number,
      });

      // Best-effort confirmation check against Thibault's own invoices
      // endpoint (read-only GET) - Thibault is the source of truth, not our
      // own send-success. Almost always "not found yet" immediately after
      // submission (Thibault hasn't processed it yet) - that's expected and
      // neutral, not an error; the dashboard's "Recheck confirmation"
      // button re-runs this later. Never blocks order processing.
      try {
        const invoiceCheck = await checkThibaultInvoice(payload.customer_refs);
        if (invoiceCheck.found) {
          await markConfirmed(statusId, {
            thibaultOrderNumber: invoiceCheck.orderNumber,
            thibaultInvoiceNumber: invoiceCheck.invoiceNumber,
          });
        }
      } catch (invoiceErr) {
        console.error(
          `[orders-create] Invoice confirmation check failed for order ${orderId} SKU ${sku}:`,
          invoiceErr.message
        );
      }
    } catch (err) {
      logEvent({
        level: 'error',
        orderId,
        sku,
        message: 'Thibault API error',
        error: err.message,
        thibaultResponse: err.response,
      });
      await sendFailureAlert('thibault_rejection', {
        orderId,
        orderName: order.name || order.order_number,
        sku,
        orderPayload: payload,
        thibaultError: err.message,
        thibaultResponse: err.response,
      });
      await markFailed(statusId, err.message);
      results.push({ sku, status: 'error', error: err.message });
    }
  }

  const anyFailed = results.some((r) => r.status === 'error');
  return sendJson(res, anyFailed ? 207 : 200, {
    status: anyFailed ? 'partial_failure' : 'success',
    results,
    unresolvedCount: unresolvedItems.length,
  });
}

module.exports = ordersCreateHandler;
