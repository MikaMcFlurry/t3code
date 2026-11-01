# Creates a "T3 Code Mika" shortcut on the desktop and in the start menu.
. "$PSScriptRoot\T3Mika.Common.ps1"

$shell = New-Object -ComObject WScript.Shell
# The nightly icon keeps the fork visually apart from the official app.
$icon = Join-Path $T3Mika.Repo 'assets\nightly\nightly-windows.ico'
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'T3 Code Mika.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'T3 Code Mika.lnk')
)
foreach ($path in $targets) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = (Get-Command pwsh).Source
  $link.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\Start-T3Mika.ps1`""
  $link.WorkingDirectory = $T3Mika.Repo
  if (Test-Path $icon) { $link.IconLocation = $icon }
  $link.Save()
  Write-Host "Verknüpfung: $path"
}
