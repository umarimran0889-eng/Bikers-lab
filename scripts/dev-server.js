require('dotenv').config();
const express = require('express');
const ordersCreateHandler = require('../api/webhooks/orders-create');
const { isMockMode } = require('../lib/productTags');

const app = express();
const PORT = process.env.PORT || 3000;

// No express.json()/body-parser middleware here on purpose - the handler
// needs the untouched raw request stream to verify Shopify's HMAC signature.
app.post('/webhooks/orders/create', (req, res) => {
  ordersCreateHandler(req, res).catch((err) => {
    console.error('Unhandled error in orders-create handler:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });
});

app.get('/', (_req, res) => {
  res.send('Biker Lab Thibault order forwarder - local dev server is running.');
});

app.listen(PORT, () => {
  console.log(`Local dev server listening on http://localhost:${PORT}`);
  console.log(`POST signed Shopify order payloads to http://localhost:${PORT}/webhooks/orders/create`);
  console.log('Run "npm run test:order" in another terminal to send the sample order.');
  console.log(
    `Product tag lookups: ${isMockMode() ? 'MOCKED (fixtures/product-tags.json)' : 'LIVE Shopify Admin API'}`
  );
});
