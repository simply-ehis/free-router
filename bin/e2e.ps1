<#
.SYNOPSIS
  Run end-to-end tests (user-facing flows).
.DESCRIPTION
  Project-specific. Edit to run tests/e2e. Returns non-zero on failure.
  Used by TESTING.md and the "test the truth" rule (#4).
#>
param([switch]$DryRun)

$cmd = '<command that runs e2e, e.g. pytest tests/e2e -q>'
if ($DryRun) { "Would run: $cmd"; return }
Write-Host "E2E: $cmd"
Invoke-Expression $cmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
