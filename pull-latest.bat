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
REM 一键拉取大厅和诡镇奇谈的最新代码（双击运行）。
REM 大厅 = 当前仓库；诡镇奇谈 = 克隆在 games/arkhamhorror 的独立仓库（大厅不跟踪它）。
REM 可选参数 --no-pause：结束时不要暂停，便于被其他脚本调用。
setlocal
chcp 65001 >nul
pushd "%~dp0" || goto directory_error

echo ==================================================
echo   桌游大厅 + 诡镇奇谈 - 一键拉取最新版本
echo ==================================================
echo.

where git >nul 2>nul
if not errorlevel 1 goto git_ready
REM Git for Windows 装好但没进 PATH 很常见，兜底找一下。
for %%D in ("%ProgramFiles%\Git\cmd" "%ProgramFiles(x86)%\Git\cmd" "%LOCALAPPDATA%\Programs\Git\cmd") do if exist "%%~D\git.exe" set "PATH=%%~D;%PATH%"
where git >nul 2>nul
if errorlevel 1 goto git_missing

:git_ready

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto not_repo

set "dirty="
for /f "usebackq delims=" %%I in (`git status --porcelain -uno`) do set "dirty=1"
if defined dirty goto dirty_tree

for /f "usebackq delims=" %%I in (`git rev-parse HEAD`) do set "old_head=%%I"

echo [1/3] 拉取大厅最新代码...
git pull --ff-only --no-rebase --tags
if errorlevel 1 goto pull_failed

echo.
echo [2/3] 更新诡镇奇谈...
if exist "games\arkhamhorror\.git" goto arkham_pull
if exist "games\arkhamhorror" goto arkham_broken
echo   未找到 games\arkhamhorror，正在克隆...
git clone https://github.com/Dr-Liao/boardgame-arkhamhorror.git games\arkhamhorror
if errorlevel 1 goto arkham_failed
goto arkham_done

:arkham_pull
set "arkham_dirty="
for /f "usebackq delims=" %%I in (`git -C games\arkhamhorror status --porcelain`) do set "arkham_dirty=1"
if defined arkham_dirty goto arkham_dirty_tree
for /f "usebackq delims=" %%I in (`git -C games\arkhamhorror rev-parse --abbrev-ref HEAD`) do set "arkham_branch=%%I"
if not "%arkham_branch%"=="HEAD" goto arkham_pull_ready
echo   诡镇奇谈处于游离状态，切回 main...
git -C games\arkhamhorror switch main
if errorlevel 1 goto arkham_failed

:arkham_pull_ready
git -C games\arkhamhorror pull --ff-only --no-rebase --tags
if errorlevel 1 goto arkham_failed

:arkham_done

echo.
echo [3/3] 当前版本：
set "hall_version=unknown"
set "arkham_version=unknown"
for /f "usebackq delims=" %%I in (`git describe --tags --always`) do set "hall_version=%%I"
for /f "usebackq delims=" %%I in (`git -C games/arkhamhorror describe --tags --always`) do set "arkham_version=%%I"
echo   大厅     : %hall_version%
echo   诡镇奇谈 : %arkham_version%
echo.

git diff --quiet "%old_head%" HEAD -- package-lock.json
if errorlevel 1 (
  echo [提示] 依赖清单有更新；若启动时报错，请在本目录运行 npm install。
  echo.
)

echo 拉取完成。
set "result=0"
goto finish

:git_missing
echo [错误] 未找到 git，请先安装 Git for Windows：https://git-scm.com/download/win
set "result=1"
goto finish

:not_repo
echo [错误] 当前目录不是 git 仓库，无法拉取。
set "result=1"
goto finish

:dirty_tree
echo [错误] 本地有未提交的改动，为避免覆盖，已停止拉取。
echo        请先提交或暂存（git stash）后重试。当前改动：
git status --short --untracked-files=no
set "result=1"
goto finish

:pull_failed
echo.
echo [错误] 拉取大厅代码失败。
echo        - 请检查网络能否访问 GitHub；
echo        - 若提示本地与远端分叉，请先处理本地提交（git pull --rebase 或 git reset）。
set "result=1"
goto finish

:arkham_broken
echo.
echo [错误] games\arkhamhorror 已存在但不是 git 仓库，无法自动克隆。
echo        请先把它移走或删除，然后重新运行本脚本。
set "result=1"
goto finish

:arkham_dirty_tree
echo.
echo [错误] 诡镇奇谈有未提交的改动，为避免覆盖，已停止更新。
echo        请先提交或暂存（git stash）后重试。当前改动：
git -C games\arkhamhorror status --short
set "result=1"
goto finish

:arkham_failed
echo.
echo [错误] 更新诡镇奇谈失败。
echo        - 请检查网络能否访问 GitHub；
echo        - 也可手动在 games\arkhamhorror 里运行 git pull --ff-only。
set "result=1"
goto finish

:directory_error
echo [错误] 无法进入脚本所在目录 "%~dp0"。
pause
exit /b 1

:finish
popd
echo.
if /i not "%~1"=="--no-pause" pause
exit /b %result%
