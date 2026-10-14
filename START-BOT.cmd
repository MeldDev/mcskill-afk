@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22.15 or newer, then open this file again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<15))process.exit(1)"
if errorlevel 1 (
  echo Update Node.js to version 22.15 or newer.
  pause
  exit /b 1
)
node --max-old-space-size=192 "%~dp0tools\login-and-afk.js"
set "bot_exit=%errorlevel%"
echo.
echo Bot stopped. Exit code: %bot_exit%
pause
exit /b %bot_exit%
