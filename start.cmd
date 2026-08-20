@echo off
rem Tenant AI launcher (Windows). Double-click or pin a shortcut to this file.
rem All logic lives in scripts\launch.mjs (shared with macOS/Linux).
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install it with: winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
node scripts\launch.mjs %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo Launcher exited with code %EXITCODE%.
  pause
)
endlocal & exit /b %EXITCODE%
