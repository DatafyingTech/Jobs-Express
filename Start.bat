@echo off
setlocal EnableExtensions
title Jobs Express
cd /d "%~dp0"
rem Do not let a node.bat or node.exe in this folder win over the real Node.js.
set "NoDefaultCurrentDirectoryInExePath=1"

echo.
echo   Jobs Express
echo   ------------
echo.

if not exist "%~dp0server.mjs" (
  echo   Some files are missing. Start.bat must sit next to server.mjs, the lib folder and the rest.
  echo   If you downloaded a ZIP: right-click it, choose Extract All, then open Start.bat from the new folder.
  echo   Running it from inside the ZIP window does not work.
  echo.
  pause
  exit /b 2
)

where node >nul 2>nul
if errorlevel 1 goto :nonode

set "NODEMAJOR="
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODEMAJOR=%%v"
if not defined NODEMAJOR goto :nonode
if %NODEMAJOR% LSS 18 goto :oldnode

echo   Starting... your browser will open in a moment.
echo   Leave this window open while you use the app. Close it to stop.
echo.
node server.mjs %*
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  echo.
  echo   The app stopped with an error. The message above says why.
  pause
)
exit /b %RC%

:nonode
echo   Node.js is not installed. It is the free engine this app runs on.
goto :offer

:oldnode
echo   Your Node.js is version %NODEMAJOR%. This app needs version 18 or newer.

:offer
echo.
where winget >nul 2>nul
if errorlevel 1 goto :web
choice /c YN /m "  Install the current Node.js LTS now with winget"
if errorlevel 2 goto :web
echo.
winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
set "RC=%errorlevel%"
echo.
if "%RC%"=="0" (
  echo   When the install finishes, close this window and double-click Start.bat again.
) else (
  echo   winget did not finish the install ^(exit code %RC%^). Install Node.js from https://nodejs.org instead, then run Start.bat again.
)
pause
exit /b %RC%

:web
echo   Opening the Node.js download page. Install the LTS version, then run Start.bat again.
start "" https://nodejs.org/en/download
pause
exit /b 1
