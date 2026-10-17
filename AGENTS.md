# AGENTS.md — Project Router

Auto-applied by `bin/apply-template.ps1`. This file is the project's own router; the
global router (`~/.config/opencode/AGENTS.md`) loads first and links here.

## What this repo is
Self-hosted free-model router: one OpenAI-compatible gateway key in front of Zen/opencode,
OpenRouter, Groq, Gemini, and any openai-compat endpoint. Sticky failover across the free
pool, Jev decision plane, stealth/persona/compaction layers, built-in dashboard. Local dev =
Node 24 (`run.ps1`, port 4141); hosted path = Cloudflare Workers (scale-to-zero, `cf` CLI).

## How to work here
- Follow `CONVENTIONS.md` (house style) for every change.
- Tests: `TESTING.md` (unit + live proofs). Run `npm test` before declaring done.
- Trace non-trivial work in `worksheets/` (`bin/worksheet.ps1`).
- Log environment friction in `AGENT_FEEDBACK.md` and fix the env.
- Commit only when asked; stage only intended files (never `config.json`, `logs/`, `.cache/`, `.dev.vars*`).

## Project-specific triggers
- READ-WHEN: touching providers/routing (registry rule), the HTTP core (`handleRequest`),
  the store seam, security/stealth layers, or deploying to Cloudflare.
- KEY-FILES: `src/index.mjs` (Node boot), `src/server.mjs#handleRequest` (shared core),
  `src/worker.mjs` + `src/workerConfig.mjs` (Workers), `cloudflare.config.ts`,
  `src/providers/index.mjs` + `src/strategies/index.mjs` (the ONLY registries),
  `config.example.json` (schema source of truth), `PLAN.md` (phase gates).
- INVARIANTS: zero runtime npm deps (`cf`/`vite` are devDependencies only, never imported by
  `src/`); every upstream time-boxed; secrets never leave the server / never written to KV;
  fail-open non-essential systems; provider/strategy registration only in their index.mjs;
  `@body:` header tags + BODY.md rows on new units; mutation audit per gate (tests can fail);
  files ≤500 lines, functions ≤100.
- GOTCHAS: no `rg` — use Select-String/Grep tool. PS 5.1 mangles UTF-8 with `-replace`/
  `Set-Content` → temp `.mjs` script files. PS `>` redirect → UTF-16 garbage; use
  `2>&1 | Out-String -Stream`. `node --test tests/` (directory) fails — always glob
  `"tests/*.test.mjs"`. Workers: `autoDiscover` forced off (no filesystem); dashboard HTML is
  `?raw`-bundled (not a `worker.assets` directory — that config type has no such field).
