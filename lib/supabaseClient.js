const { createClient } = require('@supabase/supabase-js');

let client = null;

/**
 * Returns a shared Supabase client, or null if it isn't configured
 * (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing) or SUPABASE_MOCK=true is
 * set to force-disable it (handy for local test runs that don't want to
 * write real rows). Never throws - callers treat a null return as "status
 * tracking unavailable right now" and skip, per lib/orderStatus.js.
 */
function getSupabaseClient() {
  if (process.env.SUPABASE_MOCK === 'true') return null;
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  try {
    client = createClient(url, key, { auth: { persistSession: false } });
    return client;
  } catch (err) {
    console.error('[supabase] Failed to create Supabase client:', err.message);
    return null;
  }
}

module.exports = { getSupabaseClient };
