<#
.SYNOPSIS
  Performance benchmark stub (#16).
.DESCRIPTION
  Project-specific. Run a repeatable workload and report latency/throughput.
  Edit to point at your hot path. No-op until configured.
#>
param([switch]$DryRun)
if ($DryRun) { "bench: configure a repeatable workload + timing here"; return }
Write-Host "bench: not configured for this repo yet."
