// Sends failure-alert emails via Resend (https://resend.com). One shared
// function for every "a human needs to look at this" scenario in the
// project, so there's a single consistent email format instead of four
// ad-hoc ones - see ALERT_TYPES below for what each one covers.
//
// Never let a failure to SEND an alert take down the thing it's alerting
// about: every code path here is defensive (missing config, Resend errors,
// network failures) and just logs instead of throwing.

const DEFAULT_FROM = 'onboarding@resend.dev';

// One real email per rolling window, per alert type - so an extended issue
// (e.g. Shopify Admin auth down for an hour, or a run of Thibault
// rejections) can't flood the inbox with dozens of near-identical emails.
// 15 minutes: long enough to meaningfully cut repeat noise during an
// outage, short enough that a still-ongoing issue resurfaces well within
// the same working session. Every occurrence is still logged regardless of
// throttling - only the actual email send is skipped.
const ALERT_THROTTLE_WINDOW_MS = 15 * 60 * 1000;

// type -> { lastSentAt: ms epoch (0 = never sent), suppressedCount: number
// suppressed since that last send }. Per-type and independent of other
// types, so a flood of one type never suppresses another. In-memory only -
// resets on restart, not shared across instances. Fine at this scale (see
// README); would need a shared store (Redis, a DB row, etc.) to survive
// restarts or coordinate across multiple server instances.
const throttleState = new Map();

// `severity` only affects the subject-line prefix, so the inbox is
// scannable at a glance: "order" = one order needs manual attention,
// "integration" = the whole pipeline may be down for everyone.
const ALERT_TYPES = {
  thibault_rejection: {
    severity: 'order',
    subject: (d) => `Order needs attention: Thibault rejected order ${d.orderName || d.orderId}`,
  },
  unresolved_item: {
    severity: 'order',
    subject: (d) =>
      `Order needs attention: unresolved product tag on order ${d.orderName || d.orderId} (SKU ${d.sku || 'unknown'})`,
  },
  admin_token_failure: {
    severity: 'integration',
    subject: () =>
      'Integration issue: Shopify Admin authentication is failing (blocks ALL product tag lookups)',
  },
  unhandled_error: {
    severity: 'integration',
    subject: (d) =>
      `Integration issue: unexpected error in the Thibault webhook handler${d.orderId ? ` (order ${d.orderId})` : ''}`,
  },
};

function formatValue(value) {
  if (value === undefined) return '(none)';
  if (typeof value === 'object' && value !== null) return JSON.stringify(value, null, 2);
  return String(value);
}

function buildEmailBody(type, details) {
  const typeConfig = ALERT_TYPES[type];
  const lines = [
    `Alert type: ${type}`,
    `Severity: ${typeConfig.severity} (${typeConfig.severity === 'integration' ? 'whole integration may be affected' : 'single order'})`,
    `Timestamp: ${new Date().toISOString()}`,
    '',
  ];
  for (const [key, value] of Object.entries(details || {})) {
    lines.push(`${key}: ${formatValue(value)}`);
  }
  return lines.join('\n');
}

function getThrottleState(type) {
  if (!throttleState.has(type)) {
    throttleState.set(type, { lastSentAt: 0, suppressedCount: 0 });
  }
  return throttleState.get(type);
}

/**
 * Records one occurrence of `type` and decides whether it should actually
 * send an email. "Rolling window": sending resets the window - an
 * occurrence within ALERT_THROTTLE_WINDOW_MS of the last real send is
 * suppressed (but counted); the first occurrence after the window has
 * elapsed sends again and reports how many were suppressed since.
 */
function checkThrottle(type) {
  const state = getThrottleState(type);
  const now = Date.now();
  const withinWindow = state.lastSentAt !== 0 && now - state.lastSentAt < ALERT_THROTTLE_WINDOW_MS;

  if (withinWindow) {
    state.suppressedCount += 1;
    return { shouldSend: false, suppressedCount: state.suppressedCount };
  }

  const suppressedSinceLast = state.suppressedCount;
  state.lastSentAt = now;
  state.suppressedCount = 0;
  return { shouldSend: true, suppressedSinceLast };
}

/**
 * Makes the next occurrence of `type` bypass the throttle window, as if
 * ALERT_THROTTLE_WINDOW_MS had already elapsed, without touching the
 * suppressed-occurrence count - so the next real send still correctly
 * reports how many were suppressed while throttled. Used by
 * scripts/test-alert-throttle.js to test window expiry without waiting 15
 * real minutes; also safe to use operationally to force the next
 * occurrence of a type through immediately.
 */
function expireThrottleWindow(type) {
  getThrottleState(type).lastSentAt = 0;
}

/**
 * Sends a failure-alert email for one of the ALERT_TYPES scenarios, subject
 * to per-type throttling (see ALERT_THROTTLE_WINDOW_MS above).
 *
 * @param {'thibault_rejection'|'unresolved_item'|'admin_token_failure'|'unhandled_error'} type
 * @param {object} details - freeform, included in the email body as-is
 *
 * Behavior when not fully configured:
 * - No ALERT_EMAIL_TO: logs a warning with what would have been sent, skips.
 * - No RESEND_API_KEY: logs a warning with what would have been sent, skips
 *   (this is also the "mock mode" used by scripts/test-alert.js).
 * - Resend call fails (network, bad key, etc.): logged, never thrown -
 *   sending an alert must never itself break order processing.
 */
async function sendFailureAlert(type, details = {}) {
  const typeConfig = ALERT_TYPES[type];
  if (!typeConfig) {
    console.warn(`[alerts] Unknown alert type "${type}" - logging details only:`, details);
    return;
  }

  const subject = typeConfig.subject(details);

  // Always logged, regardless of throttling - nothing is silently lost.
  console.log(`[alerts] "${type}" occurrence: ${subject}`);

  const throttleResult = checkThrottle(type);

  if (!throttleResult.shouldSend) {
    console.warn(
      `[alerts] Throttled "${type}" alert - within the ${ALERT_THROTTLE_WINDOW_MS / 60000}-minute window since the last send. Suppressed occurrences since last send: ${throttleResult.suppressedCount}.`
    );
    return;
  }

  let body = buildEmailBody(type, details);
  if (throttleResult.suppressedSinceLast > 0) {
    body += `\n\nThis issue has occurred ${throttleResult.suppressedSinceLast} times in the last ${ALERT_THROTTLE_WINDOW_MS / 60000} minutes; only this alert was sent to avoid flooding your inbox.`;
  }

  if (!process.env.ALERT_EMAIL_TO) {
    console.warn(
      `[alerts] ALERT_EMAIL_TO is not set - alert would have been sent but is being skipped.\nSubject: ${subject}\n${body}`
    );
    return;
  }

  if (!process.env.RESEND_API_KEY) {
    console.warn(
      `[alerts] RESEND_API_KEY is not set - simulating alert email instead of sending.\nSubject: ${subject}\n${body}`
    );
    return;
  }

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.ALERT_EMAIL_FROM || DEFAULT_FROM;

    const { data, error } = await resend.emails.send({
      from,
      to: process.env.ALERT_EMAIL_TO,
      subject,
      text: body,
    });

    if (error) {
      console.error(`[alerts] Resend returned an error while sending "${type}" alert:`, error);
    } else {
      console.log(`[alerts] Sent "${type}" alert email to ${process.env.ALERT_EMAIL_TO} (id: ${data && data.id})`);
    }
  } catch (err) {
    console.error(
      `[alerts] Failed to send "${type}" alert email (this never blocks order processing): ${err.message}`
    );
  }
}

module.exports = { sendFailureAlert, ALERT_TYPES, ALERT_THROTTLE_WINDOW_MS, expireThrottleWindow };
