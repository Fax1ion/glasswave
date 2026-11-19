# Adds a "Glasswave" shortcut with its own icon to your desktop.
$ErrorActionPreference = 'Stop'
try {
  $folder = Split-Path -Parent $PSScriptRoot
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path $desktop 'Glasswave.lnk'))
  $exe = Join-Path $folder 'Glasswave.exe'
  if (Test-Path -LiteralPath $exe) {
    # Glasswave.exe (made by "Install Glasswave"): Glasswave's own window.
    $link.TargetPath = $exe
    $link.Arguments = ''
    $link.WindowStyle = 1
  } else {
    # Otherwise the browser version.
    $link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $link.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'launch.ps1') + '"'
    $link.WindowStyle = 7
  }
  $link.WorkingDirectory = $folder
  $link.IconLocation = Join-Path $folder 'app\icon.ico'
  $link.Description = 'Glasswave music player'
  $link.Save()
  Write-Host 'Done. A Glasswave shortcut is now on your desktop.'
} catch {
  Write-Host ('Could not add the shortcut: ' + $_.Exception.Message)
}
Start-Sleep -Seconds 3
