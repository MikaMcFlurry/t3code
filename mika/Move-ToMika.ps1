<#
.SYNOPSIS
  Copies the official T3 Code data (threads, projects, accounts, settings) into T3 Code Mika.
.DESCRIPTION
  The official install is never modified. Close the official app first so the database is consistent.
  Worktrees and project folders stay where they are; the copied database still points at them.
#>
param([switch]$Force)
. "$PSScriptRoot\T3Mika.Common.ps1"

if (Test-T3OfficialRunning) { throw 'Bitte zuerst die offizielle T3 Code App komplett beenden (auch im Tray).' }
if (Test-T3MikaRunning) { throw 'T3 Code Mika läuft noch. Bitte zuerst beenden.' }

$target = Join-Path $T3Mika.Home 'userdata'
if ((Test-Path (Join-Path $target 'statev2.sqlite')) -and -not $Force) {
  throw "T3 Code Mika hat schon Daten in $target. Mit -Force überschreiben (vorher wird gesichert)."
}

if (Test-Path $target) {
  $backup = Join-Path $T3Mika.Backups ("mika-userdata-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Write-Host "Sichere bisherige Mika-Daten nach $backup"
  Copy-T3Directory $target $backup
}

Write-Host 'Kopiere offizielle Daten nach T3 Code Mika ...'
Copy-T3Directory (Join-Path $T3Mika.OfficialHome 'userdata') $target @('logs')

# Windows safeStorage key: without it the copied secrets cannot be decrypted.
$profile = Join-Path $T3Mika.AppData 't3code-v2'
New-Item -ItemType Directory -Force $profile | Out-Null
Copy-Item (Join-Path $T3Mika.OfficialProfile 'Local State') (Join-Path $profile 'Local State') -Force
foreach ($dir in 'Local Storage', 'IndexedDB') {
  $source = Join-Path $T3Mika.OfficialProfile $dir
  if (Test-Path $source) { Copy-T3Directory $source (Join-Path $profile $dir) }
}

$head = Get-T3DatabaseHead (Join-Path $target 'statev2.sqlite')
Write-Host "Fertig. Datenbank-Stand: Migration $head. Start mit mika\Start-T3Mika.ps1 oder der Desktop-Verknüpfung."
