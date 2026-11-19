# Installs Glasswave as an app on this computer:
#   1. builds Glasswave.exe (in the Glasswave folder) with the C# compiler that is part of
#      Windows, so nothing is downloaded
#   2. adds "Glasswave" to the Start menu, which is what Windows search finds
#   3. opens Glasswave
# Run it again any time to rebuild Glasswave.exe or repair the Start menu entry.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$log = Join-Path $here 'standalone.log'

function Log([string]$text) {
  try { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  install: ' + $text) -Encoding UTF8 } catch { }
}
Add-Type -AssemblyName System.Windows.Forms
function Say([string]$text, [System.Windows.Forms.MessageBoxIcon]$kind) {
  [void][System.Windows.Forms.MessageBox]::Show($text, 'Glasswave', [System.Windows.Forms.MessageBoxButtons]::OK, $kind)
}

try {
  Log ('---- installing. PowerShell ' + $PSVersionTable.PSVersion + ', Windows ' + [Environment]::OSVersion.Version)
  $source = Join-Path $here 'Glasswave.cs'
  $icon = Join-Path $root 'app\icon.ico'
  $exe = Join-Path $root 'Glasswave.exe'
  $next = Join-Path $root 'Glasswave.next.exe'
  $old = Join-Path $root 'Glasswave.old.exe'
  if (-not (Test-Path -LiteralPath $source)) { throw 'launcher\Glasswave.cs is missing.' }
  if (Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Force }

  # 1. Build Glasswave.exe (first with its icon and its "made for Windows 10/11" note;
  #    a plain build if either of those is the problem).
  $manifest = Join-Path $here 'Glasswave.manifest'
  $problem = $null
  foreach ($withIcon in @($true, $false)) {
    $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
    $params = New-Object System.CodeDom.Compiler.CompilerParameters
    $params.GenerateExecutable = $true
    $params.GenerateInMemory = $false
    $params.IncludeDebugInformation = $false
    $params.OutputAssembly = $next
    foreach ($name in @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll')) { [void]$params.ReferencedAssemblies.Add($name) }
    $options = '/target:winexe /platform:anycpu /optimize+'
    if ($withIcon -and (Test-Path -LiteralPath $icon)) { $options = $options + ' /win32icon:"' + $icon + '"' }
    if ($withIcon -and (Test-Path -LiteralPath $manifest)) { $options = $options + ' /win32manifest:"' + $manifest + '"' }
    $params.CompilerOptions = $options
    $result = $provider.CompileAssemblyFromFile($params, [string[]]@($source))
    try { $params.TempFiles.Delete() } catch { }
    $provider.Dispose()
    $errors = @($result.Errors | Where-Object { -not $_.IsWarning })
    if ($errors.Count -eq 0 -and (Test-Path -LiteralPath $next)) { $problem = $null; break }
    $problem = (($errors | Select-Object -First 12 | ForEach-Object { $_.ToString() }) -join "`n")
    if (-not $problem) { $problem = 'The compiler made no program.' }
    Log ('Build ' + $(if ($withIcon) { 'with' } else { 'without' }) + ' icon and note failed: ' + $problem)
  }
  if ($problem) { throw ('Glasswave.exe could not be built.' + "`n" + $problem) }

  # A running Glasswave.exe can be renamed but not overwritten.
  if (Test-Path -LiteralPath $exe) {
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
    Move-Item -LiteralPath $exe -Destination $old -Force
  }
  Move-Item -LiteralPath $next -Destination $exe -Force
  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
  Log ('Glasswave.exe built: ' + $exe)

  # 2. The Start menu entry. Glasswave.exe writes it itself, with the app ID its window uses,
  #    so pinning the open window to the taskbar pins Glasswave properly.
  $add = Start-Process -FilePath $exe -ArgumentList '--add-to-start-menu' -Wait -PassThru
  $inMenu = ($add.ExitCode -eq 0)
  if (-not $inMenu) { Log 'Glasswave.exe could not add the Start menu entry.' }

  # 3. Done.
  if ($inMenu) {
    Say ("Glasswave is installed.`n`nFrom now on, press the Windows key and type ""Glasswave"" to open it. In the Start menu you can also right-click it to pin it to Start or to the taskbar.`n`nPress OK to open Glasswave now.") ([System.Windows.Forms.MessageBoxIcon]::Information)
  } else {
    Say ("Glasswave.exe is ready in your Glasswave folder, but it could not be added to the Start menu. Details are in:`n" + $log + "`n`nPress OK to open Glasswave now.") ([System.Windows.Forms.MessageBoxIcon]::Warning)
  }
  Start-Process -FilePath $exe
  Log 'Installed.'
} catch {
  Log ('ERROR: ' + $_.Exception.ToString())
  Say ('Glasswave could not be installed: ' + $_.Exception.Message + "`n`nDetails were saved to:`n" + $log + "`n`n""Start Glasswave (own window)"" still works.") ([System.Windows.Forms.MessageBoxIcon]::Warning)
  exit 1
}
