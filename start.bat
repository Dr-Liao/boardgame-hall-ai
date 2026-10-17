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
