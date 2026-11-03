@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if exist "state\panel-guardian.off" del "state\panel-guardian.off" >nul 2>&1
echo.
echo 面板自动拉起已开启。
echo 面板没在跑的话，守护进程一分钟内会把它拉起来。
echo.
pause
