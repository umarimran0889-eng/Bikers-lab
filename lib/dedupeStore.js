const fs = require('fs');
const path = require('path');

// Simple file-based store to protect against duplicate webhook deliveries
// (Shopify retries orders/create on timeout). Not concurrency-safe and not
// meant to survive a real multi-instance deployment - fine for local
// development and single-instance use for now.
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'processed-orders.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, '{}');
}

function readStore() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function hasBeenProcessed(shopifyOrderId) {
  const store = readStore();
  return Boolean(store[String(shopifyOrderId)]);
}

function markProcessed(shopifyOrderId, result) {
  const store = readStore();
  store[String(shopifyOrderId)] = {
    processedAt: new Date().toISOString(),
    ...result,
  };
  writeStore(store);
}

module.exports = { hasBeenProcessed, markProcessed };
