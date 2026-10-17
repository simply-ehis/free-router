PURPOSE: Per-task work trace for the free-router build (P1â€“P8 session).
OWNS: worksheets/2026-10-10-free-router-p1-p8.md
READ-WHEN: Need to reconstruct why a decision was made; resume the build after interruption.
KEY-FILES: PLAN.md (phase gates), BODY.md (wiring), AGENT_FEEDBACK.md (env quirks).
INVARIANTS: One worksheet per task batch; decisions recorded with evidence, not vibes.
GOTCHAS: Evidence lives in PLAN.md progress line + test counts; keep them in sync.
UPDATED: 2026-10-10

## Task: free-router P1â€“P8 (scaffold â†’ adapters â†’ dashboard â†’ docs)

### Decisions
- Zen free-tier gatekeeper (empirical): UA `opencode/â€¦`, `x-opencode-session/client/project`,
  upstream `stream:true` mandatory, tools must include `shell`+`read`, SSE `[DONE]` + usage. 403 otherwise.
- Jev systemone wire shape (live-probed): `questions` is an **object map**, not array; no auth header;
  ~800â€“1000ms; fail-open + self-disable latch after 3 hard fails / 300s.
- Gemini: no OpenAI-compat `/models` (404 live-verified) â†’ native `/v1beta/models` for listing
  (key required, `models/` prefix stripped), OpenAI-compat `/openai/chat/completions` for chat.
- Groq/Gemini free rule = free developer/AI-Studio tier (honest caveat documented in README);
  catalog skips credential-less providers (else keyless OpenRouter pollutes pool + 401 spam).
- Dashboard keys write-only: `PUT /api/config` rejects `keys`/`apiKey`; masked via `maskKey` everywhere;
  audit log counts-only. SSE = snapshot/2s + live `bus` route/probe events.
- `FREE_ROUTER_CONFIG` env override so tests never clobber real config.json.

### Evidence
- P1â€“P6: 42/42 `node --test "tests/*.test.mjs"`; mutation audits (catalog cred-less skip) caught + reverted.
- P7: 53/53; two mutations caught (unmask gateway key â†’ red; allow secret fields â†’ red); live smoke:
  `/` 200, 13 free models, zen auto-connected, no key leak.
- Live proofs kept: tests/live-{stream,decide,dashboard}-check.mjs, jev-probe.mjs.

### Friction
- See AGENT_FEEDBACK.md (rg missing, PS 5.1 quirks, node --test glob, no-git-revert).

## P10 — key mgmt + hardening (same day)
- src/security.mjs: token-bucket per IP (capacity=min/refill=min/min — fixed a capacity=perMin/1000 bug found by tests), IP allowlist, applySecurityHeaders.
- config: security block validation; keys accept string|{key,enabled}; providerKeyEntries/enabledKeyEntries helpers; adapters use stable full-index labels.
- dashboard: POST /api/security/rotate-key (key shown once, audit w/o value), PUT /api/keys toggle, sanitize masks object keys too, removeKey raw-index fix.
- server.mjs: headers + allowlist + rate limit wired in route() before auth.
- tests/security.test.mjs 8 tests; full suite 61/61. Mutations: (1) consumeRate always-allow ? red; (2) rotate skips cfg.apiKey update ? red.
- live-rotate-check.mjs: rotate?401/200, headers, rate 200,200,200,429, audit leak check.


## P11 — stealth (same day)
- src/stealth.mjs: publicModelsBody, rewriteCompletionJson, sseModelRewriter (line-wise Transform, buffers to next newline only), optional scrubContent.
- server.mjs: handleModels(cfg), stream pipeline gains rewriter only when stealth on (zero overhead off).
- config: stealth block validation; hot-patchable via PUT /api/config (with security).
- tests/stealth.test.mjs 8 tests; suite 69/69. Mutations: non-stream rewrite off -> red; stream rewrite off -> red.
- live-stealth-check.mjs: models=cloud-1 only, stream model field alias, content + [DONE] intact.


## P12 — persona (same day)
- src/persona.mjs: withPersona merges persona + stealth anti-name-leak into one leading system msg; general-purpose ponytail-adapted default prompt; passthrough when off/empty.
- routes.mjs#runChat injects via chatBody (chat only; probes/decide untouched).
- config: persona block validation; hot-patchable via PUT /api/config.
- tests/persona.test.mjs 7 tests (5 unit + validation + end-to-end mock capturing upstream messages); suite 76/76.
- mutation: withPersona always-passthrough -> non-zero exit, caught. (Note: PS5.1 Set-Content mangles UTF-8 -> use node for mutations; bak-overwrite footgun avoided by in-process restore.)


## P13 — context + compaction (same day)
- src/context.mjs: estimateTokens (chars/4), contextWindowOf (override + 8k fallback), truncateOldest, splitForSummarize.
- routes.mjs: compactForAttempt per-attempt (summarize via provider.chat, fail-open truncate); markCompacted x_router; stream header x-router-compacted; bus 'compaction' event -> dashboard SSE.
- config: compaction.strategy|summarizeTimeoutMs + contextWindows validation; hot-patchable.
- tests/context.test.mjs 8 tests; suite 84/84. Mutations: (1) never compact -> caught; (2) summarize always-null -> caught.


## P14 — prod readiness (same day)
- dashboard.html: Security section (rate/IP cards, rotate button + one-time key reveal, session re-login); compaction SSE log line.
- README: Running in production (Caddy/nginx TLS snippets, hardening checklist, Task Scheduler/systemd).
- Full live battery rerun: stream 64 chunks/[DONE]/big-pickle; decide noul 0.96@585ms; dashboard 13 models no leak; rotate+stealth temp-config proofs green. Suite 84/84.
- v1.1 P10-P14 ALL COMPLETE. Auto-connect installer discussion deferred per user.


## Tooling switch (user-directed)
- Installed cf 1.0.0-beta.14 globally (Cloudflare birthday-week agentic CLI, replaces Wrangler long-term).
- Uninstalled vercel@59.26.0 from the machine. Cloudflare = global hoster going forward.
- User context: personal-but-not-local (mobile + trusted circle), free scale-to-zero hosting, open pool (if a model from a key works it is used), freebuff skipped, cline N/A.
- PLAN.md updated: v1.2 section (P15 open pool, P16 auto-detect + generic adapter, P17 Workers deploy, P18 wrap); invariant relaxed (no static free/paid gate).


## P15 — open pool (v1.2)
- catalog.mjs: pool gate ('all' default surfaces every keyed model; 'free' keeps legacy filter); log field freeModels->models+pool.
- config: selection.pool validated all|free; config.example.json pool:'all'.
- dashboard: modelsDetail carries catalog sources; free/unverified badges; pool mode in meta.
- engine tests pin pool:'free' (free-pool semantics); providers.test proves both modes + validation.
- tests 85/85. Mutations: (1) filter removed -> red; (2) mode ignored -> red (tests/mutate-p15.mjs, repeatable).


## P16 — auto-detect keys + openai-compat (v1.2)
- src/discovery.mjs: env vars (GROQ/GEMINI/OPENROUTER/ZEN/OPENCODE aliases) + full opencode auth.json (map opencode->zen, unknown ignored); FREE_ROUTER_AUTH_JSON override for tests; mergeDiscovered dedup-by-value + source tag wired into all 5 adapters.
- openai-compat adapter: multi-instance {baseUrl,apiKey,prefix,models?}; models auto-listed from /models when models[] absent; ids served as prefix:id; chat strips prefix + raw passthrough; classify buckets.
- config: autoDiscover flag (default true); openai-compat exempt from generic keys[] rule; example block added; dashboard (N auto) counter.
- Test hygiene: all 8 engine test cfgs pin autoDiscover:false; p16.test.mjs pins auth.json path. Tests 94/94. Mutations caught x3 (mutate-p16.mjs): mergeDiscovered neutered / prefix-strip broken / prefix never applied.



## P17 - Cloudflare Workers hosting (v1.2)
- P17a/b: Web-standard HTTP core. New src/util/http.mjs (jsonRes/errRes/safeEqual/readBodyText); src/store.mjs sync seam (setStore, Node fs default, atomic tmp+rename). server.mjs: handleRequest(request,cfg)->Response + node adapter startServer (nodeToRequest injects x-local-ip; sendResponse via Readable.fromWeb+pipeline, duplex half). security.mjs: remoteIp honors cf-connecting-ip->x-real-ip->x-forwarded-for->x-local-ip; securityHeaders({isApi,isHtml}) plain object. stealth.mjs: web TransformStream sseModelRewriterStream replaces node Transform. dashboard.mjs fully Web-standard (handlers (request,cfg,url), BOOT_AT replaces process.uptime, crypto.getRandomValues, SSE ReadableStream w/ MAX_SSE_CLIENTS=8). config.mjs: deepMerge exported, applyEnvKeys(cfg, env) param, saveConfig via store. catalog.mjs: cache via store, best-effort write.
- P17c: workerConfig.mjs (buildConfig env->cfg autoDiscover=false + GATEWAY_KEY/applyEnvKeys overlay; installKvStore KV->sync Map + fire-and-forget put 512KB cap; bootConfig KV CONFIG_PATH wins, persist built config). worker.mjs (setDashboardHtml via web/dashboard.html ?raw; memoized boot; fetch->handleRequest 503 on boot fail; scheduled ctx.waitUntil refresh->probeOnce). cloudflare.config.ts (nodejs_compat, CONFIG text binding, GATEWAY_KEY+FREE_ROUTER_*_KEYS secrets, DATA kv binding, cron */2 * * * *). vite.config.ts (@cloudflare/vite-plugin). package.json cf scripts + devDeps (cf, vite, @cloudflare/vite-plugin). .gitignore node_modules/dist/.cloudflare/.wrangler/.dev.vars*/.env*/logs.
- Tests: p17.test.mjs direct-Request (healthz, /v1/models 401/200, dashboard CSP, /api/status query-key, rate 429, cf-connecting-ip allowlist, 404, invalid JSON 400) + worker (buildConfig bindings/invalid, bootConfig empty/saved-KV, installKvStore round-trip+preload). Suite 107/107. Mutations caught x5 (mutate-p17.mjs): auth check, safeEqual, cf-connecting-ip, gateway-key binding, KV persist.
- Smoke: cf build clean (106kB bundle, ?raw HTML import OK). cf dev: /healthz 200, dashboard 200+csp, /v1/models 401 keyless. Real cf deploy gated on user cf auth login (P18).
