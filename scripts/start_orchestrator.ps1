$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$orchestrator = Join-Path $root "src\openclaw_orchestrator.js"
$orchestratorFull = (Resolve-Path $orchestrator).Path

Write-Host "Disabling OpenClaw built-in Telegram polling..."
$distro = if ($env:OPENCLAW_WSL_DISTRO) { $env:OPENCLAW_WSL_DISTRO } else { "OpenClawGateway" }
$openclaw = if ($env:OPENCLAW_BIN) { $env:OPENCLAW_BIN } else { "/home/openclaw/.openclaw/bin/openclaw" }
$patch = '{"channels":{"telegram":{"enabled":false}},"plugins":{"entries":{"telegram":{"enabled":false}}}}'
$patch | wsl.exe -d $distro -- $openclaw config patch --stdin
wsl.exe -d $distro -- $openclaw gateway restart

Write-Host "Starting Telegram team orchestrator..."
$existing = Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*$orchestratorFull*" }

if ($existing) {
  Write-Host "Orchestrator already running."
} else {
  Start-Process -FilePath "node.exe" -ArgumentList "`"$orchestratorFull`"" -WorkingDirectory $root -WindowStyle Hidden
}

Write-Host "Done."
