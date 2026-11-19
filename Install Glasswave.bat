@echo off
rem Installs Glasswave as an app: builds Glasswave.exe and adds it to the Start menu,
rem so you can open it by searching "Glasswave". Run it once. Running it again repairs it.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher\install.ps1"
