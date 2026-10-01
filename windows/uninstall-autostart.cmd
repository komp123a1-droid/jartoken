@echo off
REM Stops and removes the $JAR autostart task. Run as administrator.
set PIDFILE=%~dp0..\logs\run.pid
schtasks /end /tn "JAR coin" 2>nul
if not exist "%PIDFILE%" goto remove
set /p RUNPID=<"%PIDFILE%"
taskkill /pid %RUNPID% /t /f
:remove
schtasks /delete /tn "JAR coin" /f
echo Uklonjeno.
pause
