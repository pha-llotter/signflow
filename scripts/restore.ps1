<#
.SYNOPSIS
  Restores a SignFlow checkpoint.

.DESCRIPTION
  By default it restores to a NEW folder beside the project and leaves the
  current installation untouched, so a restore can never be the thing that
  loses your work. Use -InPlace once you have decided, and even then it takes a
  safety checkpoint of the current state first.

.PARAMETER Backup
  Path to a checkpoint .zip. Omit to list what is available.

.PARAMETER InPlace
  Overwrite the live project instead of restoring alongside it.

.EXAMPLE
  .\scripts\restore.ps1
  .\scripts\restore.ps1 -Backup ..\signflow-backups\signflow-2026-10-01-0930.zip
  .\scripts\restore.ps1 -Backup ..\signflow-backups\signflow-2026-10-01-0930.zip -InPlace
#>
[CmdletBinding()]
param(
  [string]$Backup = '',
  [switch]$InPlace
)

$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$backupRoot = Join-Path (Split-Path -Parent $project) 'signflow-backups'

# --- with no argument, just show what there is -------------------------------
if (-not $Backup) {
  if (-not (Test-Path $backupRoot)) { Write-Host "No checkpoints yet. Run .\scripts\backup.ps1"; return }
  Write-Host "Checkpoints in $backupRoot`n"
  Get-ChildItem $backupRoot -Filter *.zip | Sort-Object LastWriteTime -Descending | ForEach-Object {
    '{0,-46} {1,7:N1} MB   {2}' -f $_.Name, ($_.Length / 1MB), $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
  }
  Write-Host "`nRestore alongside the current install:"
  Write-Host '  .\scripts\restore.ps1 -Backup "<name>"'
  Write-Host 'Overwrite the current install (takes a safety checkpoint first):'
  Write-Host '  .\scripts\restore.ps1 -Backup "<name>" -InPlace'
  return
}

if (-not (Test-Path $Backup)) {
  $candidate = Join-Path $backupRoot (Split-Path -Leaf $Backup)
  if (Test-Path $candidate) { $Backup = $candidate } else { throw "No such checkpoint: $Backup" }
}
$Backup = (Resolve-Path $Backup).Path

# --- confirm the archive is intact before trusting it ------------------------
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($Backup)
# Separators are normalised because older checkpoints were written by
# Compress-Archive, which uses backslashes.
$names = $zip.Entries | ForEach-Object { $_.FullName -replace '\\', '/' }
$zip.Dispose()
if ($names -notcontains 'src/server.js') {
  throw "That archive does not look like a SignFlow checkpoint (no src/server.js)."
}
$hasDb = $names -contains 'storage/signflow.db'
if (-not $hasDb) {
  Write-Warning 'This checkpoint has no database. Restoring it gives you the code but no accounts or documents.'
}

if (-not $InPlace) {
  # --- safe path: restore beside the project ---------------------------------
  $target = Join-Path (Split-Path -Parent $project) ("signflow-restored-" + (Get-Date -Format 'yyyy-MM-dd-HHmm'))
  New-Item -ItemType Directory -Force $target | Out-Null
  Expand-Archive -Path $Backup -DestinationPath $target -Force

  Write-Host ''
  Write-Host 'Restored alongside your current install' -ForegroundColor Green
  Write-Host "  $target"
  Write-Host ''
  Write-Host 'Your live project was not touched. To use the restored copy:'
  Write-Host "  cd `"$target`""
  Write-Host '  npm install'
  Write-Host '  npm start'
  Write-Host ''
  Write-Host 'Happy with it? Swap them over, or re-run this with -InPlace.'
  return
}

# --- in-place: snapshot first, then overwrite --------------------------------
Write-Host 'Taking a safety checkpoint of the current state first...'
& (Join-Path $PSScriptRoot 'backup.ps1') -Label 'pre-restore'

$running = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*nodejs*' }
if ($running) { $running | Stop-Process -Force; Start-Sleep -Seconds 2 }

# node_modules is not in the archive and is expensive to rebuild, so it stays
# exactly where it is rather than being deleted and reinstalled.
$keep = @('node_modules')
Get-ChildItem $project -Force | Where-Object { $keep -notcontains $_.Name } | ForEach-Object {
  Remove-Item $_.FullName -Recurse -Force
}

Expand-Archive -Path $Backup -DestinationPath $project -Force

Write-Host ''
Write-Host 'Restored in place' -ForegroundColor Green
Write-Host "  $project"
Write-Host '  node_modules was left alone. If the checkpoint is from a different'
Write-Host '  set of dependencies, run: npm install'
Write-Host ''
Write-Host 'Then: npm start'
