PURPOSE: How to test this repo, including E2E.
OWNS: tests/, manual proof scripts.
READ-WHEN: Before claiming a feature works; during review.
KEY-FILES: node --test "tests/*.test.mjs", tests/*-check.mjs (manual live proofs).
INVARIANTS: A change is not done until the suite is green; live proofs run when touching upstreams.
GOTCHAS: `node --test tests/` (directory) fails on this setup — always glob `"tests/*.test.mjs"`. PS 5.1 is the default shell: avoid inline JS regex in `-replace` (use script files). `rg` is not installed.
UPDATED: 2026-10-10

## Unit
 - Run: `npm test` (= `node --test "tests/*.test.mjs"`) — 122 tests.
- Where: `tests/*.test.mjs`. Mocked HTTP upstreams; no network, no real keys.
- Coverage: routes (failover/stream/toolverify/decision wiring), strategies, probe, decision plane,
  providers (OR/Groq/Gemini adapters + catalog integration), dashboard (auth/masking/hot-apply/SSE/audit),
  P17 Workers (direct-Request `handleRequest`: auth/rate-limit/IP-allowlist/CSP, `buildConfig`/
  `bootConfig`/`installKvStore` KV round-trip).

## Mutation audits
- `tests/mutate-p15.mjs`, `mutate-p16.mjs`, `mutate-p17.mjs` — one-shot, restore in finally.
  P17: auth check, `safeEqual`, `cf-connecting-ip`, gateway-key binding, KV persist — all caught.

## Manual live proofs (not in the unit glob)
- `node tests/live-stream-check.mjs` — real Zen stream: SSE chunks + [DONE].
- `node tests/live-decide-check.mjs` — real keyless Jev via /v1/decide.
- `node tests/live-dashboard-check.mjs` — real boot: dashboard 200, masked /api/status.
- `node tests/jev-probe.mjs` — raw systemone wire-shape probe.

## E2E
- Gate (P9): Cline/opencode-shaped request through the gateway → streamed free-model reply;
  evidence = test output + run log.

## Audit
- New tests must be able to fail: mutate the guard under test, watch the test go red, revert
  (`false-confidence-audit`). Done for every phase — see PLAN.md progress line.
