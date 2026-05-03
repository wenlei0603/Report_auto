@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PYTHONPATH=%CD%\.deps"
set "BROWSER_EXE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "BROWSER_PROFILE=D:\edge-rpa-profile"
set "CDP_URL=http://127.0.0.1:9222/json/version"
set "WORKSPACE_URL=https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID#/?st=OAPermID"
set "CURL_EXE=%SystemRoot%\System32\curl.exe"

if not exist ".\.venv\Scripts\python.exe" (
  echo [ERROR] Python venv not found: .\.venv\Scripts\python.exe
  pause
  exit /b 1
)

if not exist "!BROWSER_EXE!" (
  echo [ERROR] Edge not found: !BROWSER_EXE!
  pause
  exit /b 1
)

if not exist "!CURL_EXE!" (
  echo [ERROR] curl.exe not found: !CURL_EXE!
  pause
  exit /b 1
)

echo [INFO] Checking browser CDP on port 9222...
call :wait_for_cdp 2
if errorlevel 1 (
  echo [INFO] Starting Edge with remote debugging port 9222...
  start "" "!BROWSER_EXE!" --remote-debugging-port=9222 --user-data-dir="!BROWSER_PROFILE!" "!WORKSPACE_URL!"
  call :wait_for_cdp 20
  if errorlevel 1 (
    echo [ERROR] Edge CDP did not become ready on port 9222.
    echo [ERROR] Edge may have opened without binding DevTools to 9222.
    pause
    exit /b 1
  )
) else (
  echo [INFO] Existing browser CDP detected.
)

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "RUN_TAG=%%i"

set "STATUS_LOG=logs\manual_task_status_%RUN_TAG%.jsonl"
set "PROGRESS_CSV=output\manual_task_progress_%RUN_TAG%.csv"
set "MAPPING_CSV=output\task_file_mapping_%RUN_TAG%.csv"
set "RUN_LOG=logs\run_log_%RUN_TAG%.jsonl"
set "RUN_INFO=logs\manual_loop_run_%RUN_TAG%.txt"

echo RUN_TAG=%RUN_TAG%> "%RUN_INFO%"
echo STATUS_LOG=%STATUS_LOG%>> "%RUN_INFO%"
echo PROGRESS_CSV=%PROGRESS_CSV%>> "%RUN_INFO%"
echo MAPPING_CSV=%MAPPING_CSV%>> "%RUN_INFO%"
echo RUN_LOG=%RUN_LOG%>> "%RUN_INFO%"

echo [INFO] New run files:
echo   %STATUS_LOG%
echo   %PROGRESS_CSV%
echo   %MAPPING_CSV%
echo   %RUN_LOG%
echo [INFO] Run info saved: %RUN_INFO%
echo.

".\.venv\Scripts\python.exe" "scripts\manual_loop_driver.py" ^
  --config "config\config.yaml" ^
  --status-log "%STATUS_LOG%" ^
  --progress-csv "%PROGRESS_CSV%" ^
  --mapping-csv "%MAPPING_CSV%" ^
  --run-log-jsonl "%RUN_LOG%" ^
  --day-page-limit 650

set "EC=%ERRORLEVEL%"
echo.
echo [INFO] Process exited with code %EC%.
pause
exit /b %EC%

:wait_for_cdp
setlocal EnableDelayedExpansion
set "WAIT_SECONDS=%~1"
if not defined WAIT_SECONDS set "WAIT_SECONDS=20"
set /a ATTEMPTS=WAIT_SECONDS
if !ATTEMPTS! LSS 1 set /a ATTEMPTS=1

for /l %%i in (1,1,!ATTEMPTS!) do (
  "!CURL_EXE!" --silent --show-error --fail --max-time 1 "!CDP_URL!" >nul 2>nul
  if not errorlevel 1 (
    endlocal & exit /b 0
  )
  >nul ping 127.0.0.1 -n 2
)

endlocal & exit /b 1
