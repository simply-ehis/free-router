# PURPOSE: Full build plan for free-router — self-hosted free-model router (pipeline + all phases)
# OWNS: The single source of truth for scope, architecture, phases, and proof gates
# READ-WHEN: Before implementing any phase; when scope/design questions arise
# KEY-FILES: src/* (per layout below), config.example.json, README.md, tests/
# INVARIANTS: Pool = any model a configured key can reach — if it works it is used (runtime health gates, no free/paid filter) · every upstream call time-boxed · secrets never leave server · no strategy/decision/dashboard failure can stop serving · config edits validated + atomic
# GOTCHAS: Free model list changes daily (runtime demotion is the safety net) · Zen free models span 3 upstream protocols · jev-1.13-free is keyless + non-generative (systemone only) · streaming failover only before first byte
# UPDATED: 2026-10-10

# free-router — Full Build Plan

**One-liner:** An OpenRouter-style, self-hosted, zero-dependency router that exposes ONE
single API key ("cloud key") to any client (Cline, opencode, anything OpenAI-compatible),
while the backend auto-detects free models, pools multiple keys/accounts, scores and
rotates routes (sticky-until-failure), probes/pre-warms standbys, and uses Jev (free
decision model) as its internal brain. Production-grade, customizable selection logic,
controlled via a built-in dashboard.

- **Location:** `C:\Users\ehis\source\repos\free-router`
- **Runtime:** Node 24, **zero npm dependencies** (single process, nothing to install)
- **Default bind:** `127.0.0.1:4141` (opt-in `0.0.0.0` for LAN)

---

## 1. Research findings (verified 2026-10-09)

| # | Finding | Source |
|---|---|---|
| 1 | Zen key lives in `~/.local/share/opencode/auth.json` → `.opencode.key` (top-level `opencode: { type, key }`) | local inspection (value never read/printed) |
| 2 | `GET https://opencode.ai/zen/v1/models` → 87 models, **no pricing metadata** (only `id/object/created/owned_by`) | live call |
| 3 | Free detection signals: `-free` ID suffix (Zen convention), models.dev pricing `$0.00/$0.00` (catches stealth models like `big-pickle`), runtime billing/quota errors (demote instantly) | docs + models.dev |
| 4 | Zen free models span **3 upstream protocols**: `chat/completions` (most free), `responses` (muse-spark free), `systemone` (jev free). Do NOT send everything to one endpoint. | opencode docs (zen) |
| 5 | **`jev-1.13-free` works KEYLESS** at `POST https://opencode.ai/zen/v1/systemone`, `cost: "0"`, 70–500 ms. Body: `{model, state, questions}`. Returns typed answers: `noul` (0–1 yes-probability), `choice` (option + probabilities + confidence), `score` (rubric + confidence). No text parsing needed. Paid `jev-1.13` requires key + workspace (401 otherwise). | opencode docs + typeSafe docs + independent verification (2026-10-05) |
| 6 | Jev use cases fit a router: intent routing, confidence gating, composite scoring, truth-checking (tool-call verification) | typeSafe docs |
| 7 | Node v24.15.0 + npm available; Python 3.12 available; `rg` NOT installed | local |

---

## 2. Requirements (from user)

1. **Free-only guarantee** — backend routes ONLY to models that cost $0. Frontend never sees paid models, pricing, keys, or account logic.
2. **Single frontend credential** — one API key ("cloud key", nameable) + one base URL. Everything else is backend.
3. **Multi-key pooling** — add multiple Zen keys (opencode auth auto-import + manual), same model across 3 accounts = 3 routes.
4. **Sticky until failure** (OpenRouter-style) — stay on healthy route, failover on error.
5. **Auto-detect free models** — free list is not steady; catalog refreshes itself; runtime demotion on any billing error.
6. **Priority queue / re-ranking / scoring** — weighted, backend-only, customizable selection logic (`smartest`, `fastest`, …, user-droppable custom strategy files).
7. **Health intelligence** — auto-test models; keep the next model READY (pre-warmed standby) while the current is fresh.
8. **Decision plane** — use free Jev (`jev-1.13-free`) as backend decision model: request classification, tool-call verification ("is this tool call true/justified?"), failure diagnosis, ranking hints. Expose `/v1/decide` to clients.
9. **Dashboard** — self-hosted control panel: manage keys, catalog, routes/scores/pins, strategy + weights (hot-apply), decision toggles, live monitor, config editor.
10. **Production posture** — time-boxed calls everywhere, structured logs, config validation, graceful shutdown, `/healthz`, audit trail; nothing (strategy/decision/dashboard/provider outage) can take down serving.
11. **Like OmniRoute, but lighter** — suitable for production as a lightweight self-hostable router, free forever.

---

## 3. Architecture

```
Cline / opencode / any OpenAI-compatible client
   │   ONE key ("cloud key") + ONE base URL  →  http://127.0.0.1:4141/v1
   ▼
┌─ free-router (single Node process) ───────────────────────────────┐
│  server      /v1/models  /v1/chat/completions  /v1/decide         │
│              /status  /healthz  /  (dashboard)  /api/*  /api/events│
│  catalog     free-model auto-detection + refresh loop             │
│  routes      route table = (provider × model × credential)        │
│              telemetry: latency EMA · success window · 429 headroom│
│              states: ACTIVE → STANDBY → DEGRADED → DEAD           │
│  strategies  sticky (default) · smartest · fastest · roundrobin   │
│              + custom strategy files (config-named, time-boxed)   │
│  probe       background health probes + standby pre-warm          │
│  decision    Jev client (jev-1.13-free, keyless) + tool-verify    │
│  providers   zen (multi-account) · openrouter · groq · gemini     │
└───────────────────────────────────────────────────────────────────┘
   │  hard filter: cost == $0 only (suffix / models.dev / runtime demotion)
   ▼
Zen account ×N · OpenRouter free · Groq free tier · Gemini AI Studio free
```

### Core mechanism → design mapping

| Requirement | Design |
|---|---|
| Single frontend key | Gateway issues one key (config `name`, default `cloud`). Clients use plain "OpenAI Compatible" provider → `http://127.0.0.1:4141/v1`. |
| Free-only (hard) | Catalog admits a route only if ALL signals say free. Runtime: any 402/billing/quota error → route demoted instantly (never billed by surprise). Paid/unknown client request → silently served from free pool; response `model` reports the real route. |
| "Not steady" free list | Catalog refresh: startup + every 10 min + on failure signal. Appears/vanishes handled automatically. `/v1/models` reflects live state. |
| Same model × N accounts | Route rows are `(provider, model, credential)` triples; config keys list; auth.json auto-import. |
| Sticky until failure | Per-model stickiness: current best route serves until 429/401/402/5xx/timeout → retry queue pops next-ranked route. Streaming: failover only before first byte (documented). |
| Scoring / priority queue | Score = weighted sum (config): success-rate window · latency EMA · probe freshness · rate-limit headroom · per-route priority. Weights editable in dashboard. |
| Auto-test + ready next | Prober every ~2 min: minimal probe per route. Top standby kept WARM (probed recently) so failover is instant, never cold. Startup probes all candidates for initial readiness. |
| Decision brain | Jev `noul/choice/score` calls (keyless) for: request complexity → smartest routing; tool-call justification gate; failure-cause classification; route-ranking hints. Never blocks hot path (time-boxed, fail-open). |

---

## 4. Strategy engine (pluggable selection logic)

```
src/strategies/
  index.mjs       registry: builtins + config-named custom file; validated at boot (fail fast)
  sticky.mjs      default — stick while healthy, failover on error (OpenRouter-style)
  smartest.mjs    request complexity (decision hints) × model tier × success × freshness
  fastest.mjs     latency-EMA first, then freshness
  roundrobin.mjs  even spread across healthy routes
```

- **Contract:** `async select(context) → rankedRoutes[]`
  `context = { candidates (free+health filtered), telemetry, request meta, config weights, decision hints }`
- **Hard constraints no strategy may override:** free-only filter, health states. Strategy only *re-ranks* eligible routes.
- **Custom strategies:** drop `strategies/my-pick.mjs`, set `"selection": {"strategy": "my-pick"}`. Async allowed but **time-boxed (700 ms default)** → timeout falls back to heuristic ranking; request never stalls.
- **Weights (config + dashboard sliders):** `{"success": 0.4, "latency": 0.3, "freshness": 0.2, "priority": 0.1}`

---

## 5. Decision plane (Jev)

`src/decision.mjs` → `POST https://opencode.ai/zen/v1/systemone`, body `{model: "jev-1.13-free", state, questions}` — **no Authorization header** (keyless route is intentional; adding auth risks workspace routing on paid id).

| Use | Question shape | Blocking? | Config |
|---|---|---|---|
| Request classification → `smartest` | `score`: complexity/urgency of request | Async, prefilled (time-boxed) | `decision.classify: bool` |
| Tool-call verification | `noul`: "Is this tool call justified by the conversation?" → low prob = suspect | Sync, fail-open, **non-stream only** (streaming unbuffered by default) | `decision.toolVerify: off\|flag\|block` |
| Failure diagnosis | `choice`: rate-limit / model-dead / billing / transient → backoff class | Async | `decision.diagnose: bool` |
| Ranking hints | `choice`/`score` over route telemetry, sampled | Async, sampled | `decision.rankHints: bool` |
| Client-facing decisions | Gateway endpoint `POST /v1/decide` (same key) passes typed questions through | Sync | `decision.expose: bool` |

**Degradation:** Jev unavailable (429/404/timeout) → decision features log + disable; router keeps serving. Decision plane NEVER takes down the hot path.

---

## 6. Dashboard (self-hosted control panel)

Served at `http://127.0.0.1:4141/` — single-page vanilla HTML/JS/CSS, no deps, no CDN, offline.

| Panel | Actions |
|---|---|
| Keys | add/remove/enable keys (Zen + others), one-click **test** (probe), opencode auth.json auto-import + re-sync, secrets masked (`sk-zen-…a1b2`), write-only (plaintext never returned) |
| Free catalog | detected models + detection reason, **Refresh now**, ban model, auto-refresh countdown |
| Routes & scoring | full table: state, score + component breakdown, latency EMA, last probe; pin route, set priority, force-probe |
| Strategy | strategy dropdown (builtins + custom), weight sliders, validation preview, **hot-apply** (no restart) |
| Decision plane | tool-verify `off/flag/block`, decision model, recent Jev decisions w/ latency |
| Live monitor | SSE stream: request → route, failover chain, latency, errors; counters; log tail |
| Config editor | raw `config.json` w/ schema validation + atomic write; restart-needed changes flagged |

**Dashboard API:** `GET/PUT /api/config` · `POST/DEL /api/keys` (masked GET) · `GET/PATCH /api/routes` · `POST /api/catalog/refresh` · `GET /api/status` · `GET /api/events` (SSE).

**Security:** default bind `127.0.0.1`; all `/api/*` + dashboard require the gateway key (browser localStorage after first paste); config changes validated + audit-logged; secrets write-only.

---

## 7. File layout

```
free-router/
  PLAN.md                     ← this file
  package.json                (no deps; scripts: start / test)
  config.json                 (created on first run from example; gitignored)
  config.example.json
  run.ps1                     start script (print URL + how to get key)
  README.md                   full setup: Cline, opencode, curl, dashboard
  src/
    index.mjs                 boot: config validation → wire modules → serve
    config.mjs                load/validate/atomic-write config; auth.json import
    server.mjs                HTTP: /v1/* + /api/* + dashboard + /status + /healthz
    catalog.mjs               free detection (suffix + models.dev + runtime demotion) + refresh loop
    routes.mjs                route table, telemetry, health states, sticky, retry queue
    probe.mjs                 health probes + standby pre-warm
    decision.mjs              Jev systemone client (keyless) + decision features
    strategies/
      index.mjs  sticky.mjs  smartest.mjs  fastest.mjs  roundrobin.mjs
    middleware/
      toolverify.mjs          tool-call verification gate (off/flag/block)
    providers/
      zen.mjs  openrouter.mjs  groq.mjs  gemini.mjs
    web/
      dashboard.html  dashboard.js  dashboard.css
    util/
      log.mjs  sse.mjs  errors.mjs  timebox.mjs
  tests/
    smoke.mjs                 mocked-upstream suite (free-guard, failover, scoring, demotion)
    decision.test.mjs         jev request/response shaping (offline stub)
  docs/  CONVENTIONS.md  TESTING.md  TODOS.md  worksheets/   (from project template)
```

**Provider adapter contract:** `{ id, listModels(cred), isFree(modelMeta), chat(cred, body, signal), classifyError(err) }` — thin (~80 lines each); engine treats all uniformly; openrouter/groq/gemini disabled until keys present.

**Zen endpoint map:** default `chat/completions`; per-model override for `responses` (chat→responses adapter incl. SSE translation for muse-spark-free); `systemone` models (jev) are NOT chat models — routed to decision plane instead of the chat pool.

---

## 8. Config sketch

```jsonc
{
  "name": "Cloud",                     // dashboard/frontend display name of the gateway key
  "apiKey": "cloud-…",                 // the ONE frontend key (generated on first run)
  "host": "127.0.0.1",
  "port": 4141,
  "selection": {
    "strategy": "sticky",              // sticky | smartest | fastest | roundrobin | <custom file>
    "weights": { "success": 0.4, "latency": 0.3, "freshness": 0.2, "priority": 0.1 },
    "timeboxMs": 700,
    "attemptTimeoutMs": 60000
  },
  "providers": {
    "zen":        { "enabled": true, "importOpencodeAuth": false, "keys": ["…pasted zen accounts…"] },
    "openrouter": { "enabled": false, "keys": [] },
    "groq":       { "enabled": false, "keys": [] },
    "gemini":     { "enabled": false, "keys": [] }
  },
  "probe":   { "intervalMs": 120000, "standbyWarm": 2 },
  "refresh": { "catalogMinutes": 10 },
  "decision": {
    "enabled": true, "model": "jev-1.13-free",
    "classify": true, "diagnose": true, "rankHints": true,
    "toolVerify": "off",               // off | flag | block
    "expose": true                     // serve /v1/decide
  }
}
```

Production keys: paste into `config.json` → `providers.<name>.keys` (or the dashboard's
key panel in P7), or set env `FREE_ROUTER_<PROVIDER>_KEYS` (comma-separated, runtime
overlay, never written to disk). A provider auto-connects once it holds ≥1 key —
no key = inert. `importOpencodeAuth` is a local-dev convenience only, default `false`.

---

## 9. Pipeline — all phases

Each phase ends with a **proof gate**; no phase starts until the previous gate passes.

**Progress (2026-10-10):** ✅ P1 scaffold · ✅ P2 zen + catalog (live `/v1/models`) · ✅ P3 routes + strategies (20/20 tests, live echo/reroute) · ✅ P4 streaming + probe (23/23 tests, live SSE 16 chunks → `big-pickle`, failover-before-first-byte) · ✅ P5 decision plane (33/33 tests, live keyless jev `noul 0.95` via `/v1/decide`; self-disable latch; toolverify block/flag wired + mutation-audited) · ✅ P6 extra adapters (42/42 tests, mocked HTTP: openrouter `:free`+zero-priced, groq/gemini free-tier, gemini native list + OpenAI-compat chat, catalog cred-less skip mutation-audited) · ✅ P7 dashboard (53/53 tests: masked config, key add→route appears, strategy hot-apply, SSE
snapshot+live route events, audit log w/o secrets; both mutations caught; live smoke: `/` 200, 13 free models,
zen auto-connected, no key leak) · ✅ P8 integration+docs (README copy-paste gate, run.ps1 verified
start/status/healthz/stop — fixed PS 5.1 smart-quote parse bug by pure-ASCII rewrite, template docs filled,
worksheet, IMPACT_MAP entry) · ✅ P9 test suite + live proof (53/53 green; live evidence: SSE stream
24 chunks [DONE] big-pickle "1 2 3"; keyless jev noul 0.96 @995ms + invalid 400; dashboard 200,
13 free models, no key leak). **All 9 phases complete 2026-10-10.**

### Phase 1 — Scaffold
- Create repo structure per §7, `package.json` (no deps), load skills: `code`, `code-pro`, `clean-code-enforcer-v3`, `ponytail`, `body-init`; apply project template (`bin/apply-template.ps1 -Target free-router`).
- **Gate:** repo tree exists; template docs in place; skills loaded.

### Phase 2 — Zen adapter + free-detection catalog
- `providers/zen.mjs` (auth from auth.json + config keys, endpoint map), `catalog.mjs` (suffix + models.dev pricing signals, 10-min refresh, runtime demotion API).
- **Gate (live):** `GET /v1/models` returns only known-free models; paid models absent; refresh works.

### Phase 3 — Route engine + strategies + gateway (non-stream)
- `routes.mjs` (telemetry, states, sticky, retry queue, free-guard), `strategies/*` (+ custom loader, time-box), `server.mjs` (`/v1/chat/completions` non-stream, single-key auth), error classification → demotion.
- **Gate (mocked):** tests prove — free-guard (paid request rerouted, never billed), sticky + failover order = score order, demotion on billing error, strategy time-box fallback, multi-account same-model routes.

### Phase 4 — Streaming + probe/standby
- SSE passthrough (failover only pre-first-byte), `probe.mjs` (interval probes, ACTIVE/STANDBY/DEGRADED/DEAD, keep top-N standby warm).
- **Gate (live):** real streamed completion through gateway from Zen key; killing a route mid-session triggers warm-standby failover.

### Phase 5 — Decision plane
- `decision.mjs` (keyless systemone client, degradation), `middleware/toolverify.mjs` (off/flag/block, non-stream, fail-open), `/v1/decide`, failure diagnosis wiring.
- **Gate (live):** `noul` answer from `jev-1.13-free` keyless; tool-verify test (flagged suspect tool call); Jev-down → router still serves + logs.

### Phase 6 — Extra adapters
- `openrouter.mjs` (`:free` models), `groq.mjs`, `gemini.mjs` — registered, disabled without keys.
- **Gate:** unit tests with mocked HTTP; enabling with a key adds routes to catalog.

### Phase 7 — Dashboard
- `web/dashboard.*` + `/api/*` (config CRUD atomic, keys write-only+masked, routes pin/priority, catalog refresh, status, SSE events), gateway-key auth, audit log, hot-apply for strategy/weights/keys.
- **Gate (live, browser):** add a key → route appears; switch strategy → hot-applied; monitor shows a live request; secrets never visible after save.

### Phase 8 — Integration + docs
- `run.ps1`, `README.md` (Cline "OpenAI Compatible" setup, opencode custom-provider snippet, curl examples, dashboard guide), template docs (`TESTING.md`, `CONVENTIONS.md`, `TODOS.md`), `IMPACT_MAP.md` update, worksheet.
- **Gate:** copy-paste instructions work verbatim.

### Phase 9 — Test suite + live proof
- `node --test` full suite (free-guard, failover, scoring order, demotion, strategy contract, decision stubs, config validation) + live end-to-end: Cline/opencode-shaped request through gateway → streamed free-model reply; evidence captured (test output + run log).
- **Gate:** green suite + documented live run. **Done = implemented, tested, error-handled, documented, maintainable.**

---

## v1.1 — Stealth, prompts, compaction, hardening (2026-10-10, user-requested)

Build order follows the user's issue order. Auto-connect/installer explicitly DEFERRED to a
post-v1.1 discussion (not in this plan). Every phase keeps the invariants: never route to paid,
every upstream time-boxed, secrets never leave server, fail-open on non-essential systems,
zero npm deps, `@body:` headers + BODY.md rows, mutation audit per gate.

**Locked user decisions (2026-10-10):** stealth = ONE public codename for all models ·
compaction = summarize via free model as primary strategy (truncate = fail-open fallback) ·
persona = ponytail principle adapted for GENERAL chatbot+coder use (concise, correct, no
filler/AI-slop, useful in everyday conversation — not coding-only), ON by default, one flag off.

### Phase 10 — Key management + gateway hardening ✅ (done 2026-10-10)
- Gateway key **rotation**: `POST /api/security/rotate-key` → new random key, old key dead
  immediately, response returns the new key ONCE (only time it is ever shown), audit-logged as
  "rotated" without the value; dashboard re-login prompt.
- Provider key deletion UX already exists (`DELETE /api/keys`); add per-key **disable without
  delete** (`enabled` flag per credential label) + dashboard wiring.
- Gateway **rate limiting**: token bucket per API key (config `security.rateLimitPerMin`,
  default 60; 0=off) on `/v1/*` + `/api/*`; 429 with `retry-after`. Dash/SSE exempt from tight cap.
- Security headers on all responses: `x-content-type-options: nosniff`,
  `referrer-policy: no-referrer`, `cache-control: no-store` on API, minimal CSP for dashboard.
- Optional IP allowlist (`security.allowedIps: []` = allow all, localhost default trusted).
- Config validation for the new `security` block; README security section update.
- **Gate:** tests (rotate invalidates old key; rate limit 429 after N; headers present; IP
  allowlist rejects); mutation audit (remove rate limiter → test red); live: rotate via curl.
  ✅ 61/61 tests; 2 mutations caught; `tests/live-rotate-check.mjs` proves rotate→old 401/new 200,
  headers, 200,200,200,429 rate sequence, audit never stores key. New `src/security.mjs`
  (token bucket, allowlist, headers); `keys[]` now string|{key,enabled} with stable labels.

### Phase 11 — Stealth layer (hide real model identity) ✅ (done 2026-10-10)
- Config `stealth: { enabled, alias }` — ONE public codename by default (e.g. `cloud-1`;
  user-editable). When enabled:
  - `/v1/models` returns ONLY the alias (real ids never leave the server).
  - Client may request `model: alias` (or any unknown/paid id — existing reroute) → normal
    routing to the real free model internally.
  - **Response rewrite**: `response.model` (non-stream JSON + stream chunks) rewritten to the
    alias; streaming rewrite = lightweight SSE chunk transformer (no buffering of content,
    only model-field string swap per chunk).
  - Internal logs keep real model ids (operator visibility); only the wire is blinded.
- Anti-name-leak **content scrub (optional, `stealth.scrubContent`)**: replace known real model
  id strings appearing in assistant text with the alias (exact-match only, both stream and
  non-stream). Off by default (can over-match); documented honestly.
- **Gate:** tests (models list shows alias only; chunk model field rewritten; logs still real);
  mutation audit (disable rewrite → test red); live stream proof with alias.

### Phase 12 — System prompt / skill layer ✅ (done 2026-10-10)
- Config `persona: { enabled, prompt, prependClientSystem }` — default ON with a **general-purpose**
  concise persona (ponytail principle adapted beyond coding: short direct answers, no filler,
  correct > clever, useful as an everyday chatbot AND for code); fully replaceable via config.
- Injection middleware in `routes.mjs`: merge persona + optional anti-name-leak rule
  ("never reveal internal model/provider names; you are <alias>") with client system messages;
  applies to chat protocol only (systemone untouched); never applied to probe pings.
- Streaming-safe: injection happens on the request before upstream (no response buffering).
- **Gate:** tests (persona merged once; disabled → untouched; probe unaffected; alias-aware
  name-leak line present when stealth on); live echo proving injection.

### Phase 13 — Context windows + auto-compaction ✅ (done 2026-10-10)
- `src/context.mjs`: per-model context table (curated static map + config override
  `contextWindows: { "<model>": <tokens> }`; conservative defaults for known free models,
  fallback 8k). Estimate tokens ≈ chars/4 (documented, no tokenizer dep).
- In `runChat` pre-attempt: if estimated input > model window → **compact**:
  - **primary `compaction.strategy: "summarize"`** (locked decision) — one extra free-model
    call condensing dropped (oldest non-system) turns into a summary message; time-boxed;
    **fail-open to `truncate-oldest`** on any error/timeout;
  - `truncate-oldest` also selectable directly — keep system + newest messages within budget,
    drop oldest non-system turns (never drop the current user message);
  - applied per-attempt (different candidate models may have different windows).
- Response `x_router:{compacted:true, mode:'summarize'|'truncate', dropped:n}` marker;
  dashboard counter via bus event.
- **Gate:** tests (truncate keeps system+tail; summarize fallback; stream + non-stream; huge
  request that previously 400'd now succeeds); mutation audit; live oversized request proof.

### Phase 14 — Production-readiness verification + docs ✅ (done 2026-10-10)
- README: honest production checklist (TLS reverse proxy via Caddy/nginx snippet, key rotation
  flow, rate limit, IP allowlist, systemd/Task Scheduler note); SECURITY notes section.
- Full suite + all live proofs rerun; BODY/PLAN/TODOS/worksheet updated; dashboard shows
  security block (rate limit status, key rotation button).
- **Gate:** green suite + live battery + docs verbatim-verified. THEN discuss auto-connect
  installer (deferred, separate plan).


---

## v1.2 — Open pool, auto-detect, Cloudflare hosting (2026-10-10, user-directed)

User context: personal-but-not-local tool. Holds 2 opencode/Zen accounts; will add Groq,
Google, OpenRouter keys; wants one URL + one key usable from mobile, shareable with friends
and family (they never see config/env — just the working AI). Hosting: free, scale-to-zero
(not always-active). Freebuff skipped (timer/quota churn). Cline skipped (IDE client, not a
provider — nothing to build). CLI tooling: Cloudflare `cf` (birthday-week agentic CLI,
replaces Wrangler) installed globally; Vercel CLI uninstalled from the machine. Cloudflare
is the global hoster going forward.

**Relaxed invariant (user directive):** the old "never route to a paid model" gate is
replaced by "if a model from a configured key works, it is used" — runtime health (probe +
failover + 402/billing classification) is the safety net, not a static free/paid filter.
`pool: "free"` remains available as an opt-in cost-safety toggle.

### Phase 15 — Open pool (surface all models a key can reach) ✅ (done 2026-10-10)
- Catalog stops filtering to free-only by default; `pool: "all"` (default) | `"free"` toggle.
- Free/paid tags kept from models.dev when known (dashboard display only, not a gate).
- 402/billing on a free-tier key still classifies + failovers — a paid model on a free key
  simply never succeeds and drops out of rotation; no charge can occur.
- Gate: tests flip to open-pool behavior; suite green; a paid model + free key mock proves
  failover (no charge path).

### Phase 16 — Auto-detect keys + generic OpenAI-compatible adapter
- Boot-time discovery: scan env vars (`GROQ_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`,
  `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`/`ZEN_API_KEY`, …) and the **full** opencode
  `auth.json` (all providers stored there, not just Zen) → keys surface ephemerally
  (never persisted to disk), models marked "discovered" in dashboard.
- Generic `openai-compat` adapter: config entries `{ baseUrl, apiKey, models? }` — if
  `models` omitted, auto-lists from `GET {baseUrl}/models`; chat passthrough (stream +
  non-stream), time-boxed, error-classified. Covers any future OpenAI-shaped source
  (freebuff2api sidecar, community proxies, paid subs later) with zero native adapters.
- Native adapters (zen/openrouter/groq/gemini) stay for protocol quirks.
- Gate: discovery unit tests (env + auth.json fixtures); generic adapter integration test
  (mock upstream /models + chat, stream + non-stream); suite green.
✅ (done 2026-10-10) — `src/discovery.mjs` (env + auth.json, `FREE_ROUTER_AUTH_JSON`
override for tests), `mergeDiscovered` wired into all 5 adapters, multi-instance
`openai-compat` adapter (`${prefix}:` ids, models[] override or auto-list), `autoDiscover`
config flag (default true; tests pin false), dashboard "(N auto)" counter, compat exempt
from generic keys[] validation. Tests 94/94. Mutations caught: mergeDiscovered neutered,
prefix-strip broken, prefix never applied.

### Phase 17 — Cloudflare Workers hosting (scale-to-zero, free tier) ✅ 2026-10-10
- `cf` CLI (1.0.0-beta.14) deploy tool; `cloudflare.config.ts` (typed config) + `vite.config.ts`
  (`@cloudflare/vite-plugin`); Vite-based local dev via `cf dev`.
- **Architecture (as built):** Web-standard `handleRequest(request, cfg) → Response` in
  `server.mjs`; Node adapter `startServer` preserved (nodeToRequest/sendResponse, `Readable.fromWeb`).
  New `src/util/http.mjs` (`jsonRes`/`errRes`/`safeEqual`/`readBodyText`); `src/store.mjs`
  sync read/write/append seam (Node fs default, atomic tmp+rename). `security.mjs` Web-converted
  (`remoteIp` honors `cf-connecting-ip`; `securityHeaders({isApi,isHtml})` returns header object);
  `stealth.mjs` drops node:Transform → web `sseModelRewriterStream`; `dashboard.mjs` fully
  Web-standard (handlers take `(request, cfg, url)`, SSE via `ReadableStream`, `setDashboardHtml`
  for `?raw`-bundled `web/dashboard.html`).
- `src/worker.mjs`: fetch-handler over `handleRequest` + `scheduled` (cron `*/2 * * * *` runs
  `refresh` → `probeOnce` via `ctx.waitUntil`); memoized boot per isolate. `src/workerConfig.mjs`:
  `buildConfig(env)` (example + `CONFIG` text binding, `autoDiscover=false`, secret bindings
  overlay via `applyEnvKeys(cfg, env)`), `installKvStore(kv)` (KV-seeded memory Map + fire-and-forget
  put), `bootConfig(env, kv)` (KV `CONFIG_PATH` saved config wins, else persist built config).
  Secrets (gateway + provider keys) → Workers secret bindings, never written to KV.
- `nodejs_compat` flag keeps `node:` imports loadable; `?raw` dashboard HTML verified under
  `cf build` (106 kB bundle).
- Zero runtime npm deps preserved (`cf`/`vite` are devDependencies only, never imported by `src/`).
- **Gate: PASSED** — full suite 107/107 green; `cf build` clean; `cf dev` smoke green
  (`/healthz` 200, dashboard 200 + CSP, `/v1/models` 401 keyless); mutation audit (5/5 caught:
  auth check, safeEqual, cf-connecting-ip, gateway-key binding, KV persist). Real `cf deploy`
  + live workers.dev check deferred to user login (Phase 18 interactive step).

### Phase 18 — Deploy guide + wrap
- README: Cloudflare deploy section (cf login, secrets set, KV/D1 create, cron, custom
  domain optional); mobile/share notes (one URL + one gateway key).
- BODY/PLAN/TODOS/worksheet updates; full suite + live battery; END_OF_SHIFT.

## v1.3 — Selection v2, usage ledger, custom providers, dashboard pages (2026-10-13, user-directed)

User asks (verbatim intent): make model selection better · custom key support = bring any
provider · model viewer shows only free models + better sorting · a Usage page · other pages
the dashboard is missing. Confirmed scope: aliases + default model + free-verified scoring;
bring-any-provider depth beyond the existing openai-compat form; full usage ledger (models +
client keys + tokens, persisted).

### Phase 19 — Selection v2 (default model + aliases + free-verified scoring)
- `selection.defaultModel`: requested id not in catalog (unknown/paid/typo) → that model is
  pinned first instead of pure strategy order. `selection.aliases`: `{"fast": "groq:llama-3.3-70b"}`
  — clients keep one stable name while the router rotates underneath.
- Scoring: new `verified` component (free-source evidence via `sources`) so verified-free
  models outrank unverified ones at equal health; weights rebalanced
  (success .4 / latency .3 / freshness .15 / priority .05 / verified .1).
- Gate: routes tests for alias + default-model reroute; strategy test proving verified wins.
- **Done 2026-10-13** — 127/127; sticky failover remainder also ranked by smartest score.

### Phase 20 — Usage ledger (`src/usage.mjs`)
- Per-model, per-provider and per-client-key counters (requests, ok/fail, tokens in/out when
  upstream reports them, latency, last used) + 7 days of hourly buckets; persisted through the
  store seam (fs locally, KV on Workers); debounced writes.
- Wired at every attempt outcome in `routes.mjs`; client-key attribution via `findApiKey`.
- `GET /api/usage` snapshot; `POST /api/usage/reset`. Gate: usage tests (attribution, buckets,
  persistence, reset).
- **Done 2026-10-13** — 136/136; ledger at `path.dirname(CONFIG_PATH)/.cache/usage.json`, corrupt-file resilient.

### Phase 21 — Custom providers (bring any provider)
- `src/providers/factory.mjs`: one OpenAI-compatible adapter factory; presets `cerebras`,
  `sambanova`, `mistral` (free rate-limited tiers) become first-class Providers rows with
  paste-a-key flows + env-var discovery.
- openai-compat instances gain per-instance enable/disable + a "list models" probe so the
  dashboard can verify an endpoint before committing to it.
- Gate: providers tests (factory presets over mock upstreams, enable/disable, probe).
- **Done 2026-10-13** — 139/139; env discovery vars added; compat add/toggle/remove logic moved to `src/compatInstances.mjs`.

### Phase 22 — Dashboard v2 (pages, free-only filter, sorting, usage + logs)
- Split `web/dashboard.html` → html + `dashboard.css` + `dashboard.js` (served unauthenticated
  as static assets; CSP adds `'self'`); keeps the ≤500-line rule honest.
- Tabbed pages: Overview · Models (free-only toggle, provider filter, click-to-sort columns,
  default order = score desc) · Providers (incl. custom endpoints) · Security · Usage
  (cards + per-model/per-key tables + 24h/7d bars) · Logs (audit tail + live activity) ·
  Settings (name, pool, stealth, persona, decision, compaction, default model, aliases).
- `GET /api/audit` (tail of logs/audit.jsonl). Gate: dashboard tests for assets, usage and
  audit endpoints; live dashboard smoke.
- **Done 2026-10-13** — 140/140; four-file split (`dashboard.html/.css/.js/-pages.js`), asset
  serving extracted to `src/dashboardAssets.mjs` (node reads disk, worker `?raw` bundle);
  live smoke: html/css/js/pages 200 + CSP `'self'`, `/api/usage` + `/api/audit` + reset
  verified against the running server.

### Phase 23 — Worker key persistence (dashboard keys survive refresh)
- Per-provider encrypted envelope at `.cache/provider-credentials.json` reusing
  `COMPAT_CREDENTIALS_KEY` AES-GCM (AAD = provider id); boot restore after compat restore;
  fail-open on decrypt error; 503 without the secret on Workers (parity with compat).
- Key-mutation trio extracted to `src/providerKeys.mjs`; crypto exports from
  `src/providerCredentials.mjs`; dashboard snapshot gains `configured` / `providerKeysReady`.
- Gate: `tests/worker-keys.test.mjs` (10 tests) + mutation audit.
- **Done 2026-10-14** — 150/150. Requires `COMPAT_CREDENTIALS_KEY` set to engage.

### Phase 24 — Dashboard IA restructure + UI foundation (overhaul slice 1)
- Tab restructure to 7 clear-purpose tabs: Overview · **Playground** · Models · Providers ·
  **Analytics** (old Usage + Logs merged: charts, live activity, audit tail) · Security ·
  Settings.
- Frontend file split to honor the 500-line rule: `dashboard.js` (core+overview) /
  `dashboard-models.js` (new) / `dashboard-pages.js` (providers+security) /
  `dashboard-analytics.js` (new) / `dashboard-settings.js` (new) / `dashboard-playground.js`
  (new). Each new file wires through `dashboardAssets.mjs#ASSETS`, `worker.mjs` `?raw`
  imports, and a `dashboard.html` script tag.
- Design-system pass on `dashboard.css`: consistent spacing/buttons/forms, toast
  notifications (success + error), loading skeletons, empty states, focus styles —
  zero-deps, dark ops palette kept.
- Gate: `npm test` (asset-serving tests updated for new file list) + live browser check of
  every tab.

### Phase 25 — Playground (talk to models) (overhaul slice 2)
- New `src/playground.mjs`: dashboard-authed `POST /api/playground` → `runChat` with a
  synthetic internal caller (no client key, no rate-limit consumption), usage recorded
  under a `playground` label so analytics attribute it. Returns reply + meta
  (model, provider, ms, attempts); engine SSE relayed as `text/event-stream` when the
  client asks for streaming.
- New Playground tab: model picker (auto = router decides, or pin a model), system prompt,
  temperature / max-tokens, transcript UI, per-reply metadata line, regenerate, clear,
  stop-while-streaming, graceful error states.
- Gate: playground endpoint tests (mock upstream: reply, meta, streaming, auth) + live
  browser conversation.

### Phase 26 — Scoring studio (configurable criteria + explainability) (overhaul slice 3)
- Make **all** components overridable via `cfg.selection.weights` in `smartest` (verify +
  fix freshness/priority/verified passthrough), persisted through existing config CRUD.
- New `GET /api/scoring`: current weights + defaults + per-model score breakdown
  (component contributions from live catalog/usage state); `PUT` weights with validation
  (0..1, not all zero) via strategy registry.
- Settings → Routing: weight sliders + reset-to-defaults + live top-5 preview under the
  edited weights. Models tab: per-model score breakdown (expandable detail: success /
  latency / freshness / priority / verified contributions, decision-plane shift shown when
  active).
- Gate: scoring tests (all five components honored, breakdown math, validation) + mutation
  audit.
- **Done 2026-10-14** — 165/165; shared `scoreBreakdown` math path; weights API + sliders +
  live preview; per-model "why" breakdown; mutation audit red→revert green (byte-exact).

### Phase 27 — Key & provider testing (overhaul slice 4)
- New `POST /api/providers/test` (single provider or all enabled, time-boxed, bounded
  concurrency): list-models (or probe) per credential → `{ok, models, ms, error}` per key,
  masked, never persisted.
- Providers tab: per-row Test + aggregated results (ok/fail, latency, model count);
  "test before save" in the add-key forms (native providers; compat probe already exists —
  unify UX). Batch "test all" button.
- Gate: provider-test endpoint tests against mock upstreams + live run.
- **Done 2026-10-14** — 171/171; chat-ping key test (installed or candidate key, masked,
  never persisted), per-row + test-all + test-before-save UI; live-verified incl. real zen
  `freetier` classification.

### Phase 28 — Analytics upgrade (overhaul slice 5)
- `/api/usage` enriched: per-provider rollup, success-rate series (hourly), failover /
  attempt statistics, top-models leaderboard, tokens in/out series — derived from the
  existing ledger; record attempts at the outcome wire in `routes.mjs` only if it stays
  within the 500-line cap (else a thin telemetry helper).
- Analytics tab: zero-dep SVG/CSS charts (requests+success-rate over time, provider
  distribution, latency, tokens), leaderboard, live refresh on SSE.
- Gate: usage tests for new rollups/series + live browser verification of charts with real
  traffic.
- **Done 2026-10-14** — 175/175; ledger gains per-hour latency + failover (`attemptIndex`
  inlined at the 4 `routes.mjs` record sites — still 499 lines), success-rate series,
  per-provider rollup, leaderboard ranks; 3 zero-dep SVG charts (requests bars + success-rate
  line, latency line with hover gutters, tokens bars) + 8 stat cards; SSE route events
  debounced-refresh the charts via `usageRefreshSoon` while the tab is visible; mutation
  audit 2 red (failover + success-rate neutered) → byte-exact revert green; live: charts
  auto-updated 2→4 requests on fresh mock traffic without a tab interaction, provider rollup
  + rank-1 leaderboard populated, pre-P28 ledger booted clean, zero console errors.

**Overhaul gate:** all phases → `npm test` green, mutation audit for server-side logic,
README/BODY/PLAN/worksheets updated, live browser pass across all 7 tabs.
- **P24 Done 2026-10-14** — 150/150; 6 tabs live-verified (zero console errors, all pages
  render, toast works); frontend split into 5 js modules + core; usage+logs merged into the
  analytics tab; Playground tab arrives with P25; `bin/run.ps1` placeholder bug fixed (logged
  in AGENT_FEEDBACK.md); cosmetic "168-day ledger" wording fixed (retainHours is hours).

---

## 10. Risks & honest limits

| Risk | Mitigation |
|---|---|
| models.dev pricing lags ~1 day | runtime demotion: first billing error → route excluded; worst case one failed request, never a charge |
| Zen `systemone`/`responses` protocol quirks | per-model endpoint map; jev reserved for decision plane; response-adapter only where needed; untranslatable models excluded by probe |
| Free-tier rate limits unknown | 429 headroom tracking + key rotation + backoff; probes measure |
| Jev free route changes/disappears | decision features self-disable with log; router unaffected |
| Streaming failover impossible mid-stream | retry before first byte only (industry-standard); non-stream retries freely |
| Auth.json / keys on disk | config file gitignored; secrets write-only via API; masked everywhere; server binds localhost by default |
| Custom strategy hangs/throws | time-box 700 ms + fallback ranking + boot-time validation |

## 11. Out of scope (v1)

- Anthropic-messages native protocol for clients (gateway speaks OpenAI-compatible only)
- Multi-user auth / accounts on the dashboard (single gateway key; user holds all keys)
- Freebuff native adapter (skipped by user decision — timer/quota churn; generic
  openai-compat adapter covers freebuff2api sidecar if ever wanted)
- Cline (IDE client, not a model provider — nothing to build)
- Docker image (Cloudflare Workers is the hosted path; Node run.ps1 stays for local dev)
