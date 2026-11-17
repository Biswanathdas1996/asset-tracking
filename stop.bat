@echo off
setlocal
cd /d "%~dp0"

rem --- Read PORT from .env (default 4000) ----------------------------------
set PORT=4000
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="PORT" if not "%%B"=="" set PORT=%%B
  )
)

set FOUND=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  set FOUND=1
  rem /T also stops child processes
  taskkill /PID %%P /T /F >nul 2>&1
)

if defined FOUND (
  echo Asset Tracker on port %PORT% stopped.
) else (
  echo Asset Tracker is not running on port %PORT%.
)
