// Regression test for a real rejected order: Thibault's Order API returned
// E017 ("Shipping address details are invalid in the request body") for a
// genuine Mississauga, Ontario, Canada address. Confirms:
//   1. The current code already sources ship_to.state from
//      shipping_address.province_code ("ON"), not .province ("Ontario") -
//      this hypothesis turned out to already be correct, not the bug.
//   2. The exact real address (Mississauga, ON, L5T 1G3) maps to a ship_to
//      object satisfying Thibault's documented required fields (state,
//      zip) - validateShipTo() reports no issues for it.
//   3. validateShipTo() DOES catch a genuinely missing required field
//      (state or zip blank), which is the actual hardening this incident
//      led to - Thibault's E016/E017 share one generic description, so
//      catching this ourselves before sending gives an immediately
//      actionable error instead of decoding another opaque rejection.
//
// Run with: node scripts/test-shipto-mississauga.js

const { buildThibaultOrderPayloads, validateShipTo } = require('../lib/mapOrderToThibault');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${message}`);
  }
}

const realOrder = {
  id: 5559990001,
  name: '#MISS-1',
  order_number: 'MISS-1',
  note: '',
  shipping_address: {
    first_name: 'Real',
    last_name: 'Customer',
    company: '',
    address1: '100 City Centre Dr',
    address2: 'Unit 200',
    city: 'Mississauga',
    province: 'Ontario',
    province_code: 'ON',
    zip: 'L5T 1G3',
    country: 'Canada',
    country_code: 'CA',
    phone: '+19055551234',
  },
  phone: '+19055551234',
};

const lineItem = { id: 1, sku: 'REAL-SKU-1', quantity: 1 };

function main() {
  const payloads = buildThibaultOrderPayloads(realOrder, [lineItem]);
  const shipTo = payloads[0].payload.ship_to;
  console.log('Built ship_to:', JSON.stringify(shipTo, null, 2));

  assert(shipTo.state === 'ON', `state is the ISO province code "ON", not the full name "Ontario" (got "${shipTo.state}")`);
  assert(shipTo.zip === 'L5T 1G3', `zip preserves the real postal code as given by Shopify (got "${shipTo.zip}")`);
  assert(shipTo.city === 'Mississauga', `city is correct (got "${shipTo.city}")`);
  assert(shipTo.phone === '+19055551234', `phone is populated, not blank (got "${shipTo.phone}")`);
  assert(shipTo.line1 === '100 City Centre Dr', `line1 is correct (got "${shipTo.line1}")`);

  const issuesForRealAddress = validateShipTo(shipTo);
  assert(
    issuesForRealAddress.length === 0,
    `validateShipTo() reports no issues for this real address - it satisfies Thibault's documented required fields (got: ${JSON.stringify(issuesForRealAddress)})`
  );

  // Now confirm the validation actually catches a genuinely missing
  // required field, using the same real address minus province_code/zip -
  // this is the actual hardening added because of this incident.
  const brokenOrder = {
    ...realOrder,
    shipping_address: { ...realOrder.shipping_address, province_code: '', zip: '' },
  };
  const brokenPayloads = buildThibaultOrderPayloads(brokenOrder, [lineItem]);
  const brokenShipTo = brokenPayloads[0].payload.ship_to;
  const issuesForBrokenAddress = validateShipTo(brokenShipTo);

  assert(
    issuesForBrokenAddress.some((issue) => issue.includes('ship_to.state')),
    `validateShipTo() catches a missing state (got: ${JSON.stringify(issuesForBrokenAddress)})`
  );
  assert(
    issuesForBrokenAddress.some((issue) => issue.includes('ship_to.zip')),
    `validateShipTo() catches a missing zip (got: ${JSON.stringify(issuesForBrokenAddress)})`
  );

  if (process.exitCode === 1) {
    console.error('\nMississauga ship_to test FAILED');
  } else {
    console.log(
      '\nMississauga ship_to test passed: the real address (Mississauga, ON, L5T 1G3) maps correctly - state is ' +
        'the ISO code "ON" (already correct before this change), and the new validateShipTo() check both clears ' +
        'a valid real address and catches a genuinely missing required field.'
    );
  }
}

main();
