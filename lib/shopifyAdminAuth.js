// Token manager for Shopify's OAuth client_credentials grant (this store
// uses the newer "Dev Dashboard" app system, which only issues short-lived
// tokens - there is no static Admin API token to paste into env vars).
//
// Single shared in-memory cache for the process: the first Admin API call
// fetches a token, subsequent calls reuse it until it's close to expiring,
// then it's transparently refetched. Callers (lib/shopifyAdminClient.js)
// just call getAccessToken() and don't need to know any of this.

const { sendFailureAlert } = require('./alerts');

const TOKEN_PATH = '/admin/oauth/access_token';

// Treat a token as expired this long before its real expiry, so a
// long-running request doesn't get cut off mid-flight by a token that goes
// stale a few seconds later.
const EXPIRY_SAFETY_BUFFER_MS = 5 * 60 * 1000;

let cachedToken = null;
let cachedExpiresAt = 0;
let refreshPromise = null;

async function requestNewToken() {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    throw new Error(
      'SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must all be set to authenticate with the Shopify Admin API'
    );
  }

  const url = `https://${shop}${TOKEN_PATH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });

  const text = await res.text();

  if (!res.ok) {
    const err = new Error(`Shopify OAuth token request failed with ${res.status}`);
    err.status = res.status;
    err.response = text;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Shopify OAuth token response was not valid JSON');
  }

  if (!data.access_token || !data.expires_in) {
    throw new Error('Shopify OAuth token response was missing access_token or expires_in');
  }

  cachedToken = data.access_token;
  cachedExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

function isCachedTokenValid() {
  return Boolean(cachedToken) && Date.now() < cachedExpiresAt - EXPIRY_SAFETY_BUFFER_MS;
}

/**
 * Returns a valid Shopify Admin API access token, fetching and caching a
 * new one (via the client_credentials grant) if none is cached or the
 * cached one is within EXPIRY_SAFETY_BUFFER_MS of expiring. Concurrent
 * callers during a refresh share the same in-flight request rather than
 * each firing their own.
 *
 * Throws if the token request itself fails - a missing token blocks the
 * whole Thibault-matching step, so this must not fail silently. Also fires
 * an "admin_token_failure" alert (see lib/alerts.js), since this is more
 * severe than a single order failing - it blocks ALL tag lookups until
 * resolved.
 */
async function getAccessToken() {
  if (isCachedTokenValid()) return cachedToken;

  if (!refreshPromise) {
    refreshPromise = requestNewToken()
      .catch(async (err) => {
        await sendFailureAlert('admin_token_failure', {
          error: err.message,
          status: err.status,
          response: err.response,
        });
        throw err;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

/**
 * Clears the in-memory token cache. Primarily for tests (to simulate a
 * token expiring without waiting for real time to pass); also useful to
 * force a fresh token on demand, e.g. after a credentials rotation.
 */
function clearCachedToken() {
  cachedToken = null;
  cachedExpiresAt = 0;
  refreshPromise = null;
}

module.exports = { getAccessToken, clearCachedToken };
