param(
  [string]$Port = "9222",
  [string]$UserDataDir = "D:\chrome-rpa-profile",
  [string]$Url = "https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID#/?st=OAPermID"
)

$versionUrl = "http://127.0.0.1:$Port/json/version"
try {
  Invoke-RestMethod -Uri $versionUrl -TimeoutSec 2 | Out-Null
  Write-Host "Chrome CDP is already available at $versionUrl"
  exit 0
} catch {
  Write-Host "Starting Chrome with remote debugging on port $Port"
}

$chromeCandidates = @(@(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) })

if ($chromeCandidates.Count -eq 0) {
  throw "Chrome executable not found. Install Chrome or start a compatible Chromium browser manually with --remote-debugging-port=$Port."
}

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null

Start-Process -FilePath $chromeCandidates[0] -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$UserDataDir",
  "--no-first-run",
  "--disable-popup-blocking",
  $Url
)

Write-Host "Chrome started. Log in to LSEG manually, then run npm run automation:inspect."
