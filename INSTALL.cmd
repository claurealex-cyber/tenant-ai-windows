@echo off
rem Tenant AI - one-shot Windows setup. Double-click me from the unzipped folder.
rem Needs Node.js 20+ (winget install -e --id OpenJS.NodeJS.LTS). No admin, no Docker.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\win\install.ps1"
set EXITCODE=%ERRORLEVEL%
echo.
if "%EXITCODE%"=="0" (echo Setup finished. Run start.cmd or the Tenant AI shortcut.) else (echo Setup failed with code %EXITCODE% - see the message above.)
pause
endlocal & exit /b %EXITCODE%
