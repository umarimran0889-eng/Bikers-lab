const { verifyShopifyWebhook } = require('../../lib/verifyWebhook');
const { getLineItemsByTags } = require('../../lib/lineItemTagging');
const { THIBAULT_TAG, buildThibaultOrderPayloads, validateShipTo } = require('../../lib/mapOrderToThibault');
const { KIMPEX_TAG, buildKimpexOrderRows } = require('../../lib/mapOrderToKimpex');
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
const { recordPendingKimpexOrders, hasExistingKimpexOrderForShopifyOrder } = require('../../lib/kimpexOrders');

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
    // Diagnostic fields only - deliberately never the raw body content
    // (real customer PII), the secret, or the full header/digest, just
    // enough shape/length info to tell apart the two likely causes:
    // rawBodyLength near 0 (or otherwise implausible for a real order
    // payload) points to the body not being captured correctly (e.g.
    // NODEJS_HELPERS not set); a normal-looking length instead points to
    // SHOPIFY_WEBHOOK_SECRET itself not matching what Shopify actually
    // signed with.
    logEvent({
      level: 'warn',
      message: 'Webhook HMAC verification failed',
      rawBodyLength: rawBody ? rawBody.length : 0,
      hmacHeaderPresent: Boolean(hmacHeader),
      hmacHeaderLength: hmacHeader ? hmacHeader.length : 0,
      secretConfigured: Boolean(secret),
      secretLength: secret ? secret.length : 0,
    });
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

/**
 * One POST /api/v1/order call per Thibault-tagged SKU - Thibault's
 * documented request body only supports a single {sku, qty} under "item",
 * not an array of items. Returns the `results` array (one entry per SKU).
 */
async function processThibaultItems({ order, orderId, items }) {
  if (items.length === 0) return [];

  const orderRequests = buildThibaultOrderPayloads(order, items);
  const results = [];

  for (const { sku, payload } of orderRequests) {
    // Written as soon as this SKU is confirmed Thibault-bound, before the
    // Thibault call is even attempted - so it shows up on the dashboard as
    // "pending" immediately rather than only appearing once resolved.
    const statusId = await recordPendingStatus({
      shopifyOrderId: orderId,
      orderNumber: order.name || order.order_number,
      sku,
    });

    // Catch a missing required ship_to field (zip/state) before spending a
    // call on Thibault's API - their rejection for this is a generic
    // "Shipping address details are invalid" (E016/E017 share the exact
    // same description, so their error alone never says which sub-field
    // failed). Checking ourselves first, against what their docs actually
    // document as required, gives an immediately actionable error instead
    // of another round of guessing.
    const shipToIssues = validateShipTo(payload.ship_to);
    if (shipToIssues.length > 0) {
      const validationError = `Invalid ship_to before sending to Thibault: ${shipToIssues.join('; ')}`;
      logEvent({
        level: 'error',
        orderId,
        sku,
        message: validationError,
        shipTo: payload.ship_to,
      });
      await sendFailureAlert('thibault_rejection', {
        orderId,
        orderName: order.name || order.order_number,
        sku,
        orderPayload: payload,
        thibaultError: validationError,
        thibaultResponse: null,
      });
      await markFailed(statusId, validationError);
      results.push({ sku, status: 'error', error: validationError });
      continue;
    }

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
          invoiceErr.message,
          { status: invoiceErr.status, response: invoiceErr.response }
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

  return results;
}

/**
 * Kimpex has no API - orders go out as a manually-uploaded Excel file (see
 * lib/kimpexExport.js / api/dashboard.js "Download Kimpex Export"). So
 * there's nothing to call here, no success/failure per SKU to report the
 * way Thibault has - just recording each matched line item as a pending
 * row in kimpex_pending_orders, to be picked up whenever the export is
 * next downloaded.
 */
async function processKimpexItems({ order, orderId, items }) {
  if (items.length === 0) return [];

  const rows = buildKimpexOrderRows(order, items);
  await recordPendingKimpexOrders(rows);

  logEvent({
    level: 'info',
    orderId,
    message: `Recorded ${rows.length} pending Kimpex order row(s)`,
    skus: rows.map((r) => r.sku),
  });

  return rows.map((r) => ({ sku: r.sku, status: 'recorded' }));
}

async function processOrder({ res, order, orderId }) {
  // Duplicate-order check: has EITHER distributor already recorded
  // something for this Shopify order (Shopify retries webhooks on
  // timeout)? Backed by Supabase, not a local file - a file can never
  // persist reliably across serverless invocations/instances. An order
  // with items for neither distributor never gets a row anywhere, so it
  // will redundantly re-check tags on a retry rather than short-circuit
  // here - harmless (nothing was ever going to be recorded for it anyway),
  // just a little wasted work.
  const alreadyProcessed =
    (await hasExistingStatusForOrder(orderId)) || (await hasExistingKimpexOrderForShopifyOrder(orderId));
  if (alreadyProcessed) {
    logEvent({ level: 'info', orderId, message: 'Duplicate webhook delivery, already processed - skipping' });
    return sendJson(res, 200, { status: 'skipped', reason: 'duplicate' });
  }

  const { itemsByTag, unresolvedItems } = await getLineItemsByTags(order, [THIBAULT_TAG, KIMPEX_TAG]);
  const thibaultItems = itemsByTag.get(THIBAULT_TAG) || [];
  const kimpexItems = itemsByTag.get(KIMPEX_TAG) || [];

  // "Unresolved" (tag lookup failed after retries) is distinct from
  // "confirmed not Thibault/Kimpex" - it must never be silently dropped,
  // and must never block items that DID resolve from being processed
  // normally. Reported once per line item, not once per distributor tag
  // checked - see lib/lineItemTagging.js.
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

  if (thibaultItems.length === 0 && kimpexItems.length === 0) {
    logEvent({
      level: 'info',
      orderId,
      message: 'No Thibault or Kimpex line items on this order - skipping',
      unresolvedCount: unresolvedItems.length,
    });
    return sendJson(res, 200, {
      status: 'skipped',
      reason: 'no_matching_items',
      unresolvedCount: unresolvedItems.length,
    });
  }

  const results = await processThibaultItems({ order, orderId, items: thibaultItems });
  const kimpexResults = await processKimpexItems({ order, orderId, items: kimpexItems });

  const anyFailed = results.some((r) => r.status === 'error');
  return sendJson(res, anyFailed ? 207 : 200, {
    status: anyFailed ? 'partial_failure' : 'success',
    results,
    kimpexResults,
    unresolvedCount: unresolvedItems.length,
  });
}

module.exports = ordersCreateHandler;
