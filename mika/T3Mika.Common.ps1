# Shared paths and helpers for the T3 Code Mika fork scripts.
$ErrorActionPreference = 'Stop'

$T3Mika = [ordered]@{
  Repo            = Split-Path -Parent $PSScriptRoot
  Root            = 'D:\T3-Mika'
  Home            = 'D:\T3-Mika\home'
  AppData         = 'D:\T3-Mika\appdata'
  Backups         = 'D:\T3-Mika\backups'
  Temp            = 'D:\T3-Dev\_cache\tmp'
  VpEnv           = 'D:\T3-Dev\_tools\vite-plus\env.ps1'
  OfficialHome    = Join-Path $env:USERPROFILE '.t3'
  OfficialProfile = Join-Path $env:APPDATA 't3code-v2'
  OfficialExe     = Join-Path $env:LOCALAPPDATA 'Programs\t3code\T3 Code (Beta).exe'
  AppUserModelId  = 'com.mikamcflurry.t3code.mika'
}

function Initialize-T3MikaToolchain {
  . $T3Mika.VpEnv
  New-Item -ItemType Directory -Force $T3Mika.Temp | Out-Null
  $env:TEMP = $T3Mika.Temp
  $env:TMP = $T3Mika.Temp
}

function Test-T3OfficialRunning {
  [bool](Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $T3Mika.OfficialExe })
}

function Test-T3MikaRunning {
  # The fork runs electron.exe from the repo checkout.
  $repo = $T3Mika.Repo
  [bool](Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($repo) })
}

# Highest DB migration a build knows, read from its Migrations.ts manifest.
function Get-T3MigrationHead([string]$GitRef) {
  $source = git -C $T3Mika.Repo show "${GitRef}:apps/server/src/persistence/Migrations.ts"
  if ($LASTEXITCODE -ne 0) { throw "Migrations.ts not found at $GitRef" }
  ($source | Select-String '^\s*\[(\d+),' | ForEach-Object { [int]$_.Matches[0].Groups[1].Value } |
    Measure-Object -Maximum).Maximum
}

# Highest migration recorded in a state database (read-only).
function Get-T3DatabaseHead([string]$DatabasePath) {
  if (-not (Test-Path $DatabasePath)) { return 0 }
  Initialize-T3MikaToolchain
  $script = "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare('select max(migration_id) m from effect_sql_migrations').get();console.log(r.m??0)"
  [int](node -e $script $DatabasePath)
}

function Get-T3OfficialVersion {
  if (-not (Test-Path $T3Mika.OfficialExe)) { return $null }
  (Get-Item $T3Mika.OfficialExe).VersionInfo.ProductVersion -replace '\.0$', ''
}

# Mirror a directory; robocopy exit codes below 8 mean success.
function Copy-T3Directory([string]$From, [string]$To, [string[]]$ExcludeDirs = @()) {
  $robo = @($From, $To, '/MIR', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH')
  if ($ExcludeDirs.Count -gt 0) { $robo += '/XD'; $robo += $ExcludeDirs }
  robocopy @robo | Out-Host
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $From -> $To" }
  $global:LASTEXITCODE = 0
}
