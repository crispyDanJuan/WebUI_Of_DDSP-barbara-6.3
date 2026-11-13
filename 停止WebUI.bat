@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================ Stopping DDSP WebUI ================================
if exist "env\python.exe" (
    "%~dp0env\python.exe" "%~dp0webui\stop.py"
) else (
    python "%~dp0webui\stop.py"
)
ping -n 3 127.0.0.1 >nul
exit /b 0
