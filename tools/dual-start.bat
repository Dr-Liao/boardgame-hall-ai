@echo off
setlocal

if /i "%~1"=="--host" goto host
if /i "%~1"=="--guest" goto guest

pushd "%~dp0.." || goto directory_error
where node >nul 2>nul
if errorlevel 1 goto node_missing

echo Starting two independent Boardgame Hall processes...
echo Host:  http://127.0.0.1:8787
echo Guest: http://127.0.0.1:8788
echo Relay: https://boardgame-relay.onrender.com
echo.
start "Boardgame Hall - Host" /D "%CD%" "%ComSpec%" /d /k call "%~f0" --host
start "Boardgame Hall - Guest" /D "%CD%" "%ComSpec%" /d /k call "%~f0" --guest
popd
exit /b 0

:host
set "BOARDGAME_PORT=8787"
set "DSH_HOME=%TEMP%\boardgame-hall-dual\host"
goto run

:guest
set "BOARDGAME_PORT=8788"
set "DSH_HOME=%TEMP%\boardgame-hall-dual\guest"
goto run

:run
set "BOARDGAME_HOST=127.0.0.1"
set "BOARDGAME_RELAY_URL=https://boardgame-relay.onrender.com"
set "BOARDGAME_NO_OPEN="
pushd "%~dp0.." || goto directory_error
echo Player data: %DSH_HOME%
echo Hall port: %BOARDGAME_PORT%
node server.js
set "result=%errorlevel%"
popd
exit /b %result%

:node_missing
echo Node.js 22.15+ is required.
popd
pause
exit /b 1

:directory_error
echo Cannot access the project directory.
pause
exit /b 1
