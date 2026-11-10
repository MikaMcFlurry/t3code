<#
.SYNOPSIS
  Updates T3 Code Mika only while nothing is running, then starts it again.
.DESCRIPTION
  Meant for the scheduled task "T3 Mika Safe Update" (see -Register). Each run:
  1. checks whether upstream or a Mika branch moved since the last build; if not, it stops;
  2. when upstream moved, rebases the branches and regenerates mika/main (Update-T3Mika.ps1
     -NoBuild) while the app keeps running. On a conflict the app stays open, UPDATE-KONFLIKT.txt
     names the branches, and the same upstream is not tried again until it moves or the conflict is
     resolved;
  3. counts running or queued runs in D:\T3-Mika\home (t3mika-idle.cjs); if any, it tries again
     later. From the update window's start (06:00; set it in D:\T3-Mika\update-fenster.txt as HH:mm,
     or "aus" to never force) it waits up to 10 more minutes, then updates anyway: T3 continues the
     interrupted threads after the restart. With "continue threads after a server update" off in
     the settings it never forces;
  4. closes T3 Code Mika, builds, and starts it again. A failed build rebuilds the last working
     mika/main.
  Log: D:\T3-Mika\logs\safe-update.log
.PARAMETER Register
  Registers the scheduled task: nightly from 03:30, retrying every 30 minutes until 07:30.
.PARAMETER Force
  Updates even when nothing changed upstream (still waits for idle).
.PARAMETER IgnoreThread
  Thread ids whose runs don't block the update, e.g. the agent thread that asked for it. The
  restart still interrupts that thread's turn.
#>
param([switch]$Register, [switch]$Force, [string[]]$IgnoreThread = @())
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

  # A conflict needs a person or an agent; don't retry the same upstream every 30 minutes.
  $failedFile = Join-Path $T3Mika.Root 'update-failed-upstream.txt'
  $noteFile = Join-Path $T3Mika.Root 'UPDATE-KONFLIKT.txt'
  $failedUpstream = if (Test-Path $failedFile) { (Get-Content $failedFile -Raw).Trim() } else { '' }
  if (-not $Force -and $upstream -eq $failedUpstream) { return }

  $database = Join-Path $T3Mika.Home 'userdata\statev2.sqlite'
  $ignored = $IgnoreThread -join ','
  $idle = { "$(node (Join-Path $PSScriptRoot 't3mika-idle.cjs') $database $ignored 2>$null)".Trim() }

  # Rebase and regenerate mika/main while the app keeps running: it runs from build output,
  # which git leaves alone. Only once per upstream, so a busy night doesn't make new merge
  # commits (and new builds on the iMacs) every 30 minutes.
  $before = $current
  if ($Force -or $upstream -ne $main) {
    Write-Log "Vorbereitung (upstream $($upstream.Substring(0,10)), mika/main $($current.Substring(0,10)))"
    try {
      & (Join-Path $PSScriptRoot 'Update-T3Mika.ps1') -NoBuild *>> $log
    } catch {
      Set-Content $failedFile $upstream
      Set-Content $noteFile ("$(Get-Date -Format s): Update auf upstream $($upstream.Substring(0,10)) gestoppt, " +
        "T3 Code Mika laeuft unveraendert weiter. $_ Konflikte loesen (Agent oder von Hand), " +
        "dann mika\Update-T3Mika.ps1 ausfuehren oder diese Datei und update-failed-upstream.txt loeschen.")
      Write-Log "Konflikt, App bleibt offen: $_"
      return
    }
    Remove-Item $failedFile, $noteFile -ErrorAction SilentlyContinue
  }
  $after = git rev-parse mika/main
  if (-not $Force -and $after -eq $lastBuilt) { return }

  $turns = & $idle
  if ($turns -ne '0') {
    $windowFile = Join-Path $T3Mika.Root 'update-fenster.txt'
    $window = if (Test-Path $windowFile) { (Get-Content $windowFile -Raw).Trim() } else { '06:00' }
    $now = Get-Date
    $forceAt = $null
    if ($window -match '^\d{1,2}:\d{2}$') {
      $forceAt = [datetime]::ParseExact($window.PadLeft(5, '0'), 'HH:mm', $null)
    }
    # The task repeats until 07:30; a forced restart later than that would hit the working day.
    $inWindow = $null -ne $forceAt -and $now -ge $forceAt -and $now -lt $forceAt.Date.AddHours(8)
    $settingsFile = Join-Path $T3Mika.Home 'userdata\settings.json'
    $continues = $true
    if (Test-Path $settingsFile) {
      try {
        $continues = (Get-Content $settingsFile -Raw | ConvertFrom-Json).continueThreadsAfterServerUpdate -ne $false
      } catch { $continues = $true }
    }
    if (-not $inWindow -or -not $continues) {
      Write-Log "warte: $turns laufende oder wartende Laeufe (neuer Stand $($after.Substring(0,10)) bereit)"
      return
    }
    # Give a turn that is about to end the chance to finish on its own.
    $deadline = (Get-Date).AddMinutes(10)
    while ((& $idle) -ne '0' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 20 }
    $turns = & $idle
    if ($turns -ne '0') {
      Write-Log "Update-Fenster ab ${window}: $turns Laeufe werden unterbrochen und nach dem Neustart fortgesetzt"
    }
  }

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

  # Install while the app is closed: its electron.exe lives in node_modules. Upstream adds or
  # bumps dependencies often, and a build on a stale node_modules fails.
  vp i *>> $log
  vp run build:desktop *>> $log
  if ($LASTEXITCODE -eq 0) {
    Set-Content $stateFile $after
    Write-Log "Update fertig: mika/main $($after.Substring(0,10))"
  } else {
    Write-Log "FEHLER beim Bauen von $($after.Substring(0,10)) -> baue letzten funktionierenden Stand $($before.Substring(0,10))"
    git switch -q mika/main 2>$null
    git reset -q --hard $before
    vp i *>> $log
    vp run build:desktop *>> $log
    Set-Content $stateFile $before
    Set-Content $failedFile $upstream
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
