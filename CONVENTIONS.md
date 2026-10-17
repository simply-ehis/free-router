PURPOSE: House style for this repo — the rules code must follow.
OWNS: All source in this repo.
READ-WHEN: Before writing/editing any code; during review.
KEY-FILES: AGENTS.md (router), TESTING.md (how to test), BODY.md (wiring map).
INVARIANTS: Code matches existing style; tests pass before "done".
GOTCHAS: Zero npm deps — never add a package without an explicit decision. Node 24 ESM only (`type: module`). No comments unless they carry real "why" weight; every file starts with an `@body:` header. `.ps1` files must be pure ASCII (PS 5.1 turns UTF-8 smart chars into string delimiters — see AGENT_FEEDBACK).
UPDATED: 2026-10-10

## Language / style
- Node 24, ESM (`.mjs`), no TypeScript, no build step, no dependencies.
- Files ≤ 500 lines, functions ≤ 100 lines. Small focused modules.
- Names: verbs for functions (`refresh`, `applyFailure`), nouns for state (`catalog`, `routesState`).
- Errors: contextual, recoverable, logged with structured fields; never silent.
- Every source file begins `// @body:organ=... role=...` (Body anatomy) — update BODY.md when wiring changes.

## Structure
- `src/providers/*` — external APIs; register ONLY in `src/providers/index.mjs`.
- `src/strategies/*` — selection order; register ONLY in `src/strategies/index.mjs`.
- `src/` top level = organs (index=brain, routes=engine, catalog=lungs, dashboard+server=face).
- `web/` — single-file dashboard, zero deps, inline CSS/JS.
- Config = validated + atomic write + additive self-heal from example; secrets write-only.

## Do / Don't
- DO: time-box every upstream call; keep the free-guard absolute (never route to paid).
- DO: prove a guard with a mutation audit before calling it done.
- DON'T: add npm dependencies; read/print real keys in code or tests; let strategy/decision/dashboard
  failures stop serving (fail-open with log).
- DON'T: register adapters/strategies anywhere except the two index.mjs nerves.
