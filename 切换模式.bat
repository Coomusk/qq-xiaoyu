@echo off
chcp 65001 >nul
cd /d "%~dp0"
:menu
echo.
echo ===== 小鱼模式切换 =====
pwsh -NoProfile -ExecutionPolicy Bypass -File "tools\switch-mode.ps1"
echo.
echo   1 = 群友模式（群里自动接话）
echo   2 = 手机遥控（只回你私聊，完整工具，群里不说话）
echo   3 = 普通聊天模式
echo   0 = 退出
echo.
choice /c 1230 /n /m "选一个 (1/2/3/0): "
if errorlevel 4 goto end
if errorlevel 3 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "tools\switch-mode.ps1" chat
    goto menu
)
if errorlevel 2 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "tools\switch-mode.ps1" closed-agent
    goto menu
)
if errorlevel 1 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "tools\switch-mode.ps1" reserved2
    goto menu
)
:end
