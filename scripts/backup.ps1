<#
.SYNOPSIS
  Takes a restorable checkpoint of the whole SignFlow installation.

.DESCRIPTION
  Writes a timestamped .zip to ..\signflow-backups — deliberately outside the
  project, so a bad restore cannot destroy the backups along with it.

  Included: all source, views, styles, scripts, brand assets, package-lock.json,
  the .env file and the storage directory (SQLite database, uploaded originals,
  sealed PDFs).

  Excluded: node_modules, which is 140 MB and rebuilt exactly from
  package-lock.json, plus the throwaway output of the test scripts.

  The server is stopped for the few seconds the copy takes and restarted after.
  SQLite keeps a write-ahead log; copying those files while they are being
  written can capture a torn database that restores to nothing.

.PARAMETER Label
  Optional note folded into the filename, e.g. "before-templates".

.EXAMPLE
  .\scripts\backup.ps1
  .\scripts\backup.ps1 -Label before-templates
#>
[CmdletBinding()]
param(
  [string]$Label = ''
)

$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$backupRoot = Join-Path (Split-Path -Parent $project) 'signflow-backups'
New-Item -ItemType Directory -Force $backupRoot | Out-Null

$stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
$safeLabel = if ($Label) { '-' + ($Label -replace '[^\w.-]+', '-') } else { '' }
$zipPath = Join-Path $backupRoot "signflow-$stamp$safeLabel.zip"

# --- pause the server so the database is copied in a consistent state --------
$running = Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*nodejs*' }
if ($running) {
  Write-Host 'Pausing the server so the database copies cleanly...'
  $running | Stop-Process -Force
  Start-Sleep -Seconds 2
}

# --- stage the files to copy -------------------------------------------------
$exclude = @('node_modules', '.secrets', 'ui-check', 'responsive-audit',
             'email-preview', 'rotation-check', 'mobile-check')

$staging = Join-Path ([System.IO.Path]::GetTempPath()) "signflow-backup-$stamp"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force $staging | Out-Null

Get-ChildItem $project -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item $_.FullName -Destination $staging -Recurse -Force
}

# --- record what this checkpoint is ------------------------------------------
$manifest = @"
SignFlow checkpoint
===================
Taken        : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')
Machine      : $env:COMPUTERNAME
Label        : $(if ($Label) { $Label } else { '(none)' })
Node         : $(node -v)

CONTAINS SECRETS. .env holds SESSION_SECRET and APP_KEY. APP_KEY decrypts the
stored SMTP password — without it that password is unrecoverable, and with it
anyone holding this zip can read it. Keep this file as protected as the server.

Also contains storage/ : the SQLite database (accounts, documents, audit
trails) and every uploaded and sealed PDF.

To restore:
  1. .\scripts\restore.ps1 -Backup "<this file>"
  2. cd into the restored folder and run:  npm install
  3. npm start

node_modules is not in this archive. It is 140 MB and npm install rebuilds it
exactly from package-lock.json.
"@
Set-Content (Join-Path $staging 'CHECKPOINT.txt') $manifest -Encoding utf8

# --- compress ----------------------------------------------------------------
# .NET rather than Compress-Archive: Windows PowerShell writes zip entries with
# backslash separators, which the ZIP spec does not allow. Windows copes, but
# other tools flatten the directories, so a checkpoint taken here could unpack
# into a single heap of files somewhere else.
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $staging, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item $staging -Recurse -Force

# --- verify the archive rather than assuming it worked -----------------------
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
# Normalise separators anyway, so this check cannot quietly pass or fail on a
# detail of whoever wrote the archive.
$names = $zip.Entries | ForEach-Object { $_.FullName -replace '\\', '/' }
$entries = $zip.Entries.Count
$zip.Dispose()

$hasDb  = $names -contains 'storage/signflow.db'
$hasEnv = $names -contains '.env'
$hasSrc = $names -contains 'src/server.js'

$sizeMb = (Get-Item $zipPath).Length / 1MB

Write-Host ''
Write-Host "Checkpoint written" -ForegroundColor Green
Write-Host "  $zipPath"
Write-Host ("  {0:N1} MB, {1} files" -f $sizeMb, $entries)
Write-Host "  source $(if ($hasSrc) { 'yes' } else { 'MISSING' })  |  database $(if ($hasDb) { 'yes' } else { 'MISSING' })  |  .env $(if ($hasEnv) { 'yes' } else { 'MISSING' })"

if (-not ($hasSrc -and $hasDb -and $hasEnv)) {
  Write-Warning 'Something expected is missing from the archive. Do not rely on this checkpoint.'
}

# --- put the server back the way it was --------------------------------------
if ($running) {
  Start-Process node -ArgumentList 'src/server.js' -WorkingDirectory $project -WindowStyle Hidden `
    -RedirectStandardOutput "$env:TEMP\signflow.log" -RedirectStandardError "$env:TEMP\signflow.err"
  Start-Sleep -Seconds 3
  Write-Host '  server restarted' -ForegroundColor DarkGray
}
