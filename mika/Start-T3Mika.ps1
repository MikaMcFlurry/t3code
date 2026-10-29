<#
.SYNOPSIS
  Starts T3 Code Mika from the built checkout, isolated from the official install.
#>
. "$PSScriptRoot\T3Mika.Common.ps1"
Initialize-T3MikaToolchain

if (-not (Test-Path (Join-Path $T3Mika.Repo 'apps\desktop\dist-electron\main.cjs'))) {
  throw 'Noch nicht gebaut. Bitte mika\Update-T3Mika.ps1 -SkipFetch ausführen.'
}

$env:T3CODE_HOME = $T3Mika.Home
$env:T3CODE_DESKTOP_APP_DATA_DIR = $T3Mika.AppData
$env:T3CODE_DESKTOP_APP_USER_MODEL_ID = $T3Mika.AppUserModelId
$env:T3CODE_DISABLE_AUTO_UPDATE = '1'

Set-Location (Join-Path $T3Mika.Repo 'apps\desktop')
node scripts/start-electron.mjs
