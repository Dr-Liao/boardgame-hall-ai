@echo off
REM 一键发布大厅：只更新大厅自己的版本号、提交、打 tag 并推送。
REM 推送 tag 后由 GitHub Actions 自动构建 Windows/macOS 包并发布 Release。
REM 诡镇奇谈不随大厅发布，它有自己的脚本：games\arkhamhorror\release.bat。
REM 用法：release.bat [版本号] [更新说明] [--no-pause]
REM   不传版本号时会提示输入，例如 0.3.0（不带 v）。
setlocal EnableExtensions
chcp 65001 >nul
pushd "%~dp0" || goto directory_error

set "VERSION=%~1"
if /i "%VERSION%"=="--no-pause" set "VERSION="
set "NOTES=%~2"
set "NOPAUSE="
if /i "%~1"=="--no-pause" set "NOPAUSE=1"
if /i "%NOTES%"=="--no-pause" set "NOTES="
if /i "%~2"=="--no-pause" set "NOPAUSE=1"
if /i "%~3"=="--no-pause" set "NOPAUSE=1"

echo ==================================================
echo   桌游大厅 - 一键打包发布
echo ==================================================
echo.

where git >nul 2>nul
if not errorlevel 1 goto git_ready
REM Git for Windows 装好但没进 PATH 很常见，兜底找一下。
for %%D in ("%ProgramFiles%\Git\cmd" "%ProgramFiles(x86)%\Git\cmd" "%LOCALAPPDATA%\Programs\Git\cmd") do if exist "%%~D\git.exe" set "PATH=%%~D;%PATH%"
where git >nul 2>nul
if errorlevel 1 goto git_missing

:git_ready
where node >nul 2>nul
if errorlevel 1 goto node_missing

for /f "usebackq delims=" %%I in (`node -p "require('./package.json').version"`) do set "CURRENT=%%I"
if not defined CURRENT set "CURRENT=?"
echo 当前大厅版本：v%CURRENT%
echo.

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto not_repo
set "HAS_ARKHAM="
if exist "games\arkhamhorror\.git" set "HAS_ARKHAM=1"

for /f "usebackq delims=" %%I in (`git rev-parse --abbrev-ref HEAD`) do set "HALL_BRANCH=%%I"
if /i not "%HALL_BRANCH%"=="main" goto not_main

set "HALL_DIRTY="
for /f "usebackq delims=" %%I in (`git status --porcelain`) do set "HALL_DIRTY=1"
set "ARK_DIRTY="
if not defined HAS_ARKHAM goto skip_arkham_dirty
for /f "usebackq delims=" %%I in (`git -C games\arkhamhorror status --porcelain`) do set "ARK_DIRTY=1"
:skip_arkham_dirty
if defined HALL_DIRTY goto dirty_tree
if defined ARK_DIRTY goto mod_dirty

echo 正在从远端获取最新状态...
git fetch --tags origin
if errorlevel 1 goto fetch_failed

git rev-parse --verify origin/main >nul 2>nul
if errorlevel 1 goto no_origin_main

for /f "usebackq delims=" %%I in (`git rev-list --count origin/main..HEAD`) do set "HALL_AHEAD=%%I"
for /f "usebackq delims=" %%I in (`git rev-list --count HEAD..origin/main`) do set "HALL_BEHIND=%%I"
if not "%HALL_AHEAD%"=="0" goto hall_ahead
if not "%HALL_BEHIND%"=="0" goto hall_behind

if not defined VERSION goto prompt_version
goto version_ready

:prompt_version
set "VERSION="
set /p "VERSION=请输入大厅版本号（当前 v%CURRENT%；x.y.z，例如 0.3.0）: "

:version_ready
if not defined VERSION goto version_cancelled
echo %VERSION%| findstr /r /c:"^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul
if errorlevel 1 goto bad_version

git rev-parse -q --verify "refs/tags/v%VERSION%" >nul 2>nul
if not errorlevel 1 goto tag_exists

if not defined NOTES goto prompt_notes
goto notes_ready

:prompt_notes
set /p "NOTES=更新说明（可留空，默认 Release v%VERSION%）: "

:notes_ready
if not defined NOTES set "NOTES=Release v%VERSION%"

echo.
echo 即将发布大厅 v%VERSION%
echo   当前版本：v%CURRENT%
echo   更新说明：%NOTES%
echo.

echo 正在更新大厅版本号...
node tools\release\set-version.mjs "%VERSION%" --target=hall
if errorlevel 1 goto bump_failed
echo.
echo 版本文件：
git status --short
echo.

echo 提交并打 tag...
git add -A
git commit -m "chore: release v%VERSION%"
if errorlevel 1 goto commit_failed
git tag -a "v%VERSION%" -m "%NOTES%"
if errorlevel 1 goto tag_failed

echo.
echo 正在推送大厅...
git push origin main
if errorlevel 1 goto push_failed
git push origin "v%VERSION%"
if errorlevel 1 goto tag_push_failed

echo.
echo 发布已触发：v%VERSION%
echo   GitHub Actions 正在构建并发布，通常需要几分钟。
echo.
echo   大厅发布页：https://github.com/Dr-Liao/boardgame-hall-ai/releases/tag/v%VERSION%
echo   构建进度：
echo   https://github.com/Dr-Liao/boardgame-hall-ai/actions/workflows/release.yml
echo.
echo   提示：诡镇奇谈不随大厅发布；需要发诡镇时运行 games\arkhamhorror\release.bat
set "RESULT=0"
goto finish

:git_missing
echo [错误] 未找到 git，请先安装 Git for Windows：https://git-scm.com/download/win
set "RESULT=1"
goto finish

:node_missing
echo [错误] 未找到 node，请先安装 Node.js 22.15+：https://nodejs.org
set "RESULT=1"
goto finish

:not_repo
echo [错误] 当前目录不是 git 仓库，无法发布。
set "RESULT=1"
goto finish

:not_main
echo [错误] 发布必须在 main 分支上进行。
echo        当前分支：%HALL_BRANCH%
echo        请先切回 main 并运行 push-all.bat。
set "RESULT=1"
goto finish

:dirty_tree
echo [错误] 大厅有未提交的改动，发布前必须保持工作区干净。
echo        请先运行 push-all.bat 提交并推送，然后重试。
echo        当前改动：
git status --short
set "RESULT=1"
goto finish

:mod_dirty
echo [错误] 诡镇奇谈有未提交的改动，发布前必须处理。
echo        请先在诡镇奇谈里提交并推送（或运行 push-all.bat），然后重试。
echo        当前改动：
git -C games\arkhamhorror status --short
set "RESULT=1"
goto finish

:fetch_failed
echo [错误] 获取远端状态失败，请检查网络后再试。
set "RESULT=1"
goto finish

:no_origin_main
echo [错误] 找不到 origin/main 远端分支，请检查 git remote 配置。
set "RESULT=1"
goto finish

:hall_ahead
echo [错误] 大厅有未推送的本地提交，请先运行 push-all.bat。
set "RESULT=1"
goto finish

:hall_behind
echo [错误] 大厅落后于 origin/main，请先运行 pull-latest.bat。
set "RESULT=1"
goto finish

:version_cancelled
echo 已取消，未做任何修改。
set "RESULT=1"
goto finish

:bad_version
echo [错误] 版本号格式不正确：%VERSION%
echo        请使用 x.y.z，例如 0.3.0（不要带 v）。
set "RESULT=1"
goto finish

:tag_exists
echo [错误] 大厅的 tag v%VERSION% 已存在。
echo        若上次发布中断，可手动推送该 tag；否则请换一个更大的版本号。
echo        删除本地 tag：git tag -d v%VERSION%
set "RESULT=1"
goto finish

:bump_failed
echo [错误] 版本号更新失败，未做任何提交。
set "RESULT=1"
goto finish

:commit_failed
echo [错误] 提交失败，请查看上方 git 的错误信息。
echo        版本号可能已改到工作区，请手动检查后重试。
set "RESULT=1"
goto finish

:tag_failed
echo [错误] 创建 tag 失败，提交已保留。
echo        请手动检查：git tag -l "v%VERSION%"
set "RESULT=1"
goto finish

:push_failed
echo [错误] 推送失败。本地提交和 tag 已保留，不会丢失。
echo        网络恢复后可手动执行：
echo          git push origin main
echo          git push origin v%VERSION%
set "RESULT=1"
goto finish

:tag_push_failed
echo [错误] 分支已推送，但 tag 推送失败，GitHub Actions 尚未触发。
echo        本地 tag 已保留，网络恢复后手动执行：
echo          git push origin v%VERSION%
set "RESULT=1"
goto finish

:directory_error
echo [错误] 无法进入脚本所在目录 "%~dp0"。
pause
exit /b 1

:finish
popd
echo.
if not defined NOPAUSE pause
exit /b %RESULT%
