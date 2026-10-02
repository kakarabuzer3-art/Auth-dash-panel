' AutoDash Control Panel - FAST launcher (2026-09-29)
' ---------------------------------------------------------------------------
' OLD CHAIN: wscript - cmd.exe - npm (node) - node(electron\cli.js) - electron.exe
'            npm boot alone measures about 1.4 s on this machine, and every extra
'            process made the desktop icon feel slow to open.
' NEW CHAIN: wscript - electron.exe "project folder"
'            Exactly what "electron ." does (the project folder IS the app path, so
'            the same package.json and the same userData store are used), but with
'            npm, the cmd shim and the extra node process removed entirely.
' A missing bundled binary (fresh clone / npm install not run yet) falls back to
' the previous npm launch, so the desktop icon can never break.
Option Explicit

Dim shell, fso, root, exePath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = "C:\Users\Abuzer Kakar\Desktop\autodash-control-panel"
shell.CurrentDirectory = root

exePath = root & "\node_modules\electron\dist\electron.exe"
If fso.FileExists(exePath) Then
    ' 0 = hidden console window, False = do not wait (the app runs on its own)
    shell.Run """" & exePath & """ """ & root & """", 0, False
Else
    ' Fallback: original npm launch (slower but always available)
    shell.Run "cmd /c npm start", 0, False
End If