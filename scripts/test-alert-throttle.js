// Confirms alert throttling (lib/alerts.js): repeated occurrences of the
// same type within the throttle window only attempt one real send, every
// occurrence is still logged, a different alert type is unaffected
// (per-type throttling is independent), and once the window elapses the
// next occurrence sends again while correctly reporting how many were
// suppressed in between.
//
// Deliberately does NOT load .env (same hermetic pattern as
// scripts/test-admin-token-refresh.js and scripts/test-unresolved-item.js)
// and explicitly clears RESEND_API_KEY/ALERT_EMAIL_TO if present in the
// shell environment - this is a pure throttling-logic test, not a delivery
// test (that's `npm run test:alert`), so it never sends a real email
// regardless of what's configured elsewhere.
//
// Run with: node scripts/test-alert-throttle.js

delete process.env.RESEND_API_KEY;
delete process.env.ALERT_EMAIL_TO;

const { sendFailureAlert, expireThrottleWindow, ALERT_THROTTLE_WINDOW_MS } = require('../lib/alerts');

const realLog = console.log;
const realWarn = console.warn;
let logs = [];
console.log = (...args) => {
  logs.push(args.join(' '));
  realLog(...args);
};
console.warn = (...args) => {
  logs.push(args.join(' '));
  realWarn(...args);
};

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    realLog(`OK: ${message}`);
  }
}

function countMatching(pattern) {
  return logs.filter((l) => pattern.test(l)).length;
}

function lastMatching(pattern) {
  return [...logs].reverse().find((l) => pattern.test(l));
}

async function main() {
  const windowMinutes = ALERT_THROTTLE_WINDOW_MS / 60000;

  // --- Part 1: 5 rapid occurrences of the same type ---
  logs = [];
  for (let i = 0; i < 5; i += 1) {
    await sendFailureAlert('thibault_rejection', {
      orderId: 1000 + i,
      orderName: `#${1000 + i}`,
      sku: 'TH-TEST',
      thibaultError: `Simulated failure #${i + 1}`,
    });
  }

  const occurrences = countMatching(/"thibault_rejection" occurrence:/);
  const sendAttempts = countMatching(/ALERT_EMAIL_TO is not set - alert would have been sent/);
  const throttledSkips = countMatching(/Throttled "thibault_rejection" alert/);

  assert(occurrences === 5, `all 5 occurrences were logged, even the throttled ones (got ${occurrences})`);
  assert(sendAttempts === 1, `only 1 of 5 rapid occurrences attempted a send (got ${sendAttempts})`);
  assert(throttledSkips === 4, `the other 4 occurrences were throttled and logged as skipped (got ${throttledSkips})`);

  const lastThrottleLog = lastMatching(/Throttled "thibault_rejection" alert/);
  assert(
    Boolean(lastThrottleLog && lastThrottleLog.includes('Suppressed occurrences since last send: 4')),
    `the last throttle log reports the correct running suppressed count of 4 (got: ${lastThrottleLog})`
  );

  // --- Part 2: a different alert type must not be affected ---
  logs = [];
  await sendFailureAlert('unresolved_item', {
    orderId: 2000,
    orderName: '#2000',
    productId: 123,
    sku: 'UNREL-1',
    lookupError: 'test',
  });
  const otherTypeSendAttempts = countMatching(/ALERT_EMAIL_TO is not set - alert would have been sent/);
  const otherTypeThrottled = countMatching(/Throttled "unresolved_item" alert/);
  assert(
    otherTypeSendAttempts === 1,
    'a different alert type ("unresolved_item") sends normally even while "thibault_rejection" is still throttled'
  );
  assert(otherTypeThrottled === 0, "a different alert type is never throttled by another type's activity");

  // --- Part 3: window elapses, next occurrence sends again with the count ---
  logs = [];
  expireThrottleWindow('thibault_rejection');
  await sendFailureAlert('thibault_rejection', {
    orderId: 1099,
    orderName: '#1099',
    sku: 'TH-TEST',
    thibaultError: 'Simulated failure after window expiry',
  });

  const sendAfterExpiry = countMatching(/ALERT_EMAIL_TO is not set - alert would have been sent/);
  assert(sendAfterExpiry === 1, 'the next occurrence after the window elapses sends again (not throttled)');

  const resumedSendLog = lastMatching(/ALERT_EMAIL_TO is not set - alert would have been sent/);
  assert(
    Boolean(
      resumedSendLog &&
        resumedSendLog.includes(`This issue has occurred 4 times in the last ${windowMinutes} minutes`)
    ),
    `the resumed alert body mentions the 4 occurrences suppressed before the window elapsed (got: ${resumedSendLog})`
  );

  console.log = realLog;
  console.warn = realWarn;

  if (process.exitCode === 1) {
    console.error('\nAlert throttle test FAILED');
  } else {
    console.log(
      '\nAlert throttle test passed: 5 rapid occurrences of one type produced only 1 send attempt (4 throttled, ' +
        'all 5 logged), a different type was unaffected, and the resumed alert after window expiry correctly ' +
        'reported the suppressed count.'
    );
  }
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
