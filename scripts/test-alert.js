// Exercises sendFailureAlert() for all four alert scenarios with fake data.
//
// If RESEND_API_KEY and ALERT_EMAIL_TO are set (in .env), this sends four
// REAL emails via Resend to confirm delivery end-to-end. If either is
// missing, lib/alerts.js automatically falls back to logging what would
// have been sent instead - same auto-detect pattern used for the Shopify
// Admin / Thibault mocks elsewhere in this project.
//
// Run with: node scripts/test-alert.js

require('dotenv').config();
const { sendFailureAlert } = require('../lib/alerts');

async function main() {
  const live = Boolean(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_TO);
  console.log(`Alert delivery mode: ${live ? 'LIVE (real email via Resend)' : 'MOCK (logged only, not sent)'}`);
  console.log(`ALERT_EMAIL_TO: ${process.env.ALERT_EMAIL_TO || '(not set)'}`);
  console.log(`ALERT_EMAIL_FROM: ${process.env.ALERT_EMAIL_FROM || '(not set - defaulting to onboarding@resend.dev)'}`);
  console.log('');

  console.log('--- 1. Thibault API rejection ---');
  await sendFailureAlert('thibault_rejection', {
    orderId: 5551234567890,
    orderName: '#1042',
    sku: 'TH-4521',
    orderPayload: {
      item: [{ sku: 'TH-4521', qty: 2 }],
      ship_to: { contact: 'Alex Tremblay', city: 'Montreal', state: 'QC', zip: 'H2X 1Y6' },
      dropship: true,
    },
    thibaultError: 'Thibault API responded with 400',
    thibaultResponse: { errors: { id: 'E013', data: 'TH-4521' } },
  });

  console.log('\n--- 2. Unresolved tag lookup ---');
  await sendFailureAlert('unresolved_item', {
    orderId: 5551234567999,
    orderName: '#1043',
    productId: 7005550001,
    sku: 'TH-UNRESOLVED-1',
    lineItemId: 998877103,
    lookupError: 'Simulated Shopify Admin API failure (404 Not Found)',
  });

  console.log('\n--- 3. Shopify Admin token refresh failure ---');
  await sendFailureAlert('admin_token_failure', {
    error: 'Shopify OAuth token request failed with 401',
    status: 401,
    response: '{"error":"invalid_client"}',
  });

  console.log('\n--- 4. Unhandled webhook handler error ---');
  await sendFailureAlert('unhandled_error', {
    orderId: 5551234567890,
    orderName: '#1042',
    error: "Cannot read properties of undefined (reading 'foo')",
    stack: "TypeError: Cannot read properties of undefined (reading 'foo')\n    at processOrder (api/webhooks/orders-create.js:100:5)",
  });

  console.log(`\nAll 4 alert scenarios exercised in ${live ? 'LIVE' : 'MOCK'} mode.`);
  if (live) {
    console.log(`Check ${process.env.ALERT_EMAIL_TO} for 4 emails with distinct subject lines.`);
  }
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
