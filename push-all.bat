@echo off
REM 一键提交并推送大厅与诡镇奇谈的全部代码（双击运行）。
REM 先提交并推送子模块，再提交大厅里的子模块指针，保证远端指针有效。
REM 推送前会自动 fetch，落后就快进、分叉就把本地提交变基到远端之上。
REM 可选参数 --yes：使用默认提交说明并跳过确认；--no-pause：结束时不暂停。
setlocal EnableExtensions
chcp 65001 >nul
pushd "%~dp0" || goto directory_error

set "AUTO="
set "NOPAUSE="
set "MSG=chore: sync all modules"
if /i "%~1"=="--yes" set "AUTO=1"
if /i "%~2"=="--yes" set "AUTO=1"
if /i "%~1"=="--no-pause" set "NOPAUSE=1"
if /i "%~2"=="--no-pause" set "NOPAUSE=1"

echo ==================================================
echo   桌游大厅 + 诡镇奇谈 - 一键推送全部代码
echo ==================================================
echo.

where git >nul 2>nul
if errorlevel 1 goto git_missing

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto not_repo

if not exist "games\arkhamhorror\.git" goto submodule_missing
git -C games\arkhamhorror rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto submodule_missing

for /f "usebackq delims=" %%I in (`git rev-parse --abbrev-ref HEAD`) do set "HALL_BRANCH=%%I"
if "%HALL_BRANCH%"=="HEAD" goto detached_hall

echo [大厅] 当前分支：%HALL_BRANCH%
git status --short
echo.
echo [诡镇奇谈]
git -C games\arkhamhorror status --short
echo.

set "HALL_DIRTY="
for /f "usebackq delims=" %%I in (`git status --porcelain`) do set "HALL_DIRTY=1"
set "ARK_DIRTY="
for /f "usebackq delims=" %%I in (`git -C games\arkhamhorror status --porcelain`) do set "ARK_DIRTY=1"

if not defined HALL_DIRTY if not defined ARK_DIRTY goto prepare_arkham
if defined AUTO goto default_message

set /p "MSG=提交说明（回车使用默认：chore: sync all modules）: "
if not defined MSG set "MSG=chore: sync all modules"

set "CONFIRM="
set /p "CONFIRM=确认提交并推送以上改动? [Y/n] "
if /i "%CONFIRM%"=="n" goto cancelled
goto prepare_arkham

:default_message
set "MSG=chore: sync all modules"

:prepare_arkham
for /f "usebackq delims=" %%I in (`git -C games\arkhamhorror rev-parse --abbrev-ref HEAD`) do set "ARK_BRANCH=%%I"
if not "%ARK_BRANCH%"=="HEAD" goto arkham_branch_ready

echo [诡镇奇谈] 当前是 detached HEAD，切换到 main...
set "ARK_BASE=main"
git -C games\arkhamhorror rev-parse --verify refs/heads/main >nul 2>nul
if errorlevel 1 set "ARK_BASE=origin/main"
git -C games\arkhamhorror rev-parse --verify "%ARK_BASE%" >nul 2>nul
if errorlevel 1 goto arkham_detached_error
git -C games\arkhamhorror merge-base --is-ancestor "%ARK_BASE%" HEAD
if errorlevel 1 goto arkham_head_older
git -C games\arkhamhorror checkout -B main HEAD
if errorlevel 1 goto arkham_detached_error
set "ARK_BRANCH=main"
goto arkham_branch_ready

:arkham_head_older
git -C games\arkhamhorror merge-base --is-ancestor HEAD "%ARK_BASE%"
if errorlevel 1 goto arkham_diverged
git -C games\arkhamhorror checkout -B main "%ARK_BASE%"
if errorlevel 1 goto arkham_detached_error
set "ARK_BRANCH=main"

:arkham_branch_ready
echo.
echo [诡镇奇谈] 提交...
git -C games\arkhamhorror add -A
git -C games\arkhamhorror diff --cached --quiet
if errorlevel 1 goto arkham_commit
echo   没有需要提交的改动。
goto arkham_push

:arkham_commit
git -C games\arkhamhorror commit -m "%MSG%"
if errorlevel 1 goto commit_failed
echo   已提交。

:arkham_push
call :sync_branch "games\arkhamhorror" "%ARK_BRANCH%"
if not "%SYNC_OK%"=="1" goto arkham_sync_failed
echo   推送到 origin/%ARK_BRANCH%...
git -C games\arkhamhorror push origin "%ARK_BRANCH%"
if errorlevel 1 goto arkham_push_failed

echo.
echo [大厅] 提交...
git add -A
git diff --cached --quiet
if errorlevel 1 goto hall_commit
echo   没有需要提交的改动。
goto hall_push

:hall_commit
git commit -m "%MSG%"
if errorlevel 1 goto commit_failed
echo   已提交。

:hall_push
call :sync_branch "" "%HALL_BRANCH%"
if not "%SYNC_OK%"=="1" goto hall_sync_failed
echo   推送到 origin/%HALL_BRANCH%...
git push origin "%HALL_BRANCH%"
if errorlevel 1 goto hall_push_failed

echo.
echo 推送完成：大厅 %HALL_BRANCH%，诡镇奇谈 %ARK_BRANCH%。
set "RESULT=0"
goto finish

:git_missing
echo [错误] 未找到 git，请先安装 Git for Windows：https://git-scm.com/download/win
set "RESULT=1"
goto finish

:not_repo
echo [错误] 当前目录不是 git 仓库，无法推送。
set "RESULT=1"
goto finish

:submodule_missing
echo [错误] 诡镇奇谈子模块不存在或未初始化。
echo        请先运行 pull-latest.bat。
set "RESULT=1"
goto finish

:detached_hall
echo [错误] 大厅当前处于 detached HEAD，不在任何分支上，无法推送。
echo        请先切回 main：git switch main
set "RESULT=1"
goto finish

:arkham_detached_error
echo [错误] 诡镇奇谈处于 detached HEAD，且无法安全切换到 main。
echo        请手动检查：git -C games\arkhamhorror status
set "RESULT=1"
goto finish

:arkham_diverged
echo [错误] 诡镇奇谈的 detached HEAD 与本地 main 已分叉，无法自动切换。
echo        请手动检查：git -C games\arkhamhorror log --oneline --graph --all -20
set "RESULT=1"
goto finish

:commit_failed
echo [错误] 提交失败，请查看上方 git 的错误信息。
echo        常见原因：未配置 user.name / user.email，或存在冲突。
set "RESULT=1"
goto finish

:arkham_push_failed
echo [错误] 推送诡镇奇谈失败（本地提交已保留，不会丢失）。
echo        - 若是 rejected / behind：远端又有新提交，重新运行本脚本即可（会自动变基）；
echo        - 若是 Could not resolve host / Connection：网络或代理问题，先确认能打开 github.com。
set "RESULT=1"
goto finish

:hall_push_failed
echo [错误] 推送大厅失败。
echo        - 诡镇奇谈已经推送成功；大厅的本地提交仍在；
echo        - 若是 rejected / behind：重新运行本脚本即可（会自动变基）；
echo        - 若是网络错误：检查代理或稍后重试。
set "RESULT=1"
goto finish

:arkham_sync_failed
echo [错误] 诡镇奇谈与远端同步失败，已停止推送（本地提交已保留）。
set "RESULT=1"
goto finish

:hall_sync_failed
echo [错误] 大厅与远端同步失败，已停止推送（本地提交已保留）。
set "RESULT=1"
goto finish

:cancelled
echo 已取消，未做任何提交或推送。
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

REM ---------------------------------------------------------------------------
REM 推送前和远端对齐，避免 "Updates were rejected because the tip of your
REM current branch is behind its remote counterpart"。
REM   %1 = 子仓库相对路径（大厅传空 ""），%2 = 要推送的分支名
REM   返回 SYNC_OK=1 表示可以继续推送，0 表示已停止
REM ---------------------------------------------------------------------------
:sync_branch
set "SYNC_OK=1"
set "SYNC_BR=%~2"
set "SYNC_PUSHD="
set "SYNC_FULLPATH=%~dp0"

if "%~1"=="" goto sync_ready
pushd "%~1" 2>nul
if errorlevel 1 goto sync_bad_dir
set "SYNC_PUSHD=1"
set "SYNC_FULLPATH=%CD%"

:sync_ready
echo   检查远端 origin\%SYNC_BR% 是否有新提交...
git fetch origin "%SYNC_BR%" --quiet 2>nul
if errorlevel 1 goto sync_offline

git rev-parse --verify --quiet "refs/remotes/origin/%SYNC_BR%" >nul 2>nul
if errorlevel 1 goto sync_exit

git merge-base --is-ancestor "origin/%SYNC_BR%" HEAD
if not errorlevel 1 goto sync_exit

git merge-base --is-ancestor HEAD "origin/%SYNC_BR%"
if not errorlevel 1 goto sync_behind

echo   本地与远端分叉，正在把本地提交变基到远端之上...
git pull --rebase origin "%SYNC_BR%"
if errorlevel 1 goto sync_conflict
echo   变基完成。
goto sync_exit

:sync_behind
echo   远端有新提交，正在快进...
git merge --ff-only "origin/%SYNC_BR%"
if errorlevel 1 goto sync_conflict
echo   已快进到最新。
goto sync_exit

:sync_offline
echo   [警告] 连不上远端，跳过同步检查（后面的 push 很可能也会失败）。
goto sync_exit

:sync_bad_dir
echo   [警告] 无法进入子仓库 "%~1"，跳过同步检查。
set "SYNC_OK=0"
goto sync_exit

:sync_conflict
echo.
echo   [错误] 与远端同步失败（多半是代码冲突），脚本已停止，避免把提交弄乱。
echo          请到 "%SYNC_FULLPATH%" 手动处理：
echo            git status
echo            解决冲突后 git add -A 再 git rebase --continue
echo            不想处理就 git rebase --abort 回到原样
set "SYNC_OK=0"

:sync_exit
if defined SYNC_PUSHD popd
goto :eof
