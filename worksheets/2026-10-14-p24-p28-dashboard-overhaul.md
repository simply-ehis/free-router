<!-- PURPOSE: Worksheet trace for the P24-P28 dashboard + router overhaul -->
<!-- OWNS: Overhaul scope decision, per-slice implementation steps, live-verification evidence -->
<!-- READ-WHEN: Touching dashboard tabs/frontend modules, playground, scoring studio, provider testing, or analytics -->
<!-- KEY-FILES: web/dashboard.{html,css}, web/dashboard-{js,models.js,playground.js,pages.js,analytics.js,settings.js}, src/dashboardAssets.mjs, src/worker.mjs, src/{playground,scoring,providerTest,usage}.mjs -->
<!-- INVARIANTS: zero-deps frontend (no CDN); 7-tab IA (playground arrived P25); every slice leaves npm test green -->
<!-- GOTCHAS: assetCache in dashboardAssets.mjs caches per process — restart the dev server after frontend edits or live checks serve stale files -->
<!-- UPDATED: 2026-10-14 -->

# P24-P28 — Dashboard + router overhaul

## Scope decision (user, 2026-10-14)
Approved plan: build all 5 slices in order —
P24 IA/UI foundation → P25 Playground → P26 Scoring studio → P27 Key testing → P28 Analytics.
Full plan lives in PLAN.md phases 24-28.

## P24 — IA restructure + UI foundation (2026-10-14)

### What changed
1. Tab restructure: 7-tab target IA (overview · playground · models · providers ·
   analytics · security · settings). This slice delivers 6 tabs in final order — usage+logs
   merged into **analytics**; Playground tab lands with P25.
2. Frontend split (500-line rule): core `dashboard.js` (auth/SSE/helpers/overview/snapshot
   dispatch + toast/fail feedback + `onSnapshot(fn)` hook registry) · new
   `dashboard-models.js` (viewer moved out of core) · trimmed `dashboard-pages.js`
   (providers+custom endpoints+security) · new `dashboard-analytics.js` (usage+logs) ·
   new `dashboard-settings.js`. Each new file wired through `dashboardAssets.mjs#ASSETS`,
   `worker.mjs` `?raw` imports, and a `dashboard.html` script tag (order matters: core first).
3. Design pass (`dashboard.css`): focus-visible outlines, row hover, disabled-input
   affordance, toast (fixed bottom-right, .bad variant), thin scrollbars, meta truncation.
4. Bug fixes found on the way: `bin/run.ps1` still contained the apply-template placeholder
   (`<command that starts/runs the app...>`) so "run the app" smokes always failed — fixed to
   `node src/index.mjs`, logged in AGENT_FEEDBACK.md; usage "168-day ledger" wording
   (retainHours is hours, rendered as days) — fixed to `Math.round(hours/24)`-day.

### Proof
- `npm test`: 150/150 (asset test extended to enumerate all 6 assets with per-file markers).
- Live browser pass (Node dev server via fixed run.ps1): login ok; all 6 tabs render;
  overview cards/meta, models empty-state, providers 8 rows + 7 key-form options,
  analytics (6 cards + chart + 200 audit entries), security cards + client keys, settings
  form loaded (name/pool/compaction); `toast()` fires (class=show); **zero console errors**.
- Screenshot unavailable in this environment (desktop window not visible) — DOM-state
  assertions used instead.

### Next
P25 Playground (new src/playground.mjs + dashboard-playground.js + tab).

## P25 — Playground: talk to models (2026-10-14)

### What changed
1. `src/playground.mjs` (new): `playgroundChat(body, cfg)` — dashboard-authed
   `POST /api/playground` through `runChat` with meta `{keyId:'playground', keyLabel:'playground'}`
   (usage ledger attributes every turn). Validation: 1-200 string-content messages, roles
   allowlist; temperature 0..2; maxTokens 1..32768. `model` omitted → engine sentinel `auto`
   (unknown id → pure strategy order, or configured defaultModel). Non-stream →
   `{reply, model, provider, ms, attempts, tokensIn/Out, compacted}`; `stream:true` → raw
   engine SSE relay with `x-router-model/-provider/-attempts` headers. Stealth intentionally
   NOT applied — the dashboard is the operator console, real ids stay visible. Engine errors
   pass through with the attempt trail.
2. `src/dashboard.mjs`: route branch (playground reuses handlePost's parsed body) + import.
3. `web/dashboard-playground.js` (new): transcript (user/assistant/error bubbles, textContent
   only — model output never becomes HTML), model picker fed via `onSnapshot` hook registry
   (auto + every catalog id), system prompt (re-applied to every turn, not stored in
   transcript), temp + max-tokens + stream toggle, incremental SSE parser with carry buffer,
   stop (AbortController; partial text kept + marked), regenerate, clear, Enter-to-send.
4. `web/dashboard.html`: playground tab (position 2) + section + script tag;
   `dashboardAssets.mjs` + `worker.mjs` `?raw` bundle wired.

### Proof
- `npm test`: 158/158 (8 new: auth 401 ×2, validation 400 ×5 payloads, non-stream reply +
  meta + tokens + upstream passthrough (system first, temperature, max_tokens, real id
  substituted for auto), pinned-vs-unknown fallback, SSE relay + headers, usage ledger
  attribution, engine 502 passthrough with attempt trail).
- Live: playground tab renders, composer + controls present, graceful error path (see final
  overhaul pass) — real-conversation proof needs provider keys (user env currently has none;
  engine covered by mock-upstream tests).

### P27 Key & provider testing

- **P27 Done 2026-10-14** — 171/171. New `src/providerTest.mjs`: minimal authenticated chat
  ping (`max_tokens: 1`) per native provider — listModels is keyless everywhere, so the ping
  validates the exact chat path the router uses. Newest installed key or provided candidate
  key; time-boxed (8s chat / 6s discovery); catalog-first model discovery with live
  keyless-list fallback; masked result (`ok/model/ms/keyMasked/keySource/errorKind`);
  `POST /api/providers/test` (single or all enabled; compat instances keep their probe);
  audit `providers.test`. Providers tab: per-row test + `✗ nokey`-style badges
  (`providerTests` map survives snapshot rebuilds), "test all keys" button, "test key"
  test-before-save in the add-key form (key stays in the field on failure).
- Live: test-all → 7 rows `✗ nokey` (user env keyless, graceful, fast); test-before-save
  with bogus key hit REAL zen → upstream message surfaced + kind `freetier`; key not
  persisted; zero console errors.
- Note: session gap reaped background shells (app server + mock) — restarted both;
  502 in browser was the dead server, not a code fault.

- **P26 Done 2026-10-14** — 165/165. `smartest.mjs` refactored to a single math path
  (`scoreBreakdown` → components/weights/total; `scoreModel` = thin view). New
  `src/scoring.mjs` (`scoringSnapshot`, `setScoringWeights` with validation + merge +
  saveConfig). Routes: `GET /api/scoring`, `POST /api/scoring/weights` (400 on bad/unknown/
  out-of-range/all-zero; audit `scoring.weights`). `statusSnapshot` now attaches per-model
  `components` + `weights` (models-tab breakdown rides the 2s SSE). Frontend: Settings →
  Scoring section (5 sliders + live output + client-side top-5 preview using the same
  renormalized math + reset + save with toast); Models tab "why" button toggles a component
  breakdown detail row (survives snapshot rebuilds via `expandedModels` set; `data-why`
  avoids the core `data-action` handler).
- Mutation audit: weight application neutered → strategies+scoring tests red; reverted →
  16/16 green, file byte-exact vs pre-mutation backup.
- Live: sliders/preview/reset verified (preview 42→38 matches engine normalization);
  "why" row `success 0.50×0.40 … total 51`; REAL playground conversation via a temporary
  mock compat instance (stream + non-stream, meta `mocklocal:mock-writer · openai-compat ·
  591 ms · attempts 1`, tokens 5/7, regenerate visible); analytics shows playground
  attribution + "7-day ledger" fixed wording. Zero console errors.
- Cleanup: mock instance deleted, `openai-compat.enabled` restored to original false;
  config verified back to its pre-check shape.

### P28 Analytics upgrade (overhaul slice 5 — final)

- **P28 Done 2026-10-14** — 175/175. Ledger (`src/usage.mjs`, 189→~230 lines): hourly
  buckets gain `msTotal` (success-only latency, mirroring model math) + `failover`
  (attempts beyond the first); `attemptIndex` (0-based) inlined at all 4 `routes.mjs`
  record sites — same-line edits, file stays 499/500; pre-P28 persisted buckets normalized
  on load (`{msTotal:0, failover:0, ...saved}`) so old ledgers never NaN; `totals` gains
  `successRate` + `failover`; new `providerRollup()` sums the model ledger by provider
  (requests, ok/fail, tokens, successRate, avgMs, sorted by requests); hourly rows
  precompute `successRate` + `avgMs`. Frontend (`dashboard-analytics.js`, zero deps):
  3 SVG charts — requests bars + success-rate polyline (fail-majority hours in bad color,
  native `<title>` tooltips; `preserveAspectRatio="none"` + shapes-only so nothing distorts),
  latency line with full-height hover gutters, tokens-out bars; 8 stat cards (+retries,
  +success %); "By provider" table with CSS share bars; "Top models" leaderboard with rank
  column + inline ok %; `usageRefreshSoon()` debounced live refresh wired into the SSE
  route events (`dashboard.js` core, typeof-guarded). New `tests/analytics.test.mjs`
  (4 tests: legacy-ledger normalization, bucket latency/failover accumulation, provider
  rollup math/sort, no-attemptIndex guard).
- Mutation audit: failover counting + success-rate math neutered together → 2 tests red
  (173/175); reverted byte-exact vs `%TEMP%\usage.bak.mjs` → 175/175.
- Live: charts/cards/tables render from the persisted P26 ledger (1 hour, 2 req);
  fresh mock-instance traffic (2 playground sends, `mock-local:mock-echo`, 8/5 ms) made the
  tab auto-update 2→4 requests **without any interaction** (SSE → `usageRefreshSoon`),
  second hour bucket drew the success-rate polyline, provider rollup + leaderboard ranked
  (`mock-local:mock-echo` #1). All 7 tabs re-pass (every page renders, zero console errors).
- Friction: dashboard DELETE instance takes `prefix` in the body (query-param form 400s);
  mock upstream serves bare `/models` + `/chat/completions` — compat baseUrl must NOT carry
  `/v1` (duplicate-name 400 followed the failed delete; recovered).
- Cleanup: mock instance deleted, `openai-compat.enabled` restored to false (verified
  instances=0, enabled=false via config GET).

### Deploy — Cloudflare Workers (2026-10-14)

- `npx cf deploy` (auth already valid via OAuth profile; no interactive login needed —
  the P18 blocker did not materialize). Build: vite, 59 modules → bundle 232.68 KiB /
  58.24 KiB gzip, startup 17 ms. Version `791cbc94-f40d-4ed6-9667-101b23b6f9cc`,
  schedule `*/2 * * * *` intact, KV binding `DATA` (be5bfb54…) attached.
- Live: `https://free-router.reethym.workers.dev` — cold-boot 200 (scale-to-zero read of
  KV config), all 7 dashboard assets serve the P24-P28 build (markers verified per file:
  usageRefreshSoon, playground, data-why, providerTests, usageProviders/renderLatChart/
  retries, weights, chart-grid CSS); unauthed `/api/status` → 401 (auth gate intact).
- Secrets persist across deploys — all 6 still bound (GATEWAY_KEY, COMPAT_CREDENTIALS_KEY,
  4 provider-key secrets). Live GATEWAY_KEY ≠ local dashboard password (set separately at
  the Oct-12 deploy) — user provided it (from Documents/gateway.txt) for the battery below.
- **Stub-secret purge (user-ordered, 2026-10-14):** all 4 `FREE_ROUTER_*_KEYS` secrets
  deleted from the Worker (`cf workers secrets delete --force` — each creates a new
  version without the binding, no redeploy). Remaining: `COMPAT_CREDENTIALS_KEY` +
  `GATEWAY_KEY` only. Verified live: every provider `keys=0`, catalog refresh back to
  `refreshOk:true` (keyless providers are skipped, not errors). Pool repopulates by
  itself the moment the user `cf workers secrets put` real keys — cron, no redeploy.
- Local `.dev.vars` cleaned with user's explicit approval: 4 stub lines removed
  (`FREE_ROUTER_*_KEYS`), `GATEWAY_KEY` preserved; backup at `%TEMP%\dev.vars.bak`.
- Authenticated live battery (read-only): `/api/status` ✓ (strategy sticky, decision
  jev-1.13-free), `/api/usage` ✓ (P28 shape: totals/providers/hourly/retainHours), `/api/scoring`
  ✓ (weights snapshot). Live `POST /api/providers/test` (P27 running on the deployed build):
  zen `freetier`, openrouter `auth`, groq/gemini `nomodel`, rest `nokey` → the Oct-11 stub
  secrets are still live → every keyed provider errors on listing → catalog stays empty →
  `refreshOk:false`. Not a deploy regression (adapters untouched; user env known-stub).
  Fix (user): `npx cf workers secrets put FREE_ROUTER_*_KEYS` with real keys — the */2-min
  cron repopulates the pool, no redeploy needed. Also noted: `uptimeSec` reports epoch on
  Workers (boot time never captured — pre-existing worker quirk, cosmetic).
- **P25 Done 2026-10-14** — 158/158; live browser send → user bubble + graceful 503 error
  bubble + clean state recovery (no JS errors); real-conversation rendering covered by the
  8 mock-upstream tests.
