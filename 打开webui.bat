@echo off
chcp 65001 >nul
title DDSP Studio WebUI - Open
cd /d "%~dp0"

echo Waiting for the local WebUI service...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='http://127.0.0.1:7890/api/ping'; for($i=0;$i -lt 80;$i++){ try { Invoke-RestMethod $u -TimeoutSec 1 | Out-Null; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
if errorlevel 1 (
    echo [ERROR] WebUI service is not running.
    echo Double-click the start script first.
    pause
    exit /b 1
)

start "" "http://127.0.0.1:7890/"
exit /b 0
