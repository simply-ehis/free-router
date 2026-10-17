<#
.SYNOPSIS
  Run the app for a real smoke test (not just unit tests).
.DESCRIPTION
  Starts the Node dev server (src/index.mjs, port 4141). Used by the "run the
  app" rule (#3) before declaring a feature done.
  Keep this file pure ASCII (PS 5.1 UTF-8 gotcha in AGENT_FEEDBACK.md).
#>
param([switch]$DryRun)

$cmd = 'node src/index.mjs'
if ($DryRun) { "Would run: $cmd"; return }
Write-Host "Running: $cmd"
Invoke-Expression $cmd
