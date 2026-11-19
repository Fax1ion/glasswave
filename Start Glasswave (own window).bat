@echo off
rem Opens Glasswave in its own window: no browser buttons, and the app draws the top bar itself.
rem Uses Glasswave.exe when "Install Glasswave" has made it; otherwise the older PowerShell way.
rem If it cannot start, a message explains why and "Start Glasswave" still works.
if not exist "%~dp0Glasswave.exe" goto older
if not exist "%~dp0launcher\webview2\WebView2Loader.dll" goto older
start "" "%~dp0Glasswave.exe"
exit /b
:older
start "" /min powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher\standalone.ps1"
