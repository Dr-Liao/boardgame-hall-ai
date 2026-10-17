@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 goto directory_error

echo Building Boardgame Hall Windows hall-only package...
echo This package bundles only Gobang and Tic-Tac-Toe; other games install from the in-app game store.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build-windows.ps1" -HallOnly
set "build_result=%errorlevel%"
echo.
if "%build_result%"=="0" (
  echo Build completed. Output:
  echo "%~dp0dist"
) else (
  echo Build failed. See the error above.
)
popd
goto finish

:directory_error
echo Cannot access the project directory.
set "build_result=1"

:finish
if /i not "%~1"=="--no-pause" pause
exit /b %build_result%
