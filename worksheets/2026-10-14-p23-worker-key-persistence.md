<!-- PURPOSE: Worksheet trace for the P23 worker key-persistence bugfix -->
<!-- OWNS: Root-cause evidence, design decision, implementation steps, proof for this fix -->
<!-- READ-WHEN: Touching provider key storage, workerConfig boot, or the Providers dashboard page -->
<!-- KEY-FILES: src/providerCredentials.mjs, src/providerKeys.mjs, src/workerConfig.mjs, tests/worker-keys.test.mjs -->
<!-- INVARIANTS: Envelope is per-provider surgical; config blob in KV stays keyless; 503 refusal without COMPAT_CREDENTIALS_KEY -->
<!-- GOTCHAS: Env keys are the bootstrap only — once a provider is touched in the dashboard its envelope wins at boot (documented in README) -->
<!-- UPDATED: 2026-10-14 -->

# P23 — Worker key persistence bugfix

## Symptom (user report)
"every time i refresh the site the key i set up clears and the stub keys get rolled back in"

## Root cause
On the Worker runtime (`npx cf dev`), dashboard-added provider keys lived only in the
isolate's in-memory cache. `installKvStore.flush()` strips every `providers.*.keys` array
before `kv.put` (secrets-never-in-KV invariant), so on isolate recycle (site refresh in
`cf dev`) boot restored the key-stripped config from KV and re-applied only the
`FREE_ROUTER_*_KEYS` env secrets from `.dev.vars` (the old stub keys). The user's
dashboard-added key vanished; stubs "rolled back in". Node (`run.ps1`) was unaffected
(`saveConfig` writes to disk). Compat instances had already solved this with AES-GCM +
`COMPAT_CREDENTIALS_KEY`; native provider keys never got it.

## Decision
User chose encrypted KV persistence: reuse the existing `COMPAT_CREDENTIALS_KEY`
AES-GCM machinery (no new deploy secret) for a per-provider envelope at
`.cache/provider-credentials.json` (KV key `PROVIDER_CREDENTIALS_PATH`).

## Implementation (all 2026-10-14)
1. `src/compatCredentials.mjs` — exported `importKey`/`encode`/`decode` primitives (additive).
2. `src/config.mjs` — `PROVIDER_CREDENTIALS_PATH` beside `COMPAT_CREDENTIALS_PATH`.
3. `src/providerCredentials.mjs` (new) — envelope `{version:1, providers:{<id>:{iv,ciphertext}}}`;
   plaintext = raw keys array (strings + `{key,enabled}` preserved, `[]` = "cleared, stays cleared");
   AAD = provider id (entries can't be swapped). `persistProviderKeys` is surgical: only the
   touched provider is rewritten, so untouched providers keep seeding from env bindings.
4. `src/workerConfig.mjs#bootConfig` — `configureProviderCredentials(env.COMPAT_CREDENTIALS_KEY)`;
   after the compat restore, decrypt envelope and REPLACE keys for covered providers;
   fail-open (warn + env keys) on decrypt error.
5. `src/providerKeys.mjs` (new) — `addKeys`/`removeKey`/`toggleKey` extracted from `dashboard.mjs`
   (which was at 481/500 lines) and made async: worker path 503s without `COMPAT_CREDENTIALS_KEY`,
   persists before `saveConfig`, rolls back the in-memory mutation on KV failure.
   `dashboard.mjs` routes await them and propagate `out.status ?? 400`.
6. Snapshot: `configured` (raw config key count) + `providerKeysReady` in `/api/status`.
7. Frontend: `dropKey` label now uses `p.configured` (was counting enabled+discovered — a real
   label-mismatch bug); drop button hidden when `configured === 0`; `renderKeyFormState` disables
   the key form on Workers without the encryption key (mirrors the compat form).

## Proof
- New `tests/worker-keys.test.mjs`: 10 tests — crypto round-trip/tamper/wrong-secret/AAD-swap;
  key survives "isolate recycle" (boot → mutate → boot same KV); deleted stub stays deleted;
  cleared provider stays cleared; toggle survives; 503 without secret (cfg untouched);
  KV write failure → 503 + rollback; Node path unchanged, no envelope written.
- Mutation audit: neutering the boot restore → 3 tests red; neutering the 503 guard → 1 red.
- Full suite: **150/150** (`npm test`, was 140/140).

## Follow-up for the user
`.dev.vars` still holds the Oct-11 stub keys — remove or replace them for env-binding hygiene:
`npx cf secret delete FREE_ROUTER_*_KEYS` (deployed) / edit `.dev.vars` (dev). Set
`COMPAT_CREDENTIALS_KEY` if not already set (README now documents generation).
