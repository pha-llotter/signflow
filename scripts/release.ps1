<#
.SYNOPSIS
  Bumps the version, tags it and pushes.

.DESCRIPTION
  Refuses to release from a dirty tree or a failing test suite. A version
  number is a claim that a particular state of the code works; tagging
  something untested makes the tag worthless as a thing to roll back to.

  This file is deliberately ASCII only. Windows PowerShell reads .ps1 files as
  ANSI unless they carry a BOM, so a stray em dash or bullet decodes into
  garbage that can terminate a string early and break the parse.

.PARAMETER Part
  patch (0.1.0 -> 0.1.1), minor (-> 0.2.0) or major (-> 1.0.0).

.PARAMETER Note
  One line describing the release, used as the tag message.

.PARAMETER SkipTests
  Release without running the suites. For documentation-only changes.

.EXAMPLE
  .\scripts\release.ps1 minor -Note "Sidebar redesign"
  .\scripts\release.ps1 patch -Note "Fix field placement on touch devices"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('major', 'minor', 'patch')][string]$Part,
  [Parameter(Mandatory = $true)][string]$Note,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
Set-Location $project

if (git status --porcelain) {
  throw "Working tree has uncommitted changes. Commit them first: a tag should describe a state you can return to."
}

# --- the version must mean something ----------------------------------------
$suites = @(
  @{ name = 'smoke';        script = 'scripts/smoke.js';                args = @() },
  @{ name = 'admin-check';  script = 'scripts/admin-check.js';          args = @() },
  @{ name = 'rotation';     script = 'scripts/rotation-check.js';       args = @("$env:TEMP\release-rot") },
  @{ name = 'ui-check';     script = 'scripts/ui-check.js';             args = @("$env:TEMP\release-ui") },
  @{ name = 'mobile-check'; script = 'scripts/mobile-placer-check.js';  args = @("$env:TEMP\release-mob") }
)

if (-not $SkipTests) {
  Write-Host 'Running the suites before tagging...' -ForegroundColor Cyan
  foreach ($s in $suites) {
    Write-Host ("  {0,-14}" -f $s.name) -NoNewline
    $out = & node $s.script @($s.args) 2>&1 | Out-String
    $m = [regex]::Match($out, '(\d+) passed, 0 failed')
    if (-not $m.Success) {
      Write-Host '  FAILED' -ForegroundColor Red
      Write-Host ($out -split "`n" | Select-Object -Last 25 | Out-String)
      throw "$($s.name) did not pass. Fix it, or pass -SkipTests if you are certain."
    }
    Write-Host ("  " + $m.Value) -ForegroundColor DarkGray
  }
}

# --- bump --------------------------------------------------------------------
$pkgPath = Join-Path $project 'package.json'
$old = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
$n = $old.Split('.') | ForEach-Object { [int]$_ }

if     ($Part -eq 'major') { $new = "{0}.0.0" -f ($n[0] + 1) }
elseif ($Part -eq 'minor') { $new = "{0}.{1}.0" -f $n[0], ($n[1] + 1) }
else                       { $new = "{0}.{1}.{2}" -f $n[0], $n[1], ($n[2] + 1) }

# Edited as text rather than re-serialised, so npm's formatting and key order
# survive and the diff shows one changed line.
$raw = Get-Content $pkgPath -Raw
$pattern = '("version"\s*:\s*")[^"]+(")'
$replacement = '${1}' + $new + '${2}'
[System.IO.File]::WriteAllText($pkgPath, ($raw -replace $pattern, $replacement))

git add package.json
git commit -q -m "Release v$new - $Note"
git tag -a "v$new" -m $Note
git push -q origin main
git push -q origin "v$new"

# known-good follows a release that passed its tests, so
# `git reset --hard known-good` always lands somewhere that actually worked.
if (-not $SkipTests) {
  git tag -f known-good -m "v$new - $Note" | Out-Null
  git push -q -f origin known-good
}

Write-Host ''
Write-Host "Released v$new  (was v$old)" -ForegroundColor Green
Write-Host "  $Note"
if ($SkipTests) {
  Write-Host "  tag v$new pushed. known-good not moved: tests were skipped."
} else {
  Write-Host "  tag v$new pushed, known-good moved here"
}
