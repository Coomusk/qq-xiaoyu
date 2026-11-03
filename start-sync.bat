@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [start-sync] 先同步 DSH 端口到 config.json ...
pwsh -NoProfile -ExecutionPolicy Bypass -File "tools\sync-dsh-port.ps1"
if errorlevel 1 (
    echo [start-sync] 端口同步失败：DSH 可能没在运行。先打开 DeepSeek Harness 再双击本文件。
    pause
    exit /b 1
)
echo [start-sync] 端口已同步，启动桥接 ...
call "%~dp0start.bat"
