@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12 or newer, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Run npm.cmd install in this folder first.
  pause
  exit /b 1
)
call npm.cmd run build
if errorlevel 1 (
  pause
  exit /b 1
)
echo Open http://localhost:4317 in your browser.
call npm.cmd start
pause
