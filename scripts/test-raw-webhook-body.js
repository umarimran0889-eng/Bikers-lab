// Tests the ACTUAL raw-body-reading path used in production: reading the
// request as a raw byte stream (req.on('data'/'end')), NOT a pre-set
// req.body. This is the path Vercel uses once NODEJS_HELPERS=0 is set (see
// api/webhooks/orders-create.js), and the path every genuine Shopify
// webhook delivery goes through.
//
// None of the other test scripts exercise this: they all construct a fake
// req with `body` already set to a Buffer, which takes a shortcut straight
// past the stream-reading code entirely. That's exactly why the regression
// this test targets - Vercel's Node.js helpers pre-parsing req.body (and
// thereby consuming the raw stream) for Content-Type: application/json,
// before our own code could read the original bytes - slipped through
// every existing test and only showed up against real Shopify traffic.
//
// Two scenarios:
//   1. Helpers disabled (NODEJS_HELPERS=0, the required Vercel project
//      setting) - req.body is undefined, the real stream is intact - the
//      handler reads it correctly and a genuinely valid signature passes.
//   2. Helpers still active (misconfigured environment) - req.body is
//      already a parsed object - the handler must fail loudly and
//      clearly, naming the actual fix, not silently mis-verify.
//
// Run with: node scripts/test-raw-webhook-body.js

const crypto = require('crypto');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');

process.env.SHOPIFY_ADMIN_MOCK = 'true';
process.env.THIBAULT_LIVE_CALLS_ENABLED = 'false';
process.env.SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'test-secret-for-raw-body-test';

const ordersCreateHandler = require('../api/webhooks/orders-create');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${message}`);
  }
}

/**
 * A req that behaves like a genuine raw Node.js IncomingMessage stream -
 * `body` is NOT pre-set; the raw bytes are only obtainable by listening
 * for 'data'/'end' events, exactly like the real HTTP request Shopify
 * sends, and like Vercel's Node runtime with NODEJS_HELPERS=0.
 */
function makeRawStreamReq(rawBodyBuffer, headers) {
  const stream = new Readable({
    read() {
      this.push(rawBodyBuffer);
      this.push(null);
    },
  });
  stream.method = 'POST';
  stream.headers = headers;
  return stream;
}

/**
 * A req that mimics Vercel's Node.js helpers having already parsed the
 * body (Content-Type: application/json -> plain object) - simulating what
 * happens if NODEJS_HELPERS=0 is NOT set. The raw stream is already
 * ended/drained, matching how the helper consumes the bytes before
 * handler code ever runs.
 */
function makeHelperParsedReq(parsedBodyObject, headers) {
  const stream = new Readable({ read() {} });
  stream.push(null);
  stream.method = 'POST';
  stream.headers = headers;
  stream.body = parsedBodyObject;
  return stream;
}

function makeRes() {
  return {
    statusCode: undefined,
    body: undefined,
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
}

async function main() {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'sample-order.json');
  const rawBody = fs.readFileSync(fixturePath);
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const validHmac = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  console.log('--- Scenario 1: NODEJS_HELPERS=0 (raw stream, correct config) ---');
  const req1 = makeRawStreamReq(rawBody, {
    'x-shopify-hmac-sha256': validHmac,
    'user-agent': 'Shopify-Captain-Hook',
  });
  const res1 = makeRes();
  await ordersCreateHandler(req1, res1);
  const body1 = res1.body ? JSON.parse(res1.body) : null;
  console.log('Response:', res1.statusCode, res1.body);
  assert(
    res1.statusCode === 200,
    `a genuinely raw, correctly-signed request (real stream, no pre-set body) passes HMAC verification and returns 200 (got ${res1.statusCode})`
  );
  assert(body1 && body1.status === 'success', `status is "success" (got "${body1 && body1.status}")`);

  console.log('\n--- Scenario 2: helpers still active (req.body pre-parsed, misconfigured) ---');
  const parsedOrder = JSON.parse(rawBody.toString('utf8'));
  const req2 = makeHelperParsedReq(parsedOrder, {
    'x-shopify-hmac-sha256': validHmac,
    'user-agent': 'Shopify-Captain-Hook',
  });
  const res2 = makeRes();
  await ordersCreateHandler(req2, res2);
  console.log('Response:', res2.statusCode, res2.body);
  assert(
    res2.statusCode === 500,
    `a pre-parsed req.body (helpers still active) is caught explicitly, not silently mis-verified (got ${res2.statusCode})`
  );
  assert(
    Boolean(res2.body && res2.body.includes('raw request body unavailable')),
    `the error clearly names the actual failure, not a generic HMAC mismatch (got: ${res2.body})`
  );

  if (process.exitCode === 1) {
    console.error('\nRaw webhook body test FAILED');
  } else {
    console.log(
      '\nRaw webhook body test passed: a genuinely raw request stream (matching NODEJS_HELPERS=0 / a real ' +
        'Shopify delivery) verifies correctly and processes the order, and the "helpers still active" ' +
        'misconfiguration is caught with a clear, actionable error instead of a confusing generic HMAC failure.'
    );
  }
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
