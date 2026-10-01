@echo off
REM Starts the $JAR backend + site when Windows boots (before anyone logs in) and keeps them running.
REM Right-click -> "Run as administrator".
setlocal
set ROOT=%~dp0..
for %%I in ("%ROOT%") do set ROOT=%%~fI
for /f "delims=" %%N in ('where node') do (set NODE=%%N& goto :found)
echo Node.js nije pronadjen. Instaliraj Node 22+ sa nodejs.org.& pause & exit /b 1
:found
schtasks /create /tn "JAR coin" /tr "\"%NODE%\" \"%ROOT%\run.js\"" /sc onstart /ru SYSTEM /rl HIGHEST /f
if errorlevel 1 (echo Pokreni kao administrator.& pause & exit /b 1)
schtasks /run /tn "JAR coin"
echo.
echo Gotovo. Backend i sajt se pale sa Windowsom. Logovi: %ROOT%\logs
echo Provera: http://127.0.0.1:8787  i  http://127.0.0.1:8787/test/
pause
