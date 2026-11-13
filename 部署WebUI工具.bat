@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title DDSP WebUI 部署工具
color 0B

set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"
for %%I in ("%SRC%") do set "SRC=%%~fI"

rem 如果整个工具包文件夹被放进了整合包, 目标就是上一层
set "TARGET=%SRC%"
if exist "%SRC%\..\env\python.exe" if exist "%SRC%\..\reflow\solver.py" for %%I in ("%SRC%\..") do set "TARGET=%%~fI"

echo ================================================================
echo                  DDSP WebUI 工具包 部署
echo ================================================================
echo   源目录 : %SRC%
echo   整合包 : %TARGET%
echo.

if not exist "%TARGET%\env\python.exe" goto no_pack
if not exist "%TARGET%\train_reflow.py" goto no_pack
if not exist "%TARGET%\reflow\solver.py" goto no_pack
if /I "%SRC%"=="%TARGET%" goto already_here

rem ================= 1. 备份 =================
:do_copy
set "BACKUP=%TARGET%\_webui_backup"
set /a IDX=1
:find_backup
if not exist "%BACKUP%" goto backup_ready
set "BACKUP=%TARGET%\_webui_backup_!IDX!"
set /a IDX+=1
goto find_backup

:backup_ready
mkdir "%BACKUP%" >nul 2>nul
echo [1/3] 备份将被覆盖的旧文件 ...
if exist "%TARGET%\webui" xcopy "%TARGET%\webui" "%BACKUP%\webui\" /E /I /Y /Q >nul
if exist "%TARGET%\reflow\solver.py" xcopy "%TARGET%\reflow\solver.py" "%BACKUP%\reflow\" /I /Y /Q >nul
if exist "%TARGET%\logger\saver.py" xcopy "%TARGET%\logger\saver.py" "%BACKUP%\logger\" /I /Y /Q >nul
if exist "%TARGET%\logger\utils.py" xcopy "%TARGET%\logger\utils.py" "%BACKUP%\logger\" /I /Y /Q >nul
if exist "%TARGET%\configs\reflow-barbara.yaml" xcopy "%TARGET%\configs\reflow-barbara.yaml" "%BACKUP%\configs\" /I /Y /Q >nul
if exist "%TARGET%\configs\reflow-barbara-cpu.yaml" xcopy "%TARGET%\configs\reflow-barbara-cpu.yaml" "%BACKUP%\configs\" /I /Y /Q >nul
if exist "%TARGET%\configs\reflow.yaml" xcopy "%TARGET%\configs\reflow.yaml" "%BACKUP%\configs\" /I /Y /Q >nul
if exist "%TARGET%\preprocess.py" copy /Y "%TARGET%\preprocess.py" "%BACKUP%\preprocess.py" >nul
if exist "%TARGET%\train_reflow.py" copy /Y "%TARGET%\train_reflow.py" "%BACKUP%\train_reflow.py" >nul
if exist "%TARGET%\启动WebUI.bat" copy /Y "%TARGET%\启动WebUI.bat" "%BACKUP%\启动WebUI.bat" >nul
if exist "%TARGET%\打开webui.bat" copy /Y "%TARGET%\打开webui.bat" "%BACKUP%\打开webui.bat" >nul
if exist "%TARGET%\停止WebUI.bat" copy /Y "%TARGET%\停止WebUI.bat" "%BACKUP%\停止WebUI.bat" >nul
if exist "%TARGET%\WebUI使用说明.md" copy /Y "%TARGET%\WebUI使用说明.md" "%BACKUP%\WebUI使用说明.md" >nul
echo       备份目录 : %BACKUP%

rem ================= 2. 复制 =================
echo [2/3] 复制 WebUI 文件 ...
if not exist "%TARGET%\configs" mkdir "%TARGET%\configs" >nul 2>nul
set "KEEP_LABELS="
if exist "%TARGET%\webui\model_labels.json" set "KEEP_LABELS=1"
xcopy "%SRC%\webui" "%TARGET%\webui\" /E /I /Y /Q >nul
if defined KEEP_LABELS copy /Y "%BACKUP%\webui\model_labels.json" "%TARGET%\webui\model_labels.json" >nul
if defined KEEP_LABELS if exist "%BACKUP%\webui\model_label_meta.json" copy /Y "%BACKUP%\webui\model_label_meta.json" "%TARGET%\webui\model_label_meta.json" >nul

copy /Y "%SRC%\preprocess.py" "%TARGET%\preprocess.py" >nul
copy /Y "%SRC%\train_reflow.py" "%TARGET%\train_reflow.py" >nul
copy /Y "%SRC%\reflow\solver.py" "%TARGET%\reflow\solver.py" >nul
copy /Y "%SRC%\logger\saver.py" "%TARGET%\logger\saver.py" >nul
copy /Y "%SRC%\logger\utils.py" "%TARGET%\logger\utils.py" >nul
copy /Y "%SRC%\configs\reflow-barbara.yaml" "%TARGET%\configs\reflow-barbara.yaml" >nul
copy /Y "%SRC%\configs\reflow-barbara-cpu.yaml" "%TARGET%\configs\reflow-barbara-cpu.yaml" >nul
copy /Y "%SRC%\configs\reflow.yaml" "%TARGET%\configs\reflow.yaml" >nul
copy /Y "%SRC%\启动WebUI.bat" "%TARGET%\启动WebUI.bat" >nul
copy /Y "%SRC%\打开webui.bat" "%TARGET%\打开webui.bat" >nul
copy /Y "%SRC%\停止WebUI.bat" "%TARGET%\停止WebUI.bat" >nul
copy /Y "%SRC%\WebUI使用说明.md" "%TARGET%\WebUI使用说明.md" >nul
goto verify

rem ================= 3. 检查 =================
:verify
echo [3/3] 检查部署结果 ...
set "FAIL=0"
call :check_file "webui\app.py"
call :check_file "webui\core.py"
call :check_file "webui\tasks.py"
call :check_file "webui\inference.py"
call :check_file "webui\static\index.html"
call :check_file "webui\static\js\app.js"
call :check_file "webui\static\js\pages\infer.js"
call :check_file "preprocess.py"
call :check_file "train_reflow.py"
call :check_file "reflow\solver.py"
call :check_file "logger\saver.py"
call :check_file "logger\utils.py"
call :check_file "configs\reflow-barbara.yaml"
call :check_file "启动WebUI.bat"
call :check_file "打开webui.bat"
call :check_file "停止WebUI.bat"
call :check_file "WebUI使用说明.md"
call :check_file "env\python.exe"
echo.
if "%FAIL%"=="1" goto some_failed
goto all_ok

:check_file
if exist "%TARGET%\%~1" goto file_ok
echo   [FAIL] %~1
set "FAIL=1"
goto :eof
:file_ok
echo   [OK]   %~1
goto :eof

rem ================= 结果 =================
:all_ok
echo ================================================================
echo   部署完成!
echo   回到整合包根目录, 双击 启动WebUI.bat 即可使用
echo   地址: http://127.0.0.1:7890/
echo ================================================================
if defined BACKUP echo   旧文件已备份到 : %BACKUP%
echo.
pause
exit /b 0

:some_failed
echo [ERROR] 有文件没有复制成功
echo   请确认工具包完整, 整合包目录可写
echo   或者先关闭正在运行的 WebUI 再重试
echo   也可以手动复制工具包里所有内容到整合包根目录
echo.
pause
exit /b 1

:already_here
echo [INFO] 工具包内容已在整合包根目录, 跳过复制, 只做检查
goto verify

:no_pack
echo [ERROR] 没有找到 DDSP 整合包
echo   缺少 env\python.exe 或 train_reflow.py
echo.
echo   请把整个工具包文件夹放进整合包根目录后再运行
echo   或者把工具包里的内容全部复制到整合包根目录
echo.
pause
exit /b 1
