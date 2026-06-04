# Deployment

End-to-end steps to get unmute-cloud running on top of the existing BoloAI Supabase + Cloudflare infrastructure. **Do these in order.**

## 0. Prerequisites

- `wrangler` CLI authenticated against the Cloudflare account that hosts `bolo-pipeline`/`bolo-config`
- Supabase service-role key for the existing project (in `~/tools/unmute/BoloAI/.env`)
- A Groq API key (the one already in BoloAI's Cloudflare secrets is fine — we'll reuse)
- macOS signing/notarization env vars (same as the OSS engine release flow): `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`

## 1. Apply the new Supabase migration

The migration is **additive** — it doesn't touch BoloAI's existing tables. It adds `balance_cents` to `profiles`, the `wallet_ledger` table, the `topups` table, and the `debit_wallet` / `credit_wallet` RPCs.

```bash
cd ~/tools/unmute/unmute-cloud
# Option A: via Supabase CLI (recommended)
supabase db push --db-url "<your-supabase-connection-string>"

# Option B: via Studio SQL editor — paste the contents of
#   backend/supabase/migrations/005_managed_paywall.sql
# directly and run.
```

Verify:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles'
ORDER BY column_name;
-- Should include `balance_cents`

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('wallet_ledger', 'topups');
-- Should return both
```

## 2. Create the KV namespace for balance cache

```bash
cd backend/cloudflare/pipeline
wrangler kv:namespace create USER_BALANCE
# → output:
#   { binding = "USER_BALANCE", id = "abcd1234..." }
```

Paste the returned `id` into the `kv_namespaces` block of:

- `backend/cloudflare/pipeline/wrangler.toml`
- `backend/cloudflare/payments/wrangler.toml`

(Both workers share the same KV namespace — pipeline decrements, payments credits.)

## 3. Set secrets on both workers

```bash
# Pipeline worker
cd backend/cloudflare/pipeline
wrangler secret put GROQ_API_KEY                # paste Groq key
wrangler secret put SUPABASE_URL                # paste Supabase project URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # paste service-role key

# Payments worker
cd ../payments
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# DODO_WEBHOOK_SECRET — set when Dodo integration lands
```

## 4. Deploy the workers

```bash
cd backend/cloudflare/pipeline && npm install && npm run deploy
cd ../payments && npm install && npm run deploy
```

Note the deployed URLs — typically:

- `https://unmute-pipeline.<your-subdomain>.workers.dev`
- `https://unmute-payments.<your-subdomain>.workers.dev`

## 5. Sanity-check the pipeline worker

```bash
# Get a JWT from Supabase (sign in via the desktop app once and copy from the keychain,
# or use the supabase-js CLI). Then:
TOKEN="<jwt>"
curl -H "Authorization: Bearer $TOKEN" https://unmute-pipeline.<sub>.workers.dev/v1/me
# Should return { ok: true, balance_cents: 0, top_up_url: ... }
```

## 6. Configure the desktop build

Edit `desktop/build/wire-into-engine.sh` (or pass as env vars) with the deployed URLs and Supabase keys:

```bash
export __SUPABASE_URL__="https://<project>.supabase.co"
export __SUPABASE_ANON_KEY__="<anon-key>"
export __PIPELINE_URL__="https://unmute-pipeline.<sub>.workers.dev"
```

The build script injects these into the renderer + main process via the bundler's `define` config.

## 7. Build the unified DMG

```bash
cd desktop
./build/wire-into-engine.sh build
```

Output: a signed + notarized DMG under `desktop/work/oss-engine/release/`.

Inside this build:

- BYOK + Local routes are **untouched** from the OSS engine — they work identically
- Managed route hits your deployed pipeline worker
- First launch shows the 3-card onboarding (Managed / BYOK / Local)
- Sign-in is gated to Managed only

## 8. Publish

Upload the DMG and `latest-mac.yml` to a public GitHub release on `arpitpatel25/unmute-dictation` (auto-updater pulls from there). Bump `arpitpatel25/homebrew-unmute` cask sha256.

For the OSS-only build (no paywall layer), users can still build directly from `arpitpatel25/unmute-dictation` — that's the OSS path, fully supported.

## Rollback

If the managed route is misbehaving, you can disable it server-side by setting a feature flag in the pipeline worker (`return 503 INSUFFICIENT_BALANCE` on every request), or by removing the worker route. Users in `auto` mode will fall back to BYOK/Local automatically. Users in `managed` mode will get a clear error.
