Option Explicit

Dim shell
Dim fileSystem
Dim scriptDirectory
Dim powerShellScript
Dim powerShellExecutable
Dim command
Dim exitCode

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powerShellScript = fileSystem.BuildPath(scriptDirectory, "start-windows-bridge.ps1")
powerShellExecutable = shell.ExpandEnvironmentStrings("%SystemRoot%") & _
  "\System32\WindowsPowerShell\v1.0\powershell.exe"

command = Chr(34) & powerShellExecutable & Chr(34) & _
  " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden" & _
  " -File " & Chr(34) & powerShellScript & Chr(34) & _
  " -ConfirmRealConnection"

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
