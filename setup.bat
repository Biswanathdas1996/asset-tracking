@echo off
setlocal
cd /d "%~dp0"
title Asset Tracker - Setup

echo === Asset Tracker setup ===
echo.

rem --- Node.js 20+ ---------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 20 or newer from https://nodejs.org
  goto :fail
)
for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set NODE_MAJOR=%%V
if %NODE_MAJOR% LSS 20 (
  echo [ERROR] Node.js 20+ is required. Found:
  node -v
  goto :fail
)
for /f %%V in ('node -v') do echo [OK] Node.js %%V

rem --- Dependencies --------------------------------------------------------
echo.
echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  goto :fail
)
echo [OK] Dependencies installed

rem --- .env ----------------------------------------------------------------
echo.
if exist ".env" (
  echo [OK] .env already exists, leaving it unchanged
) else (
  copy /y ".env.example" ".env" >nul
  echo [OK] Created .env from .env.example
  echo      Optional: edit .env to change PORT or add a CoinGecko API key.
)

echo.
echo Setup complete. Run start.bat to launch the app.
echo Your data is stored encrypted in your browser - no database needed.
echo.
pause
exit /b 0

:fail
echo.
echo Setup failed.
pause
exit /b 1
