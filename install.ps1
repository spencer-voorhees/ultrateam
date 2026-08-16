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
Say "-> installing dependencies"
npm install --no-audit --no-fund --silent
Say "-> building"
npm run build --silent
Say "-> linking the ultrateam command"
npm link

Say "ultrateam installed. Next: cd your-project; ultrateam init"
if (-not (Get-Command ultrateam -ErrorAction SilentlyContinue)) {
  Write-Host "  note: reopen your terminal so 'ultrateam' is on PATH" -ForegroundColor Yellow
}
