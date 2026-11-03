' panel-hidden.vbs - start the local panel (tools\panel\server.mjs) with no console window.
' Used by tools\guardian.ps1 when 3210 is not listening.
' Keep this file ASCII-only: VBScript reads .vbs as ANSI, non-ASCII in UTF-8 breaks it.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
sh.Run "cmd.exe /c node tools\panel\server.mjs", 0, False
