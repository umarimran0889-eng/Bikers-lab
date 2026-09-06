// Simulates a product tag lookup that fails every retry for ONE line item
// in a multi-item order, and confirms:
//   - the other line items in that order still process normally
//     (the confirmed-Thibault item gets forwarded, the confirmed-non-Thibault
//     item is correctly excluded)
//   - the failed item is logged via console.warn (`[unresolved-item]`), not
//     dropped and not treated as "confirmed not Thibault"
//   - retries actually happened (2 retries, ~300ms apart) before giving up
//
// Run with: node scripts/test-unresolved-item.js
// Uses the mock Shopify Admin client (forced, regardless of .env) and the
// simulated Thibault path (THIBAULT_LIVE_CALLS_ENABLED forced off) - no
// real network calls of any kind. Also doesn't load .env, so Supabase
// status writes are skipped entirely (logged, not attempted).

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

process.env.SHOPIFY_ADMIN_MOCK = 'true';
process.env.THIBAULT_LIVE_CALLS_ENABLED = 'false';
process.env.SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'test-secret-for-unresolved-item-test';

const retryWarnings = [];
let unresolvedItemLogLine = null;
const realWarn = console.warn;
console.warn = (...args) => {
  const msg = args.join(' ');
  if (msg.includes('[product-tags]') && msg.includes('7005550001')) {
    retryWarnings.push(msg);
  }
  if (msg.startsWith('[unresolved-item] ')) {
    unresolvedItemLogLine = msg.slice('[unresolved-item] '.length);
  }
  realWarn(...args);
};

const ordersCreateHandler = require('../api/webhooks/orders-create');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${message}`);
  }
}

function invokeHandler(bodyBuffer, secret) {
  const hmac = crypto.createHmac('sha256', secret).update(bodyBuffer).digest('base64');
  const req = {
    method: 'POST',
    headers: { 'x-shopify-hmac-sha256': hmac },
    body: bodyBuffer,
  };
  const res = {
    statusCode: undefined,
    body: undefined,
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
  return ordersCreateHandler(req, res).then(() => ({
    statusCode: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
  }));
}

async function main() {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'sample-order-with-unresolved-item.json');
  const bodyBuffer = fs.readFileSync(fixturePath);

  const { statusCode, body } = await invokeHandler(bodyBuffer, process.env.SHOPIFY_WEBHOOK_SECRET);
  console.log('Handler response:', statusCode, JSON.stringify(body));

  assert(statusCode === 200, `handler returns 200 (got ${statusCode})`);
  assert(body.status === 'success', `status is "success" (got "${body.status}")`);
  assert(body.unresolvedCount === 1, `unresolvedCount is 1 (got ${body.unresolvedCount})`);
  assert(body.results.length === 1, `exactly one item was forwarded, not three and not zero (got ${body.results.length})`);
  assert(
    body.results[0] && body.results[0].sku === 'TH-4521',
    `the forwarded item is the confirmed-Thibault SKU TH-4521 (got ${body.results[0] && body.results[0].sku})`
  );
  assert(
    body.results[0] && body.results[0].simulated === true,
    'the forwarded item went through the simulated Thibault path (THIBAULT_LIVE_CALLS_ENABLED is off)'
  );

  assert(
    retryWarnings.length === 2,
    `exactly 2 retry warnings were logged for the unresolvable product before giving up (got ${retryWarnings.length})`
  );

  assert(unresolvedItemLogLine !== null, 'a "[unresolved-item]" console.warn line was emitted');

  const unresolvedEntry = unresolvedItemLogLine ? JSON.parse(unresolvedItemLogLine) : {};
  assert(
    unresolvedEntry.sku === 'TH-UNRESOLVED-1',
    `unresolved log entry is for SKU TH-UNRESOLVED-1, not dropped and not silently excluded (got ${unresolvedEntry.sku})`
  );
  assert(
    unresolvedEntry.productId === 7005550001,
    `unresolved log entry has the correct product_id (got ${unresolvedEntry.productId})`
  );
  assert(
    unresolvedEntry.orderId === 5551234567999,
    `unresolved log entry has the correct Shopify order id (got ${unresolvedEntry.orderId})`
  );
  assert(
    unresolvedEntry.orderName === '#1043',
    `unresolved log entry has the correct Shopify order name (got ${unresolvedEntry.orderName})`
  );

  if (process.exitCode === 1) {
    console.error('\nUnresolved-item test FAILED');
  } else {
    console.log(
      '\nUnresolved-item test passed: the confirmed-Thibault item was still forwarded, the confirmed-non-Thibault ' +
        'item was still correctly excluded, and the item whose lookup failed after retries was logged as ' +
        'unresolved rather than dropped or wrongly excluded.'
    );
  }
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
