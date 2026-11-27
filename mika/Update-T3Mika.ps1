<#
.SYNOPSIS
  Pulls the latest upstream T3 Code, replays every Mika branch on top and rebuilds.
.DESCRIPTION
  mika/main is regenerated each time: upstream main plus a merge of every branch in branches.txt.
  Feature branches are rebased onto upstream main so they stay ready for upstream pull requests.
  On a conflict the script stops, leaves the repo clean and names the branch; resolve it by hand
  or let an agent do it (see mika/README.md), then run the script again.
#>
param([switch]$SkipFetch, [switch]$NoBuild, [switch]$NoPush)
. "$PSScriptRoot\T3Mika.Common.ps1"
Initialize-T3MikaToolchain
Set-Location $T3Mika.Repo

if ((Test-T3MikaRunning) -and -not $NoBuild) { throw 'Bitte zuerst T3 Code Mika beenden.' }
git config rerere.enabled true
git config rerere.autoUpdate true
if (git status --porcelain) { throw 'Es gibt uncommittete Änderungen im Fork. Bitte erst committen oder verwerfen.' }

$branches = Get-Content (Join-Path $PSScriptRoot 'branches.txt') |
  ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') }

if (-not $SkipFetch) {
  git fetch -q upstream --tags
  git switch -q main
  git merge -q --ff-only upstream/main
  if ($LASTEXITCODE -ne 0) { throw 'main lässt sich nicht vorspulen. main darf keine eigenen Commits haben.' }
  if (-not $NoPush) { git push -q origin main }
}

# Conflicts between the Mika branches are resolved once and the resolutions committed to
# mika/tooling (mika/rr-cache, see mika/README.md); rerere replays them below like resolutions made
# on this machine. Read them and the catalog merge driver from the branch: the working tree may not
# hold mika/ right now, and rebases of the feature branches run without it.
$gitCommon = (Resolve-Path (git rev-parse --git-common-dir)).Path
$rrTemp = Join-Path ([IO.Path]::GetTempPath()) "t3mika-rr-$PID"
New-Item -ItemType Directory -Force $rrTemp | Out-Null
try {
  $paths = @('mika/t3mika-merge-catalog.mjs')
  if (git ls-tree --name-only mika/tooling mika/rr-cache) { $paths += 'mika/rr-cache' }
  git archive -o (Join-Path $rrTemp 'tooling.tar') mika/tooling @paths
  tar -xf (Join-Path $rrTemp 'tooling.tar') -C $rrTemp
  Copy-Item (Join-Path $rrTemp 'mika\t3mika-merge-catalog.mjs') $gitCommon -Force
  if (Test-Path (Join-Path $rrTemp 'mika\rr-cache')) {
    Get-ChildItem (Join-Path $rrTemp 'mika\rr-cache') -Directory | ForEach-Object {
      $target = Join-Path $gitCommon "rr-cache\$($_.Name)"
      if (-not (Test-Path (Join-Path $target 'postimage'))) {
        New-Item -ItemType Directory -Force $target | Out-Null
        Copy-Item (Join-Path $_.FullName '*') $target -Force
      }
    }
  }
} finally {
  Remove-Item -Recurse -Force $rrTemp -ErrorAction SilentlyContinue
}
# agentContextBudget.json holds measured byte counts that every branch adding an MCP tool changes
# on the same lines. Merges keep mika/main's side; the exact-match budget test guards upstream CI only.
git config merge.t3mika-keep.name 'keep mika/main side'
git config merge.t3mika-keep.driver true
# The translation catalogs merge key by key: branches that add strings add them on neighbouring
# lines, which a line merge reports as a conflict. git runs drivers through sh: forward slashes.
$catalogDriver = (Join-Path $gitCommon 't3mika-merge-catalog.mjs') -replace '\\', '/'
git config merge.t3mika-catalog.name 'GT catalogs, key by key'
git config merge.t3mika-catalog.driver "node '$catalogDriver' %O %A %B %P"
$attributes = Join-Path $gitCommon 'info\attributes'
foreach ($rule in @(
    'apps/server/src/provider/agentContextBudget.json merge=t3mika-keep',
    'apps/*/src/i18n/translations/*.json merge=t3mika-catalog'
  )) {
  if (-not ((Test-Path $attributes) -and (Select-String -Quiet -SimpleMatch $rule $attributes))) {
    New-Item -ItemType Directory -Force (Split-Path $attributes) | Out-Null
    Add-Content $attributes $rule
  }
}

$lockBefore = git rev-parse 'mika/main:pnpm-lock.yaml' 2>$null
$failed = @()
foreach ($branch in $branches) {
  git switch -q $branch
  # --update-refs carries stacked branches (e.g. auto-model under routine-auto) along.
  git rebase -q --update-refs main 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    git rebase --abort
    $failed += $branch
    Write-Warning "Konflikt beim Rebase von $branch auf das neue upstream main."
    continue
  }
}
if (-not $NoPush) {
  $all = git for-each-ref --format='%(refname:short)' refs/heads/mika/ | Where-Object { $_ -ne 'mika/main' }
  git push -q --force-with-lease origin @all
}
if ($failed.Count -gt 0) {
  git switch -q mika/main
  throw "Update gestoppt. Konflikte in: $($failed -join ', '). mika/main und dein Build sind unverändert."
}

# Merge in a worktree of its own with current dependencies: the commit hooks lint against
# node_modules, and the app's node_modules are only refreshed while the app is closed.
$mergeDir = Join-Path (Split-Path $T3Mika.Repo) 'wt\t3mika-merge'
if (-not (Test-Path (Join-Path $mergeDir '.git'))) {
  git worktree prune
  git worktree add -q --detach $mergeDir main
}
Push-Location $mergeDir
try {
  git merge --abort 2>$null
  git checkout -q --force --detach main
  git clean -qfd
  vp i *> $null
  foreach ($branch in $branches) {
    $lock = git rev-parse 'HEAD:pnpm-lock.yaml'
    git merge -q --no-ff $branch -m "merge: $branch"
    $merged = $LASTEXITCODE -eq 0
    # rerere replays conflict resolutions recorded on earlier updates; commit when none remain.
    if (-not $merged -and -not (git diff --name-only --diff-filter=U)) {
      # A branch that changes dependencies needs them installed before the hooked commit.
      if ($lock -ne (git rev-parse ':pnpm-lock.yaml')) { vp i *> $null }
      git add -A
      git commit -q --no-edit
      $merged = $LASTEXITCODE -eq 0
    }
    if (-not $merged) {
      git merge --abort
      throw "Die Branches vertragen sich untereinander nicht ($branch). Build unverändert."
    }
    if ($lock -ne (git rev-parse 'HEAD:pnpm-lock.yaml')) { vp i *> $null }
  }
  $result = git rev-parse HEAD
} finally {
  Pop-Location
}
git switch -q mika/main
git reset -q --hard $result
if (-not $NoPush) { git push -q --force-with-lease origin mika/main }

if ($NoBuild) { return }
if ($lockBefore -ne (git rev-parse 'mika/main:pnpm-lock.yaml')) { vp i }
vp run build:desktop
if ($LASTEXITCODE -ne 0) { throw 'Build fehlgeschlagen. Die letzte funktionierende Version: git log mika/main@{1}.' }
Write-Host "T3 Code Mika ist aktuell: $(git log -1 --format='%h %s' main)"
