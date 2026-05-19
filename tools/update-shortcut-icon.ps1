param(
  [string]$ShortcutPath = "$env:USERPROFILE\Desktop\浮空笔记.lnk",
  [string]$IconPath = "$PSScriptRoot\..\assets\images\app-icon.ico"
)

$ErrorActionPreference = "Stop"

$resolvedIconPath = (Resolve-Path -LiteralPath $IconPath).Path
if (-not (Test-Path -LiteralPath $ShortcutPath)) {
  throw "Shortcut not found: $ShortcutPath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.IconLocation = "$resolvedIconPath,0"
$shortcut.Save()

ie4uinit.exe -show
Write-Host "Updated shortcut icon:"
Write-Host " - Shortcut: $ShortcutPath"
Write-Host " - Icon: $resolvedIconPath"
