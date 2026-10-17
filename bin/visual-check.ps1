<#
.SYNOPSIS
  Visual regression check stub (#15).
.DESCRIPTION
  Project-specific. Capture or compare screenshots for UI changes.
  Edit to call your screenshot tool / diff engine. No-op until configured.
#>
param([switch]$Baseline, [switch]$DryRun)
if ($DryRun) { "visual-check: configure screenshot capture + diff here"; return }
Write-Host "visual-check: not configured for this repo yet."
