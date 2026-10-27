@echo off
rem Lumen CLI launcher: builds on first run, then opens the chat.
if not exist "%~dp0dist-cli\cli\index.js" (
  echo First run: building Lumen CLI...
  call npm run --prefix "%~dp0" build:cli || exit /b 1
)
node "%~dp0dist-cli\cli\index.js" %*
