<#
.SYNOPSIS
  Bumps the version, tags it and pushes.

.DESCRIPTION
  Refuses to release from a dirty tree or a failing test suite. A version number
  is a claim that a particular state of the code works; tagging something
  untested makes the tag worthless as a thing to roll back to.

.PARAMETER Part
  patch (0.1.0 -> 0.1.1), minor (-> 0.2.0) or major (-> 1.0.0).

.PARAMETER Note
  One line describing the release, used as the tag message.

.PARAMETER SkipTests
  Release without running the suites. For documentation-only changes.

.EXAMPLE
  .\scripts\release.ps1 minor -Note "Invitation-only accounts and admin roles"
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
  throw "Working tree has uncommitted changes. Commit them first — a tag should describe a state you can return to."
}

# --- the version must mean something ----------------------------------------
if (-not $SkipTests) {
  Write-Host 'Running the suites before tagging...' -ForegroundColor Cyan
  foreach ($suite in @('smoke', 'admin-check', 'ui-check', 'mobile-check')) {
    Write-Host "  $suite"
    $out = & node "scripts/$($suite -replace '^smoke$','smoke' -replace '^mobile-check$','mobile-placer-check').js" 2>&1 | Out-String
    if ($out -notmatch '(\d+) passed, 0 failed') {
      Write-Host $out
      throw "$suite did not pass. Fix it, or pass -SkipTests if you are certain."
    }
    Write-Host ("    " + ([regex]::Match($out, '\d+ passed, 0 failed').Value)) -ForegroundColor DarkGray
  }
}

# --- bump --------------------------------------------------------------------
$pkgPath = Join-Path $project 'package.json'
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$old = $pkg.version
$n = $old.Split('.') | ForEach-Object { [int]$_ }

switch ($Part) {
  'major' { $new = "$($n[0] + 1).0.0" }
  'minor' { $new = "$($n[0]).$($n[1] + 1).0" }
  'patch' { $new = "$($n[0]).$($n[1]).$($n[2] + 1)" }
}

# Edited as text rather than re-serialised, so npm's formatting and key order
# survive and the diff shows one changed line.
(Get-Content $pkgPath -Raw) -replace '("version"\s*:\s*")[^"]+(")', "`${1}$new`${2}" |
  Set-Content $pkgPath -Encoding utf8 -NoNewline

git add package.json
git commit -q -m "Release v$new - $Note"
git tag -a "v$new" -m $Note
git push -q origin main
git push -q origin "v$new"

# known-good follows a release that passed its tests, so `git reset --hard
# known-good` always lands somewhere that actually worked.
if (-not $SkipTests) {
  git tag -f known-good -m "v$new - $Note" | Out-Null
  git push -q -f origin known-good
}

Write-Host ''
Write-Host "Released v$new  (was v$old)" -ForegroundColor Green
Write-Host "  $Note"
Write-Host "  tag v$new pushed$(if (-not $SkipTests) { ', known-good moved here' })"
