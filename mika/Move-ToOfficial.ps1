<#
.SYNOPSIS
  Brings work done in T3 Code Mika back to the official T3 Code install.
.DESCRIPTION
  Refuses when the Mika database has migrations the installed official version does not know,
  because an older build would run on an unknown schema. Update the official app first in that case.
  The current official data is backed up to D: before it is replaced.
#>
param([switch]$WhatIf)
. "$PSScriptRoot\T3Mika.Common.ps1"

if (Test-T3OfficialRunning) { throw 'Bitte zuerst die offizielle T3 Code App komplett beenden.' }
if (Test-T3MikaRunning) { throw 'Bitte zuerst T3 Code Mika beenden.' }

$source = Join-Path $T3Mika.Home 'userdata'
$target = Join-Path $T3Mika.OfficialHome 'userdata'
if (-not (Test-Path (Join-Path $source 'statev2.sqlite'))) { throw 'T3 Code Mika hat noch keine Daten.' }

$version = Get-T3OfficialVersion
if (-not $version) { throw 'Offizielle T3 Code Installation nicht gefunden.' }
git -C $T3Mika.Repo fetch -q upstream --tags
$officialHead = Get-T3MigrationHead "v$version"
$mikaHead = Get-T3DatabaseHead (Join-Path $source 'statev2.sqlite')
Write-Host "Offiziell v$version kennt Migration bis $officialHead, Mika-Datenbank steht auf $mikaHead."
if ($mikaHead -gt $officialHead) {
  throw "Die offizielle Version ist zu alt für diese Daten. Bitte offizielle T3 Code App zuerst aktualisieren (oder Nightly nutzen) und erneut ausführen."
}
if ($WhatIf) { Write-Host 'Prüfung ok, es wurde nichts kopiert (-WhatIf).'; return }

$backup = Join-Path $T3Mika.Backups ("official-userdata-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Host "Sichere offizielle Daten nach $backup"
Copy-T3Directory $target $backup

Write-Host 'Übertrage Mika-Daten zur offiziellen Version ...'
# In parallel mode Mika has its own identity; the official app keeps its own and its phone link.
$keepIdentity = if ((Get-T3MikaMode) -eq 'parallel') { @('environment-id', 'cloud-*') } else { @() }
Copy-T3Directory $source $target @('logs') $keepIdentity
Write-Host 'Fertig. Die offizielle T3 Code App kann wieder gestartet werden.'
