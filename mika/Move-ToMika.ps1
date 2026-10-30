<#
.SYNOPSIS
  Copies the official T3 Code data (threads, projects, accounts, settings) into T3 Code Mika.
.DESCRIPTION
  The official install is never modified. Close the official app first so the database is consistent.
  Worktrees and project folders stay where they are; the copied database still points at them.

  Default (takeover): Mika keeps the official machine identity and port, so the phone app and
  T3 Connect keep working unchanged. Run only one of the two apps at a time.
  -Parallel: Mika gets its own identity. Pair the phone with it once (Settings > Connections),
  then both apps can run side by side and appear as two machines.
#>
param([switch]$Force, [switch]$Parallel)
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

if ($Parallel) {
  # A fresh environment id and no copied T3 Connect link, so the relay and phone see a second machine.
  Remove-Item (Join-Path $target 'environment-id') -Force -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $target 'secrets') -Filter 'cloud-*' -ErrorAction SilentlyContinue |
    Remove-Item -Force
  Set-Content $T3Mika.ModeFile 'parallel'
  Write-Host 'Modus: parallel. Handy einmal neu mit T3 Code Mika koppeln (Einstellungen > Connections).'
} else {
  Set-Content $T3Mika.ModeFile 'takeover'
  Write-Host 'Modus: Übernahme. Handy-App funktioniert wie bisher; nur eine der beiden Apps gleichzeitig starten.'
}

$head = Get-T3DatabaseHead (Join-Path $target 'statev2.sqlite')
Write-Host "Fertig. Datenbank-Stand: Migration $head. Start mit mika\Start-T3Mika.ps1 oder der Desktop-Verknüpfung."
