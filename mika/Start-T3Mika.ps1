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

if ((Get-T3MikaMode) -eq 'takeover') {
  # Same identity as the official app: the phone and T3 Connect expect its port, and two
  # servers with one identity would fight over the relay tunnel.
  if (Test-T3OfficialRunning) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      'Die offizielle T3 Code App läuft noch. Bitte erst beenden (auch im Tray), dann T3 Code Mika starten.',
      'T3 Code Mika') | Out-Null
    exit 1
  }
  $env:T3CODE_PORT = "$($T3Mika.OfficialPort)"
}

Set-Location (Join-Path $T3Mika.Repo 'apps\desktop')
node scripts/start-electron.mjs
