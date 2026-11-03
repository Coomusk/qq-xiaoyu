@echo off
chcp 65001 >nul
cd /d "%~dp0"
pwsh -NoProfile -ExecutionPolicy Bypass -File "tools\restart-bridge.ps1"
pause
