<!-- PURPOSE: Body map (DNA) of free-router — brain/bones/muscles/nerves and their wiring -->
<!-- OWNS: Structural truth of this repo; body-build adds rows, body-audit verifies them -->
<!-- READ-WHEN: Adding any feature (body-build) or auditing wiring (body-audit) -->
<!-- KEY-FILES: src/index.mjs (boot), src/routes.mjs (engine brain), src/strategies/index.mjs (nerve), src/providers/index.mjs (nerve) -->
<!-- INVARIANTS: No orphan bones/muscles — every unit declares its tendon/nerve; every nerve is a real registration point -->
<!-- GOTCHAS: providers/index.mjs + strategies/index.mjs are the ONLY places new adapters/strategies register -->
<!-- UPDATED: 2026-10-14 -->

# BODY.md — free-router

Self-hosted free-model router. Dashboard password plus separately managed client API keys; backend detects free models, pools provider keys,
scores/sticks routes, probes standbys, decides with Jev, and serves a control dashboard.

## Anatomy map

| Part | Where | Role |
|---|---|---|
| 🧠 Brain | `src/index.mjs` (boot/wiring), `src/routes.mjs` (route engine) | orchestration + route selection decisions |
| 🦴 Skeleton | `src/` tree (see layout below) | folder/file shape |
| 🦴 Bones | `config.example.json`, provider contracts, strategy contract | shape/schemas — no behavior |
| 💪 Muscles | `catalog.mjs`, `probe.mjs`, `decision.mjs`, `strategies/*`, `middleware/*` | behavior |
| 🔗 Tendons | `server.mjs` (HTTP → engine bindings), `config.mjs` (config → modules) | local glue |
| 🧬 Nerves | `strategies/index.mjs` (strategy registry), `providers/index.mjs` (provider registry) | the ONLY registration points |
| 🩸 Blood | route telemetry, request/response payloads, SSE event bus | circulating data |
| ❤️ Heart | Node event loop / `server.mjs` listener | the pump |
| 👁️ Face | `/v1/*`, `/api/*`, `/status`, dashboard at `/` | outside-world surface |
| 🫁 Lungs | `providers/*` (external APIs), models.dev fetch | boundary with outside world |
| 🛡️ Immune | config validation, dashboard-password and client-key auth, `classifyError`, time-boxing | validation/error/security |
| 🩹 Skin | `web/dashboard.html` + `web/dashboard.css` + `web/dashboard.js` (core/overview) + `dashboard-models.js` + `dashboard-playground.js` + `dashboard-providers.js` + `dashboard-security.js` + `dashboard-analytics.js` + `dashboard-settings.js` (split files, served as static assets) | presentation |

## Skeleton

```
src/
  index.mjs            🧠 boot: validate config → wire registries → serve
  config.mjs           🛡️+🔗 load/validate/atomic-write; opencode auth.json import
  apiKeys.mjs          🛡️ client key generation, hashing, and verification
  runtime.mjs          🔗 runtime platform flag for platform-specific behavior
  discovery.mjs        💪 ephemeral key discovery (env vars + full opencode auth.json)
  server.mjs           👁️+🔗 HTTP: /v1/* /api/* dashboard /status /healthz
  anthropic.mjs        protocol translation: Anthropic Messages to OpenAI chat
  catalog.mjs          💪 open pool + free tags + refresh (models.dev + suffix + demotion)
  routes.mjs           🧠 route table, telemetry, states, sticky, retry queue
  probe.mjs            💪 health probes + standby prewarm
  decision.mjs         💪 Jev systemone client (keyless) + decision features
  strategies/          💪 + 🧬 nerve = index.mjs (registry)
  middleware/          🛡️ toolverify.mjs
  providers/           💪 + 🧬 nerve = index.mjs (registry)
  web/                 🩹 dashboard.html + dashboard.css + 6 js modules (core/models/playground/pages/analytics/settings, tabbed UI, static assets)
  util/                💪 log/sse/errors/timebox
```

## Bones & Muscles (wiring registry)

| Unit | File | Wired at (tendon/nerve) | Status |
|---|---|---|---|
| boot | `src/index.mjs` | entry (`npm start`) | done P1 |
| config | `src/config.mjs` | imported by `index.mjs` | done P1 |
| zen adapter | `src/providers/zen.mjs` | `providers/index.mjs#registry` | done P2 |
| catalog | `src/catalog.mjs` | `index.mjs` → `server.mjs`; classifies every listed model (chat vs image/video/audio/embedding/…), keeps non-chat ones in `filtered` with a reason; `selection.forceChat` overrides; soft demotions expire | done P2/P15 (open pool), polish pass 2026-10 |
| model modality | `src/modality.mjs` + `src/providers/listing.mjs` | `catalog.mjs#refresh`; provider adapters expose `listModels()` (id + raw metadata); metadata first (output modalities, capabilities, generation methods, type fields), word-based name rules second | polish pass 2026-10 |
| free lanes | `src/freeLanes.mjs` | `probe.mjs` (per-provider hourly ceiling for background checks), `dashboardStatus.mjs` (lane notes) | polish pass 2026-10 |
| route engine | `src/routes.mjs` | `server.mjs` (chat handler) | done P3 (stream+non-stream) |
| strategies | `src/strategies/*.mjs` | `strategies/index.mjs#registry` | done P3 |
| prober | `src/probe.mjs` | `index.mjs` (interval), `dashboard.mjs` (`/api/models/verify`) | done P4; polish pass 2026-10: 429 = limited not failing, only billing/404/keyless-401 demote (soft ones expire), per-provider check budget, on-demand verify |
| SSE relay | `src/server.mjs#handleChat` | streaming branch of chat handler | done P4 |
| decision plane | `src/decision.mjs` | `routes.mjs` + `middleware/toolverify.mjs` + `/v1/decide` | done P5 |
| tool-verify gate | `src/middleware/toolverify.mjs` | `routes.mjs#verifyResponse` (non-stream) | done P5 |
| adapters OR/Groq/Gemini | `src/providers/{openrouter,groq,gemini}.mjs` | `providers/index.mjs#registry` | done P6 |
| dashboard | `src/dashboard.mjs` + `src/dashboardStatus.mjs` + `web/dashboard.{html,css}` + `web/dashboard{,-models,-playground,-providers,-security,-analytics,-settings}.js` | `server.mjs` (`/` + `/api/*`, SSE via bus); session-cookie auth + 7 tabbed pages (overview/models/playground/providers/analytics/security/settings); key routes delegate to `providerKeys.mjs`; settings writes are awaited and refresh the pool when membership changes | updated polish pass 2026-10 |
| dashboard assets | `src/dashboardAssets.mjs` | `server.mjs` (GET `/dashboard*.css|js`, no auth); `worker.mjs` (`?raw` bundle via `setDashboardAsset`) | done P22, extended P24 |
| usage ledger | `src/usage.mjs` | `routes.mjs#runChat` (record + attemptIndex), `dashboard.mjs` (`/api/usage`, `/api/usage/reset`); hourly latency/failover buckets, per-provider rollup, store-seam persistence | updated P28 |
| selection v2 | `src/routes.mjs#resolveRequested` + `src/strategies/smartest.mjs` | aliases/defaultModel resolution; `verified` scoring component (evidence map) | done P19 |
| provider factory | `src/providers/factory.mjs` | cerebras/sambanova/mistral presets → `providers/index.mjs#registry` | done P21 |
| gateways (kilo/OVH/llm7/zai) | `src/providers/{kilo,ovh,llm7,zai}.mjs` | anonymous/key-optional free-tier providers → `providers/index.mjs#registry`; kilo auto-routes `:free` models, OVH anonymous 2 req/min/IP, llm7 key-optional `unused`, zai key-required GLM family | added |
| keyed gateways (nvidia/qwen/kluster/hf) | `src/providers/{nvidia,qwen,kluster,huggingface}.mjs` | key-required OpenAI-compatible providers → `providers/index.mjs#registry`; NVIDIA NIM `integrate.api.nvidia.com/v1`, Qwen DashScope `dashscope.aliyuncs.com/compatible-mode/v1`, Kluster.ai `api.kluster.ai/v1`, Hugging Face `router.huggingface.co/v1` | added |
| compat instances | `src/compatInstances.mjs` | `dashboard.mjs` (add/probe/toggle/remove custom endpoints) | done P21/P22 |
| client API keys | `src/apiKeys.mjs` + `src/dashboard.mjs` | `/v1/*` authentication; hash records in store/KV | separate from dashboard password |
| Anthropic protocol | src/anthropic.mjs | server.mjs (/v1/messages, Anthropic model list) | OpenAI chat translation + SSE |
| dashboard auth | `src/dashboardAuth.mjs` + `src/session.mjs` + `src/authGuard.mjs` + `src/audit.mjs` | `dashboard.mjs#handleDashboard`; stateless HMAC session cookie (key derived from password + `security.sessionEpoch`), per-IP lockout with backoff + global soft cap, same-origin guard for cookie writes, audit trail | polish pass 2026-10 |
| gateway hardening | `src/security.mjs` | `server.mjs#route` (headers, IP allowlist, rate limit) + dashboard (rotate/toggle keys) | done P10 |
| stealth layer | `src/stealth.mjs` | `server.mjs` (`/v1/models` alias list, chat JSON + SSE rewrite) | done P11 |
| persona layer | `src/persona.mjs` | `routes.mjs#runChat` (merged system message, chat only) | done P12 |
| context + compaction | `src/context.mjs` | `routes.mjs` per-attempt (`compactForAttempt`, summarize w/ truncate fail-open) | done P13 |
| key discovery | `src/discovery.mjs` | every adapter `#listCredentials` via `mergeDiscovered` (dedup by value, `source` tag) | done P16 |
| openai-compat adapter | `src/providers/openaiCompat.mjs` | `providers/index.mjs#registry` (multi-instance, `${prefix}:` model ids) | done P16 |
| Web-standard core | `src/server.mjs#handleRequest` + `src/util/http.mjs` | Node adapter `startServer` + `src/worker.mjs` fetch | done P17 |
| compatible credentials | `src/compatCredentials.mjs` | AES-GCM encrypts OpenAI-compatible upstream keys before Worker KV storage; `workerConfig.mjs` restores them at boot; exports the shared base64/AES-GCM primitives | active |
| provider credentials | `src/providerCredentials.mjs` | AES-GCM envelope (per-provider, AAD-bound) for native provider keys in Worker KV; `workerConfig.mjs` restores at boot, `providerKeys.mjs` persists on mutation | done P23 |
| provider key mutations | `src/providerKeys.mjs` | `dashboard.mjs` key routes (add/remove/toggle); Worker path persists encrypted + rolls back on KV failure, 503 without `COMPAT_CREDENTIALS_KEY` | done P23 |
| runtime platform | `src/runtime.mjs` | Worker entrypoint sets platform for sensitive features | active |
| store seam | `src/store.mjs` | `config.mjs`/`catalog.mjs`/`providerKeys.mjs` (read/write/append + `writeDurable`); Workers KV via `installKvStore` | done P17 |
| worker entrypoint | `src/worker.mjs` + `src/workerConfig.mjs` | `cloudflare.config.ts` (fetch/scheduled, secrets, KV, cron); durable awaited saves (secrets never reach KV config), coalesced background writes finished under `ctx.waitUntil`, cross-isolate `syncFromKv` via a revision key, no boot-time config overwrite | done P17; polish pass 2026-10 |

## Growth rules

- New strategy → file in `strategies/` + register in `strategies/index.mjs` (never import directly elsewhere).
- New provider → file in `providers/` + register in `providers/index.mjs`.
- Every new bone/muscle gets a `@body:` header tag and a row above — `body-audit` enforces it.
