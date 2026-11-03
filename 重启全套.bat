@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在重启 DeepSeek Harness 和桥接，约 40 秒，别关这个窗口 ...
pwsh -NoProfile -ExecutionPolicy Bypass -File "tools\restart-all.ps1"
echo.
echo 完成后这个窗口可以关掉。
pause
