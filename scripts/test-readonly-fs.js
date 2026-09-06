// Simulates Vercel's actual serverless filesystem constraint - writable
// ONLY under the OS temp directory (Vercel's /tmp), everything else
// read-only - by intercepting every fs write/mkdir call and throwing
// exactly the kind of error Vercel reported in production
// (ENOENT on a project-relative path) for anything outside temp.
//
// Then runs the real webhook handler through a realistic order and asserts
// it completes successfully WITHOUT ever attempting such a write. This is
// what caught (and now proves the fix for) the production crash: local
// dev's filesystem is fully writable, which is exactly what let a
// project-relative `logs/`/`data/` write pass silently until it hit
// Vercel's real constraint.
//
// Run with: node scripts/test-readonly-fs.js

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DIR = fs.realpathSync(os.tmpdir());
const WRITE_METHODS = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'writeFile', 'appendFile', 'mkdir'];

const blockedAttempts = [];

function isUnderTmp(targetPath) {
  try {
    return path.resolve(String(targetPath)).startsWith(TMP_DIR);
  } catch {
    return false;
  }
}

for (const method of WRITE_METHODS) {
  const original = fs[method];
  fs[method] = function patched(targetPath, ...rest) {
    if (!isUnderTmp(targetPath)) {
      const err = new Error(`ENOENT: no such file or directory, ${method} '${targetPath}'`);
      err.code = 'ENOENT';
      blockedAttempts.push({ method, path: String(targetPath) });
      if (method.endsWith('Sync')) throw err;
      const cb = rest[rest.length - 1];
      if (typeof cb === 'function') return cb(err);
      return Promise.reject(err);
    }
    return original.call(fs, targetPath, ...rest);
  };
}

process.env.SHOPIFY_ADMIN_MOCK = 'true';
process.env.THIBAULT_LIVE_CALLS_ENABLED = 'false';
process.env.SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'test-secret-for-readonly-fs-test';
// Deliberately no dotenv/.env load - Supabase being unconfigured here is
// irrelevant to what this test checks (it already fails open on its own,
// covered by other tests) and keeps this one hermetic.

const crypto = require('crypto');
const ordersCreateHandler = require('../api/webhooks/orders-create');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${message}`);
  }
}

function invokeHandler(order, secret) {
  const rawBody = Buffer.from(JSON.stringify(order));
  const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const req = {
    method: 'POST',
    headers: { 'x-shopify-hmac-sha256': hmac },
    body: rawBody,
  };
  const res = {
    statusCode: undefined,
    body: undefined,
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
  return ordersCreateHandler(req, res).then(() => ({
    statusCode: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
  }));
}

async function main() {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'sample-order.json');
  const order = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  order.id = Date.now(); // fresh id each run

  let statusCode;
  let body;
  let crashed = null;
  try {
    ({ statusCode, body } = await invokeHandler(order, process.env.SHOPIFY_WEBHOOK_SECRET));
  } catch (err) {
    crashed = err;
  }

  assert(crashed === null, `handler did not throw/crash under a simulated read-only filesystem (${crashed && crashed.message})`);
  assert(statusCode === 200, `handler returns 200 (got ${statusCode})`);
  assert(body && body.status === 'success', `status is "success" (got "${body && body.status}")`);
  assert(
    blockedAttempts.length === 0,
    `zero disk writes were attempted outside the OS temp dir (got ${blockedAttempts.length}: ${JSON.stringify(blockedAttempts)})`
  );

  if (process.exitCode === 1) {
    console.error('\nRead-only filesystem test FAILED');
  } else {
    console.log(
      "\nRead-only filesystem test passed: a full webhook run completes with zero attempted writes outside the " +
        "OS temp directory - matching Vercel's actual constraint (writable only under /tmp, everything else " +
        'read-only), simulated locally by intercepting every fs write call.'
    );
  }
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
