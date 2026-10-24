<!-- PURPOSE: Worksheet trace for the 2026-10 polish pass (model filtering, free providers, settings/keys, UI, security) -->
<!-- OWNS: Root-cause evidence, decisions, implementation map, proof for this pass -->
<!-- READ-WHEN: Touching model classification, probe/sweep verdicts, dashboard auth, Worker persistence/sync, or the dashboard UI -->
<!-- KEY-FILES: src/modality.mjs, src/catalog.mjs, src/probe.mjs, src/freeLanes.mjs, src/probeStore.mjs, src/dashboardAuth.mjs, src/session.mjs, src/authGuard.mjs, src/workerConfig.mjs, web/dashboard*.js -->
<!-- INVARIANTS: Only chat models enter the pool; a 429 is never a failure; only billing / 404 / keyless-lane 401|403 demote (soft ones expire); secrets never reach the KV config; the dashboard password never lives in the page -->
<!-- GOTCHAS: Worker lockout counters are per isolate (best effort); KV is eventually consistent (~60s); health survives restarts only through probeStore -->
<!-- UPDATED: 2026-10-23 -->

# Polish pass — report → root cause → fix

## Reported
Filtering of working models broken; video/other non-text models in a text-only pool; settings
don't work; key settings and UI poor; security weak (personal dashboard, cloud deployed).

## Root causes found (evidence from code + tests, not guesses)
1. **Non-text models leaked** — `catalog.mjs` classified by name regex only; providers' `/models`
   metadata (output modalities, capabilities, generation methods) was thrown away at the adapter.
   Video names (`veo`, `wan2.x`, `kling`, `seedance`…) and TTS/image-preview models with a
   `generateContent` method were never matched.
2. **No notion of "working"** — the pool had no verified state; the sweep treated HTTP 400 as
   `notfound` and demoted *permanently*, and an `auth` (401/403) sweep result on a rotated key
   demoted a whole provider until restart. 429s on free tiers were counted as failures.
3. **Settings never saved** — `PUT /api/config` treated `name` as an object, so the settings form
   (which always sends `name`) answered 400 every time. Also: pool / provider-enable changes only
   took effect at the next scheduled refresh; on Workers, saves were fire-and-forget KV puts and
   each isolate held its own in-memory config (never re-read), so changes vanished or disagreed.
4. **Key UI** — only the *last* key of a provider could be removed; no per-key list/toggle; client
   keys could not be paused; multi-key paste unsupported.
5. **Security** — dashboard password in sessionStorage and in `?key=` URLs (SSE); failed GET
   logins unlimited (rate limit only on writes); CSP allowed inline scripts; password compare
   leaked length; no sign-out-everywhere; custom endpoint URLs allowed plain http / private hosts.

## Decisions
- Classification: metadata first, token-aware name rules second; filtered models stay listed with a
  reason and `selection.forceChat` lets the owner override.
- Free lanes: per-provider hourly ceiling on *background* checks; manual Test always runs.
- Auth: stateless HMAC session cookie (key = password + `security.sessionEpoch`) so it works on
  Workers with no session store; bearer password still accepted for scripts (same lockout).
- Worker: awaited durable writes for shared state, coalesced fire-and-forget for the rest, a KV
  revision key for cross-isolate sync, and probe results persisted (7-day horizon).

## Proof
- `node --test` 230/230 on Node 24 (baseline 189). Mutation audit: re-introducing each of
  name-bug / 429-as-failure / no-classifier / no-pool-refresh / no-lockout / no-probe-flush fails a test.
- Real browser (Chromium) run of login, every tab, test/filter/allow, key add/toggle/remove, client
  key pause, settings validation + save, dark + mobile: 0 console errors.
- Real Workers runtime (`cf dev`): headers, login cookie, config save → survives restart,
  sign-out-everywhere epoch persisted, password absent from KV store files.
- Not exercised: real providers online (sandbox had no internet), a real Cloudflare deploy.
