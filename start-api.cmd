@echo off
rem One-click launcher for the local OpenAI-compatible endpoint (no DSH needed).
rem Keep this file next to scripts\serve.mjs. Chinese messages come from the Node script.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [start-api] node.exe not found in PATH.
  echo [start-api] Install Node.js 22+ ^(or add DSH's bundled node to PATH^), then run this again.
  pause
  exit /b 1
)

node scripts\serve.mjs %*
echo.
echo [start-api] endpoint stopped.
pause
