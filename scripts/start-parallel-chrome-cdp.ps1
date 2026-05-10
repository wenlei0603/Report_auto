param(
  [string]$PortA = "9222",
  [string]$PortB = "9223",
  [string]$UserDataDirA = "D:\chrome-rpa-profile-account-a",
  [string]$UserDataDirB = "D:\chrome-rpa-profile-account-b",
  [string]$Url = "https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID#/?st=OAPermID"
)

$DotEnv = @{}
$DotEnvPath = Join-Path (Get-Location) ".env"
if (Test-Path -LiteralPath $DotEnvPath) {
  Get-Content -LiteralPath $DotEnvPath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      return
    }
    $separator = $line.IndexOf("=")
    $key = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim().Trim('"').Trim("'")
    $DotEnv[$key] = $value
  }
}

function Get-LocalSetting {
  param(
    [string]$Name,
    [string]$Default = ""
  )

  $processValue = [Environment]::GetEnvironmentVariable($Name)
  if ($processValue) {
    return $processValue
  }
  if ($DotEnv.ContainsKey($Name)) {
    return $DotEnv[$Name]
  }
  return $Default
}

function Get-PortFromEndpoint {
  param(
    [string]$Endpoint,
    [string]$DefaultPort
  )

  if (-not $Endpoint) {
    return $DefaultPort
  }
  try {
    $uri = [Uri]$Endpoint
    if ($uri.Port -gt 0) {
      return [string]$uri.Port
    }
  } catch {
    throw "Invalid CDP endpoint in .env: $Endpoint"
  }
  return $DefaultPort
}

function Start-CdpChrome {
  param(
    [string]$Port,
    [string]$UserDataDir,
    [string]$Url
  )

  $versionUrl = "http://127.0.0.1:$Port/json/version"
  try {
    Invoke-RestMethod -Uri $versionUrl -TimeoutSec 2 | Out-Null
    Write-Host "Chrome CDP is already available at $versionUrl"
    return
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
}

$accounts = @()
for ($i = 1; $i -le 20; $i++) {
  $id = Get-LocalSetting -Name "LSEG_ACCOUNT_${i}_ID"
  $endpoint = Get-LocalSetting -Name "LSEG_ACCOUNT_${i}_CDP_ENDPOINT"
  $profileDir = Get-LocalSetting -Name "LSEG_ACCOUNT_${i}_PROFILE_DIR"
  if ($id -or $endpoint -or $profileDir) {
    if (-not $endpoint) {
      throw "Missing LSEG_ACCOUNT_${i}_CDP_ENDPOINT in .env"
    }
    if (-not $profileDir) {
      throw "Missing LSEG_ACCOUNT_${i}_PROFILE_DIR in .env"
    }
    $accounts += [PSCustomObject]@{
      Id = $(if ($id) { $id } else { "account_$i" })
      Port = Get-PortFromEndpoint -Endpoint $endpoint -DefaultPort ""
      UserDataDir = $profileDir
    }
  }
}

if ($accounts.Count -eq 0) {
  $accounts = @(
    [PSCustomObject]@{ Id = "account_a"; Port = $PortA; UserDataDir = $UserDataDirA },
    [PSCustomObject]@{ Id = "account_b"; Port = $PortB; UserDataDir = $UserDataDirB }
  )
}

$seenProfiles = @{}
$seenPorts = @{}
foreach ($account in $accounts) {
  if ($seenProfiles.ContainsKey($account.UserDataDir)) {
    throw "Duplicate Chrome profile directory: $($account.UserDataDir)"
  }
  if ($seenPorts.ContainsKey($account.Port)) {
    throw "Duplicate Chrome CDP port: $($account.Port)"
  }
  $seenProfiles[$account.UserDataDir] = $true
  $seenPorts[$account.Port] = $true
  Write-Host "Account $($account.Id): profile $($account.UserDataDir), CDP port $($account.Port)"
  Start-CdpChrome -Port $account.Port -UserDataDir $account.UserDataDir -Url $Url
}

Write-Host "Parallel Chrome windows started. Log in to each LSEG account manually, then run:"
Write-Host "  npm run automation:parallel:preflight"
Write-Host "  npm run automation:parallel:dry-run -- --max-tasks 5"
Write-Host "  npm run automation:parallel -- --max-downloads 0"
