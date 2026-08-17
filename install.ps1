# ultrateam installer for Windows (PowerShell) — one line, no manual clone:
#   irm https://raw.githubusercontent.com/spencer-voorhees/ultrateam/main/install.ps1 | iex
#
# Fetches the repo, installs deps, builds, and links the `ultrateam` command.
# Re-running updates an existing install in place. Everything lives under %USERPROFILE%\.ultrateam-app.

$ErrorActionPreference = "Stop"

function Say  ($m) { Write-Host $m -ForegroundColor Cyan }
function Fail ($m) { Write-Host $m -ForegroundColor Red; exit 1 }

if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { Fail "ultrateam needs git." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "ultrateam needs Node.js 22.13+ - https://nodejs.org" }
if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { Fail "ultrateam needs npm (ships with Node.js)." }

# Node >= 22.13 (uses the built-in node:sqlite)
$parts = (node -p "process.versions.node").Split(".")
$maj = [int]$parts[0]; $min = [int]$parts[1]
if ($maj -lt 22 -or ($maj -eq 22 -and $min -lt 13)) {
  Fail "ultrateam needs Node.js 22.13+ (found $(node -v)). Please upgrade."
}

$repo = "https://github.com/spencer-voorhees/ultrateam"
$dir  = Join-Path $env:USERPROFILE ".ultrateam-app"

if (Test-Path (Join-Path $dir ".git")) {
  Say "-> updating ultrateam in $dir"
  git -C $dir pull --ff-only --quiet
} else {
  Say "-> fetching ultrateam into $dir"
  git clone --depth 1 --quiet $repo $dir
}

Set-Location $dir

# Run npm through cmd (npm.cmd), never PowerShell's npm.ps1/tsc.ps1 shims — those
# are script files subject to the execution policy and can fail with "not signed".
function Npm ($npmArgs) {
  cmd /c "npm $npmArgs"
  if ($LASTEXITCODE -ne 0) { Fail "npm $npmArgs failed (exit $LASTEXITCODE)" }
}

Say "-> installing dependencies"
Npm "install --no-audit --no-fund"
Say "-> building"
Npm "run build"
Say "-> linking the ultrateam command"
Npm "link"

# npm link generates an unsigned ultrateam.ps1 shim in npm's global prefix.
# In PowerShell, invoking 'ultrateam' resolves that .ps1 before ultrateam.cmd,
# triggering PowerShell's ExecutionPolicy ("file is not digitally signed").
# Remove ultrateam.ps1 and ensure a durable ultrateam.cmd shim exists so PowerShell
# always uses .cmd (which is not subject to script signing policies).
$npmPrefix = $null
try {
  $npmPrefix = (cmd /c "npm config get prefix").Trim()
} catch {}
if (-not $npmPrefix -and $env:APPDATA) {
  $npmPrefix = Join-Path $env:APPDATA "npm"
}

if ($npmPrefix) {
  # Remove any unsigned .ps1 shims
  $psShim = Join-Path $npmPrefix "ultrateam.ps1"
  if (Test-Path $psShim) { Remove-Item -Force $psShim -ErrorAction SilentlyContinue }
  $psShimBin = Join-Path $npmPrefix "bin\ultrateam.ps1"
  if (Test-Path $psShimBin) { Remove-Item -Force $psShimBin -ErrorAction SilentlyContinue }

  # Ensure ultrateam.cmd exists and points directly to node + dist/cli.js
  $cmdShim = Join-Path $npmPrefix "ultrateam.cmd"
  $cliJs = Join-Path $dir "dist\cli.js"
  "@echo off`r`nnode `"$cliJs`" %*" | Set-Content -Path $cmdShim -Encoding Ascii

  # Ensure npm's prefix is on the persistent User PATH and current session PATH
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) {
    [Environment]::SetEnvironmentVariable("Path", $npmPrefix, "User")
  } elseif ($userPath -notlike "*$npmPrefix*") {
    [Environment]::SetEnvironmentVariable("Path", "$npmPrefix;$userPath", "User")
  }
  if ($env:Path -notlike "*$npmPrefix*") {
    $env:Path = "$npmPrefix;$env:Path"
  }
}

# Also remove any other ultrateam.ps1 found on PATH
Get-Command ultrateam.ps1 -All -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Source -and (Test-Path $_.Source)) {
    Remove-Item -Force $_.Source -ErrorAction SilentlyContinue
  }
}

Say "ultrateam installed. Next: cd your-project; ultrateam init"
if (-not (Get-Command ultrateam -ErrorAction SilentlyContinue)) {
  Write-Host "  note: reopen your terminal so 'ultrateam' is on PATH" -ForegroundColor Yellow
}

