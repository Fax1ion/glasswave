# Glasswave standalone window
#
# Opens Glasswave in its own window instead of a browser window: no browser
# buttons, and the app draws its own top bar. It uses "WebView2", the Microsoft
# Edge engine that Windows already has. Microsoft's small WebView2 helper files
# are in launcher\webview2; if they are ever missing, they are downloaded again
# from nuget.org.
#
# If anything goes wrong, the details are written to launcher\standalone.log.
param([int]$Port = 8765)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$log = Join-Path $here 'standalone.log'
$sdk = Join-Path $here 'webview2'
$url = "http://127.0.0.1:$Port/"

function Log([string]$text) {
  try { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $text) -Encoding UTF8 } catch { }
}
function Stop-WithMessage([string]$text) {
  Log ('STOPPED: ' + $text)
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $more = "`n`nDetails were saved to:`n" + $log + "`n`nYou can still open Glasswave with ""Start Glasswave""."
    [void][System.Windows.Forms.MessageBox]::Show($text + $more, 'Glasswave', 'OK', 'Warning')
  } catch { }
  exit 1
}

try {
  if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 300000)) { Remove-Item -LiteralPath $log -Force }
} catch { }
Log ('---- start. PowerShell ' + $PSVersionTable.PSVersion + ', Windows ' + [Environment]::OSVersion.Version + ', 64-bit process: ' + [Environment]::Is64BitProcess)

# Only one standalone window at a time.
$isFirst = $false
$mutex = New-Object System.Threading.Mutex($true, 'Glasswave.Standalone.Window', [ref]$isFirst)
if (-not $isFirst) {
  Log 'Already open; bringing that window forward.'
  try { [void](New-Object -ComObject WScript.Shell).AppActivate('Glasswave') } catch { }
  exit 0
}

$server = $null
$splash = $null
try {
  # ---- 1. Small helpers that must be in place before any window exists -----------------------
  Add-Type -IgnoreWarnings -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace Glasswave
{
    public static class Native
    {
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern int SetCurrentProcessExplicitAppUserModelID(string id);

        private static string folder;

        public static void Prepare(string sdkFolder)
        {
            folder = sdkFolder;
            AppDomain.CurrentDomain.AssemblyResolve += Resolve;
            try { SetCurrentProcessExplicitAppUserModelID("Glasswave.Player"); } catch { }
            // Sharp text on high-resolution screens.
            try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
            catch { try { SetProcessDPIAware(); } catch { } }
        }

        private static Assembly Resolve(object sender, ResolveEventArgs args)
        {
            try
            {
                string name = new AssemblyName(args.Name).Name;
                string path = Path.Combine(folder, name + ".dll");
                if (File.Exists(path)) return Assembly.LoadFrom(path);
            }
            catch { }
            return null;
        }
    }
}
'@
  [Glasswave.Native]::Prepare($sdk)
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  # ---- 2. A small "starting" window, so something shows while the first start sets up -------
  try {
    $splash = New-Object System.Windows.Forms.Form
    $splash.Text = 'Glasswave'
    $splash.FormBorderStyle = 'None'
    $splash.StartPosition = 'CenterScreen'
    $splash.Size = New-Object System.Drawing.Size(360, 110)
    $splash.BackColor = [System.Drawing.Color]::FromArgb(14, 17, 30)
    $splash.ShowInTaskbar = $false
    $splash.TopMost = $true
    $label = New-Object System.Windows.Forms.Label
    $label.Text = 'Starting Glasswave...'
    $label.Dock = 'Fill'
    $label.TextAlign = 'MiddleCenter'
    $label.ForeColor = [System.Drawing.Color]::FromArgb(225, 230, 245)
    $label.Font = New-Object System.Drawing.Font('Segoe UI', 12)
    $splash.Controls.Add($label)
    $splash.Show()
    [System.Windows.Forms.Application]::DoEvents()
  } catch { $splash = $null }
  function Set-Splash([string]$text) {
    if ($splash) { try { $label.Text = $text; [System.Windows.Forms.Application]::DoEvents() } catch { } }
  }

  # ---- 3. Microsoft's WebView2 helper files (downloaded once) --------------------------------
  $core = Join-Path $sdk 'Microsoft.Web.WebView2.Core.dll'
  $forms = Join-Path $sdk 'Microsoft.Web.WebView2.WinForms.dll'
  $loader = Join-Path $sdk 'WebView2Loader.dll'
  if (-not ((Test-Path -LiteralPath $core) -and (Test-Path -LiteralPath $forms) -and (Test-Path -LiteralPath $loader))) {
    Set-Splash 'First start: getting a small Microsoft component...'
    Log 'WebView2 helper files not found; downloading the Microsoft.Web.WebView2 package from nuget.org'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    New-Item -ItemType Directory -Force -Path $sdk | Out-Null
    $zip = Join-Path $env:TEMP ('glasswave-webview2-' + [Guid]::NewGuid().ToString('N') + '.zip')
    $sources = @(
      'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2903.40',
      'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2'
    )
    $got = $false
    foreach ($source in $sources) {
      try {
        Invoke-WebRequest -Uri $source -OutFile $zip -UseBasicParsing -TimeoutSec 180
        if ((Test-Path -LiteralPath $zip) -and ((Get-Item -LiteralPath $zip).Length -gt 500000)) { $got = $true; Log ('Downloaded ' + $source + ' (' + (Get-Item -LiteralPath $zip).Length + ' bytes)'); break }
      } catch { Log ('Download failed from ' + $source + ': ' + $_.Exception.Message) }
    }
    if (-not $got) { throw 'Could not download the Microsoft WebView2 component. Check the internet connection and try again.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
      $arch = 'x64'
      if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' } elseif (-not [Environment]::Is64BitProcess) { $arch = 'x86' }
      $wanted = @(
        @('Microsoft.Web.WebView2.Core.dll', '^lib/net4[^/]*/Microsoft\.Web\.WebView2\.Core\.dll$'),
        @('Microsoft.Web.WebView2.WinForms.dll', '^lib/net4[^/]*/Microsoft\.Web\.WebView2\.WinForms\.dll$'),
        @('WebView2Loader.dll', ('^runtimes/win-' + $arch + '/native/WebView2Loader\.dll$'))
      )
      foreach ($pair in $wanted) {
        $pattern = $pair[1]
        $entry = $archive.Entries | Where-Object { ($_.FullName -replace '\\', '/') -match $pattern } | Sort-Object FullName | Select-Object -Last 1
        if (-not $entry) { throw ('The downloaded package did not contain ' + $pair[0]) }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $sdk $pair[0]), $true)
        Log ('Unpacked ' + $entry.FullName)
      }
    } finally {
      $archive.Dispose()
      Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    }
  }

  # ---- 4. The little helper that hands the app's files to the window -------------------------
  function Test-Port {
    try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $Port); $ok = $c.Connected; $c.Close(); return $ok } catch { return $false }
  }
  if (-not (Test-Port)) {
    $psExe = Join-Path $PSHOME 'powershell.exe'
    $serverArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $here 'launch.ps1') + '" -Port ' + $Port + ' -NoBrowser -ParentPid ' + $PID
    $server = Start-Process -FilePath $psExe -ArgumentList $serverArgs -WindowStyle Hidden -PassThru
    $tries = 0
    while (-not (Test-Port) -and $tries -lt 60) { Start-Sleep -Milliseconds 150; $tries++ }
    if (-not (Test-Port)) { throw 'The helper that serves the app files did not start.' }
    Log 'File helper started.'
  } else { Log 'File helper was already running.' }

  # ---- 5. The window itself ------------------------------------------------------------------
  Set-Splash 'Starting Glasswave...'
  $env:PATH = $sdk + ';' + $env:PATH
  [void][System.Reflection.Assembly]::LoadFrom($core)
  [void][System.Reflection.Assembly]::LoadFrom($forms)
  try { [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::SetLoaderDllFolderPath($sdk) } catch { Log ('SetLoaderDllFolderPath not used: ' + $_.Exception.Message) }
  try {
    Log ('WebView2 runtime found: ' + [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::GetAvailableBrowserVersionString($null))
  } catch {
    $why = $_.Exception
    if ($why.InnerException) { $why = $why.InnerException }
    if ($why.GetType().Name -match 'RuntimeNotFound') {
      throw ('Windows is missing the Microsoft Edge WebView2 Runtime. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and try again.')
    }
    Log ('Could not read the WebView2 runtime version (carrying on): ' + $why.Message)
  }

  # shell.cs is the window. If it will not build on this computer, the earlier version
  # (shell-fallback.cs) is used instead, so the player still opens.
  $built = $false
  foreach ($name in @('shell.cs', 'shell-fallback.cs')) {
    $source = Join-Path $here $name
    if (-not (Test-Path -LiteralPath $source)) { continue }
    try {
      Add-Type -IgnoreWarnings -TypeDefinition (Get-Content -LiteralPath $source -Raw) -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing', $core, $forms)
      Log ('Window code compiled (' + $name + ').')
      $built = $true
      break
    } catch {
      Log ('Window code in ' + $name + ' did not build: ' + $_.Exception.Message)
    }
  }
  if (-not $built) { throw 'The window code could not be built. Details are in the log.' }

  $dataDir = Join-Path $env:LOCALAPPDATA 'Glasswave\Standalone'
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  if ($splash) { try { $splash.Close(); $splash.Dispose() } catch { }; $splash = $null }
  [Glasswave.Shell]::Start($url, $dataDir, (Join-Path $root 'app\icon.ico'), $log)
  Log 'Window closed normally.'
} catch {
  $detail = $_.Exception.ToString()
  if ($_.Exception.InnerException) { $detail = $detail + "`n-- inner: " + $_.Exception.InnerException.ToString() }
  if ($_.ScriptStackTrace) { $detail = $detail + "`n-- at: " + $_.ScriptStackTrace }
  Log ('ERROR: ' + $detail)
  if ($splash) { try { $splash.Close() } catch { } }
  Stop-WithMessage ('The standalone window could not start: ' + $_.Exception.Message)
} finally {
  if ($server) { try { if (-not $server.HasExited) { $server.Kill() } } catch { } }
  try { $mutex.ReleaseMutex() } catch { }
}
