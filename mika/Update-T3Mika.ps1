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

git switch -q -C mika/main main
foreach ($branch in $branches) {
  git merge -q --no-ff $branch -m "merge: $branch"
  # rerere replays conflict resolutions recorded on earlier updates; commit when none remain.
  if ($LASTEXITCODE -ne 0 -and -not (git diff --name-only --diff-filter=U)) {
    git add -A
    git commit -q --no-edit
  }
  if ($LASTEXITCODE -ne 0) {
    git merge --abort
    git switch -q main
    throw "Die Branches vertragen sich untereinander nicht ($branch). Build unverändert."
  }
}
if (-not $NoPush) { git push -q --force-with-lease origin mika/main }

if ($NoBuild) { return }
if ($lockBefore -ne (git rev-parse 'mika/main:pnpm-lock.yaml')) { vp i }
vp run build:desktop
if ($LASTEXITCODE -ne 0) { throw 'Build fehlgeschlagen. Die letzte funktionierende Version: git log mika/main@{1}.' }
Write-Host "T3 Code Mika ist aktuell: $(git log -1 --format='%h %s' main)"
