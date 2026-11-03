' hidden-launch.vbs - start the bridge in a hidden window
' Usage: wscript.exe "hidden-launch.vbs" "<project-root>"
' Style 0 = hidden window, False = do not wait.
' When invoked through WMI the parent is WmiPrvSE, so the process is detached
' from the caller and survives a DSH restart.
' NOTE: keep this file ASCII-only. VBScript reads .vbs as ANSI; non-ASCII
' comments saved as UTF-8 corrupt the script and wscript pops an error dialog.
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 1 Then WScript.Quit 1
sh.CurrentDirectory = WScript.Arguments(0)
sh.Run "cmd.exe /c start.bat", 0, False
