' guardian-hidden.vbs - run ONE guardian round with no console window.
' Task action: wscript.exe "<repo>\tools\guardian-hidden.vbs"
' Keep this file ASCII-only: VBScript reads .vbs as ANSI, non-ASCII in UTF-8 breaks it.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
cmd = "pwsh.exe -NoProfile -ExecutionPolicy Bypass -File """ & root & "\tools\guardian.ps1"" -Once"
sh.Run cmd, 0, False
