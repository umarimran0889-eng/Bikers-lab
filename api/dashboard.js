const crypto = require('crypto');
const { listRecentStatuses, getStatusById, markConfirmed, updateTracking } = require('../lib/orderStatus');
const { checkThibaultInvoice, getThibaultTracking } = require('../lib/thibaultClient');

const ROW_LIMIT = 100;
const SESSION_COOKIE_NAME = 'thibault_dashboard_session';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  });
  return cookies;
}

/**
 * Session tokens are "<expiresAtEpochMs>.<hmac>" signed with
 * DASHBOARD_PASSWORD as the HMAC key - no separate secret or session store
 * needed. A tampered or expired token is rejected; a valid one just proves
 * "this browser supplied the correct password within the last
 * SESSION_DURATION_MS", without storing the password itself in the cookie.
 */
function createSessionToken() {
  const password = process.env.DASHBOARD_PASSWORD || '';
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  const signature = crypto.createHmac('sha256', password).update(String(expiresAt)).digest('hex');
  return `${expiresAt}.${signature}`;
}

function isValidSessionToken(token) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password || !token) return false;

  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;
  const expiresAtStr = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const expectedSignature = crypto.createHmac('sha256', password).update(expiresAtStr).digest('hex');
  return timingSafeEqualStrings(signature, expectedSignature);
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/dashboard; SameSite=Lax; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/dashboard; SameSite=Lax; Max-Age=0`);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATUS_BADGES = {
  sent: { label: 'Sent', className: 'badge-sent' },
  failed: { label: 'Failed', className: 'badge-failed' },
  pending: { label: 'Pending', className: 'badge-pending' },
};

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Shared look and feel between the login card and the dashboard table, so
// switching between them doesn't feel like two different apps.
const BASE_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f7f7f8;
    color: #1a1a1a;
  }
  header {
    padding: 20px 16px;
    background: #111827;
    color: #fff;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  header h1 { margin: 0; font-size: 1.25rem; }
  header p { margin: 4px 0 0; color: #9ca3af; font-size: 0.85rem; }
  header a.logout { color: #9ca3af; font-size: 0.8rem; text-decoration: none; }
  header a.logout:hover { color: #fff; text-decoration: underline; }
  footer { padding: 12px 16px; color: #9ca3af; font-size: 0.8rem; text-align: center; }
`;

function renderLoginPage({ error } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Thibault Dashboard - Sign in</title>
<style>
${BASE_STYLE}
  .login-wrap {
    min-height: calc(100vh - 0px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .login-card {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 32px;
    width: 100%;
    max-width: 360px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .login-card h1 { margin: 0 0 4px; font-size: 1.15rem; color: #111827; }
  .login-card .subtitle { margin: 0 0 20px; color: #6b7280; font-size: 0.88rem; }
  .login-card label {
    display: block;
    font-size: 0.82rem;
    font-weight: 600;
    color: #374151;
    margin-bottom: 6px;
  }
  .login-card input[type="password"] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-size: 0.95rem;
    margin-bottom: 16px;
  }
  .login-card input[type="password"]:focus {
    outline: none;
    border-color: #111827;
    box-shadow: 0 0 0 3px rgba(17,24,39,0.1);
  }
  .login-card button {
    width: 100%;
    padding: 10px 12px;
    border: none;
    border-radius: 8px;
    background: #111827;
    color: #fff;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
  }
  .login-card button:hover { background: #1f2937; }
  .error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #991b1b;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 0.85rem;
    margin-bottom: 16px;
  }
</style>
</head>
<body>
  <div class="login-wrap">
    <div class="login-card">
      <h1>Thibault Order Status</h1>
      <p class="subtitle">Enter the dashboard password to continue.</p>
      ${error ? '<div class="error">Incorrect password. Try again.</div>' : ''}
      <form method="POST" action="/dashboard">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autofocus required autocomplete="current-password" />
        <button type="submit">Sign in</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function renderMisconfiguredPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Thibault Dashboard</title>
<style>${BASE_STYLE}
  .notice-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .notice { max-width: 420px; text-align: center; color: #6b7280; }
</style>
</head>
<body>
  <div class="notice-wrap">
    <div class="notice">
      <p>The dashboard isn't configured yet - <code>DASHBOARD_PASSWORD</code> is not set.</p>
    </div>
  </div>
</body>
</html>`;
}

function actionForm(action, id, label) {
  return `<form method="POST" action="/dashboard" class="inline-form">
            <input type="hidden" name="action" value="${escapeHtml(action)}" />
            <input type="hidden" name="id" value="${escapeHtml(id)}" />
            <button type="submit" class="btn-small">${escapeHtml(label)}</button>
          </form>`;
}

function renderConfirmationCell(row) {
  if (row.confirmation === 'confirmed') {
    const orderNum = row.thibault_order_number
      ? `<span class="cell-sub">Thibault #${escapeHtml(row.thibault_order_number)}</span>`
      : '';
    return `<span class="badge badge-confirmed">Confirmed</span>${orderNum}`;
  }

  const badge = '<span class="badge badge-not-confirmed">Not confirmed</span>';
  // Only makes sense to check for an invoice once the order was actually
  // sent - a pending/failed row has no Thibault order to look up yet.
  if (row.status !== 'sent') return badge;
  return `${badge}<br>${actionForm('recheck_confirmation', row.id, 'Recheck confirmation')}`;
}

function renderTrackingCell(row) {
  if (row.confirmation !== 'confirmed') return '<span class="cell-sub">—</span>';

  const hasTracking = row.tracking_carrier || row.tracking_pin;
  const info = hasTracking
    ? `${escapeHtml(row.tracking_carrier || 'Unknown carrier')} &middot; ${escapeHtml(row.tracking_pin || 'no tracking #')}` +
      (row.tracking_shipped_at ? `<span class="cell-sub">${escapeHtml(formatTimestamp(row.tracking_shipped_at))}</span>` : '')
    : '<span class="cell-sub">Not shipped yet</span>';

  return `${info}<br>${actionForm('refresh_tracking', row.id, 'Refresh tracking')}`;
}

function renderRow(row) {
  const badge = STATUS_BADGES[row.status] || { label: row.status || 'unknown', className: 'badge-unknown' };
  return `        <tr>
          <td data-label="Order #">${escapeHtml(row.order_number || row.shopify_order_id)}</td>
          <td data-label="SKU">${escapeHtml(row.sku)}</td>
          <td data-label="Status"><span class="badge ${badge.className}">${escapeHtml(badge.label)}</span></td>
          <td data-label="Thibault Confirmation">${renderConfirmationCell(row)}</td>
          <td data-label="Tracking">${renderTrackingCell(row)}</td>
          <td data-label="Timestamp">${escapeHtml(formatTimestamp(row.created_at))}</td>
          <td data-label="Error">${row.error_message ? escapeHtml(row.error_message) : ''}</td>
        </tr>`;
}

function renderDashboardPage(rows) {
  const rowsHtml = rows.length
    ? rows.map(renderRow).join('\n')
    : `        <tr><td colspan="7" class="empty">No orders recorded yet.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Thibault Order Status</title>
<style>
${BASE_STYLE}
  main { padding: 16px; max-width: 1100px; margin: 0 auto; }
  .table-wrap {
    overflow-x: auto;
    background: #fff;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
  }
  table { border-collapse: collapse; width: 100%; min-width: 640px; }
  th, td {
    padding: 10px 12px;
    text-align: left;
    border-bottom: 1px solid #e5e7eb;
    font-size: 0.9rem;
    vertical-align: top;
  }
  th { background: #f3f4f6; font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  .empty { text-align: center; color: #9ca3af; padding: 32px 12px; }
  .badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 600;
    color: #fff;
    white-space: nowrap;
  }
  .badge-sent { background: #16a34a; }
  .badge-failed { background: #dc2626; }
  .badge-pending { background: #ca8a04; }
  .badge-unknown { background: #6b7280; }
  .badge-confirmed { background: #16a34a; }
  .badge-not-confirmed { background: #9ca3af; }
  .cell-sub {
    display: block;
    margin-top: 4px;
    color: #6b7280;
    font-size: 0.8rem;
  }
  .btn-small {
    display: inline-block;
    margin-top: 6px;
    padding: 4px 9px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: #fff;
    color: #374151;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .btn-small:hover { background: #f3f4f6; }
  .inline-form { margin: 0; display: inline-block; }

  /* Mobile: fall back to a stacked card layout instead of a horizontally
     scrolling table, so it's readable at a glance on a phone. */
  @media (max-width: 640px) {
    .table-wrap { border: none; background: none; overflow: visible; }
    table, thead, tbody, th, td, tr { display: block; }
    thead { display: none; }
    table { min-width: 0; }
    tr {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      margin-bottom: 10px;
      padding: 8px 12px;
    }
    tr:last-child { margin-bottom: 0; }
    td {
      border-bottom: none;
      padding: 6px 0;
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    td::before {
      content: attr(data-label);
      font-weight: 600;
      color: #6b7280;
      flex-shrink: 0;
    }
    td.empty { display: block; text-align: center; }
    td.empty::before { content: none; }
  }
</style>
</head>
<body>
  <header>
    <div>
      <h1>Thibault Order Status</h1>
      <p>Most recent ${rows.length} order${rows.length === 1 ? '' : 's'} forwarded to Thibault</p>
    </div>
    <a class="logout" href="/dashboard?logout=1">Sign out</a>
  </header>
  <main>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Order #</th>
            <th>SKU</th>
            <th>Status</th>
            <th>Thibault Confirmation</th>
            <th>Tracking</th>
            <th>Timestamp</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
${rowsHtml}
        </tbody>
      </table>
    </div>
  </main>
  <footer>Biker Lab &middot; Thibault order forwarder</footer>
</body>
</html>`;
}

function sendHtml(res, statusCode, html) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function redirectToDashboard(res) {
  res.statusCode = 302;
  res.setHeader('Location', '/dashboard');
  return res.end();
}

function handleLogin(params, res) {
  const suppliedPassword = params.get('password') || '';

  const password = process.env.DASHBOARD_PASSWORD;
  const isCorrect = Boolean(password) && timingSafeEqualStrings(suppliedPassword, password);

  if (!isCorrect) {
    return sendHtml(res, 200, renderLoginPage({ error: true }));
  }

  setSessionCookie(res, createSessionToken());
  return redirectToDashboard(res);
}

/**
 * Re-runs the same read-only invoices lookup on demand for one row. Only
 * ever upgrades not_confirmed -> confirmed when Thibault now has a match;
 * a genuine API failure or a continued "not found" just leaves the row as
 * it was (still neutral/pending, not an error) rather than surfacing
 * anything to the user - this is a best-effort refresh, not a required step.
 */
async function handleRecheckConfirmation(params, res) {
  const id = params.get('id');
  if (id) {
    try {
      const row = await getStatusById(id);
      if (row && row.order_number) {
        const check = await checkThibaultInvoice(row.order_number);
        if (check.found) {
          await markConfirmed(id, {
            thibaultOrderNumber: check.orderNumber,
            thibaultInvoiceNumber: check.invoiceNumber,
          });
        }
      }
    } catch (err) {
      console.error(`[dashboard] Recheck confirmation failed for row ${id}:`, err.message);
    }
  }
  return redirectToDashboard(res);
}

/**
 * Re-runs the read-only tracking lookup for one confirmed row. Same
 * best-effort semantics as recheck confirmation above - a failure or "no
 * tracking yet" just leaves the row's existing tracking info as-is.
 */
async function handleRefreshTracking(params, res) {
  const id = params.get('id');
  if (id) {
    try {
      const row = await getStatusById(id);
      if (row && row.thibault_order_number) {
        const tracking = await getThibaultTracking(row.thibault_order_number);
        if (tracking.found) {
          await updateTracking(id, {
            carrier: tracking.carrier,
            trackingPin: tracking.trackingPin,
            shippedAt: tracking.shippedAt,
          });
        }
      }
    } catch (err) {
      console.error(`[dashboard] Refresh tracking failed for row ${id}:`, err.message);
    }
  }
  return redirectToDashboard(res);
}

async function handlePost(req, res) {
  const rawBody = await readRawBody(req);
  const params = new URLSearchParams(rawBody.toString('utf8'));
  const action = params.get('action') || 'login';

  if (action === 'login') {
    return handleLogin(params, res);
  }

  // Every action other than logging in requires an existing session.
  const cookies = parseCookies(req);
  if (!isValidSessionToken(cookies[SESSION_COOKIE_NAME])) {
    return sendHtml(res, 401, renderLoginPage());
  }

  if (action === 'recheck_confirmation') return handleRecheckConfirmation(params, res);
  if (action === 'refresh_tracking') return handleRefreshTracking(params, res);

  res.statusCode = 400;
  res.setHeader('Content-Type', 'text/plain');
  return res.end('Unknown action');
}

async function handleView(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const isLoggingOut = url.searchParams.get('logout') === '1';

  if (isLoggingOut) {
    clearSessionCookie(res);
    return sendHtml(res, 200, renderLoginPage());
  }

  const cookies = parseCookies(req);
  if (!isValidSessionToken(cookies[SESSION_COOKIE_NAME])) {
    return sendHtml(res, 200, renderLoginPage());
  }

  const rows = await listRecentStatuses(ROW_LIMIT);
  return sendHtml(res, 200, renderDashboardPage(rows));
}

/**
 * Password-gated /dashboard page with a real login form + session cookie
 * (instead of the browser's native HTTP Basic Auth prompt). The session
 * token is signed with DASHBOARD_PASSWORD via HMAC - no separate secret or
 * session store needed - and expires after SESSION_DURATION_MS.
 *
 * If DASHBOARD_PASSWORD isn't set at all, access is denied entirely (a
 * clear "not configured" page) rather than left open or shown a form that
 * could never succeed.
 */
async function dashboardHandler(req, res) {
  if (!process.env.DASHBOARD_PASSWORD) {
    return sendHtml(res, 503, renderMisconfiguredPage());
  }

  if (req.method === 'POST') return handlePost(req, res);
  if (req.method === 'GET') return handleView(req, res);

  res.statusCode = 405;
  res.setHeader('Content-Type', 'text/plain');
  return res.end('Method Not Allowed');
}

module.exports = dashboardHandler;
