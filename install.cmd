@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
title INPX Library - Installation

echo.
echo  =============================================
echo   INPX Library Server - Installation Script
echo  =============================================
echo.

:: ── 1. Node.js ──────────────────────────────────────────────────────

echo  [1/4] Node.js
echo  -------------------------------------------

set "NODE_VER=v24.18.0"
set "NODE_ARCH=x64"
set "PLATFORM_ARCH=amd64"
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" set "NODE_ARCH="
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" set "PLATFORM_ARCH=386"
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "NODE_ARCH=x64"
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "PLATFORM_ARCH=amd64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=arm64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PLATFORM_ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "NODE_ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "PLATFORM_ARCH=arm64"

set "NODE_EXE=node"
set "NPM_CMD=npm"
if exist "runtime\node.exe" (
  set "NODE_EXE=%~dp0runtime\node.exe"
  set "NPM_CMD=%~dp0runtime\npm.cmd"
  set "PATH=%~dp0runtime;%PATH%"
)

"%NODE_EXE%" -v >nul 2>&1
if errorlevel 1 goto :install_node
call "%NPM_CMD%" -v >nul 2>&1
if not "%ERRORLEVEL%"=="0" goto :install_node

set "SERVER_PORT=3000"
if exist ".env" for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="PORT" set "SERVER_PORT=%%B"
if exist "data\server-process-%SERVER_PORT%.json" (
  echo    Stopping the running server before updating files...
  "%NODE_EXE%" scripts\server-control.js stop "%SERVER_PORT%"
  if errorlevel 1 (
    echo    ERROR: Failed to stop the running server.
    echo    Run stop-server.cmd and try install.cmd again.
    goto :fail
  )
)

set "CURRENT_NODE="
for /f "tokens=*" %%V in ('"%NODE_EXE%" -v') do set "CURRENT_NODE=%%V"
set "NODE_MAJOR="
for /f "tokens=1 delims=." %%V in ("%CURRENT_NODE:~1%") do set "NODE_MAJOR=%%V"
if "%NODE_MAJOR%"=="22" goto :node_ready
if "%NODE_MAJOR%"=="24" goto :node_ready

echo    Unsupported Node.js %CURRENT_NODE%. Node.js 22 or 24 is required.
goto :install_node

:node_ready
for /f "tokens=*" %%V in ('"%NODE_EXE%" -v') do echo    OK: Node.js %%V
goto :step_npm

:install_node
if defined NODE_ARCH goto :download_node
echo    ERROR: Portable Node.js 24 is unavailable for 32-bit Windows.
echo    Install 64-bit Windows or provide a supported Node.js 22 manually.
goto :fail

:download_node
echo    Installing portable Node.js %NODE_VER%...
echo    Version: %NODE_VER% (%NODE_ARCH%)

if exist ".runtime-backup\" if not exist "runtime\" (
  move /y ".runtime-backup" "runtime" >nul
  if errorlevel 1 (
    echo    ERROR: Cannot restore the previous runtime.
    goto :fail
  )
)
if exist ".runtime-backup\" rd /s /q ".runtime-backup" 2>nul
if exist ".runtime-backup\" (
  echo    ERROR: Cannot remove stale runtime backup.
  goto :fail
)
if exist ".runtime-stage\" rd /s /q ".runtime-stage" 2>nul
if exist ".runtime-stage\" (
  echo    ERROR: Cannot remove stale runtime staging directory.
  goto :fail
)
del ".node-runtime.zip" 2>nul

powershell -NoProfile -Command ^
  "$ErrorActionPreference='Stop';" ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/%NODE_VER%/node-%NODE_VER%-win-%NODE_ARCH%.zip' -OutFile '.node-runtime.zip'"
if errorlevel 1 (
  echo    ERROR: Download failed. Check internet connection.
  goto :fail
)

echo    Verifying checksum...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "$sums=(Invoke-WebRequest -Uri 'https://nodejs.org/dist/%NODE_VER%/SHASUMS256.txt' -UseBasicParsing).Content;" ^
  "$filename='node-%NODE_VER%-win-%NODE_ARCH%.zip';" ^
  "$line=$sums -split '[\r\n]+' | Where-Object {(($_.Trim() -split '\s+')[-1]) -eq $filename} | Select-Object -First 1;" ^
  "if(-not $line){Write-Error ('Checksum entry not found for '+$filename); exit 1}" ^
  "$expected=($line.Trim() -split '\s+')[0].ToLower();" ^
  "$actual=(Get-FileHash '.node-runtime.zip' -Algorithm SHA256).Hash.ToLower();" ^
  "if($actual -ne $expected){Write-Error ('SHA256 mismatch: expected '+$expected+', got '+$actual); exit 1}" ^
  "Write-Host '    SHA256 OK'"
if errorlevel 1 (
  echo    ERROR: Checksum verification failed.
  goto :fail
)

echo    Extracting...
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Expand-Archive -Path '.node-runtime.zip' -DestinationPath '.runtime-stage' -Force"
if errorlevel 1 (
  echo    ERROR: Failed to extract Node.js.
  goto :fail
)

set "STAGED_RUNTIME=.runtime-stage\node-%NODE_VER%-win-%NODE_ARCH%"
if not exist "%STAGED_RUNTIME%\node.exe" (
  echo    ERROR: node.exe not found after extraction.
  goto :fail
)
if not exist "%STAGED_RUNTIME%\npm.cmd" (
  echo    ERROR: npm.cmd not found after extraction.
  goto :fail
)
"%STAGED_RUNTIME%\node.exe" -e "if(process.version!=='%NODE_VER%')process.exit(1)" >nul 2>&1
if errorlevel 1 (
  echo    ERROR: Extracted Node.js version is invalid.
  goto :fail
)

if exist "runtime\" move /y "runtime" ".runtime-backup" >nul
if errorlevel 1 (
  echo    ERROR: Cannot back up the existing runtime.
  goto :fail
)

move /y "%STAGED_RUNTIME%" "runtime" >nul
if errorlevel 1 (
  echo    ERROR: Cannot activate the new Node.js runtime.
  if exist "runtime\" rd /s /q "runtime" 2>nul
  if exist ".runtime-backup\" move /y ".runtime-backup" "runtime" >nul
  goto :fail
)

rd /s /q ".runtime-stage" 2>nul
set "NODE_EXE=%~dp0runtime\node.exe"
set "NPM_CMD=%~dp0runtime\npm.cmd"
set "PATH=%~dp0runtime;%PATH%"
"%NODE_EXE%" -v >nul 2>&1
if errorlevel 1 (
  echo    ERROR: Installed Node.js failed to start.
  rd /s /q "runtime" 2>nul
  if exist ".runtime-backup\" move /y ".runtime-backup" "runtime" >nul
  goto :fail
)

if exist ".runtime-backup\" rd /s /q ".runtime-backup" 2>nul
if exist ".runtime-backup\" echo    WARNING: Old runtime remains in .runtime-backup.
del ".node-runtime.zip" 2>nul
for /f "tokens=*" %%V in ('"%NODE_EXE%" -v') do echo    OK: Node.js %%V installed.

:: ── 2. npm ──────────────────────────────────────────────────────────

:step_npm
echo.
echo  [2/4] Dependencies
echo  -------------------------------------------

echo    Installing / updating dependencies...
call "%NPM_CMD%" install --omit=dev
if "%ERRORLEVEL%"=="0" goto :npm_install_ok

echo    npm install failed, retrying once...
"%NODE_EXE%" -e "setTimeout(()=>{},750)"
call "%NPM_CMD%" install --omit=dev
if not "%ERRORLEVEL%"=="0" (
  echo    ERROR: npm install failed.
  goto :fail
)

:npm_install_ok
set "PREV_VER="
if exist "node_modules\.node_version" set /p PREV_VER=<"node_modules\.node_version"
for /f "tokens=*" %%V in ('"%NODE_EXE%" -v') do set "CUR_VER=%%V"
if "%PREV_VER%"=="%CUR_VER%" goto :verify_native_modules

echo    Node.js version changed (%PREV_VER% -^> %CUR_VER%^), rebuilding native modules...
call "%NPM_CMD%" rebuild
if not "%ERRORLEVEL%"=="0" (
  echo    ERROR: npm rebuild failed.
  goto :fail
)

:verify_native_modules
"%NODE_EXE%" -e "const D=require('better-sqlite3');const d=new D(':memory:');d.close()" >nul 2>&1
if "%ERRORLEVEL%"=="0" goto :native_modules_ok

echo    better-sqlite3 failed to load, rebuilding it...
call "%NPM_CMD%" rebuild better-sqlite3
if not "%ERRORLEVEL%"=="0" (
  echo    ERROR: better-sqlite3 rebuild failed.
  goto :fail
)
"%NODE_EXE%" -e "const D=require('better-sqlite3');const d=new D(':memory:');d.close()" >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
  echo    ERROR: better-sqlite3 still fails to load.
  goto :fail
)

:native_modules_ok
"%NODE_EXE%" -e "require('fs').writeFileSync('node_modules/.node_version',process.version)"
if errorlevel 1 (
  echo    ERROR: Failed to save Node.js version marker.
  goto :fail
)
echo    OK: Dependencies installed.

:: ── 3. Data directory ───────────────────────────────────────────────

:step_env
echo.
echo  [3/4] Data directory
echo  -------------------------------------------

if not exist "data" mkdir data
echo    OK: data\ directory ready.

:: ── 4. FB2 converter ────────────────────────────────────────────────

echo.
echo  [4/4] FB2 converter (fb2cng)
echo  -------------------------------------------

if exist "converter\fbc.exe" (
  echo    OK: converter\fbc.exe already present.
  goto :done
)

set "FBC_VERSION=v1.9.5"
set "FBC_ARCH=%PLATFORM_ARCH%"
set "FBC_SHA256=c4e76822e7ab5b8c699fc6f9644d2c75022c03abf886ac3e270f4705b2d6f589"
if /i "%PLATFORM_ARCH%"=="arm64" set "FBC_SHA256=e66abecfff62baf03131a080a43b5036fce9e354f1e54ebe43fa31f935c85e21"
if /i "%PLATFORM_ARCH%"=="386" set "FBC_SHA256=5abb920a096ddd285f2db86b7f3d6f533b8d144ff041346d2d9c2354863bd3ea"

echo    Downloading fb2cng %FBC_VERSION% for Windows (%FBC_ARCH%)...
if not exist "converter" mkdir converter
del "converter\fbc.zip" 2>nul

powershell -NoProfile -Command ^
  "$ErrorActionPreference='Stop';" ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/rupor-github/fb2cng/releases/download/%FBC_VERSION%/fbc-windows-%FBC_ARCH%.zip' -OutFile 'converter\fbc.zip'"
if errorlevel 1 (
  echo    WARNING: Download failed - FB2 to EPUB conversion will not work.
  echo    You can install it manually later.
  del "converter\fbc.zip" 2>nul
  goto :done
)

echo    Verifying checksum...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$expected='%FBC_SHA256%';" ^
  "$actual=(Get-FileHash 'converter\fbc.zip' -Algorithm SHA256).Hash.ToLower();" ^
  "if($actual -ne $expected){Write-Error ('SHA256 mismatch: expected '+$expected+', got '+$actual); exit 1}" ^
  "Write-Host '    SHA256 OK'"
if errorlevel 1 (
  echo    WARNING: Converter checksum verification failed; converter was not installed.
  del "converter\fbc.zip" 2>nul
  goto :done
)

powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Expand-Archive -Path 'converter\fbc.zip' -DestinationPath 'converter' -Force"
if errorlevel 1 (
  echo    WARNING: Failed to extract fb2cng.
  del "converter\fbc.exe" 2>nul
  del "converter\fbc.zip" 2>nul
  goto :done
)
del "converter\fbc.zip" 2>nul

if exist "converter\fbc.exe" (
  echo    OK: fb2cng installed.
) else (
  echo    WARNING: fbc.exe not found after extraction.
)

:: ── Done ────────────────────────────────────────────────────────────

:done
echo.
echo  =============================================
echo   Installation complete!
echo  =============================================
echo.
echo   Next steps:
echo     1. Run:  start-server.cmd
echo     2. Open: http://localhost:3000
echo     3. Log in as admin / admin
echo     4. Set library path and .inpx in admin panel
echo.
pause
exit /b 0

:fail
del ".node-runtime.zip" 2>nul
if exist ".runtime-stage\" rd /s /q ".runtime-stage" 2>nul
if exist ".runtime-backup\" if not exist "runtime\" move /y ".runtime-backup" "runtime" >nul
del "converter\fbc.zip" 2>nul
echo.
echo  =============================================
echo   Installation FAILED — see errors above.
echo  =============================================
echo.
pause
exit /b 1
