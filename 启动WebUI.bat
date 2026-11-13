@echo off
chcp 65001 >nul
title DDSP Studio WebUI
cd /d "%~dp0"

rem A medium-integrity relaunch skips the integrity checks.
if /I "%~1"=="--medium" goto run

echo ================================================================
echo                  DDSP Studio WebUI
echo ================================================================
echo Starting the local service. This may take a few seconds...
echo.

if not exist "%~dp0webui\launcher.py" (
    echo [ERROR] webui\launcher.py not found
    pause
    exit /b 1
)

set "LOW=0"
whoami /groups 2>nul | find "S-1-16-4096" >nul
if not errorlevel 1 set "LOW=1"

set "HIGH=0"
whoami /groups 2>nul | find "S-1-16-12288" >nul
if not errorlevel 1 set "HIGH=1"

rem Low-integrity processes cannot create browser profiles or start Chromium.
rem Ask Windows for a normal-level relaunch (one UAC prompt).
if "%LOW%"=="1" (
    echo [INFO] Low integrity detected. Requesting a normal-level relaunch...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '--elevated' -Verb RunAs"
    if errorlevel 1 (
        echo [ERROR] The normal-level relaunch was cancelled.
        echo Open http://127.0.0.1:7890/ manually, or start this file from
        echo Windows Explorer.
        pause
    )
    exit /b 0
)

rem An elevated console cannot start Chromium. Drop to a basic-user token and
rem let that process start the server and browser.
if "%HIGH%"=="1" (
    echo [INFO] Administrator token detected. Relaunching at normal user level...
    runas /trustlevel:0x20000 "cmd.exe /c %~f0 --medium"
    echo.
    echo If no new window appeared, close this window and run this file from
    echo Windows Explorer without "Run as administrator".
    pause
    exit /b 0
)

:run
if not exist "%~dp0webui\launcher.py" (
    echo [ERROR] webui\launcher.py not found
    pause
    exit /b 1
)

rem Launch the browser opener logic directly (avoids encoding issues with the
rem Chinese-named helper batch). The standalone open helper uses the same wait.
start "" powershell -NoProfile -WindowStyle Hidden -Command "$u='http://127.0.0.1:7890/api/ping'; for($i=0;$i -lt 80;$i++){ try { Invoke-RestMethod $u -TimeoutSec 1 | Out-Null; Start-Process 'http://127.0.0.1:7890/'; exit 0 } catch { Start-Sleep -Milliseconds 500 } }"

echo Starting server; logs will appear below.
echo Keep this window open while using the WebUI.
echo Closing this window stops the service.
echo.

"%~dp0env\python.exe" "%~dp0webui\launcher.py" --console --no-browser

echo.
echo The WebUI service has stopped. All DDSP child tasks have been terminated.
echo If this was unexpected, see webui\logs\launcher.log and server.log.
timeout /t 5 >nul
exit /b 0
