@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 goto directory_error

echo Building Boardgame Hall macOS packages...
echo This creates Apple Silicon and Intel packages with bundled Node.js.
echo.

node "%~dp0tools\build-macos.mjs" --arch=all
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
