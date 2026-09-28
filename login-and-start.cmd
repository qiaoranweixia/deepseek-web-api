@echo off
rem One-click: log in from the browser you already use (Edge/Chrome), then start the endpoint.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [login-and-start] node.exe not found in PATH.
  echo [login-and-start] Install Node.js 22+ ^(or add DSH's bundled node to PATH^), then run this again.
  pause
  exit /b 1
)

rem Paste not working in the console (old conhost Ctrl+V)? Put the token on the first line of
rem ds-token.txt next to this file and run this again - the script will read it instead of asking.
if exist "%~dp0ds-token.txt" (
  echo [login-and-start] using ds-token.txt ^(delete that file once you are done - it is a credential^)
  node scripts\serve.mjs --token-file "%~dp0ds-token.txt" --enable
) else (
  node scripts\serve.mjs --login --enable
)
if errorlevel 1 (
  echo.
  echo [login-and-start] stopped with an error - read the lines above.
)
echo.
echo [login-and-start] endpoint stopped.
pause
