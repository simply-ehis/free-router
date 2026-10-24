# free-router

<img src="public/logo.svg" width="48" alt="free-router logo">

One self-hosted OpenAI-compatible router. Every free model behind a single gateway key — no per-model signups, no per-model keys needed.

[![Tests](https://img.shields.io/badge/tests-187%2F187-green)](https://github.com/simply-ehis/free-router)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it is

`free-router` is a self-hosted OpenAI-compatible gateway that pools free models from multiple providers behind one dashboard password and one client API key. Sticky failover across the free pool, runtime health probes, billing demotion (a paid model on a free key drops out immediately — it can never charge you), and a built-in dashboard.

**Zero-config free models work out of the box** — Zen, Kilo, OVH, and LLM7 serve free models with no account and no credit card. Add your own keys for OpenRouter, NVIDIA, Qwen, Cerebras, HuggingFace, Gemini, Groq, Kluster.ai, and Z.AI to expand the pool.

## Private deployment

Deploy to your own Cloudflare Workers instance (or run locally). The live endpoint is **private** — share only your client API key with trusted users, not the URL itself.

Deploy:

```powershell
npm install
npx cf auth login
npx cf secret put GATEWAY_KEY        # dashboard password
npx cf secret put COMPAT_CREDENTIALS_KEY  # 32 random bytes base64url
npx cf deploy
```

Then add provider keys from the dashboard (Providers page) or via env vars:

```powershell
$env:FREE_ROUTER_OPENROUTER_KEYS="sk-or-v1-..."
$env:FREE_ROUTER_NVIDIA_KEYS="nvapi-..."
$env:FREE_ROUTER_QWEN_KEYS="sk-ws-..."
```

Connect any OpenAI-compatible client to your deployed endpoint:

- **Base URL:** `https://your-worker.reethym.workers.dev/v1`
- **API Key:** your client key from the dashboard (create one under Security)
- **Model:** any id from `GET /v1/models`

## The dashboard

- **Overview** shows how many models in the pool actually work right now (a proportional bar you can click), your connection URLs, and a tile for each free provider with its limits.
- **Models** lists every model with a status — *working*, *rate limited*, *failing* or *not tested yet* — plus a strip of its last results. Filter by status, provider or free-only, and press **Test shown models** to check them. A 429 from a free tier shows as *rate limited*, never as *failing*.
- **Only chat models enter the pool.** Image, video, audio, embedding, reranker, safety-classifier and OCR models are filtered out using each provider's own metadata (output modalities, capabilities, supported methods) and word-based name rules. They are listed under *Filtered out* with the reason, and **Allow as chat** puts a wrongly filtered one back.
- **Providers** has the free providers up top, then one block per provider with each key listed (masked), with turn on/off and remove per key, multi-key paste, and a test button.
- **Security** has client keys (create, pause, revoke), access limits (rate limit, IP allow-list with a lock-out guard, session length), and sign out everywhere.

## Security model

The dashboard is for one person, so the design is: a long random password, a session cookie, and no secrets in the page.

- Signing in sets an `HttpOnly`, `SameSite=Strict` cookie (`Secure` on https). The password is never stored in the browser and never sent in a URL. Sessions are signed with a key derived from the password, so changing the password — or pressing **Sign out everywhere** — ends every session.
- Wrong passwords lock that IP (5 failures, then 1 minute, doubling to 1 hour). A flood of failures from many IPs pauses password attempts for 5 minutes; signed-in sessions are unaffected. Scripts that send `Authorization: Bearer <password>` go through the same lockout.
- Writes made with the cookie must come from the dashboard's own origin. The page ships no inline scripts, and the CSP allows scripts from `'self'` only. Responses are `noindex`, `no-store` and unframeable.
- Custom endpoints must use https (plain http only for local hosts), and a cloud deployment refuses private/local addresses.
- Every dashboard change and sign-in attempt is in the audit trail (never with secrets).
- Strongest option for a cloud deployment: put the dashboard path behind Cloudflare Access, or set an IP allow-list under Security.

## Free providers

Anonymous free tiers share a per-IP quota, so background health checks are budgeted per provider per hour (Kilo 30, OVH 60, LLM7 40, Zen 40, keyed providers 60) and never use the quota your requests need. A manual **Test** always runs. A 401/403 on a keyless lane means "this model needs a paid token" and hides that model for 6 hours; a 401/403 on *your own* key never hides models, so a rotated key cannot empty the pool. 404 hides a model for 6 hours; a billing signal hides it until you bring it back.

## Providers in the pool

| Provider | Key needed? | Free models | Endpoint |
|---|---|---|---|
| **Zen (opencode)** | No | big-pickle, beam-free, glm-5.3-flash-free, mimo-v2.6-flash-free, nemotron-3.5-*-free, space-bunny-free, longcat-2.5-preview-free, deepseek-v4.1-flash-free | `opencode.ai/zen/v1` |
| **Kilo Gateway** | No (anonymous) | `:free` tagged models, `kilo-auto/free` auto-router | `ai-gateway.kilo.ai/api/v1` |
| **OVHcloud AI Endpoints** | No (anonymous) | All catalog models (2 req/min/IP) | `oai.endpoints.kepler.ai.cloud.ovh.net/v1` |
| **LLM7** | No (`unused` key) | turbo models (10 req/min) | `api.llm7.io/v1` |
| **OpenRouter** | Yes | `:free` tagged models | `openrouter.ai/api/v1` |
| **NVIDIA NIM** | Yes | nemotron family | `integrate.api.nvidia.com/v1` |
| **Qwen / DashScope** | Yes | qwen-turbo, qwen-max, qwen3 series | `dashscope.aliyuncs.com/compatible-mode/v1` |
| **Cerebras** | Yes | gpt-oss-120b, qwen-3.8-27b | `api.cerebras.ai/v1` |
| **Hugging Face** | Yes | router.huggingface.co models | `router.huggingface.co/v1` |
| **Gemini** | Yes | gemini flash series | `generativelanguage.googleapis.com` |
| **Groq** | Yes | gpt-oss, qwen series | `api.groq.com/openai/v1` |
| **Kluster.ai** | Yes | llama, deepseek family | `api.kluster.ai/v1` |

## Quickstart

```powershell
git clone https://github.com/simply-ehis/free-router.git
cd free-router
node src/index.mjs        # or: .\run.ps1
```

On first boot the router:
1. Creates `config.json` (gitignored) from `config.example.json` with a generated dashboard password
2. Listens on `http://127.0.0.1:4141`

Open the dashboard, enter the password from `config.json`, then under **Security** create a client API key. Connect any OpenAI-compatible client:

- **Base URL:** `http://127.0.0.1:4141/v1`
- **API Key:** your client key from the dashboard
- **Model:** any id from `GET /v1/models`

## Adding provider keys

Dashboard → Providers → paste key (write-only, masked everywhere, shown once). Or set env vars:

```powershell
$env:FREE_ROUTER_OPENROUTER_KEYS="sk-or-v1-..."
$env:FREE_ROUTER_NVIDIA_KEYS="nvapi-..."
$env:FREE_ROUTER_QWEN_KEYS="sk-ws-..."
$env:FREE_ROUTER_CEREBRAS_KEYS="csk-..."
$env:FREE_ROUTER_HF_TOKEN="hf_..."
$env:FREE_ROUTER_GEMINI_KEYS="AIzaSy..."
$env:FREE_ROUTER_GROQ_KEYS="sk-..."
$env:FREE_ROUTER_KLUSTER_KEYS="..."
$env:FREE_ROUTER_ZAI_KEYS="fe_oa_d..."
```

Keys added from the dashboard are stored per-provider in an AES-GCM encrypted envelope (Cloudflare KV on the live worker, local `.cache/` in Node mode) and survive restarts.

## Free models that need no key

Zen, Kilo, OVH, and LLM7 all serve models with no account, no credit card, no phone number:

```powershell
# Zen — big-pickle
curl http://127.0.0.1:4141/v1/chat/completions -H "Authorization: Bearer <client-key>" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"say hi"}]}'

# OVH — Meta-Llama-3_3-70B-Instruct
curl http://127.0.0.1:4141/v1/chat/completions -H "Authorization: Bearer <client-key>" \
  -d '{"model":"Meta-Llama-3_3-70B-Instruct","messages":[{"role":"user","content":"say hi"}]}'

# LLM7 — gpt-oss:20b
curl http://127.0.0.1:4141/v1/chat/completions -H "Authorization: Bearer <client-key>" \
  -d '{"model":"gpt-oss:20b","messages":[{"role":"user","content":"say hi"}]}'
```

## Safety

- Billing signals demote a route on the first `402` — a paid model on a free key can never charge you
- Runtime probes revive unhealthy models; background checks are budgeted per provider so free tiers keep their quota
- Sticky failover across the free pool — if one model is down, the next one answers
- Set `selection.pool: "free"` in `config.json` for a strict free-only filter

## License

MIT — see [LICENSE](LICENSE).

## Live instance

https://free-router.reethym.workers.dev — create a client key in the dashboard and connect any client.
