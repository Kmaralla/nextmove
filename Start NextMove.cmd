@echo off
cd /d "%~dp0"
title NextMove Development Server
set "NEEDS_KEY=1"
if exist ".env" (
  findstr /R /C:"^OPENAI_API_KEY=.." ".env" >nul 2>&1 && set "NEEDS_KEY=0"
)
if "%NEEDS_KEY%"=="1" (
  echo NextMove needs an OpenAI API key for real analysis.
  echo Create one at https://platform.openai.com/api-keys
  echo The key will be saved only in this local, git-ignored workspace file.
  echo.
  set /p "NEXTMOVE_KEY=Paste your API key here and press Enter: "
  if not defined NEXTMOVE_KEY (
    echo No key was entered. NextMove was not started.
    pause
    exit /b 1
  )
  > ".env" echo OPENAI_API_KEY=%NEXTMOVE_KEY%
  >> ".env" echo OPENAI_MODEL=gpt-5.4-mini
  set "NEXTMOVE_KEY="
)
echo Starting NextMove at http://localhost:4318/
echo Keep this window open while using the app.
echo.
node server.js
pause
