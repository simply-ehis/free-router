PURPOSE: The task queue for this repo.
OWNS: Current and upcoming work items.
READ-WHEN: Starting a session; picking the next slice; during night-shift.
KEY-FILES: worksheets/ (per-task traces), PLAN.md (phase gates).
INVARIANTS: At most one item is in_progress; completed items get a date.
GOTCHAS: Don't start a new thread before the in_progress item is done/closed.
UPDATED: 2026-10-14

## Recent (done)
- [x] P9 Test suite + live proof — 2026-10-10 (53/53; live stream/decide/dashboard evidence)
- [x] v1.1 P10 Key mgmt + hardening — 2026-10-10 (rotate/enable/rate-limit/headers/allowlist; 61/61)
- [x] v1.1 P11 Stealth layer — 2026-10-10 (alias-only models, JSON+SSE rewrite, scrub; 69/69)
- [x] v1.1 P12 Persona layer — 2026-10-10 (general-purpose prompt merge + anti-name-leak; 76/76)
- [x] v1.1 P13 Context + auto-compaction — 2026-10-10 (summarize w/ truncate fail-open; 84/84)
- [x] v1.1 P14 Production-readiness — 2026-10-10 (dash security UI, prod docs, full live battery)
- [x] v1.2 P15 Open pool — 2026-10-10 (pool=all default, free-only opt-in, dashboard tags; 85/85)
- [x] v1.2 P16 Auto-detect keys + openai-compat adapter — 2026-10-10 (discovery, multi-instance passthrough; 94/94)
- [x] v1.2 P17 Cloudflare Workers hosting — 2026-10-10 (Web-standard core, KV store seam, worker entrypoint, cf build/dev smoke; 107/107)
- [x] v1.3 P19 Selection v2 — 2026-10-13 (defaultModel + aliases + verified scoring, sticky failover ranked; 127/127)
- [x] v1.3 P20 Usage ledger — 2026-10-13 (`src/usage.mjs`, per-model/per-key/token counts, persisted + reset; 136/136)
- [x] v1.3 P21 Custom providers — 2026-10-13 (factory + cerebras/sambanova/mistral presets, per-instance enable/disable + probe; 139/139)
- [x] v1.3 P22 Dashboard v2 — 2026-10-13 (html/css/js/-pages split, 7 tabbed pages, assets module, /api/audit; 140/140 + live smoke)
- [x] P23 Worker key persistence bugfix — 2026-10-14 (encrypted KV envelope for dashboard-added provider keys via COMPAT_CREDENTIALS_KEY, per-provider surgical restore, 503 refusal without the secret; 150/150 + mutation audit)

## In progress
- (none)

## Next
- [ ] v1.2 P18 Deploy guide + wrap — README Cloudflare section, final live battery, END_OF_SHIFT
- [x] Real `cf deploy` gate: PASSED 2026-10-14 — OAuth profile already valid (no interactive login needed); deployed v791cbc94 to free-router.reethym.workers.dev; authenticated live battery done (status/usage/scoring/providers-test).
- [x] Live stub-secret purge (user-ordered): all 4 `FREE_ROUTER_*_KEYS` Worker secrets deleted (new version without bindings, no redeploy); live `refreshOk:true` restored, every provider keyless. Remaining live secrets: GATEWAY_KEY + COMPAT_CREDENTIALS_KEY only.
- [ ] User action: set real keys when ready — `npx cf workers secrets put FREE_ROUTER_<NAME>_KEYS`; */2-min cron repopulates the pool, no redeploy. (Local `.dev.vars` stubs already removed 2026-10-14 with user approval; backup at `%TEMP%\dev.vars.bak`.)
- Worker polish: `uptimeSec` reports epoch seconds on Workers (boot time never captured) — cosmetic, pre-existing.

## Blocked
- (none)

## Done
- [x] P1 Scaffold — 2026-10-10
- [x] P2 Zen adapter + catalog (live /v1/models) — 2026-10-10
- [x] P3 Routes + strategies (echo/reroute live) — 2026-10-10
- [x] P4 Streaming + probe (live SSE 16 chunks, failover-before-first-byte) — 2026-10-10
- [x] P5 Decision plane (live keyless jev noul 0.95; toolverify block/flag) — 2026-10-10
- [x] P6 Extra adapters (OR/Groq/Gemini, catalog cred-less skip) — 2026-10-10
- [x] P7 Dashboard (masked config, hot-apply, SSE live feed, audit log; live smoke) — 2026-10-10
- [x] P8 Integration + docs (README, run.ps1, template docs, worksheet, IMPACT_MAP) — 2026-10-10
