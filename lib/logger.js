const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'forwarded-orders.log');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Logs a structured event to stdout and appends it to logs/forwarded-orders.log
 * (one JSON object per line) so results are inspectable after a local test run.
 */
function logEvent(event) {
  ensureLogDir();
  const entry = { timestamp: new Date().toISOString(), ...event };
  const line = JSON.stringify(entry);
  console.log(`[thibault-forwarder] ${line}`);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

module.exports = { logEvent };
