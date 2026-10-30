@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 24 or later and try again.
  pause
  exit /b 1
)
echo Starting schedule chatbot. Keep this window open.
echo To stop the server, press Ctrl+C.
node server.js --open %*
if errorlevel 1 pause
