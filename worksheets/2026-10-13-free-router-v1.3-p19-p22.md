<!-- PURPOSE: Work trace for free-router v1.3 (P19-P22): selection v2, usage ledger, custom providers, dashboard v2 -->
<!-- OWNS: chronological record of decisions, files touched, verification evidence for this phase -->
<!-- READ-WHEN: auditing v1.3 work; re-running or extending these phases -->
<!-- KEY-FILES: PLAN.md#v1.3 (phase gates), TODOS.md (queue), BODY.md (wiring map) -->
<!-- INVARIANTS: evidence = actual command output, not claims; one section per phase -->
<!-- GOTCHAS: PowerShell output redirect mangles UTF-8 — use 2>&1 | Out-String -Stream -->
<!-- UPDATED: 2026-10-13 -->

# Worksheet — free-router v1.3 (P19–P22), 2026-10-13

Scope (user-confirmed): better model selection (aliases + new scoring) · custom provider
("bring any provider") · model viewer with free-only filtering + better sorting · persisted
Usage page · other missing dashboard pages.

## P19 — Selection v2
- `selection.defaultModel` + `selection.aliases` validated in `src/config.mjs`, present in `config.example.json`.
- `resolveRequested()` in `src/routes.mjs`; `orderCandidates` pins the resolved target and passes the `sources` evidence map.
- `src/strategies/smartest.mjs`: new `verified` component (only scored when evidence present; weights renormalize otherwise), `BASE_WEIGHTS` = success .4 / latency .3 / freshness .15 / priority .05 / verified .1. Sticky strategy ranks failover remainder by the same score.
- Evidence: routes + strategies tests → 127/127.

## P20 — Usage ledger
- New `src/usage.mjs` (organ=muscle): per-model / per-client-key / hourly counters, token counts, 7-day retention, debounced flush through the store seam (`path.dirname(CONFIG_PATH)/.cache/usage.json`), corrupt-file resilient (boots fresh, never throws).
- Wired: `routes.mjs#runChat` outcome recording, `apiKeys.mjs#findApiKey` attribution, `server.mjs` keyMeta.
- API: `GET /api/usage`, `POST /api/usage/reset` in `dashboard.mjs`; tests isolate `FREE_ROUTER_CONFIG`.
- Evidence: usage tests + suite → 136/136.

## P21 — Custom providers
- `src/providers/factory.mjs` (`makeOpenAIProvider`) + presets `cerebras.mjs` / `sambanova.mjs` / `mistral.mjs`; registered in `providers/index.mjs` (8 providers). Env vars in `config.mjs#ENV_KEY_VARS` + `discovery.mjs#ENV_KEYS`; entries in `config.example.json`.
- openai-compat: per-instance `enabled` (filter in `openaiCompat.mjs`, validated in `config.mjs`), `PUT /api/openai-compat/instances` toggle, `POST /api/openai-compat/probe` — shared `parseCompatBaseUrl()` / `probeCompatEndpoint()`.
- Evidence: providers + dashboard tests → 139/139.

## P22 — Dashboard v2
- Split `web/dashboard.html` (239 lines) → `dashboard.css` (77) + `dashboard.js` (292, core: auth/SSE/tabs/overview/models) + `dashboard-pages.js` (296, providers/security/usage/logs/settings + form handlers). All ≤500.
- Assets served unauthenticated at `/dashboard.css|/dashboard.js|/dashboard-pages.js`; CSP adds `'self'` to script-src/style-src. Node reads via store seam; Worker bundles `?raw`.
- `dashboard.mjs` grew past 500 during P20/P21 → split: asset serving → `src/dashboardAssets.mjs` (63), compat add/probe/toggle/remove/list → `src/compatInstances.mjs` (100). `dashboard.mjs` back to 483.
- Models page: free-only toggle + provider filter + click-to-sort + localStorage prefs; Settings page edits name/pool/defaultModel/aliases/stealth/persona/decision/compaction/intervals.
- Evidence: new dashboard test asserts asset routes (content types, markers, no-auth) + CSP `'self'` → 140/140.
- Live proof (run.ps1, pid 9848, port 4141): html/css/js/pages all 200 with correct content-types + CSP; `/api/usage` returns totals/models/keys/hourly/retainHours/persisted; `/api/audit` returns entries; `POST /api/usage/reset` zeroes and persists (`.cache/usage.json` rewritten on disk).

## Wrap-up
- BODY.md rows added: usage ledger, selection v2, provider factory, compat instances, dashboard assets; skin updated to the four-file split.
- PLAN.md P19–P22 marked done with dates; TODOS.md updated (P20/P21/P22 → done, P18 next).
- README: 3 new providers in the table, tabbed dashboard section, selection config note, custom-endpoint probe.
