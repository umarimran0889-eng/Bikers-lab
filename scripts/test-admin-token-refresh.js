// Exercises lib/shopifyAdminAuth.js's token caching + refresh logic against
// a mocked fetch, without hitting the real Shopify OAuth endpoint. Run with:
//   node scripts/test-admin-token-refresh.js

process.env.SHOPIFY_SHOP_DOMAIN = 'test-shop.myshopify.com';
process.env.SHOPIFY_CLIENT_ID = 'test-client-id';
process.env.SHOPIFY_CLIENT_SECRET = 'test-client-secret';

let fetchCallCount = 0;

// A long expiry (1 hour) so the safety buffer doesn't make the token look
// expired immediately - this is what lets us test that a valid token is
// reused rather than refetched on every call.
global.fetch = async (url, opts) => {
  fetchCallCount += 1;
  const body = JSON.parse(opts.body);
  if (body.grant_type !== 'client_credentials' || !body.client_id || !body.client_secret) {
    throw new Error('Mock fetch received an unexpected request body: ' + opts.body);
  }
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        access_token: `mock-token-${fetchCallCount}`,
        scope: 'read_products',
        expires_in: 3600,
      }),
  };
};

const { getAccessToken, clearCachedToken } = require('../lib/shopifyAdminAuth');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${message}`);
  }
}

async function main() {
  const token1 = await getAccessToken();
  assert(fetchCallCount === 1, 'first call fetches a token (1 fetch so far)');
  assert(token1 === 'mock-token-1', 'first call returns the freshly fetched token');

  const token2 = await getAccessToken();
  assert(fetchCallCount === 1, 'second call reuses the cached token (still 1 fetch)');
  assert(token2 === token1, 'second call returns the same cached token value');

  // Simulate the cached token having expired (e.g. crossed the safety
  // buffer, or was evicted) without waiting for real time to pass.
  clearCachedToken();

  const token3 = await getAccessToken();
  assert(fetchCallCount === 2, 'call after cache-clear fetches a new token (2 fetches total)');
  assert(token3 === 'mock-token-2', 'call after cache-clear returns a newly fetched token');
  assert(token3 !== token1, 'the refreshed token differs from the original cached token');

  if (process.exitCode === 1) {
    console.error('\nToken refresh test FAILED');
  } else {
    console.log('\nToken refresh test passed - caching and expiry-triggered refetch both work.');
  }
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
