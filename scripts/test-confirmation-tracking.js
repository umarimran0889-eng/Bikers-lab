// Tests the new Thibault order-confirmation + tracking feature in two parts:
//
// Part A (hermetic, no .env, no real network): mocks `fetch` to return
// responses shaped exactly like Thibault's documented /invoices and
// /tracking response ({ items: [{ document: {...}, shipment: [{...}] }] }),
// and verifies lib/thibaultClient.js's checkThibaultInvoice()/
// getThibaultTracking() parse them correctly - both the "found" and
// "not found" (empty items) cases. THIBAULT_LIVE_CALLS_ENABLED is forced
// "true" ONLY for this in-process mocked-fetch test, so the parsing logic
// (which only runs on the live-calls path) actually gets exercised - no
// real network call happens since fetch itself is replaced.
//
// Part B (loads real .env, like scripts/test-dashboard.js): writes a
// throwaway row via lib/orderStatus.js, marks it confirmed with fake
// Thibault numbers, updates its tracking info, reads it back, asserts
// everything round-tripped correctly, then deletes it.
//
// Run with: node scripts/test-confirmation-tracking.js

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${message}`);
  }
}

async function testPartA() {
  console.log('--- Part A: response parsing (mocked fetch) ---');

  process.env.THIBAULT_LIVE_CALLS_ENABLED = 'true';
  process.env.THIBAULT_API_TOKEN = 'test-token';

  const realFetch = global.fetch;
  let nextResponse = null;
  let lastUrl = null;
  global.fetch = async (url) => {
    lastUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(nextResponse),
    };
  };

  // Force a fresh require so the module reads the env vars set just above.
  delete require.cache[require.resolve('../lib/thibaultClient')];
  const { checkThibaultInvoice, getThibaultTracking } = require('../lib/thibaultClient');

  // --- invoices: found ---
  nextResponse = {
    items: [
      {
        document: { order: 445566, invoice: 'INV-9001', order_date: 1735689600, invoice_date: 1735776000 },
        recipient: { name: 'Jane Doe', city: 'Testville' },
        shipment: [{ pin: '1Z999AA10123456784', carrier: 'UPS', label_date: 1735862400, eta_date: 1736035200 }],
      },
    ],
  };
  const invoiceFound = await checkThibaultInvoice('#TEST-1042');
  assert(String(lastUrl).includes('customer_refs=%23TEST-1042'), 'invoice lookup URL includes the encoded customer_refs value');
  assert(invoiceFound.found === true, 'invoice lookup reports found:true when Thibault returns a matching item');
  assert(invoiceFound.orderNumber === 445566, `invoice lookup extracts document.order as orderNumber (got ${invoiceFound.orderNumber})`);
  assert(invoiceFound.invoiceNumber === 'INV-9001', `invoice lookup extracts document.invoice as invoiceNumber (got ${invoiceFound.invoiceNumber})`);

  // --- invoices: not found (empty items) ---
  nextResponse = { items: [] };
  const invoiceNotFound = await checkThibaultInvoice('#TEST-9999');
  assert(invoiceNotFound.found === false, 'invoice lookup reports found:false when Thibault returns an empty items array');

  // --- tracking: found ---
  nextResponse = {
    items: [
      {
        document: { order: 445566, invoice: 'INV-9001' },
        shipment: [{ pin: '1Z999AA10123456784', carrier: 'UPS', label_date: 1735862400, eta_date: 1736035200 }],
      },
    ],
  };
  const trackingFound = await getThibaultTracking(445566);
  assert(String(lastUrl).includes('order=445566'), 'tracking lookup URL includes the order number as the "order" query param');
  assert(trackingFound.found === true, 'tracking lookup reports found:true when Thibault returns shipment data');
  assert(trackingFound.carrier === 'UPS', `tracking lookup extracts shipment.carrier (got ${trackingFound.carrier})`);
  assert(trackingFound.trackingPin === '1Z999AA10123456784', `tracking lookup extracts shipment.pin as trackingPin (got ${trackingFound.trackingPin})`);
  assert(
    trackingFound.shippedAt === new Date(1735862400 * 1000).toISOString(),
    `tracking lookup converts shipment.label_date (epoch seconds) to an ISO timestamp (got ${trackingFound.shippedAt})`
  );

  // --- tracking: not found ---
  nextResponse = { items: [] };
  const trackingNotFound = await getThibaultTracking(999999);
  assert(trackingNotFound.found === false, 'tracking lookup reports found:false when Thibault returns an empty items array');

  global.fetch = realFetch;
}

async function testPartB() {
  console.log('\n--- Part B: Supabase round-trip (real credentials) ---');

  require('dotenv').config();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set - skipping the Supabase round-trip part of this test.');
    return;
  }

  delete require.cache[require.resolve('../lib/orderStatus')];
  const { recordPendingStatus, markSent, markConfirmed, updateTracking, getStatusById, deleteStatusesForOrder } =
    require('../lib/orderStatus');

  const testOrderId = `TEST-CONFIRM-${Date.now()}`;

  try {
    const id = await recordPendingStatus({
      shopifyOrderId: testOrderId,
      orderNumber: '#TESTCONFIRM',
      sku: 'TEST-CONFIRM-SKU',
    });
    assert(id != null, 'recordPendingStatus returns a row id');

    await markSent(id, { simulated: true });
    await markConfirmed(id, { thibaultOrderNumber: 778899, thibaultInvoiceNumber: 'INV-7788' });
    await updateTracking(id, {
      carrier: 'FedEx',
      trackingPin: '9611918123456789012345',
      shippedAt: new Date('2026-01-15T12:00:00Z').toISOString(),
    });

    const row = await getStatusById(id);
    assert(Boolean(row), 'getStatusById returns the row after all updates');
    assert(row && row.confirmation === 'confirmed', `row.confirmation is "confirmed" (got ${row && row.confirmation})`);
    assert(row && row.thibault_order_number === '778899', `row.thibault_order_number round-tripped correctly (got ${row && row.thibault_order_number})`);
    assert(row && row.thibault_invoice_number === 'INV-7788', `row.thibault_invoice_number round-tripped correctly (got ${row && row.thibault_invoice_number})`);
    assert(row && row.tracking_carrier === 'FedEx', `row.tracking_carrier round-tripped correctly (got ${row && row.tracking_carrier})`);
    assert(
      row && row.tracking_pin === '9611918123456789012345',
      `row.tracking_pin round-tripped correctly (got ${row && row.tracking_pin})`
    );
    assert(Boolean(row && row.tracking_shipped_at), 'row.tracking_shipped_at was written');
  } finally {
    console.log(`Cleaning up: deleting test rows for order id ${testOrderId}...`);
    await deleteStatusesForOrder(testOrderId);
  }
}

async function main() {
  await testPartA();
  await testPartB();

  if (process.exitCode === 1) {
    console.error('\nConfirmation/tracking test FAILED');
  } else {
    console.log(
      '\nConfirmation/tracking test passed: invoice + tracking response parsing matches Thibault\'s documented ' +
        'shape (both found and not-found cases), and confirmation/tracking fields round-trip correctly through Supabase.'
    );
  }
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
