$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$orchestrator = Join-Path $root "src\openclaw_orchestrator.js"
$orchestratorFull = (Resolve-Path $orchestrator).Path
$distro = if ($env:OPENCLAW_WSL_DISTRO) { $env:OPENCLAW_WSL_DISTRO } else { "OpenClawGateway" }
$openclaw = if ($env:OPENCLAW_BIN) { $env:OPENCLAW_BIN } else { "/home/openclaw/.openclaw/bin/openclaw" }

function Rollback-OpenClawTelegram {
  Write-Warning "Rollback: Re-enabling OpenClaw built-in Telegram polling..."
  try {
    $restorePatch = '{"channels":{"telegram":{"enabled":true}},"plugins":{"entries":{"telegram":{"enabled":true}}}}'
    $restorePatch | wsl.exe -d $distro -- $openclaw config patch --stdin
    wsl.exe -d $distro -- $openclaw gateway restart
    Write-Host "OpenClaw built-in Telegram polling restored."
  } catch {
    Write-Error "Failed during rollback: $_"
  }
}

try {
  Write-Host "Disabling OpenClaw built-in Telegram polling..."
  $patch = '{"channels":{"telegram":{"enabled":false}},"plugins":{"entries":{"telegram":{"enabled":false}}}}'
  $patch | wsl.exe -d $distro -- $openclaw config patch --stdin
  wsl.exe -d $distro -- $openclaw gateway restart

  Write-Host "Starting Telegram team orchestrator..."
  $existing = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*$orchestratorFull*" -and $_.CommandLine -notlike "*--check*" }

  if ($existing) {
    Write-Host "Orchestrator is already running (PID $($existing.ProcessId))."
  } else {
    $proc = Start-Process -FilePath "node.exe" -ArgumentList "`"$orchestratorFull`"" -WorkingDirectory $root -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    if ($proc.HasExited) {
      throw "Orchestrator process exited immediately with exit code $($proc.ExitCode). Check orchestrator.log for details."
    }
  }

  Write-Host "Done. Orchestrator started successfully."
} catch {
  Write-Error "Startup failed: $_"
  Rollback-OpenClawTelegram
  exit 1
}
