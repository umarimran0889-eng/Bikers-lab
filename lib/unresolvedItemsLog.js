const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const UNRESOLVED_LOG_FILE = path.join(LOG_DIR, 'unresolved-items.log');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Logs a line item whose Thibault-tag status could not be determined - the
 * Shopify Admin product tag lookup failed even after retries (see
 * lib/productTags.js). Deliberately kept separate from
 * logs/forwarded-orders.log: "unresolved" (we don't know) is not the same
 * as "confirmed not Thibault" or "Thibault API rejected it", and needs a
 * human to manually check whether this item should have gone to Thibault.
 */
function logUnresolvedItem({ orderId, orderName, productId, sku, lineItemId, error }) {
  ensureLogDir();
  const entry = {
    timestamp: new Date().toISOString(),
    orderId,
    orderName,
    productId,
    sku,
    lineItemId,
    error,
  };
  const line = JSON.stringify(entry);
  console.warn(`[unresolved-item] ${line}`);
  fs.appendFileSync(UNRESOLVED_LOG_FILE, line + '\n');
}

module.exports = { logUnresolvedItem, UNRESOLVED_LOG_FILE };
