@echo off
title Delux Radio Server
color 0B
cls
chcp 65001 >nul 2>&1

echo.
echo  ########  #######  ##       ##     ## ##     ## 
echo  ##     ## ##       ##       ##     ##  ##   ##  
echo  ##     ## ##       ##       ##     ##   ## ##   
echo  ##     ## ######   ##       ##     ##    ###    
echo  ##     ## ##       ##       ##     ##   ## ##   
echo  ##     ## ##       ##       ##     ##  ##   ##  
echo  ########  #######  ########  #######  ##     ## 
echo.
echo  ########     ###    ########  ####  #######  
echo  ##     ##   ## ##   ##     ##  ##  ##     ## 
echo  ##     ##  ##   ##  ##     ##  ##  ##     ## 
echo  ########  ##     ## ##     ##  ##  ##     ## 
echo  ##   ##   ######### ##     ##  ##  ##     ## 
echo  ##    ##  ##     ## ##     ##  ##  ##     ## 
echo  ##     ## ##     ## ########  ####  #######  
echo.
echo                   90s Bollywood Radio Station
echo =================================================================
echo.

cd /d "%~dp0backend"

:: [1/7] Create venv if it doesn't exist
if not exist "..\venv" (
    echo  [*] Step 1/7: Creating Python virtual environment...
    call "..\setup.bat"
    if errorlevel 1 (
        echo.
        echo  [-] ERROR: Failed to set up environment.
        echo.
        pause
        exit /b 1
    )
    echo  [+] Success: Virtual environment created.
    echo.
) else (
    echo  [i] Step 1/7: Virtual environment found.
    echo.
)

:: [2/7] Activate venv
call "..\venv\Scripts\activate.bat"
echo  [i] Step 2/7: Virtual environment activated.
echo.

:: [3/7] Install / upgrade all dependencies
echo  [*] Step 3/7: Installing / updating dependencies...
pip install -r "..\requirements.txt" -q --no-warn-script-location
if errorlevel 1 (
    echo  [-] Warning: Some packages may have failed. Continuing anyway...
) else (
    echo  [+] Success: Core dependencies ready.
)
echo.

:: [4/7] Auto-update yt-dlp to latest nightly
echo  [*] Step 4/7: Updating yt-dlp (keeps YouTube stream extraction working)...
pip install "yt-dlp[default]" --pre -U -q --no-warn-script-location
if errorlevel 1 (
    echo  [-] Warning: yt-dlp update failed. Using existing version.
) else (
    for /f "tokens=*" %%v in ('python -c "import yt_dlp; print(yt_dlp.version.__version__)" 2^>nul') do (
        echo  [+] Success: yt-dlp is now at version %%v
    )
)
echo.

:: [5/7] Create required directories
echo  [*] Step 5/7: Setting up required directories...

if not exist "audio" (
    mkdir audio
    echo  [+] Created: backend\audio\
) else (
    echo  [i] Exists:  backend\audio\
)

if not exist "audio\rj" (
    mkdir audio\rj
    echo  [+] Created: backend\audio\rj\
) else (
    echo  [i] Exists:  backend\audio\rj\
)

if not exist "audio\mixed" (
    mkdir audio\mixed
    echo  [+] Created: backend\audio\mixed\
) else (
    echo  [i] Exists:  backend\audio\mixed\
)

if not exist "audio\tts" (
    mkdir audio\tts
    echo  [+] Created: backend\audio\tts\
) else (
    echo  [i] Exists:  backend\audio\tts\
)

cd /d "%~dp0"

if not exist "assets" (
    mkdir assets
    echo  [+] Created: assets\
) else (
    echo  [i] Exists:  assets\
)

cd /d "%~dp0backend"
echo.

:: [5b] Create .env file if missing
if not exist ".env" (
    echo  [*] Setting up environment configuration...
    (
        echo # Delux Radio - Environment Configuration
        echo # Edit this file to customise your setup
        echo.
        echo # Admin credentials
        echo ADMIN_USERNAME=admin
        echo ADMIN_PASSWORD=delux2025
        echo SECRET_KEY=delux-radio-secret-key-change-me-in-production
        echo.
        echo # Database
        echo DATABASE_URL=sqlite:///./delux_radio.db
        echo.
        echo # Optional AI / TTS features
        echo # OPENAI_API_KEY=sk-...
        echo # ELEVENLABS_API_KEY=...
        echo # GEMINI_API_KEY=AIza...
        echo.
        echo # Server
        echo HOST=0.0.0.0
        echo PORT=8000
    ) > .env
    echo  [+] Success: .env created. Edit backend\.env to customise credentials.
) else (
    echo  [i] Config:  .env already exists. Skipping.
)
echo.

:: [6/7] Initialise database (tables + seed songs)
echo  [*] Step 6/7: Initialising database...
if not exist "delux_radio.db" (
    echo  [*] Creating fresh database and seeding songs...
    python -c "from database import create_tables; create_tables()"
    if errorlevel 1 (
        echo  [-] ERROR: Failed to create database tables!
        pause
        exit /b 1
    )
    python seed_songs.py
    if errorlevel 1 (
        echo  [-] Warning: Seed songs script had errors. DB tables are still created.
    ) else (
        echo  [+] Success: Database initialised and songs seeded.
    )
) else (
    echo  [i] Database already exists. Skipping seed.
    echo      (Delete backend\delux_radio.db to force a fresh setup)
)
echo.

:: Optional: FFmpeg check
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo  [-] Warning: FFmpeg not found. Audio mixing will be limited.
    echo      Download: https://ffmpeg.org/download.html
    echo.
) else (
    echo  [+] FFmpeg found.
    echo.
)

:: Optional: Node.js check
node --version >nul 2>&1
if errorlevel 1 (
    echo  [-] Warning: Node.js not found. YouTube extraction may fail for some songs.
    echo      Download: https://nodejs.org/
    echo.
) else (
    for /f "tokens=*" %%n in ('node --version 2^>nul') do (
        echo  [+] Node.js %%n found. (YouTube JS solving enabled)
    )
    echo.
)

:: [7/7] Start server
echo  [*] Step 7/7: Starting Delux Radio...
echo.
echo  =================================================================
echo.
echo    [i] Main Player  -^>  http://localhost:8000
echo    [i] Admin Panel  -^>  http://localhost:8000/admin
echo    [i] Admin Login  -^>  admin / delux2025
echo.
echo  =================================================================
echo.
echo  Press Ctrl+C to stop the server.
echo.

python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

pause
