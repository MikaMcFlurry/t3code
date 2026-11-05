<#
.SYNOPSIS
  Updates T3 Code Mika only while nothing is running, then starts it again.
.DESCRIPTION
  Meant for the scheduled task "T3 Mika Safe Update" (see -Register). Each run:
  1. checks whether upstream or a Mika branch moved since the last build; if not, it stops;
  2. counts running turns in D:\T3-Mika\home (running-turns.cjs); if any, it stops and the task
     tries again later, so no run is interrupted;
  3. closes T3 Code Mika, runs Update-T3Mika.ps1 and starts T3 Code Mika again. If the update
     fails, the last working mika/main is rebuilt so the app always comes back.
  Log: D:\T3-Mika\logs\safe-update.log
.PARAMETER Register
  Registers the scheduled task: nightly from 03:30, retrying every 30 minutes until 07:30.
.PARAMETER Force
  Updates even when nothing changed upstream (still waits for idle).
#>
param([switch]$Register, [switch]$Force)
. "$PSScriptRoot\T3Mika.Common.ps1"

$logDir = Join-Path $T3Mika.Root 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'safe-update.log'
function Write-Log([string]$Message) {
  "[{0}] {1}" -f (Get-Date -Format s), $Message | Add-Content -Path $log -Encoding utf8
}

if ($Register) {
  $pwsh = (Get-Command pwsh).Source
  $action = New-ScheduledTaskAction -Execute $pwsh -WorkingDirectory $T3Mika.Repo `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $trigger = New-ScheduledTaskTrigger -Daily -At '03:30'
  $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '03:30' `
      -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 4)).Repetition
  # Interactive, so the restarted app opens on the desktop.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName 'T3 Mika Safe Update' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host 'Geplanter Task "T3 Mika Safe Update" registriert (täglich ab 03:30, alle 30 min bis 07:30).'
  return
}

$mutex = New-Object System.Threading.Mutex($false, 'Global\T3MikaSafeUpdate')
if (-not $mutex.WaitOne(0)) { return }
$closedByUpdate = $false
try {
  Initialize-T3MikaToolchain
  Set-Location $T3Mika.Repo
  $stateFile = Join-Path $T3Mika.Root 'last-built.txt'

  git fetch -q upstream
  $upstream = git rev-parse upstream/main
  $main = git rev-parse main
  $current = git rev-parse mika/main
  $lastBuilt = if (Test-Path $stateFile) { (Get-Content $stateFile -Raw).Trim() } else { '' }
  if (-not $Force -and $upstream -eq $main -and $current -eq $lastBuilt) { return }

  $database = Join-Path $T3Mika.Home 'userdata\statev2.sqlite'
  $turns = node (Join-Path $PSScriptRoot 'running-turns.cjs') $database 2>$null
  if ("$turns".Trim() -ne '0') { Write-Log "warte: $turns laufende Turns"; return }

  Write-Log "Update startet (upstream $($upstream.Substring(0,10)), mika/main $($current.Substring(0,10)))"
  $mikaProcesses = Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($T3Mika.Repo) }
  $mikaProcesses | ForEach-Object { [void]$_.CloseMainWindow() }
  $deadline = (Get-Date).AddSeconds(45)
  while ((Test-T3MikaRunning) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  if (Test-T3MikaRunning) {
    Get-Process electron -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($T3Mika.Repo) } | Stop-Process -Force
    Start-Sleep -Seconds 3
  }
  $closedByUpdate = $true
  Write-Log 'T3 Code Mika geschlossen'

  $before = git rev-parse mika/main
  try {
    & (Join-Path $PSScriptRoot 'Update-T3Mika.ps1') *>> $log
    git rev-parse mika/main | Set-Content $stateFile
    Write-Log "Update fertig: mika/main $((git rev-parse mika/main).Substring(0,10))"
  } catch {
    Write-Log "FEHLER beim Update: $_ -> baue letzten funktionierenden Stand $($before.Substring(0,10))"
    git rebase --abort 2>$null; git merge --abort 2>$null
    git switch -q mika/main 2>$null
    git reset -q --hard $before
    vp run build:desktop *>> $log
  }
} finally {
  # Only reopen the app this run closed; a user who quit it on purpose keeps it closed.
  if ($closedByUpdate -and -not (Test-T3MikaRunning)) {
    Start-Process (Get-Command pwsh).Source -WindowStyle Hidden -WorkingDirectory $T3Mika.Repo `
      -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\Start-T3Mika.ps1`""
    Write-Log 'T3 Code Mika gestartet'
  }
  $mutex.ReleaseMutex()
}
