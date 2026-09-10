// Verifies a webhook run with a Kimpex-tagged line item writes a correct
// row to kimpex_pending_orders, using real .env Supabase credentials (this
// test is specifically about verifying real Supabase writes, like
// scripts/test-dashboard.js). Also confirms a Thibault-tagged item in the
// SAME order still processes independently (both distributors handled
// side by side, per the requirement), and that a plain non-tagged item is
// excluded from both.
//
// Uses a throwaway, uniquely-generated order id so it can't collide with
// anything real, and deletes its own test rows from both tables
// afterward. Never touches Thibault's or Shopify's real APIs (forces
// THIBAULT_LIVE_CALLS_ENABLED=false and SHOPIFY_ADMIN_MOCK=true regardless
// of .env).
//
// Run with: node scripts/test-kimpex-order.js

require('dotenv').config();

process.env.THIBAULT_LIVE_CALLS_ENABLED = 'false';
process.env.SHOPIFY_ADMIN_MOCK = 'true';
process.env.SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'test-secret-for-kimpex-order-test';

const crypto = require('crypto');
const ordersCreateHandler = require('../api/webhooks/orders-create');
const { deleteStatusesForOrder } = require('../lib/orderStatus');
const { listRecentKimpexOrders, deleteKimpexOrdersForShopifyOrder } = require('../lib/kimpexOrders');

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
        'to verify real writes to kimpex_pending_orders. Set them and re-run.'
    );
    process.exit(1);
  }

  const testOrderId = `TEST-KIMPEX-${Date.now()}`;
  const testOrder = {
    id: testOrderId,
    name: '#TESTKIMPEX',
    order_number: 'TESTKIMPEX',
    note: 'Automated Kimpex test order - safe to ignore',
    shipping_address: {
      first_name: 'Test',
      last_name: 'Kimpex',
      address1: '456 Warehouse Rd',
      address2: 'Suite 2',
      city: 'Mississauga',
      province: 'Ontario',
      province_code: 'ON',
      zip: 'L5T 1G3',
      country: 'Canada',
      country_code: 'CA',
      phone: '+19055550000',
    },
    customer: { email: 'test-kimpex@example.com' },
    line_items: [
      {
        id: 1,
        product_id: 7002234567, // tagged "Supplier-Kimpex" in fixtures/product-tags.json
        sku: 'TEST-KIMPEX-SKU',
        title: 'Test Kimpex Helmet',
        quantity: 2,
        price: '149.99',
      },
      {
        id: 2,
        product_id: 7001234567, // tagged "Supplier-Thibault" - should process independently
        sku: 'TEST-THIBAULT-SKU',
        title: 'Test Thibault Part',
        quantity: 1,
        price: '39.99',
      },
      {
        id: 3,
        product_id: 7009998888, // tagged neither - should be excluded from both
        sku: 'TEST-NEITHER-SKU',
        title: 'Untagged Product',
        quantity: 1,
        price: '9.99',
      },
    ],
  };

  try {
    const { statusCode, body } = await invokeHandler(testOrder, process.env.SHOPIFY_WEBHOOK_SECRET);
    console.log('Handler response:', statusCode, JSON.stringify(body));

    assert(statusCode === 200, `handler returns 200 (got ${statusCode})`);
    assert(body && body.status === 'success', `status is "success" (got "${body && body.status}")`);
    assert(
      Array.isArray(body.results) && body.results.length === 1 && body.results[0].sku === 'TEST-THIBAULT-SKU',
      `the Thibault-tagged item was processed independently via the existing Thibault pipeline (got ${JSON.stringify(body.results)})`
    );
    assert(
      Array.isArray(body.kimpexResults) &&
        body.kimpexResults.length === 1 &&
        body.kimpexResults[0].sku === 'TEST-KIMPEX-SKU' &&
        body.kimpexResults[0].status === 'recorded',
      `the Kimpex-tagged item was recorded (got ${JSON.stringify(body.kimpexResults)})`
    );

    const allKimpexRows = await listRecentKimpexOrders(200);
    const rows = allKimpexRows.filter((r) => r.shopify_order_id === String(testOrderId));

    assert(rows.length === 1, `exactly 1 row was written to kimpex_pending_orders - only for the Kimpex-tagged item (got ${rows.length})`);

    const row = rows[0];
    console.log('Written row:', JSON.stringify(row, null, 2));

    assert(row.order_number === '#TESTKIMPEX', `order_number is the Shopify order name (got "${row.order_number}")`);
    assert(row.recipient_name === 'Test Kimpex', `recipient_name is correct (got "${row.recipient_name}")`);
    assert(row.ship_address_1 === '456 Warehouse Rd', `ship_address_1 is correct (got "${row.ship_address_1}")`);
    assert(row.ship_address_2 === 'Suite 2', `ship_address_2 is correct (got "${row.ship_address_2}")`);
    assert(row.ship_city === 'Mississauga', `ship_city is correct (got "${row.ship_city}")`);
    assert(row.ship_postal_code === 'L5T 1G3', `ship_postal_code is correct (got "${row.ship_postal_code}")`);
    assert(
      row.ship_state === 'ON',
      `ship_state is the 2-letter province CODE "ON", not the full name "Ontario" (got "${row.ship_state}") - Kimpex's own upload errors say to use the 2-letter code`
    );
    assert(
      row.ship_country === 'CA',
      `ship_country is the 2-letter country CODE "CA", not the full name "Canada" (got "${row.ship_country}") - same lesson as ship_state, confirmed from Kimpex's own docs`
    );
    assert(row.buyer_phone_number === '+19055550000', `buyer_phone_number is correct (got "${row.buyer_phone_number}")`);
    assert(row.buyer_email === 'test-kimpex@example.com', `buyer_email is correct (got "${row.buyer_email}")`);
    assert(row.sku === 'TEST-KIMPEX-SKU', `sku is correct (got "${row.sku}")`);
    assert(row.product_name === 'Test Kimpex Helmet', `product_name is correct (got "${row.product_name}")`);
    assert(row.quantity_purchased === 2, `quantity_purchased is correct (got ${row.quantity_purchased})`);
    assert(Number(row.item_price) === 149.99, `item_price is correct (got ${row.item_price})`);
    assert(row.exported === false, `exported defaults to false (got ${row.exported})`);
  } finally {
    console.log(`Cleaning up: deleting test rows for order id ${testOrderId}...`);
    await deleteStatusesForOrder(testOrderId);
    await deleteKimpexOrdersForShopifyOrder(testOrderId);
  }

  if (process.exitCode === 1) {
    console.error('\nKimpex order test FAILED');
  } else {
    console.log(
      '\nKimpex order test passed: the Kimpex-tagged item was correctly recorded with the right address/contact/' +
        'product fields (province and country as 2-letter codes), the Thibault-tagged item in the same order was ' +
        'still processed independently, and the untagged item was excluded from both. Test rows cleaned up.'
    );
  }
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
