@echo off
REM ==========================================================================
REM Encoding note: this file must stay UTF-8 (no BOM) + CRLF. cmd.exe mis-parses
REM a UTF-8 batch file when the console code page changes while it is reading the
REM file, so this ASCII-only header switches the console to UTF-8 and re-runs the
REM script in a NEW cmd process (whose parser starts in UTF-8 from the first byte).
REM Keep this header ASCII-only: no Chinese text here, please.
REM ==========================================================================
if defined BG_SCRIPT_UTF8 goto main
setlocal
set "BG_SCRIPT_UTF8=1"
chcp 65001 >nul
"%COMSPEC%" /d /c call "%~f0" %*
set "BG_SCRIPT_RC=%errorlevel%"
exit /b %BG_SCRIPT_RC%

:main
@echo off
REM One-click launcher for the Board Game Hall (double-click to run).
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Error] Node.js not found. Please install it from https://nodejs.org
  pause
  exit /b 1
)

echo 正在启动桌游大厅...
node server.js
if errorlevel 1 (
  echo.
  echo 启动未完成，请查看上方错误信息。
  pause
  exit /b 1
)
