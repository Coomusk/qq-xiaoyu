' bridge-hidden.vbs - start start.bat in a HIDDEN window
' Usage: wscript.exe "bridge-hidden.vbs"
'
' Why: the scheduled task "xiaoyu-bridge" used to run start.bat directly, and a
' scheduled task with a visible action pops a console window every time the
' guardian triggers it (user saw it at 2026-11-02 12:11). Wrapping it in wscript
' with Style 0 keeps the same start.bat / :loop behaviour but shows nothing.
'
' NOTE: keep this file ASCII-only. VBScript reads .vbs as ANSI; non-ASCII
' comments saved as UTF-8 corrupt the script and wscript pops an error dialog.
Option Explicit
Dim sh, fso, here, root
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
sh.CurrentDirectory = root
sh.Run "cmd.exe /c start.bat", 0, False
