@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ===== 小鱼控制面板 =====
echo.
echo   简单版（侧边选功能）： http://127.0.0.1:3210/simple
echo   详细版（一页看全部）： http://127.0.0.1:3210/
echo.
echo 关闭此窗口即停止服务。
echo.
node tools\panel\server.mjs
pause
