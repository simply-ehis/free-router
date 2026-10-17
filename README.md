# free-router

PURPOSE: Single entry doc — what it is, quickstart, client setup, dashboard, honest limits.
OWNS: README.md.
READ-WHEN: First contact; onboarding any client tool; troubleshooting.
KEY-FILES: config.json (runtime), config.example.json (schema), BODY.md (wiring), PLAN.md (build history).
INVARIANTS: Every command/snippet here is copy-paste verified; secrets never pasted into docs.
GOTCHAS: Requires Node >= 24; binds 127.0.0.1:4141 by default; zen free-tier gatekeeper rules apply to opencode traffic.
UPDATED: 2026-10-10

One self-hosted router. A dashboard password and separate client API keys. The backend pools **every model a configured key can
reach** — free tiers, stealth models, and (if you later add a paid sub) paid models too: if a model
from a key works, it is used; runtime health (probe, failover, billing demotion) decides what
actually serves traffic. Multiple providers/accounts, sticky/fastest/roundrobin/smartest strategies,
Jev (`jev-1.13-free`, no cost) as a lightweight decision plane, and a built-in dashboard for
everything. Billing signals demote a route on the first 402 — a paid model on a free key can never
charge you, it just drops out of rotation. Set `selection.pool: "free"` for a strict free-only filter.

## Requirements

- Node.js **>= 24** (`node --version`)
- That's it — zero npm dependencies.

## Quickstart

```powershell
git clone <this-repo> free-router
cd free-router
node src/index.mjs        # or: .\run.ps1
```

On first boot the router:

1. creates `config.json` (gitignored) from `config.example.json` with a **generated dashboard password** saved in the ignored config file;
2. auto-imports your opencode Zen credential if present (`providers.zen.importOpencodeAuth: true`);
3. listens on **http://127.0.0.1:4141**.

The dashboard password is in `config.json` → `dashboardPassword`. Keep it private. After opening the dashboard, create separate client API keys under **Security**; each new API key is shown once and can be revoked independently.

```powershell
.\run.ps1            # start (background, PID in .free-router.pid)
.\run.ps1 -Status    # is it up?
.\run.ps1 -Stop      # graceful stop
```

## Connect a client (copy-paste)

### Cline (VS Code)

1. Cline settings → **API Provider: OpenAI Compatible**
2. Base URL: `http://127.0.0.1:4141/v1`
3. API Key: *(create a client API key in Dashboard → Security)*
4. Model: any id from the dashboard, or `echo-free`-style ids — or just ask; unknown/paid ids are
   transparently rerouted to the best free model and `response.model` tells you what actually answered.

### opencode

Add a custom provider to your `opencode.json`:

```json
{
  "provider": {
    "free-router": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "free-router (Cloud)",
      "options": {
        "baseURL": "http://127.0.0.1:4141/v1",
        "apiKey": "<client API key created in the dashboard>"
      }
    }
  }
}
```

### curl

```bash
# list models
curl http://127.0.0.1:4141/v1/models -H "Authorization: Bearer $KEY"

# non-streaming chat (failover retries freely behind the scenes)
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"echo-free","messages":[{"role":"user","content":"ping"}]}'

# streaming (SSE; failover happens only before the first byte)
curl -N http://127.0.0.1:4141/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"any-free-id","messages":[{"role":"user","content":"count 1-3"}],"stream":true}'
```

`$KEY` = a client API key created in Dashboard → Security.

## Providers & keys

| Provider | How it connects | Free rule |
|---|---|---|
| `zen` (opencode) | auto-imports `auth.json`, or paste keys | `-free` suffix / models.dev $0 |
| `openrouter` | paste key or `OPENROUTER_API_KEY` | `:free` suffix or $0 pricing |
| `groq` | paste key or `GROQ_API_KEY` | free rate-limited developer tier |
| `gemini` (AI Studio) | paste key or `GEMINI_API_KEY` / `GOOGLE_API_KEY` | free rate-limited AI Studio tier |
| `cerebras` | paste key or `CEREBRAS_API_KEY` | free rate-limited tier |
| `sambanova` | paste key or `SAMBANOVA_API_KEY` | free rate-limited tier |
| `mistral` | paste key or `MISTRAL_API_KEY` | free tier (La Plateforme) |
| `kilo` | optional key or `KILO_API_KEY` | anonymous keyless for `:free` models (200 req/hr/IP); `kilo-auto/free` auto-routes best free model |
| `ovh` | optional key or `OVH_AI_ENDPOINTS_ACCESS_TOKEN` | anonymous keyless for all models (2 req/min/IP/model) |
| `llm7` | optional key or `LLM7_API_KEY` | key-optional anonymous (`unused`) on turbo models, 10 req/min |
| `zai` | paste key or `ZAI_API_KEY` / `Z_AI_API_KEY` | GLM family (glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5, glm-4.7, glm-4.6, glm-5-turbo); flash/4.x/5.1 free, flagship paid |
| `nvidia` | paste key or `NVIDIA_API_KEY` | NVIDIA NIM models (paid by default; runtime 402 demotion) |
| `qwen` | paste key or `QWEN_API_KEY` / `DASHSCOPE_API_KEY` | Alibaba Qwen / DashScope models (paid by default; runtime 402 demotion) |
| `kluster` | paste key or `KLUSTER_API_KEY` | Kluster.ai models (paid by default; runtime 402 demotion) |
| `huggingface` | paste key or `HF_TOKEN` / `HUGGINGFACE_API_KEY` | Hugging Face Inference Providers models (paid by default; runtime 402 demotion) |
| `openai-compat` | dashboard form: name, base URL, upstream API key | open pool (runtime demotion guards) |

Add keys (write-only, never shown again — only masked) via:

- **Dashboard** → Providers → paste key (recommended), or
- `config.json` → `providers.<name>.keys`, or
- env vars: `FREE_ROUTER_<PROVIDER>_KEYS=k1,k2` (runtime overlay, never written to disk).

**Auto-discovery (`autoDiscover`, default on):** the env vars above plus the full opencode
`auth.json` (every provider it stores, not just Zen) are scanned at credential time. Keys
surface ephemerally — never written to config.json — and the dashboard marks them
`(N auto)`. Set `"autoDiscover": false` to disable entirely. Env-only deploy: export
`GROQ_API_KEY` (etc.) and the provider connects with zero config edits.

**Any OpenAI-compatible endpoint:** use Dashboard → Providers → Custom endpoints to enter an endpoint name, API base URL, and that service's upstream API key. A **probe** button lists the endpoint's models before you commit. Models auto-list from `GET {baseUrl}/models` and are served as `{prefix}:{id}`; each endpoint can be disabled or removed later without deleting its key history. On Cloudflare, endpoint metadata and AES-GCM-encrypted keys persist in KV; the encryption key is the `COMPAT_CREDENTIALS_KEY` Worker secret. Keep that secret backed up and unchanged: losing or rotating it makes saved endpoint keys undecryptable.

```json
"openai-compat": {
  "enabled": true,
  "instances": [
    { "prefix": "fb", "baseUrl": "http://127.0.0.1:3457/v1", "apiKey": "local" }
  ]
}
```

A provider with no key stays idle; it connects the moment one appears (hot — no restart needed).
**Caveat, stated honestly:** Groq/Gemini "free-tier" means the key's default developer/AI-Studio
tier. If *you* attach paid cloud billing to that same key, the router cannot detect it in advance —
runtime demotion removes a model the instant a billing-class error appears, but a cloud-billed key
can charge. Use free-tier keys.

**Proactive model sweep:** every hour (while the router has seen recent use), the probe pings
every catalog model with a tiny `hi` prompt. Models that return auth/billing/notfound/deprecated
errors are demoted and hidden from the pool immediately; transient failures just cool down.
Configure with `probe.sweepIntervalMs` (default 3600000 = 1h) and `probe.sweepActiveWindowMs`
(default 3600000 = only sweep if a request happened in the last hour).

## Dashboard

Open **http://127.0.0.1:4141/** and enter the dashboard password from `config.json`. Create client API keys separately under **Security**. The dashboard is tabbed:

- **Overview** — status cards, API endpoint URLs, provider summary, probe states.
- **Models** — every model with score/state/ok-fail/latency. Filter by text, toggle **free only** (models with free-tier evidence), filter by provider, click a column header to sort (default: score desc). `try` a model, `disable`/`reinstate` it, `blacklist` it, pin its priority. A **why** button opens the per-component score breakdown.
- **Playground** — chat against the router itself with a dashboard session (no client key). Strategy-routed or pinned model, system prompt, temperature, streaming with stop/regenerate.
- **Providers** — add/remove keys (write-only + masked everywhere), enable/disable providers, and manage **Custom endpoints** (any OpenAI-compatible service — name, base URL, key, with a probe-before-add button). **test** any provider's key with a real 1-token chat ping (per row, all at once, or before saving a new key) — results show model, latency, and a classified error kind; keys are never stored by the test.
- **Analytics** — persisted ledger rendered as zero-dependency charts: requests + success rate per hour, average latency, tokens out, plus stat cards (including retry/failover count and success %). Rollups by provider (with traffic-share bars) and a ranked model leaderboard, client-key attribution, live activity stream, and the audit trail. Charts auto-refresh while the tab is visible; 24h/7d window; resettable.
- **Security** — client API keys (create → shown once → revoke), rate-limit/IP-allowlist state.
- **Settings** — router name, model pool, **default model** (fallback for unknown/paid ids), **model aliases** (`fast = groq:llama-3.3-70b` — clients request `fast`, you retarget anytime), **scoring studio** (weight sliders with live preview of the smartest ranking), stealth/persona/decision/compaction toggles, refresh/probe intervals.

The header strategy selector — `sticky` (default) / `fastest` / `roundrobin` / `smartest` — hot-applies on the next request, no restart.

Every dashboard mutation is appended to `logs/audit.jsonl` (action + counts, **never secrets**).

## Decision plane (Jev)

`decision.enabled: true` uses free `jev-1.13-free` to classify request complexity (feeds the
`smartest` strategy), diagnose upstream failures into engine error kinds, and (optionally) verify
tool-call quality. It is **fail-open**: if the decision endpoint is slow or down, routing proceeds
normally and the plane self-disables with a log. `/v1/decide` exposes the raw plane when
`decision.expose: true`.

## Config

`config.json` is validated on load and auto-heals additively from `config.example.json` (schema
evolution never bricks an old file). Atomic writes (tmp + rename). The dashboard edits it for you;
`PUT /api/config` refuses secret fields. Provider credentials use dedicated forms; client API keys are stored as hashes.

Selection lives under `selection`: `strategy`, `pool` (`all`/`free`), `blacklist`, per-model
`priorities`, plus two routing shortcuts — `defaultModel` (used when a client asks for an unknown
or paid id) and `aliases` (`{"fast": "groq:llama-3.3-70b"}` — clients request `fast`; retarget it
anytime without touching clients).

## Security

- **Dashboard password:** configured as `dashboardPassword` locally or the `GATEWAY_KEY` secret on Workers. Change it in the config/secret store. It only opens the dashboard.
- **Client API keys:** create named keys in Dashboard → Security. Plaintext is shown once; revoke a key to make it stop working immediately. Only hashes are stored.
- **Per-key enable/disable:** `PUT /api/keys {provider, label, enabled}` — pause a credential
  without deleting it (labels stay stable while disabled).
- **Rate limiting:** token bucket per IP on `/v1/*` + mutating `/api/*` (default
  60 req/min; `security.rateLimitPerMin: 0` disables). 429s carry `retry-after`.
- **Security headers:** `nosniff`, `no-referrer`, `no-store` on APIs, CSP + frame-deny on the
  dashboard HTML.
- **IP allowlist (optional):** `security.allowedIps: ["127.0.0.1"]` — empty list = allow all
  (localhost default).

## Stealth mode

`stealth.enabled: true` hides real model identities from clients (operator views on the
dashboard/logs keep them):

- `/v1/models` returns **one public codename** (`stealth.alias`, default `cloud-1`) instead of
  the real free-model list.
- Every chat response (JSON + SSE chunks) has its `model` field rewritten to the alias.
  The SSE transformer is line-wise — content is never buffered.
- Optional `stealth.scrubContent: true` also replaces real model-id strings appearing in
  assistant text with the alias (exact match; off by default — can over-match).
- Requesting the alias (or any unknown/paid id) routes normally into the free pool.

## Persona (system prompt layer)

`persona.enabled: true` (default) prepends a configurable system persona to every chat
request — concise, direct, general-purpose (useful as a chatbot and for code), fully
replaceable via `persona.prompt`. Client system messages are kept and ordered by
`persona.prependClientSystem` (default true = persona first). When stealth is also on, an
anti-name-leak rule ("never reveal internal model/provider names; you are <alias>") is
appended automatically. Probes and `/v1/decide` are never injected.

## Context windows & auto-compaction

When estimated input (chars/4) exceeds a candidate model's context window, the router compacts
messages **per attempt** before calling upstream:

- `compaction.strategy: "summarize"` (default) — oldest non-system turns are condensed into a
  summary via one extra free-model call (time-boxed by `compaction.summarizeTimeoutMs`); newest
  turns stay verbatim. Any summarize failure falls open to truncate.
- `"truncate-oldest"` — keep system + newest turns that fit; never drops the current user message.
- Windows: `contextWindows: { "<model>": <tokens> }` overrides; otherwise a conservative 8k
  fallback (tokens ≈ chars/4 — no tokenizer dependency).
- Non-stream responses carry `x_router:{compacted:true, mode, dropped}`; streams carry an
  `x-router-compacted` header; the dashboard activity log shows compaction events.

## Running in production

The router binds `127.0.0.1` by default and is happiest behind a TLS terminator:

**Caddy** (auto-TLS; reverse-proxy to the router, keep the router on localhost):

```
your.domain.example {
    reverse_proxy 127.0.0.1:4141
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name your.domain.example;
    ssl_certificate     /etc/ssl/certs/fullchain.pem;
    ssl_certificate_key /etc/ssl/private/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:4141;
        proxy_buffering off;          # required for SSE streaming
        proxy_read_timeout 3600s;
    }
}
```

**Hardening checklist:** set `security.allowedIps` if clients are on fixed addresses ·
use a strong dashboard password and revoke client API keys when needed · keep `security.rateLimitPerMin` on · keep the router on localhost and never expose port 4141 publicly · upstream provider keys stay server-side and never go into client apps.

**Windows (Task Scheduler):** `schtasks /create /tn free-router /tr "powershell -File C:\path\to\run.ps1" /sc onstart /ru SYSTEM`
· **Linux (systemd):** a unit with `ExecStart=/usr/bin/node /path/to/src/index.mjs`,
`Restart=on-failure`, `User=` a dedicated unprivileged user.

## Cloudflare Workers (scale-to-zero hosting)

The same engine runs on Cloudflare Workers (free plan, scales to zero) via the [`cf`](https://developers.cloudflare.com/) CLI.
Local dev = Node; Workers = `cloudflare.config.ts` + `src/worker.mjs` (Web-standard fetch handler
over the shared `handleRequest` core). Secrets stay in Workers secret bindings; config + catalog
cache live in Workers KV; probe + catalog refresh run on a cron trigger (`*/2 * * * *`).

```powershell
npm install                    # devDependencies: cf, vite, @cloudflare/vite-plugin
npx cf auth login              # interactive — once per machine
npx cf dev                     # local worker dev (reads .dev.vars for secrets)
npx cf deploy                  # build + deploy to your Cloudflare account
```

On first deploy, set secrets (write-once, never in files):

```powershell
npx cf secret put GATEWAY_KEY                 # dashboard password
npx cf secret put COMPAT_CREDENTIALS_KEY      # 32 random bytes, base64url — see below
```

Provider keys (`FREE_ROUTER_*_KEYS`) are no longer deploy bindings — add them from the
dashboard Providers page or via `npx cf workers secrets put`; they are stored per-provider
in the KV-encrypted envelope and survive isolate restarts.

`COMPAT_CREDENTIALS_KEY` is the AES-GCM key for every credential the dashboard stores in KV:
custom-endpoint keys **and** provider keys added/toggled/removed from the Providers page. Generate
it once (`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`)
and keep it backed up and unchanged — losing or rotating it makes saved keys undecryptable.
Without it the Providers page refuses key edits with a 503 instead of letting them silently
vanish on the next isolate restart. Env-secret keys (`FREE_ROUTER_*_KEYS`) remain the bootstrap
source; once you edit a provider's keys in the dashboard, the encrypted copy for that provider
wins at boot (deletions of env-seeded keys stick), while untouched providers keep following
their env bindings.

Config edits and client API-key hashes persist to Workers KV and survive isolate restarts; the dashboard password and provider keys are **never** written to KV in plaintext.
`autoDiscover` is forced off on Workers (no filesystem to scan). Point your clients at the
`workers.dev` URL + a client API key created in the dashboard. Use the dashboard password only to access the dashboard.

## Testing

```powershell
 npm test          # node --test "tests/*.test.mjs" — 150 tests, mocked upstreams, no network
```

## Honest limits

- **Free ≠ unlimited.** Providers rate-limit free tiers; the router rotates, backs off, and fails
  over, but a hard global limit still exists.
- **Zen free-tier gate:** opencode's Zen free route requires the official client fingerprints and
  tool set; the router reproduces them. Maintainers consider third-party proxying ToS-gray — you
  accept that risk by using it; quota still binds your account.
- **Streaming failover is pre-first-byte only** (industry standard) — once bytes flow to the
  client, the route is immutable.
- **Never bills.** Paid/unknown model requests are rerouted to the free pool; `response.model`
  reports the model that actually answered.
- Binds `127.0.0.1` by default. If you expose it (`host: "0.0.0.0"`), put it behind your own
  auth/network controls — dashboard password for `/api/*`, client API keys for `/v1/*`.

## Architecture

See `BODY.md` (wiring map) and `PLAN.md` (9-phase build log with proof gates). Registry rule:
providers register only in `src/providers/index.mjs`, strategies only in `src/strategies/index.mjs`.
