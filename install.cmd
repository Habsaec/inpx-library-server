@echo off
setlocal enabledelayedexpansion
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

if exist "runtime\node.exe" (
  set "PATH=%~dp0runtime;%PATH%"
)

node -v >nul 2>&1
if not errorlevel 1 (
  for /f "tokens=*" %%V in ('node -v') do echo    OK: Node.js %%V
  goto :step_npm
)

echo    Node.js not found. Downloading portable Node.js 20...
if not exist "runtime" mkdir runtime

set "NODE_VER=v20.18.1"
set "NODE_ARCH=x64"
if "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=arm64"

echo    Version: %NODE_VER% (%NODE_ARCH%)
powershell -NoProfile -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/%NODE_VER%/node-%NODE_VER%-win-%NODE_ARCH%.zip' -OutFile 'runtime\node.zip'"
if errorlevel 1 (
  echo    ERROR: Download failed. Check internet connection.
  goto :fail
)

echo    Verifying checksum...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "$sums=(Invoke-WebRequest -Uri 'https://nodejs.org/dist/%NODE_VER%/SHASUMS256.txt' -UseBasicParsing).Content;" ^
  "$line=$sums -split '[\r\n]+' | Where-Object {$_ -like '*node-%NODE_VER%-win-%NODE_ARCH%.zip*'} | Select-Object -First 1;" ^
  "if(-not $line){Write-Host '    SHASUMS not found, skipping verify'; exit 0}" ^
  "$expected=($line.Trim() -split '\s+')[0].ToLower();" ^
  "$actual=(Get-FileHash 'runtime\node.zip' -Algorithm SHA256).Hash.ToLower();" ^
  "if($actual -ne $expected){Write-Error ('SHA256 mismatch: expected '+$expected+', got '+$actual); exit 1}" ^
  "Write-Host '    SHA256 OK'"
if errorlevel 1 (
  echo    WARNING: Checksum verification failed. The download may be corrupted.
  del "runtime\node.zip" 2>nul
  goto :fail
)

echo    Extracting...
powershell -NoProfile -Command "Expand-Archive -Path 'runtime\node.zip' -DestinationPath 'runtime\tmp' -Force"
if errorlevel 1 (
  echo    ERROR: Failed to extract Node.js.
  goto :fail
)

for /d %%D in (runtime\tmp\node-*) do xcopy "%%D\*" "runtime\" /s /e /y /q >nul
rd /s /q "runtime\tmp" 2>nul
del "runtime\node.zip" 2>nul

if not exist "runtime\node.exe" (
  echo    ERROR: node.exe not found after extraction.
  goto :fail
)

set "PATH=%~dp0runtime;%PATH%"
for /f "tokens=*" %%V in ('node -v') do echo    OK: Node.js %%V installed.

:: ── 2. npm ──────────────────────────────────────────────────────────

:step_npm
echo.
echo  [2/4] Dependencies
echo  -------------------------------------------

echo    Installing / updating dependencies...
call npm install --omit=dev
if errorlevel 1 (
  echo    ERROR: npm install failed.
  goto :fail
)

set "PREV_VER="
if exist "node_modules\.node_version" set /p PREV_VER=<"node_modules\.node_version"
for /f "tokens=*" %%V in ('node -v') do set "CUR_VER=%%V"
if not "!PREV_VER!"=="!CUR_VER!" (
  echo    Node.js version changed (!PREV_VER! -^> !CUR_VER!^), rebuilding native modules...
  call npm rebuild
  if errorlevel 1 (
    echo    ERROR: npm rebuild failed.
    goto :fail
  )
)

node -e "require('fs').writeFileSync('node_modules/.node_version',process.version)"
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

echo    Downloading fb2cng v1.1.8 for Windows...
if not exist "converter" mkdir converter

powershell -NoProfile -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/rupor-github/fb2cng/releases/download/v1.1.8/fbc-windows-amd64.zip' -OutFile 'converter\fbc.zip'"
if errorlevel 1 (
  echo    WARNING: Download failed - FB2 to EPUB conversion will not work.
  echo    You can install it manually later.
  goto :done
)

powershell -NoProfile -Command "Expand-Archive -Path 'converter\fbc.zip' -DestinationPath 'converter' -Force"
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
echo.
echo  =============================================
echo   Installation FAILED — see errors above.
echo  =============================================
echo.
pause
exit /b 1
