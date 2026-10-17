<#
.SYNOPSIS
  Profiler stub (#17).
.DESCRIPTION
  Project-specific. Attach a profiler to a workload and dump hotspots.
  Edit to call your profiler (cProfile, perf, etc.). No-op until configured.
#>
param([string]$Target, [switch]$DryRun)
if ($DryRun) { "profile: configure profiler + target here"; return }
Write-Host "profile: not configured for this repo yet (Target=$Target)."
