// Verifies a webhook run correctly writes pending -> sent/failed rows to
// Supabase, using your real .env credentials (SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY). Deliberately loads .env (unlike the other
// scripts/test-*.js scripts) since the whole point is exercising the real
// database - if those two vars aren't set, this explains that and exits
// rather than silently passing without having tested anything.
//
// Uses a throwaway, uniquely-generated order id so it can't collide with
// anything real, and deletes its own test rows from Supabase afterward -
// this script does not leave test data behind on your dashboard.
//
// Never touches Thibault's real API or Shopify's real Admin API: forces
// THIBAULT_LIVE_CALLS_ENABLED=false and SHOPIFY_ADMIN_MOCK=true regardless
// of what's in .env.
//
// Run with: node scripts/test-dashboard.js

require('dotenv').config();

process.env.THIBAULT_LIVE_CALLS_ENABLED = 'false';
process.env.SHOPIFY_ADMIN_MOCK = 'true';
process.env.SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'test-secret-for-dashboard-test';

const crypto = require('crypto');
const ordersCreateHandler = require('../api/webhooks/orders-create');
const { listRecentStatuses, deleteStatusesForOrder } = require('../lib/orderStatus');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${message}`);
  }
}

function invokeHandler(order, secret) {
  const rawBody = Buffer.from(JSON.stringify(order));
  const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const req = {
    method: 'POST',
    headers: { 'x-shopify-hmac-sha256': hmac },
    body: rawBody,
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
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      'SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set in .env - this test needs real credentials ' +
        'to verify real writes to your order_status table. Set them and re-run.'
    );
    process.exit(1);
  }

  const testOrderId = `TEST-DASHBOARD-${Date.now()}`;
  const testOrder = {
    id: testOrderId,
    name: '#TESTDASH',
    order_number: 'TESTDASH',
    note: 'Automated dashboard test order - safe to ignore',
    shipping_address: {
      first_name: 'Test',
      last_name: 'Dashboard',
      address1: '1 Test St',
      city: 'Testville',
      province_code: 'ON',
      zip: 'T3S 7T3',
      phone: '+15550000000',
    },
    line_items: [
      {
        id: 1,
        product_id: 7001234567, // tagged "Supplier-Thibault" in fixtures/product-tags.json
        sku: 'TEST-DASH-SKU',
        quantity: 1,
        vendor: 'Test Vendor',
      },
      {
        id: 2,
        product_id: 7009998888, // NOT tagged Thibault in fixtures/product-tags.json
        sku: 'TEST-DASH-NONTHIBAULT',
        quantity: 1,
        vendor: 'Test Vendor',
      },
    ],
  };

  console.log(`Running the webhook handler for test order ${testOrder.name} (id: ${testOrderId})...`);

  try {
    const { statusCode, body } = await invokeHandler(testOrder, process.env.SHOPIFY_WEBHOOK_SECRET);
    console.log('Handler response:', statusCode, JSON.stringify(body));

    assert(statusCode === 200, `handler returns 200 (got ${statusCode})`);
    assert(body && body.status === 'success', `status is "success" (got "${body && body.status}")`);

    const allRecent = await listRecentStatuses(200);
    const statuses = allRecent.filter((r) => r.shopify_order_id === String(testOrderId));

    assert(
      statuses.length === 1,
      `exactly 1 status row was written - only for the Thibault-matched SKU, not the non-Thibault one (got ${statuses.length})`
    );

    const row = statuses[0];
    assert(Boolean(row) && row.sku === 'TEST-DASH-SKU', `the row is for the Thibault-matched SKU TEST-DASH-SKU (got ${row && row.sku})`);
    assert(Boolean(row) && row.status === 'sent', `the row's status is "sent" (got ${row && row.status})`);
    assert(
      Boolean(row) && row.distributor === 'thibault',
      `the row's distributor is "thibault" (got ${row && row.distributor})`
    );
    assert(
      Boolean(row) && row.order_number === '#TESTDASH',
      `the row's order_number is "#TESTDASH" (got ${row && row.order_number})`
    );
    assert(
      Boolean(row) && typeof row.error_message === 'string' && row.error_message.includes('Simulated'),
      `the row's error_message notes it was simulated, since THIBAULT_LIVE_CALLS_ENABLED is off (got: ${row && row.error_message})`
    );
  } finally {
    console.log(`Cleaning up: deleting test rows for order id ${testOrderId}...`);
    await deleteStatusesForOrder(testOrderId);
  }

  if (process.exitCode === 1) {
    console.error('\nDashboard/Supabase test FAILED');
  } else {
    console.log(
      '\nDashboard/Supabase test passed: the webhook handler wrote a pending row for the Thibault-matched SKU and ' +
        'correctly updated it to "sent" (simulated) once the Thibault call resolved. Test rows were cleaned up ' +
        'afterward, so nothing was left on your real dashboard.'
    );
  }
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
