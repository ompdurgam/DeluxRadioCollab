#!/usr/bin/env bash
# ==============================================================================
# Delux Radio — Linux Startup Script (converted from start.bat)
# ==============================================================================

set -e

# Terminal colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${SCRIPT_DIR}/backend"

echo ""
echo -e "${CYAN}${BOLD}"
echo " ########  #######  ##       ##     ## ##     ## "
echo " ##     ## ##       ##       ##     ##  ##   ##  "
echo " ##     ## ##       ##       ##     ##   ## ##   "
echo " ##     ## ######   ##       ##     ##    ###    "
echo " ##     ## ##       ##       ##     ##   ## ##   "
echo " ##     ## ##       ##       ##     ##  ##   ##  "
echo " ########  #######  ########  #######  ##     ## "
echo ""
echo " ########     ###    ########  ####  #######  "
echo " ##     ##   ## ##   ##     ##  ##  ##     ## "
echo " ##     ##  ##   ##  ##     ##  ##  ##     ## "
echo " ########  ##     ## ##     ##  ##  ##     ## "
echo " ##   ##   ######### ##     ##  ##  ##     ## "
echo " ##    ##  ##     ## ##     ##  ##  ##     ## "
echo " ##     ## ##     ## ########  ####  #######  "
echo -e "${NC}"
echo "                  90s Bollywood Radio Station"
echo "================================================================="
echo ""

cd "${BACKEND_DIR}"

# [1/7] Create venv if it doesn't exist
if [ ! -d "${SCRIPT_DIR}/venv" ]; then
    echo " [*] Step 1/7: Creating Python virtual environment..."
    if [ -f "${SCRIPT_DIR}/setup.sh" ]; then
        bash "${SCRIPT_DIR}/setup.sh"
    else
        python3 -m venv "${SCRIPT_DIR}/venv"
        source "${SCRIPT_DIR}/venv/bin/activate"
        pip install -r "${SCRIPT_DIR}/requirements.txt" -q --no-warn-script-location || true
    fi
    echo " [+] Success: Virtual environment created."
    echo ""
else
    echo " [i] Step 1/7: Virtual environment found."
    echo ""
fi

# [2/7] Activate venv
if [ -f "${SCRIPT_DIR}/venv/bin/activate" ]; then
    source "${SCRIPT_DIR}/venv/bin/activate"
elif [ -f "${SCRIPT_DIR}/venv/Scripts/activate" ]; then
    source "${SCRIPT_DIR}/venv/Scripts/activate"
else
    echo -e "${RED}[-] ERROR: Could not find virtual environment activation script.${NC}"
    exit 1
fi
echo " [i] Step 2/7: Virtual environment activated."
echo ""

# [3/7] Install / upgrade all dependencies
echo " [*] Step 3/7: Installing / updating dependencies..."
if pip install -r "${SCRIPT_DIR}/requirements.txt" -q --no-warn-script-location; then
    echo " [+] Success: Core dependencies ready."
else
    echo " [-] Warning: Some packages may have failed. Continuing anyway..."
fi
echo ""

# [4/7] Auto-update yt-dlp to latest nightly
echo " [*] Step 4/7: Updating yt-dlp (keeps YouTube stream extraction working)..."
if pip install "yt-dlp[default]" --pre -U -q --no-warn-script-location 2>/dev/null; then
    YTDLP_VER=$(python -c "import yt_dlp; print(yt_dlp.version.__version__)" 2>/dev/null || true)
    if [ -n "$YTDLP_VER" ]; then
        echo " [+] Success: yt-dlp is now at version ${YTDLP_VER}"
    else
        echo " [+] Success: yt-dlp updated."
    fi
else
    echo " [-] Warning: yt-dlp update failed. Using existing version."
fi
echo ""

# [5/7] Create required directories
echo " [*] Step 5/7: Setting up required directories..."

for dir in "audio" "audio/rj" "audio/mixed" "audio/tts"; do
    if [ ! -d "${BACKEND_DIR}/${dir}" ]; then
        mkdir -p "${BACKEND_DIR}/${dir}"
        echo " [+] Created: backend/${dir}/"
    else
        echo " [i] Exists:  backend/${dir}/"
    fi
done

if [ ! -d "${SCRIPT_DIR}/assets" ]; then
    mkdir -p "${SCRIPT_DIR}/assets"
    echo " [+] Created: assets/"
else
    echo " [i] Exists:  assets/"
fi
echo ""

# [5b] Create .env file if missing
if [ ! -f "${BACKEND_DIR}/.env" ]; then
    echo " [*] Setting up environment configuration..."
    cat << 'EOF' > "${BACKEND_DIR}/.env"
# Delux Radio - Environment Configuration
# Edit this file to customise your setup

# Admin credentials
ADMIN_USERNAME=admin
ADMIN_PASSWORD=delux2025
SECRET_KEY=delux-radio-secret-key-change-me-in-production

# Database
DATABASE_URL=sqlite:///./delux_radio.db

# Optional AI / TTS features
# OPENAI_API_KEY=sk-...
# ELEVENLABS_API_KEY=...
# GEMINI_API_KEY=AIza...

# Server
HOST=0.0.0.0
PORT=8000
EOF
    echo " [+] Success: .env created. Edit backend/.env to customise credentials."
else
    echo " [i] Config:  .env already exists. Skipping."
fi
echo ""

# [6/7] Initialise database (tables + seed songs)
echo " [*] Step 6/7: Initialising database..."
if [ ! -f "${BACKEND_DIR}/delux_radio.db" ]; then
    echo " [*] Creating fresh database and seeding songs..."
    if ! python -c "from database import create_tables; create_tables()"; then
        echo -e "${RED}[-] ERROR: Failed to create database tables!${NC}"
        exit 1
    fi
    if python seed_songs.py; then
        echo " [+] Success: Database initialised and songs seeded."
    else
        echo " [-] Warning: Seed songs script had errors. DB tables are still created."
    fi
else
    echo " [i] Database already exists. Skipping seed."
    echo "     (Delete backend/delux_radio.db to force a fresh setup)"
fi
echo ""

# Optional: FFmpeg check
if ! command -v ffmpeg >/dev/null 2>&1; then
    echo " [-] Warning: FFmpeg not found. Audio mixing will be limited."
    echo "     Download: https://ffmpeg.org/download.html or install via: sudo apt install ffmpeg"
    echo ""
else
    echo " [+] FFmpeg found."
    echo ""
fi

# Optional: Node.js check
if ! command -v node >/dev/null 2>&1; then
    echo " [-] Warning: Node.js not found. YouTube extraction may fail for some songs."
    echo "     Download: https://nodejs.org/"
    echo ""
else
    NODE_VER=$(node --version 2>/dev/null || true)
    echo " [+] Node.js ${NODE_VER} found. (YouTube JS solving enabled)"
    echo ""
fi

# [7/7] Start server
echo " [*] Step 7/7: Starting Delux Radio..."
echo ""
echo " ================================================================="
echo ""
echo "   [i] Main Player  ->  http://localhost:8000"
echo "   [i] Admin Panel  ->  http://localhost:8000/admin"
echo "   [i] Admin Login  ->  admin / delux2025"
echo ""
echo " ================================================================="
echo ""
echo " Press Ctrl+C to stop the server."
echo ""

exec python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
