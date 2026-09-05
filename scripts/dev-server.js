require('dotenv').config();
const express = require('express');
const ordersCreateHandler = require('../api/webhooks/orders-create');
const dashboardHandler = require('../api/dashboard');
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

// GET renders the login form or the dashboard table (depending on the
// session cookie); POST handles the login form submission. Same handler
// for both - see api/dashboard.js.
function handleDashboard(req, res) {
  dashboardHandler(req, res).catch((err) => {
    console.error('Unhandled error in dashboard handler:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });
}
app.get('/dashboard', handleDashboard);
app.post('/dashboard', handleDashboard);

app.get('/', (_req, res) => {
  res.send('Biker Lab Thibault order forwarder - local dev server is running. See /dashboard for order status.');
});

app.listen(PORT, () => {
  console.log(`Local dev server listening on http://localhost:${PORT}`);
  console.log(`POST signed Shopify order payloads to http://localhost:${PORT}/webhooks/orders/create`);
  console.log('Run "npm run test:order" in another terminal to send the sample order.');
  console.log(
    `Product tag lookups: ${isMockMode() ? 'MOCKED (fixtures/product-tags.json)' : 'LIVE Shopify Admin API'}`
  );
  console.log(
    `Order status dashboard: http://localhost:${PORT}/dashboard (password: DASHBOARD_PASSWORD from .env)`
  );
});
