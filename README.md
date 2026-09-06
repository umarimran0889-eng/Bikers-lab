# Biker Lab — Thibault Order Forwarder

Biker Lab is a Shopify store. One of its suppliers, Importations Thibault,
drop-ships orders directly to customers but does not accept order
notifications by email — orders must go through their REST API instead.

This project listens for Shopify's `orders/create` webhook and automatically
forwards any order containing Thibault-supplied line items to Thibault's
Order API, removing manual re-entry.

## How it works

1. Shopify fires an `orders/create` webhook to `api/webhooks/orders-create.js`.
2. The handler verifies the request is genuinely from Shopify by checking the
   `X-Shopify-Hmac-Sha256` header against an HMAC-SHA256 computed over the
   raw request body, using `SHOPIFY_WEBHOOK_SECRET` (constant-time
   comparison, not a plain string equality check).
3. It checks Supabase for an existing `order_status` row for this Shopify
   order ID — if this order was already processed (Shopify retries webhooks
   on timeout), it skips silently.
4. For each distinct product on the order, it looks up that product's tags
   via the Shopify Admin API (cached — see **Line item matching** below) and
   keeps only the line items whose product carries the `Supplier-Thibault`
   tag.
5. If none match, it skips cleanly with no action.
6. Otherwise, it builds one Thibault order request per SKU. For each one, it
   writes a `pending` row to Supabase (see **Order status dashboard**), then
   POSTs to `https://api.importationsthibault.com/api/v1/order` with a
   Bearer token (`THIBAULT_API_TOKEN`), updating that row to `sent` or
   `failed` once it resolves.
7. Every outcome (success or failure per SKU) is logged to the console
   (captured by Vercel's own Logs dashboard in production — nothing is
   written to disk anywhere in this project, see **No filesystem writes**
   below). On failure, a real alert email goes out via Resend — see
   **Failure alerting**.

## Folder structure

```
api/webhooks/orders-create.js   Main webhook handler (entry point)
lib/verifyWebhook.js            Shopify HMAC signature verification
lib/mapOrderToThibault.js       Tag-based line item filtering + Thibault payload building
lib/productTags.js              Product tag lookup orchestrator (cache, retries, mock/live switch)
lib/productTagCache.js          Short-lived in-memory cache of product_id -> tags
lib/shopifyAdminClient.js       Real Shopify Admin API product tag lookup
lib/shopifyAdminAuth.js         OAuth token manager - fetches/caches/refreshes the Admin API access token
lib/shopifyAdminMock.js         Stubbed product tag lookup for local testing
lib/thibaultClient.js           POSTs (or simulates) an order to Thibault's Order API
lib/logger.js                   Structured console logging (console.log only, no files)
lib/unresolvedItemsLog.js       Separate console.warn logging for line items whose tag lookup never succeeded
lib/alerts.js                   Sends failure-alert emails via Resend (see "Failure alerting")
lib/supabaseClient.js           Shared Supabase client (or null if unconfigured/mocked)
lib/orderStatus.js              Writes/reads order_status rows (see "Order status dashboard")
api/dashboard.js                Password-gated /dashboard page listing recent order_status rows
scripts/dev-server.js           Local Express server for testing the handler + dashboard
scripts/send-test-order.js      Signs & POSTs a sample order to the dev server
scripts/test-admin-token-refresh.js  Tests token caching/expiry/refresh against a mocked fetch
scripts/test-unresolved-item.js Tests retry + unresolved-item handling for a failed tag lookup
scripts/test-alert.js           Exercises all 4 alert scenarios (real or mocked, see "Failure alerting")
scripts/test-alert-throttle.js  Tests per-type alert throttling (5 rapid occurrences -> 1 send)
scripts/test-dashboard.js       Verifies a webhook run writes pending->sent/failed rows to Supabase
scripts/test-confirmation-tracking.js  Tests invoice/tracking response parsing + the Supabase round-trip
scripts/test-readonly-fs.js     Simulates Vercel's read-only filesystem locally (see "No filesystem writes")
scripts/test-raw-webhook-body.js  Tests the real raw-stream HMAC path (see "Raw webhook body & NODEJS_HELPERS")
fixtures/sample-order.json      Sample Shopify order payload for testing
fixtures/sample-order-with-unresolved-item.json  Multi-item order with one always-failing lookup
fixtures/product-tags.json      Stubbed product_id -> tags map used by the mock lookup
```

No `data/` or `logs/` directories - see **No filesystem writes** below.

## No filesystem writes

**Nothing in this project writes to disk, anywhere, ever - by design, not by
accident.** This wasn't always true, and the fallout was a real production
incident worth documenting so it doesn't get reintroduced:

Early versions had four things writing to project-relative `data/`/`logs/`
folders: a duplicate-order dedupe store, a product-tag cache, and two log
files. All four worked perfectly in local dev, because a normal filesystem
is fully writable - which is exactly what hid the problem. Once deployed,
Vercel's serverless functions run on a filesystem that's **read-only
everywhere except `/tmp`** (and `/tmp` itself is ephemeral and not shared
across invocations or instances). The very first real webhook delivery
crashed with `ENOENT: no such file or directory, mkdir '/var/task/logs'` -
a 500 on every single order, meaning nothing reached Thibault, Supabase, or
anywhere else, since the crash happened before any of that logic ran.

The fix, applied throughout:
- **`lib/logger.js` / `lib/unresolvedItemsLog.js`** - `console.log`/
  `console.warn` only, no file writes. Vercel captures stdout/stderr into
  its own Logs dashboard automatically - that's the right place for this
  anyway, not a project-relative file only the same server instance could
  ever read back.
- **`lib/productTagCache.js`** - now a plain in-memory `Map`, not a file.
  Purely a performance optimization (skip a redundant Shopify Admin API
  call within the same warm instance) - resetting per cold start / per
  instance is a fully acceptable trade-off, unlike correctness-critical
  state.
- **Duplicate-order protection** - now backed by Supabase instead of a
  local file (see `hasExistingStatusForOrder()` in `lib/orderStatus.js`,
  used in `api/webhooks/orders-create.js`): checks whether an
  `order_status` row already exists for this Shopify order ID. This is
  more correct anyway, not just "not broken" - a project-relative file
  never actually persisted across separate serverless invocations even
  before this crash, so duplicate-order protection likely never really
  worked in production; a shared database naturally does. One trade-off:
  this fails *open* (treats "can't tell" as "not yet processed") if
  Supabase itself is unavailable at that exact moment, since failing
  *closed* would risk silently dropping real new orders instead - the same
  "never let a dependency block order processing" principle used
  everywhere else in this project. Also note: only orders with at least
  one Thibault-matched SKU get an `order_status` row at all, so an order
  with zero Thibault items won't be recognized as a duplicate on retry -
  harmless (nothing was ever going to be forwarded for it anyway), just a
  little redundant tag-lookup work.

**Testing this locally** (`npm run test:readonly-fs`): local dev's
filesystem is fully writable, which is exactly what let this bug hide until
a real deployment found it - so this test doesn't just run the code
locally, it simulates Vercel's actual constraint by intercepting every
`fs` write/mkdir call and throwing the same `ENOENT` error Vercel did for
anything outside the OS temp directory. It then runs a real webhook
delivery through and asserts both that the handler completes successfully
(200, not a crash) and that literally zero write attempts occurred outside
temp. This is as close to proving the fix as local tooling can get; it is
not a substitute for confirming on a real deployment, which needs an actual
Vercel environment to fully verify (see below).

## Raw webhook body & `NODEJS_HELPERS` (required Vercel setting)

**HMAC verification needs the exact raw bytes Shopify signed - and getting
those bytes on Vercel requires a specific, easy-to-miss project setting.**
This caused a second production incident right after the filesystem fix
above: real Shopify deliveries (confirmed via their `Shopify-Captain-Hook`
User-Agent) started failing HMAC verification on every single request.

**Root cause:** Vercel's Node.js Serverless Functions (the plain kind under
`api/` used here - not Next.js) auto-populate `req.body` with a *parsed*
version of the request whenever `Content-Type: application/json` is sent -
accessing `req.body` at all triggers a getter that reads and consumes the
raw request stream to produce that parsed object. Once that happens, the
original bytes are gone; there's no reconstructing Shopify's exact
serialization (key order, whitespace) from the parsed object, so HMAC
verification can never succeed against it - not "sometimes fails", *never*
succeeds. The `config.api.bodyParser = false` export that used to be in
`api/webhooks/orders-create.js` did nothing here - that convention only
applies to Next.js API routes, and this project isn't Next.js. It's been
removed since it was actively misleading.

**The fix - a required Vercel project Environment Variable:**
```
NODEJS_HELPERS=0
```
Set in the Vercel dashboard (Project Settings → Environment Variables) for
every environment this deploys to (Production, and Preview if you test
there too), then redeploy. This disables Vercel's automatic
`req.body`/`req.query`/`req.cookies` parsing entirely, so `req` stays the
raw, unconsumed stream and `readRawBody()` in `api/webhooks/orders-create.js`
gets the genuine bytes - exactly like local dev, where nothing pre-parses
the request. (`api/dashboard.js` already parsed cookies/query/body itself
manually rather than relying on these helpers, so disabling them doesn't
affect it.) This is a platform-level setting, not an application env var -
it isn't read via `process.env` anywhere in this codebase, and has no
effect locally.

**Defense in depth:** if `req.body` ever shows up already parsed anyway
(e.g. `NODEJS_HELPERS` isn't set in some environment), the handler now
detects this specifically and fails with a clear, actionable 500
("Server misconfigured: raw request body unavailable") naming the exact
fix - instead of the confusing generic "HMAC verification failed" that
made this hard to diagnose the first time.

**Why no existing test caught this:** every other test script builds its
fake `req` with `body` already set to a `Buffer` - which takes a shortcut
straight past the raw-stream-reading code, so `readRawBody()` was never
actually exercised by any of them. `npm run test:raw-webhook-body` fixes
that: it builds a real Node.js `Readable` stream (no pre-set `body`, bytes
only obtainable via `req.on('data'/'end')`, exactly like a genuine HTTP
request) with a correctly-computed signature, confirms it verifies and
processes successfully, and separately confirms the "helpers still active"
misconfiguration is caught with the clear, named error above rather than
silently mis-verifying.

## Line item matching

Thibault-supplied products are identified **only by the `Supplier-Thibault`
tag** on the product — never by vendor (vendor is always the real
manufacturer/brand, e.g. "Puig", "K&S", "Athena", "Scar", "All Balls",
"Pivot Works", "Koubalinks").

The match is case-insensitive and whitespace-trimmed (`.trim().toLowerCase()`
on both sides — see `lib/mapOrderToThibault.js`), since tags are free-text
and can pick up inconsistent casing or stray spaces from manual entry.

**Why a lookup is needed:** Shopify's `orders/create` webhook payload does
not include per-line-item product tags — tags live on the product, not the
line item. So for each distinct `product_id` on the incoming order, the
handler calls the Shopify Admin API (`GET /admin/api/{version}/products/{id}.json`)
to fetch that product's current tags, then checks for `Supplier-Thibault`.
The full flow is:

```
webhook receives order
  → distinct product_ids extracted from line_items
  → each product's tags looked up individually (cached, retried, rate-limited)
  → line items whose product has "Supplier-Thibault" are forwarded
  → line items whose product has no such tag are excluded
  → line items whose lookup never succeeded are logged as unresolved (see below)
```

Lookups run **sequentially, not in parallel** (`lib/productTags.js`), with a
~550ms pause after each real Admin API call, to stay within Shopify's
standard Admin REST API rate limit (roughly 2 requests/second per store).
Results are cached in memory for 1 hour (per warm instance - see **No
filesystem writes**), so frequently-ordered products don't trigger a repeat
lookup. Failed lookups
are never cached, since a transient failure must not get "stuck" as a
false answer for an hour.

### Retries and unresolved items

The goal is that **every order that should reach Thibault actually does** —
a flaky lookup for one product must never silently drop that item, and must
never take down the rest of the order with it.

- **Retries:** each product's tag lookup gets up to 3 attempts total (1
  initial + 2 retries), ~300ms apart (`TAG_LOOKUP_MAX_ATTEMPTS` /
  `TAG_LOOKUP_RETRY_DELAY_MS` in `lib/productTags.js`). Most 404s and
  network blips don't survive a retry.
- **If a lookup still fails after all retries**, that line item is marked
  **unresolved** — this is deliberately a third outcome, distinct from
  "confirmed Thibault" and "confirmed not Thibault" (`getThibaultLineItems`
  in `lib/mapOrderToThibault.js` returns `{ matchedItems, unresolvedItems }`,
  not a single filtered list). An unresolved item is never silently treated
  as "not Thibault."
- **Every other line item in that order is unaffected** — confirmed-Thibault
  items are still forwarded, confirmed-non-Thibault items are still
  excluded, regardless of whether some other item in the same order came
  back unresolved.
- **Unresolved items are logged separately** from normal success/failure
  logs, via a distinct `[unresolved-item]`-prefixed `console.warn`
  (`lib/unresolvedItemsLog.js`) — one JSON line per item with the order
  id/name, `product_id`, SKU, line item id, and the underlying error — so
  they're easy to find (search Vercel's Logs dashboard for the prefix) and
  manually review, rather than mixed in with routine forwarding logs.
- **Each unresolved item also triggers the same stubbed failure-alert**
  (`lib/alerts.js`) used for Thibault API rejections — it's exactly the
  kind of thing that needs a human to check, since the system genuinely
  doesn't know whether it should have gone to Thibault.

## Shopify Admin API authentication (token lifecycle)

**This is not a static token.** This store uses Shopify's newer Dev
Dashboard app system, which authenticates via an OAuth `client_credentials`
grant and only issues **short-lived access tokens (~24h, `expires_in`
seconds in the response)** — there's no long-lived Admin API token to
generate once and paste into an env var. If this gets rediscovered later:
that's expected, it's how this app type works, not a bug.

`SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` (which do **not** expire) are
the credentials actually stored in `.env`. `lib/shopifyAdminAuth.js` is a
single in-memory token manager that:
- POSTs to `https://{shop}/admin/oauth/access_token` with those credentials
  and `grant_type: client_credentials` to get an access token + `expires_in`.
- Caches that token in memory (module-level, shared across the whole
  process) and reuses it for every subsequent Admin API call.
- Treats the cached token as expired 5 minutes before its real expiry (a
  safety buffer), and transparently fetches a new one when needed.
- Shares a single in-flight request if multiple callers ask for a token at
  the same moment, so a burst of lookups doesn't fire multiple token
  requests.
- Throws if the token request itself fails — this is never swallowed,
  since a missing token blocks the whole Thibault-matching step.

`lib/shopifyAdminClient.js` (and everything upstream of it, like
`lib/productTags.js`) just calls `getAccessToken()` and uses whatever comes
back — none of that code knows or cares whether a fresh token was just
fetched or an existing one was reused.

## ⚠️ Thibault live calls are disabled by default

**As of now, nothing in this project makes a real network call to
`api.importationsthibault.com`, by design.** We're still in the
verification phase — real Shopify orders must never reach Thibault's real
system until that's explicitly decided.

This is controlled by `THIBAULT_LIVE_CALLS_ENABLED` (see `lib/thibaultClient.js`):
- **Unset, or anything other than exactly `"true"` (the current/default
  state):** `submitThibaultOrder()` makes **no network call whatsoever**. It
  logs the full payload that *would* have been sent, and returns a
  simulated success response (`{ simulated: true, order_number:
  "SIMULATED-<timestamp>", ... }`) shaped like Thibault's documented
  response. The webhook handler logs and dedupes this exactly like a real
  success, but every log line and result carries `simulated: true` so it's
  never confused with a real confirmation.
- **`THIBAULT_LIVE_CALLS_ENABLED=true`:** real POST calls go out to
  Thibault's live Order API, using `THIBAULT_API_TOKEN`.

**When we're actually ready to test against Thibault's real system**, set
`THIBAULT_LIVE_CALLS_ENABLED=true` in `.env` — nothing else needs to
change. Until then, leave it unset or `false`.

Everything else in the pipeline (HMAC verification, Shopify Admin tag
lookups + token refresh, order mapping, dedupe, logging) is real and fully
exercised either way — only the final Thibault network call is gated.

## Order mapping details

Per [Thibault's API docs](https://api.importationsthibault.com/docs) (Order
endpoint), the request body only supports a single `{ sku, qty }` under
`item` — there's no documented array of multiple items. So an order with
several distinct Thibault SKUs results in **multiple POST calls**, one per
SKU, each getting its own Thibault `order_number`. All calls for the same
order share the same `ship_to`, `note`, and `customer_refs`.

Fields sent:
- `item.sku` / `item.qty` — from the Shopify line item
- `ship_to.*` — from the order's `shipping_address` (company, contact name,
  address lines, city, zip, phone, `state` as the province/state code)
- `customer_refs` — the Shopify order name (e.g. `#1042`), so Thibault can
  cross-reference it
- `note` — the Shopify order number plus any customer order note
- `dropship: true`, `no_backorder: false`
- `test_mode` — controlled by `THIBAULT_TEST_MODE` env var

The customer's **email is not sent to Thibault** — their API has no field for
it, and Thibault doesn't email customers directly anyway. It's only visible
in Shopify and in local logs.

## Failure alerting

Four scenarios send a failure-alert email via [Resend](https://resend.com),
all through one shared function, `sendFailureAlert(type, details)`
(`lib/alerts.js`), so there's one consistent email format instead of four
ad-hoc ones. The subject line prefix tells you at a glance whether it's a
single order or the whole integration:

| Type | Triggered from | Subject prefix | Includes |
|---|---|---|---|
| `thibault_rejection` | Thibault's Order API rejects a call (blocked postal code, invalid SKU, malformed payload, etc.) — `api/webhooks/orders-create.js` | `Order needs attention:` | order id/name, SKU, the exact payload that was sent, Thibault's error response |
| `unresolved_item` | A product tag lookup still fails after retries — `api/webhooks/orders-create.js` | `Order needs attention:` | order id/name, `product_id`, SKU, line item id, the lookup error |
| `admin_token_failure` | Shopify Admin OAuth token fetch fails — `lib/shopifyAdminAuth.js` | `Integration issue:` | the error, HTTP status, response body |
| `unhandled_error` | Any unexpected/uncaught error in the webhook handler — `api/webhooks/orders-create.js` (catch-all around the whole request) | `Integration issue:` | order id/name (if known), error message, stack trace |

`Order needs attention` alerts mean one order needs a human to check it -
the rest of the pipeline is fine. `Integration issue` alerts mean something
more structural broke - Admin auth failing blocks tag lookups for every
order, and an unhandled handler error means a bug slipped past everything
else that's supposed to catch it cleanly.

**Never blocks order processing:** the Resend call is wrapped in its own
try/catch inside `sendFailureAlert()` - if sending the alert itself fails
(bad key, Resend outage, network blip), that failure is logged and
swallowed, never thrown. An alerting failure must never cascade into an
order-processing failure.

### Throttling

An extended issue (Shopify Admin auth down, a run of Thibault rejections,
etc.) can trigger `sendFailureAlert()` many times in quick succession -
without throttling, that means an inbox full of near-identical emails.

- **One real email per rolling 15-minute window, per alert type**
  (`ALERT_THROTTLE_WINDOW_MS` in `lib/alerts.js`). 15 minutes is long enough
  to meaningfully cut the noise during an outage, short enough that a
  still-ongoing issue resurfaces well within the same working session.
- **Every occurrence is still logged**, throttled or not - only the actual
  email send is skipped. A throttled occurrence logs a clear line stating
  it was throttled, plus a running count of how many have been suppressed
  since the last real send.
- **"Rolling window" means sending resets the clock**: the first occurrence
  of a type always sends; the next one within 15 minutes of that send is
  suppressed (but counted); the first occurrence *after* 15 minutes have
  passed since the last send fires again - and its email body says how many
  were suppressed in between (e.g. *"This issue has occurred 4 times in the
  last 15 minutes; only this alert was sent to avoid flooding your
  inbox."*).
- **Throttling is independent per type** - a flood of `thibault_rejection`
  alerts never suppresses an `admin_token_failure` or any other type. Each
  type tracks its own last-sent time and suppressed count.
- **In-memory only, by design** (a `Map` in `lib/alerts.js`) - resets on
  restart, and isn't shared across multiple server instances. Fine at this
  project's scale; a shared store (Redis, a DB row, etc.) would be needed
  if that ever changes.

**Env vars:**
- `RESEND_API_KEY` - from your Resend account.
- `ALERT_EMAIL_TO` - where alerts go. **If blank, no email is sent at all** -
  `sendFailureAlert()` logs a warning with what would have been sent and
  returns, rather than crashing. Useful before a final recipient is decided;
  the local testing address doesn't have to be the eventual production one.
- `ALERT_EMAIL_FROM` - optional, defaults to Resend's shared sandbox address
  `onboarding@resend.dev`. A real from-address (e.g. `alerts@bikerlab.com`)
  needs a verified sending domain in Resend first.

**Testing locally:**
```
npm run test:alert
```
Calls `sendFailureAlert()` with fake data for all four scenarios above.
With `RESEND_API_KEY` + `ALERT_EMAIL_TO` set, it sends 4 real emails (check
your inbox for 4 distinct subject lines). With either unset, it logs exactly
what each email's subject and body would have been instead - same
mock/live auto-detect pattern used for the Shopify Admin and Thibault
clients elsewhere in this project, so alerting can be exercised without
real Resend credentials too. Each type is only called once, so nothing here
gets throttled.

To test throttling itself, run:
```
npm run test:alert-throttle
```
Deliberately hermetic (doesn't load `.env`, never sends a real email
regardless of what's configured) - it fires the same alert type 5 times in
a tight loop and asserts: only 1 of the 5 attempts a send, the other 4 are
logged as throttled with a correctly incrementing suppressed count, a
different alert type fired mid-burst is completely unaffected, and after
simulating the window elapsing (`expireThrottleWindow()`, a small
test/ops-only escape hatch exported from `lib/alerts.js`), the next
occurrence sends again and correctly reports "4 times" suppressed.

## Order status dashboard

A password-gated `/dashboard` page (`api/dashboard.js`) lists the ~100 most
recent order-forwarding attempts, newest first, backed by a Supabase table:

```sql
create table order_status (
  id bigint generated always as identity primary key,
  shopify_order_id text not null,
  order_number text,
  sku text,
  distributor text default 'thibault',
  status text not null check (status in ('pending', 'sent', 'failed')),
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- Added for Thibault order confirmation + tracking:
  thibault_order_number text,
  thibault_invoice_number text,
  confirmation text not null default 'not_confirmed'
    check (confirmation in ('not_confirmed', 'confirmed')),
  tracking_carrier text,
  tracking_pin text,
  tracking_shipped_at timestamptz
);
```

**Writing status** (`lib/orderStatus.js`, wired into `api/webhooks/orders-create.js`):
- As soon as a line item is confirmed Thibault-bound (before the Thibault
  call is even attempted), a `pending` row is inserted.
- Once the Thibault call resolves, that row is updated to `sent` (success)
  or `failed` (with `error_message` populated from Thibault's error).
- This happens **even when `THIBAULT_LIVE_CALLS_ENABLED` is off** - the row
  is marked `sent`, with `error_message` noting it was simulated, so the
  dashboard reflects that every local test run "worked" without ever
  implying a real Thibault order was placed.
- **Every Supabase call is wrapped in its own try/catch and never throws**
  (`lib/supabaseClient.js` / `lib/orderStatus.js`) - a missing table, a bad
  key, a network blip, none of it can break or block order forwarding. It's
  logged and the webhook keeps going. (This was actually exercised for
  real during development: the `order_status` table didn't exist yet in
  Supabase on first test, and the webhook still completed normally.)

**Reading status:** `lib/orderStatus.js`'s `listRecentStatuses()` powers the
dashboard; `SUPABASE_MOCK=true` (or missing credentials) makes both reading
and writing no-ops, logged clearly, so local testing that isn't about
Supabase specifically doesn't have to touch it.

### Order confirmation and tracking

A row being `sent` only means *we* successfully called Thibault's Order API
- it doesn't prove Thibault actually has the order. Confirmation and
tracking use **Thibault's own API as the source of truth** instead:

- **Confirmation** (`checkThibaultInvoice()` in `lib/thibaultClient.js`):
  right after a successful send, a read-only `GET /api/v1/invoices?customer_refs={ref}`
  call checks whether Thibault already has a matching invoice, using the
  same `customer_refs` value sent in the order payload.
  - **Found:** the row is marked `confirmation: confirmed`, and Thibault's
    real `thibault_order_number` + `thibault_invoice_number` are saved.
  - **Not found:** the row stays `not_confirmed` - this is expected and
    neutral (Thibault usually hasn't processed the order yet), not an
    error. It is never conflated with a failure.
  - The dashboard's **"Recheck confirmation"** button (shown on any `sent`
    row that isn't confirmed yet) re-runs this exact same check on demand.
- **Tracking** (`getThibaultTracking()` in `lib/thibaultClient.js`): once
  confirmed, `GET /api/v1/tracking?order={thibault_order_number}` fetches
  carrier, tracking number, and ship date, shown in the Tracking column.
  The **"Refresh tracking"** button re-runs this, since shipment status
  changes over time.
- **Entirely read-only** - both are GET requests against Thibault's API,
  so there's zero risk of ever creating a duplicate order.
- **Gated behind `THIBAULT_LIVE_CALLS_ENABLED`** exactly like
  `submitThibaultOrder()` - while it's off, both checks return "not found"
  immediately with no network call, since there's no real Thibault order to
  check against yet.
- Response shapes (`items[].document.{order,invoice}` and
  `items[].shipment[].{pin,carrier,label_date}`) come directly from
  Thibault's own `/docs` page for these two endpoints - not guessed.

**Dashboard columns:** Order #, SKU, Status (`sent`/`failed`/`pending`),
Thibault Confirmation (confirmed/not confirmed badge + the real Thibault
order number once known, plus the Recheck button), Tracking (carrier +
tracking number + ship date once available, plus the Refresh button),
Timestamp, Error.

**Viewing the dashboard locally:**
```
npm run dev
```
then visit `http://localhost:3000/dashboard` in a browser. You'll see a
styled login form (not a browser popup) - enter `DASHBOARD_PASSWORD` from
`.env`. A signed session cookie (12h) keeps you logged in after that; a
"Sign out" link in the header clears it. Falls back to a stacked card
layout on narrow (mobile) screens instead of a horizontally scrolling
table.

**Auth:** the login form posts to `/dashboard`, checked with a
constant-time password comparison (same reasoning as the webhook's HMAC
check) against `DASHBOARD_PASSWORD`. The session cookie is
`HttpOnly`/`SameSite=Lax`, signed via HMAC using `DASHBOARD_PASSWORD` as
the key - no separate secret or session store needed. If
`DASHBOARD_PASSWORD` isn't set, the page denies access entirely (a clear
"not configured" message) rather than showing a form that could never
succeed.

**Testing locally:**
```
npm run test:dashboard
npm run test:confirmation-tracking
```
`test:dashboard` loads real `.env` credentials and verifies a webhook run
writes `pending`→`sent` correctly (cleans up its own test rows afterward).
`test:confirmation-tracking` has two parts: a hermetic mocked-`fetch` test
proving `checkThibaultInvoice()`/`getThibaultTracking()` parse Thibault's
documented response shape correctly (both the found and not-found cases),
and a real-Supabase round-trip proving the new columns read/write
correctly end-to-end. Neither touches Thibault's or Shopify's real APIs.
Both require `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to be set, and
the `order_status` table (with the confirmation/tracking columns above) to
actually exist - they'll say so clearly rather than silently passing.

## Environment variables

Copy `.env.example` to `.env` and fill in:

> **Also required on Vercel, but not an app env var:** `NODEJS_HELPERS=0`
> must be set in the Vercel project's Environment Variables (not `.env` -
> it's a platform setting, has no effect locally, and isn't read via
> `process.env` anywhere in this code). See **Raw webhook body &
> NODEJS_HELPERS** above - without it, HMAC verification fails on every
> real webhook delivery.

| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_WEBHOOK_SECRET` | Yes | Shared secret Shopify signs webhooks with |
| `THIBAULT_API_TOKEN` | Only once live calls are enabled | Bearer token for Thibault's API |
| `THIBAULT_LIVE_CALLS_ENABLED` | No | Must be exactly `true` for real Thibault calls to go out. Default (unset/`false`) simulates every Thibault call — see **Thibault live calls are disabled by default** above |
| `SHOPIFY_SHOP_DOMAIN` | Yes (for real tag lookups) | e.g. `biker-lab.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Yes (for real tag lookups) | Dev Dashboard app client ID — does not expire |
| `SHOPIFY_CLIENT_SECRET` | Yes (for real tag lookups) | Dev Dashboard app client secret — does not expire. Used with the client ID to fetch short-lived access tokens (see **Shopify Admin API authentication** below); the underlying token only ever carries the `read_products` scope, nothing else |
| `SHOPIFY_ADMIN_API_VERSION` | No | Defaults to `2024-10` |
| `SHOPIFY_ADMIN_MOCK` | No | Force `true`/`false` to override the mock/live auto-detect |
| `THIBAULT_TEST_MODE` | No | `true` to flag every Thibault order as test_mode (recommended locally) |
| `RESEND_API_KEY` | Yes (to actually send alert emails) | From your Resend account — see **Failure alerting** above |
| `ALERT_EMAIL_TO` | Yes (to actually send alert emails) | Recipient address. Blank = alerts are logged, not sent |
| `ALERT_EMAIL_FROM` | No | Defaults to Resend's sandbox address `onboarding@resend.dev` until a domain is verified |
| `SUPABASE_URL` | Yes (for status tracking) | From your Supabase project's API settings — see **Order status dashboard** |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (for status tracking) | Secret — from the same place. Never commit it |
| `SUPABASE_MOCK` | No | `true` forces status reads/writes to no-op (logged), regardless of the above |
| `DASHBOARD_PASSWORD` | Yes (to access `/dashboard`) | Shared password for the dashboard's HTTP Basic Auth gate |
| `PORT` | No | Local dev server port (default `3000`) |

## Install

```
npm install
```

Requires Node.js 18+ (uses the built-in `fetch`).

## Run locally

1. `cp .env.example .env` and fill in `SHOPIFY_WEBHOOK_SECRET` (any string
   works locally — it just has to match between the dev server and the test
   script). Leave `SHOPIFY_SHOP_DOMAIN` / `SHOPIFY_CLIENT_ID` /
   `SHOPIFY_CLIENT_SECRET` / `THIBAULT_API_TOKEN` blank for now — see
   **Testing without real credentials** below.
2. Start the local dev server:
   ```
   npm run dev
   ```
   It prints whether product tag lookups are `MOCKED` or `LIVE`.
3. In another terminal, send the sample order (properly HMAC-signed, just
   like a real Shopify webhook):
   ```
   npm run test:order
   ```
   Or point it at a different fixture: `node scripts/send-test-order.js path/to/order.json`.
4. Watch the dev server terminal for structured log lines (console only -
   see **No filesystem writes**).
5. Run `npm run test:order` again with the same fixture to see duplicate
   protection kick in (`{"status":"skipped","reason":"duplicate"}`) - this
   now requires `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` to be set, since
   it's backed by the `order_status` table rather than a local file.

The sample fixture (`fixtures/sample-order.json`) contains two Thibault line
items (different SKUs, to exercise the one-call-per-SKU logic, and their
`product_id`s) and one non-Thibault item (to prove filtering works).

### Testing without real credentials

Product tag lookups are mocked automatically whenever `SHOPIFY_SHOP_DOMAIN`,
`SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` aren't all set (see
`lib/productTags.js`). In mock mode, `lib/shopifyAdminMock.js` reads canned
tags from `fixtures/product-tags.json` (keyed by `product_id`) instead of
calling the real Admin API — and `lib/shopifyAdminAuth.js`'s token
fetching/refresh logic is never touched at all — that's what the sample
order above exercises. One of the two fixture products deliberately has its
tag written as `"  supplier-thibault  "` (extra spaces, lowercase) to prove
the normalized match handles messy real-world tag entry.

**To switch to real lookups**, no code change is needed: just set
`SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` in
`.env`, and `lib/productTags.js` will start calling the real Shopify Admin
API (with real, auto-refreshed access tokens) instead. `SHOPIFY_ADMIN_MOCK=
true` / `false` can also force one mode or the other regardless of what's
set.

**Heads up:** if real Admin credentials are set, `fixtures/sample-order.json`
will 404 against them — its `product_id`s are made-up placeholders, not real
products in your store. Either swap in real `product_id`s from your catalog,
or run with `SHOPIFY_ADMIN_MOCK=true` to keep using the fixture data while
Admin credentials stay configured for other purposes. A single such failure
no longer aborts the order, though - see **Retries and unresolved items**
above.

To test the token cache/expiry/refresh logic itself (without hitting
Shopify's real OAuth endpoint), run:
```
npm run test:token-refresh
```
This mocks `fetch`, calls `getAccessToken()` twice to prove a valid cached
token is reused (only one token request fires), then clears the cache to
simulate expiry and confirms a new token is fetched on the next call.

To test the retry + unresolved-item handling, run:
```
npm run test:unresolved-item
```
This sends `fixtures/sample-order-with-unresolved-item.json` (one
confirmed-Thibault item, one confirmed-non-Thibault item, and one item whose
mocked tag lookup always fails) straight through the real webhook handler,
and asserts: exactly 2 retries happen for the failing product before it's
given up on; the confirmed-Thibault item still gets forwarded (via the
simulated path) despite the other item failing; the confirmed-non-Thibault
item is still correctly excluded; and the failed item is logged via
`console.warn` with the right order/product/SKU details - never silently
dropped, never miscounted as "not Thibault."

## What's stubbed out vs. working

**Working:**
- HMAC webhook verification (constant-time comparison)
- `Supplier-Thibault` tag-based line item filtering, via a real (or mocked)
  Shopify Admin API lookup — case-insensitive, whitespace-trimmed
- Sequential, rate-limit-aware product tag lookups with a 1-hour in-memory
  cache, retried on failure, with unresolved items tracked separately
  rather than dropped or misclassified (see **Retries and unresolved items**)
- OAuth `client_credentials` token fetching, in-memory caching, and
  expiry-aware auto-refresh for the Shopify Admin API (`lib/shopifyAdminAuth.js`)
- Order → Thibault payload mapping (per the documented Order endpoint schema)
- One simulated (or, once enabled, real) call per SKU against the Thibault
  Order endpoint shape
- Supabase-backed duplicate-order protection (see **No filesystem writes**)
- Structured logging to console only - nothing written to disk anywhere in
  this project (see **No filesystem writes**)
- Failure-alert emails via Resend for all four scenarios in **Failure
  alerting** above — real sending, not a stub, as long as `RESEND_API_KEY`
  and `ALERT_EMAIL_TO` are set
- Order-status tracking to Supabase (`pending` → `sent`/`failed` per SKU)
  and the password-gated `/dashboard` page (real login form + session
  cookie, not the browser's Basic Auth popup) — real, not a stub, as long as
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set **and** the
  `order_status` table actually exists in that Supabase project (see
  **Order status dashboard**)
- Order confirmation + tracking against Thibault's own `/invoices` and
  `/tracking` endpoints (read-only GETs, response shapes confirmed against
  their docs) — real parsing/writing logic, gated the same way as
  everything else behind `THIBAULT_LIVE_CALLS_ENABLED`

**Stubbed / disabled by design:**
- **Real Thibault API calls are off by default** — see **Thibault live
  calls are disabled by default** above. `THIBAULT_LIVE_CALLS_ENABLED=true`
  turns them on when we're ready.
- Real Shopify Admin API product tag lookups — mocked by default (see
  **Testing without real credentials**) until `SHOPIFY_SHOP_DOMAIN` +
  `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` are set. (Unlike Thibault,
  once those are set the Admin API lookups go live immediately - there's no
  separate enable flag for this one, since reading product tags is
  low-risk. `THIBAULT_LIVE_CALLS_ENABLED` is the only gate that matters for
  actually contacting the supplier.)
- Deployed on Vercel — `api/*.js` handlers, plus `vercel.json` rewriting the
  clean `/dashboard` URL to `/api/dashboard` (Vercel's default file-based
  route). See **No filesystem writes** above for the read-only-filesystem
  constraints that come with running here.
