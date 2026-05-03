@echo off
setlocal
cd /d "%~dp0"

if not exist ".\.venv\Scripts\python.exe" (
  echo [ERROR] Python venv not found: .\.venv\Scripts\python.exe
  pause
  exit /b 1
)

echo [INFO] This will archive current stable progress files and reset the manual loop state.
echo [INFO] Use this only when you want to restart all tasks from the beginning.
set /p CONFIRM="Type RESET to continue: "
if /I not "%CONFIRM%"=="RESET" (
  echo [INFO] Canceled.
  pause
  exit /b 0
)

".\.venv\Scripts\python.exe" "scripts\init_manual_loop_state.py"
set "EC=%ERRORLEVEL%"

echo.
echo [INFO] Process exited with code %EC%.
pause
exit /b %EC%
