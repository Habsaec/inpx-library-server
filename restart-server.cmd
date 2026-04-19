@echo off
cd /d "%~dp0"
if exist "runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
node scripts\server-control.js restart %1
pause
