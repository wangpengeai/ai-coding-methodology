' File: collect.vbs
' os-observation scheduled-task launcher (TASK-OSOBWIN-1, R-M14-9): the Task
' Scheduler action runs wscript.exe (GUI subsystem) on this file instead of
' launching powershell.exe directly -- a console-subsystem child started by
' schtasks in the interactive session gets a visible console window before
' PowerShell can act on -WindowStyle Hidden (window flash every poll round).
' The wscript host allocates no console of its own, and WScript.Shell.Run
' window style 0 creates the PowerShell child hidden (SW_HIDE at
' CreateProcess time).
' Argument 0 (optional): collector ps1 file name resolved next to this
' script, or a path used as-is; default = collect.ps1. The child exit code
' is propagated so the task history still reports failures.
' Pure ASCII only: wscript parses this file with the system ANSI codepage
' (zh-CN hosts = GBK), same rule as collect.ps1.
Option Explicit
Dim shell, selfDir, ps1, cmd, code
Set shell = CreateObject("WScript.Shell")
selfDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
ps1 = "collect.ps1"
If WScript.Arguments.Count > 0 Then ps1 = WScript.Arguments(0)
If InStr(ps1, ":") = 0 And InStr(ps1, "\") = 0 Then ps1 = selfDir & ps1
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """"
code = shell.Run(cmd, 0, True)
WScript.Quit code
