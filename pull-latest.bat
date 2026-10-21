@echo off
REM 一键拉取大厅和诡镇奇谈的最新代码（双击运行）。
REM 大厅 = 当前仓库；诡镇奇谈 = games/arkhamhorror 子模块，版本由大厅锁定。
REM 可选参数 --no-pause：结束时不要暂停，便于被其他脚本调用。
setlocal
chcp 65001 >nul
pushd "%~dp0" || goto directory_error

echo ==================================================
echo   桌游大厅 + 诡镇奇谈 - 一键拉取最新版本
echo ==================================================
echo.

where git >nul 2>nul
if errorlevel 1 goto git_missing

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
echo [2/3] 更新诡镇奇谈子模块...
git submodule sync --recursive
if errorlevel 1 goto submodule_failed
git submodule update --init --recursive
if errorlevel 1 goto submodule_failed

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

:submodule_failed
echo.
echo [错误] 更新诡镇奇谈子模块失败。
echo        - 若子模块内有未提交改动，请先处理后重试；
echo        - 也可手动运行：git submodule update --init --recursive
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
