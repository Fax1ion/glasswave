@echo off
rem Opens Glasswave. A tiny helper hands the app files to your browser, then switches itself off.
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher\launch.ps1"
