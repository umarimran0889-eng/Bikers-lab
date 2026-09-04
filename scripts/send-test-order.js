require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TARGET_URL = process.env.TEST_TARGET_URL || 'http://localhost:3000/webhooks/orders/create';
const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const fixturePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'fixtures', 'sample-order.json');

async function main() {
  if (!SECRET) {
    console.error(
      'SHOPIFY_WEBHOOK_SECRET is not set. Copy .env.example to .env and set a value ' +
        '(any string works for local testing - it just needs to match what the dev ' +
        'server reads) before running this script.'
    );
    process.exit(1);
  }

  if (!fs.existsSync(fixturePath)) {
    console.error(`Fixture file not found: ${fixturePath}`);
    process.exit(1);
  }

  const rawBody = fs.readFileSync(fixturePath);
  const hmac = crypto.createHmac('sha256', SECRET).update(rawBody).digest('base64');

  console.log(`Sending ${fixturePath} to ${TARGET_URL}`);

  const res = await fetch(TARGET_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Topic': 'orders/create',
      'X-Shopify-Shop-Domain': 'biker-lab-test.myshopify.com',
    },
    body: rawBody,
  });

  const text = await res.text();
  console.log(`Response status: ${res.status}`);
  console.log(text);
}

main().catch((err) => {
  console.error('Test script failed:', err);
  process.exit(1);
});
