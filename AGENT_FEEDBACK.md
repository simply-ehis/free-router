PURPOSE: What tripped the agent, so we fix the ENVIRONMENT not just the bug.
OWNS: Recurring friction, missing scripts, bad docs, flaky setup.
READ-WHEN: The agent gets stuck, guesses, or wastes a turn on env issues.
KEY-FILES: AGENTS.md, CONVENTIONS.md, the script that should have existed.
INVARIANTS: Each entry has a fix (script added / doc corrected), not just a complaint.
GOTCHAS: Don't log one-off user mistakes; log systemic env problems.
UPDATED: 2026-10-10

## Entries
- 2026-10-10 — `rg` (ripgrep) is NOT installed → Grep tool unusable; use PowerShell `Select-String`
  or read files directly. Fix for env: install ripgrep (`winget install BurntSushi.ripgrep.MSVC`).
- 2026-10-10 — default shell is Windows PowerShell **5.1**, not pwsh 7: inline JS regex in
  `-replace` breaks (backtick-n injection, quoting hell) → write temp `.mjs`/`.ps1` script files
  instead of mutating files from the command line.
- 2026-10-10 — `node --test tests/` (directory arg) fails in this setup → always glob
  `node --test "tests/*.test.mjs"`. Documented in TESTING.md.
- 2026-10-10 — assertion-throw before `server.close()` leaves open handles → test hangs; use
  `t.after(() => { server.closeAllConnections?.(); server.close(); })` and `port: 0` is rejected
  by config validation (1-65535) → freePort() helper (bind 0, read, close).
- 2026-10-10 — UTF-8 smart chars (em-dash etc.) in .ps1 files WITHOUT BOM get misdecoded by
  Windows PowerShell 5.1 (0x94 → curly quote, which PS treats as a string delimiter) and silently
  swallow the middle of the script into a string (param switches "bind" but branches never run!).
  Fix: keep .ps1 files pure ASCII; comment the rule at the top of the file. Detected via
  Parser::ParseFile token map.
- 2026-10-10 — repo had no commits until P7; `git checkout --` cannot revert a mutation audit.
  Fix: suggest checkpoint commits per phase (done; user decides).
- 2026-10-14: `bin/run.ps1` still contained the apply-template placeholder command
  (`<command that starts/runs the app...>`) so every "run the app" smoke via run.ps1
  failed with "term '<' is not recognized". Fixed: `$cmd = 'node src/index.mjs'` (= npm start).
