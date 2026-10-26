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
REM 一键提交并推送大厅与诡镇奇谈的全部代码（双击运行）。
REM 诡镇奇谈是独立仓库：先提交并推送它，再提交并推送大厅（大厅不跟踪诡镇的内容）。
REM 推送前会自动 fetch：落后就快进；分叉就自动合并远端（merge，不改写本地提交）。
REM 推送被远端拒绝时也会自动拉取、合并后重试；合并冲突时停止并自动取消本次合并。
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
if not errorlevel 1 goto git_ready
REM Git for Windows 装好但没进 PATH 很常见，兜底找一下。
for %%D in ("%ProgramFiles%\Git\cmd" "%ProgramFiles(x86)%\Git\cmd" "%LOCALAPPDATA%\Programs\Git\cmd") do if exist "%%~D\git.exe" set "PATH=%%~D;%PATH%"
where git >nul 2>nul
if errorlevel 1 goto git_missing

:git_ready

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto not_repo

set "HAS_ARKHAM="
if exist "games\arkhamhorror\.git" set "HAS_ARKHAM=1"

REM 上次合并/变基因冲突没收尾时先停下来，避免把半成品提交、推送上去。
call :check_progress "大厅" ".git"
if not "%CLEAN_STATE%"=="1" goto progress_pending
if not defined HAS_ARKHAM goto progress_ok
call :check_progress "诡镇奇谈" "games\arkhamhorror\.git"
if not "%CLEAN_STATE%"=="1" goto progress_pending
:progress_ok

for /f "usebackq delims=" %%I in (`git rev-parse --abbrev-ref HEAD`) do set "HALL_BRANCH=%%I"
if "%HALL_BRANCH%"=="HEAD" goto detached_hall

echo [大厅] 当前分支：%HALL_BRANCH%
git status --short
echo.
if not defined HAS_ARKHAM goto skip_arkham_status
echo [诡镇奇谈]
git -C games\arkhamhorror status --short
:skip_arkham_status
echo.
set "HALL_DIRTY="
for /f "usebackq delims=" %%I in (`git status --porcelain`) do set "HALL_DIRTY=1"
set "ARK_DIRTY="
if not defined HAS_ARKHAM goto skip_arkham_dirty
for /f "usebackq delims=" %%I in (`git -C games\arkhamhorror status --porcelain`) do set "ARK_DIRTY=1"
:skip_arkham_dirty

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
if not defined HAS_ARKHAM goto hall_section
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
call :push_with_merge "games\arkhamhorror" "%ARK_BRANCH%"
if not "%PUSH_OK%"=="1" goto arkham_push_failed

:hall_section
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
call :push_with_merge "" "%HALL_BRANCH%"
if not "%PUSH_OK%"=="1" goto hall_push_failed

echo.
echo 推送完成：大厅 %HALL_BRANCH%
if defined HAS_ARKHAM echo              诡镇奇谈 %ARK_BRANCH%
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
echo        - 脚本已自动拉取远端并尝试合并；若仍失败，按上方提示手动处理；
echo        - 网络问题（Could not resolve host / Connection）：检查网络或代理后重新运行；
echo        - 手动重试：git -C games\arkhamhorror fetch origin ^&^& git -C games\arkhamhorror merge origin/%ARK_BRANCH%
set "RESULT=1"
goto finish

:hall_push_failed
echo [错误] 推送大厅失败。
echo        - 诡镇奇谈已经推送成功；大厅的本地提交仍在；
echo        - 脚本已自动拉取远端并尝试合并；若仍失败，按上方提示手动处理；
echo        - 网络问题：检查网络或代理后重新运行；
echo        - 手动重试：git fetch origin ^&^& git merge origin/%HALL_BRANCH% ^&^& git push origin %HALL_BRANCH%
set "RESULT=1"
goto finish

:arkham_sync_failed
echo [错误] 诡镇奇谈自动合并远端失败，已停止推送（本地提交已保留，未完成的合并已取消）。
set "RESULT=1"
goto finish

:hall_sync_failed
echo [错误] 大厅自动合并远端失败，已停止推送（本地提交已保留，未完成的合并已取消）。
set "RESULT=1"
goto finish

:progress_pending
echo [错误] %PROGRESS_REPO% 有未完成的合并或变基，脚本已停止（避免提交、推送半成品）。
echo        请到对应仓库目录手动处理（大厅在根目录，诡镇奇谈在 games\arkhamhorror）：
echo          git status
echo          想放弃这次合并/变基：git merge --abort 或 git rebase --abort
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
REM 落后时快进；分叉时自动合并远端（merge，不改写本地提交）。
REM   %1 = 子仓库相对路径（大厅传空 ""），%2 = 要推送的分支名
REM   返回 SYNC_OK=1 表示可以继续推送，0 表示已停止
REM ---------------------------------------------------------------------------
:sync_branch
set "SYNC_OK=1"
set "SYNC_BR=%~2"
set "SYNC_PUSHD="
set "SYNC_FULLPATH=%CD%"

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

echo   本地与远端分叉，正在自动合并远端提交（merge）...
git merge --no-edit "origin/%SYNC_BR%"
if errorlevel 1 goto sync_conflict
echo   合并完成。
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
git merge --abort >nul 2>nul
echo.
echo   [错误] 自动合并远端失败（多半是代码冲突），脚本已停止，你的本地提交都还在。
echo          未完成的合并已自动取消，工作区恢复到合并前。
echo          如需手动合并，请到 "%SYNC_FULLPATH%"：
echo            git fetch origin
echo            git merge origin/%SYNC_BR%
echo            解决冲突后：git add -A 然后 git commit
echo            不想合并：git merge --abort
set "SYNC_OK=0"

:sync_exit
if defined SYNC_PUSHD popd
goto :eof

REM ---------------------------------------------------------------------------
REM 检查仓库里有没有上次没收尾的合并/变基（有的话先停下，避免提交半成品）。
REM   %1 = 打印用的仓库名，%2 = .git 目录的相对路径
REM   返回 CLEAN_STATE=1 表示没有未完成状态，0 表示有
REM ---------------------------------------------------------------------------
:check_progress
set "PROGRESS_REPO=%~1"
set "PROGRESS_GITDIR=%~2"
set "CLEAN_STATE=1"
if exist "%PROGRESS_GITDIR%\MERGE_HEAD" set "CLEAN_STATE=0"
if exist "%PROGRESS_GITDIR%\rebase-merge" set "CLEAN_STATE=0"
if exist "%PROGRESS_GITDIR%\rebase-apply" set "CLEAN_STATE=0"
goto :eof

REM ---------------------------------------------------------------------------
REM 推送一个仓库；被远端拒绝时自动 fetch + merge 远端，然后再推一次（最多 3 次尝试）。
REM 只有“被远端拒绝”（别人先推了新提交）才重试；网络、权限等错误直接报错。
REM   %1 = 子仓库相对路径（大厅传空 ""），%2 = 要推送的分支名
REM   返回 PUSH_OK=1 表示推送成功，0 表示失败
REM ---------------------------------------------------------------------------
:push_with_merge
set "PUSH_OK=0"
set "PUSH_BR=%~2"
set "PUSH_TRY=0"
set "PUSH_PUSHD="
set "PUSH_LOG=%TEMP%\boardgame-hall-push.log"

if "%~1"=="" goto push_next_try
pushd "%~1" 2>nul
if errorlevel 1 goto push_bad_dir
set "PUSH_PUSHD=1"

:push_next_try
set /a PUSH_TRY+=1
if "%PUSH_TRY%"=="1" goto push_first_try
echo   自动拉取并合并完成，正在重新推送...
goto push_run

:push_first_try
echo   推送到 origin/%PUSH_BR%...

:push_run
git push origin "%PUSH_BR%" >"%PUSH_LOG%" 2>&1
if not errorlevel 1 goto push_ok

if %PUSH_TRY% GEQ 3 goto push_gave_up

REM 先排除“远端拒绝但不该重试”的情况（例如分支保护），再判断是否值得自动重试。
findstr /i /c:"remote rejected" >nul "%PUSH_LOG%"
if not errorlevel 1 goto push_failed
findstr /i /c:"rejected" /c:"non-fast-forward" /c:"fetch first" /c:"behind its remote" >nul "%PUSH_LOG%"
if errorlevel 1 goto push_failed

echo   远端在推送期间又有新提交，正在自动拉取并合并后重试...
REM 此时当前目录已经是要推送的仓库（大厅根目录或 games\arkhamhorror），所以传空路径。
call :sync_branch "" "%PUSH_BR%"
if not "%SYNC_OK%"=="1" goto push_exit
goto push_next_try

:push_ok
set "PUSH_OK=1"
echo   推送完成。
goto push_exit

:push_failed
echo.
echo   [错误] 推送失败，详细原因：
type "%PUSH_LOG%"
goto push_exit

:push_gave_up
echo.
echo   [错误] 推送被远端拒绝，自动重试 3 次仍未成功，详细原因：
type "%PUSH_LOG%"
goto push_exit

:push_bad_dir
echo   [错误] 无法进入子仓库 "%~1"，已跳过推送。
goto push_exit

:push_exit
del "%PUSH_LOG%" >nul 2>nul
if defined PUSH_PUSHD popd
goto :eof
