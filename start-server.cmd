@echo off
cd /d "%~dp0"
title INPX Library Server
echo.

:: --- Find Node.js ---
if exist "runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
node -v >nul 2>&1
if errorlevel 1 (
  echo  Node.js not found.
  echo  Run install.cmd first, or install Node.js manually.
  goto :fail
)
node -e "console.log('  Node.js ' + process.version)"

:: --- Check dependencies ---
if not exist "node_modules\" (
  echo  Dependencies not installed.
  echo  Run install.cmd first.
  goto :fail
)

:: --- Rebuild native modules if Node.js version changed ---
setlocal enabledelayedexpansion
set "PREV_VER="
if exist "node_modules\.node_version" set /p PREV_VER=<"node_modules\.node_version"
for /f "tokens=*" %%V in ('node -v') do set "CUR_VER=%%V"
if not "!PREV_VER!"=="!CUR_VER!" (
  echo  Node.js version changed (!PREV_VER! -^> !CUR_VER!^), rebuilding native modules...
  call npm rebuild
  if errorlevel 1 (
    echo  ERROR: npm rebuild failed. Try running install.cmd again.
    goto :fail
  )
  node -e "require('fs').writeFileSync('node_modules/.node_version',process.version)"
  echo  OK
  echo.
)
endlocal

:: --- Detect port ---
set "SERVER_PORT=3000"
for /f "tokens=*" %%P in ('node -e "try{const d=require('dotenv');d.config()}catch{}console.log(process.env.PORT||3000)" 2^>nul') do set "SERVER_PORT=%%P"

:: --- Start server ---
node scripts/server-control.js start
if errorlevel 1 goto :err_start
echo.
echo  ======================================
echo   INPX Library Server is running
echo   http://localhost:%SERVER_PORT%
echo.
echo   Stop:    stop-server.cmd
echo   Restart: restart-server.cmd
echo  ======================================
start "" "http://localhost:%SERVER_PORT%"
goto :end

:err_start
echo.
echo  ERROR: Server failed to start.
goto :end

:fail
echo.
pause
exit /b 1

:end
echo.
pause
