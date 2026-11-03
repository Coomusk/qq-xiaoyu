@echo off
chcp 65001 >nul
cd /d "%~dp0"
:menu
node tools\status.mjs
echo.
echo   [1] 刷新    [2] 每 30 秒自动刷新（Ctrl+C 退出）    [0] 退出
choice /c 120 /n /m "选一个: "
if errorlevel 3 goto end
if errorlevel 2 ( node tools\status.mjs --watch & goto end )
if errorlevel 1 ( cls & goto menu )
:end
