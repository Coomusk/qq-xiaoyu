@echo off
chcp 65001 >nul
cd /d "%~dp0.."
> "state\panel-guardian.off" echo 面板自动拉起已关闭（本文件存在即关闭；删掉它就恢复）
echo.
echo 面板自动拉起已关闭。
echo 想彻底关面板：自己关掉那个面板窗口/进程即可，守护不会再碰它。
echo 想恢复：双击同目录下的「面板守护-开启.bat」。
echo.
pause
