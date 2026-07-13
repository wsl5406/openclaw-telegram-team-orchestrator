$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$patterns = @(
  @{ Name = "telegram-token"; Regex = "\b\d{8,12}:[A-Za-z0-9_-]{25,}\b" },
  @{ Name = "openai-key"; Regex = "\bsk-[A-Za-z0-9_-]{20,}\b" },
  @{ Name = "anthropic-key"; Regex = "\bsk-ant-[A-Za-z0-9_-]{20,}\b" },
  @{ Name = "google-key"; Regex = "\bAIza[A-Za-z0-9_-]{20,}\b" },
  @{ Name = "github-token"; Regex = "\bgh[pousr]_[A-Za-z0-9_]{20,}\b" },
  @{ Name = "bearer-token"; Regex = "Bearer\s+[A-Za-z0-9._-]{20,}" },
  @{ Name = "private-key"; Regex = "BEGIN (RSA |OPENSSH |EC |)PRIVATE KEY" }
)

$skipParts = @(
  "\node_modules\",
  "\.git\",
  "\venv\",
  "\__pycache__\",
  "\chrome_user_data\"
)

$files = Get-ChildItem -LiteralPath $root -Recurse -Force -File |
  Where-Object {
    $full = $_.FullName
    -not ($skipParts | Where-Object { $full -like "*$_*" })
  }

$hits = New-Object System.Collections.Generic.List[object]

foreach ($file in $files) {
  $text = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($null -eq $text) { continue }
  foreach ($pattern in $patterns) {
    $matches = [regex]::Matches($text, $pattern.Regex)
    foreach ($match in $matches) {
      $line = ($text.Substring(0, $match.Index).Split("`n")).Count
      $hits.Add([pscustomobject]@{
        Type = $pattern.Name
        File = $file.FullName.Substring($root.Path.Length + 1)
        Line = $line
      })
    }
  }
}

Write-Host "Scanned $($files.Count) files."

if ($hits.Count -gt 0) {
  $hits | Format-Table -AutoSize
  throw "Secret scan failed: $($hits.Count) potential secret(s) found."
}

Write-Host "Secret scan passed: 0 potential secrets found."
