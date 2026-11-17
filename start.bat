@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if not exist "node_modules" (
  echo Dependencies are missing. Run setup.bat first.
  pause
  exit /b 1
)
if not exist ".env" (
  echo .env not found. Run setup.bat first.
  pause
  exit /b 1
)

rem --- Read PORT from .env (default 4000) ----------------------------------
set PORT=4000
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="PORT" if not "%%B"=="" set PORT=%%B
)

rem --- Already running? ----------------------------------------------------
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo Asset Tracker is already running on http://localhost:%PORT%
  start "" "http://localhost:%PORT%"
  exit /b 0
)

echo Starting Asset Tracker on port %PORT%...
echo Logs: %~dp0server.log
start "Asset Tracker Server" /min cmd /c "node src\server.js > server.log 2>&1"

rem --- Wait until the port is listening ---
set /a TRIES=0
:wait
timeout /t 1 /nobreak >nul
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 goto :ready
set /a TRIES+=1
if !TRIES! GEQ 30 goto :failed
goto :wait

:ready
echo Asset Tracker is running at http://localhost:%PORT%
echo Run stop.bat to stop it.
start "" "http://localhost:%PORT%"
exit /b 0

:failed
echo [ERROR] The server did not start within 30 seconds. Last log lines:
echo.
powershell -NoProfile -Command "Get-Content -Tail 20 'server.log'"
pause
exit /b 1
