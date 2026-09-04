const fs = require('fs');
const path = require('path');

// Short-lived file-based cache of product_id -> tags, so an order with
// repeat/frequent SKUs doesn't re-hit the Shopify Admin API every time.
// Same simple approach as lib/dedupeStore.js - not concurrency-safe, fine
// for local dev and single-instance use for now.
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'product-tag-cache.json');
const TTL_MS = 60 * 60 * 1000; // 1 hour

function ensureCache() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, '{}');
}

function readCache() {
  ensureCache();
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  ensureCache();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function getCachedTags(productId) {
  const cache = readCache();
  const entry = cache[String(productId)];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry.tags;
}

function setCachedTags(productId, tags) {
  const cache = readCache();
  cache[String(productId)] = { tags, fetchedAt: Date.now() };
  writeCache(cache);
}

module.exports = { getCachedTags, setCachedTags, TTL_MS };
