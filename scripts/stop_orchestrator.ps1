param(
  [switch]$RestoreOpenClawTelegram
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$orchestrator = Join-Path $root "src\openclaw_orchestrator.js"
$orchestratorFull = (Resolve-Path $orchestrator).Path

Write-Host "Stopping Telegram team orchestrator..."
$orchestrators = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -like "*$orchestratorFull*" -and
    $_.CommandLine -notlike "*--check*"
  }

if ($orchestrators) {
  $orchestrators | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host "Stopped $($orchestrators.Count) process(es)."
} else {
  Write-Host "No orchestrator process found."
}

if ($RestoreOpenClawTelegram) {
  Write-Host "Re-enabling OpenClaw built-in Telegram polling..."
  $distro = if ($env:OPENCLAW_WSL_DISTRO) { $env:OPENCLAW_WSL_DISTRO } else { "OpenClawGateway" }
  $openclaw = if ($env:OPENCLAW_BIN) { $env:OPENCLAW_BIN } else { "/home/openclaw/.openclaw/bin/openclaw" }
  $patch = '{"channels":{"telegram":{"enabled":true}},"plugins":{"entries":{"telegram":{"enabled":true}}}}'
  $patch | wsl.exe -d $distro -- $openclaw config patch --stdin
  wsl.exe -d $distro -- $openclaw gateway restart
}

Write-Host "Done."
