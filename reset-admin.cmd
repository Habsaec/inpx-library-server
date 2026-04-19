@echo off
cd /d "%~dp0"
echo.

:: --- Find Node.js ---
if exist "runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
node -v >nul 2>&1
if errorlevel 1 (
  echo  Node.js not found.
  echo  Run install.cmd first, or install Node.js manually.
  goto :fail
)

:: --- Check dependencies ---
if not exist "node_modules\" (
  echo  Dependencies not installed.
  echo  Run install.cmd first.
  goto :fail
)

:: --- Run reset ---
node scripts/reset-admin.js %*
goto :end

:fail
echo.
pause
exit /b 1

:end
echo.
pause
