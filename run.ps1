# run.ps1 - start/stop/status for free-router (zero-dep, Node-only)
# NOTE: keep this file pure ASCII. PS 5.1 misreads UTF-8 smart chars as quotes.
param(
  [switch]$Stop,
  [switch]$Status,
  [string]$BindHost = "127.0.0.1",
  [int]$Port = 4141
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root ".free-router.pid"
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Error "node not found on PATH - install Node >= 24"; exit 1 }

function Get-RouterPid {
  if (-not (Test-Path $pidFile)) { return $null }
  $p = Get-Content $pidFile -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if (-not $proc) { Remove-Item $pidFile -ErrorAction SilentlyContinue; return $null }
  return [int]$p
}

if ($Status) {
  $p = Get-RouterPid
  if ($p) { Write-Host "free-router running (pid $p)  http://$BindHost`:$Port" }
  else { Write-Host "free-router not running" }
  exit 0
}

if ($Stop) {
  $p = Get-RouterPid
  if (-not $p) { Write-Host "free-router not running"; exit 0 }
  Stop-Process -Id $p -ErrorAction SilentlyContinue
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  Write-Host "free-router stopped (pid $p)"
  exit 0
}

$p = Get-RouterPid
if ($p) { Write-Host "already running (pid $p) - use -Stop first"; exit 1 }

$proc = Start-Process -FilePath $node.Source -ArgumentList "src/index.mjs" -WorkingDirectory $root -PassThru -WindowStyle Hidden
$proc.Id | Set-Content $pidFile
Write-Host "free-router started (pid $($proc.Id))  http://$BindHost`:$Port"
Write-Host "dashboard: http://$BindHost`:$Port/   gateway key: config.json -> apiKey"
