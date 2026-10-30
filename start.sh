#!/usr/bin/env bash
# ==============================================================================
# Delux Radio — Startup Script (Linux & Google Colab)
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

# Parse tunnel argument if provided
TUNNEL_MODE=""
for arg in "$@"; do
    case "$arg" in
        --pinggy|--pinngy|pinggy|pinngy)
            TUNNEL_MODE="pinggy"
            ;;
        --cloudflare|-cf|cloudflare)
            TUNNEL_MODE="cloudflare"
            ;;
        --localtunnel|-lt|localtunnel)
            TUNNEL_MODE="localtunnel"
            ;;
        --tunnel=*)
            TUNNEL_MODE="${arg#*=}"
            ;;
    esac
done

cd "${BACKEND_DIR}"

# Find system Python
SYSTEM_PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
        SYSTEM_PYTHON="$cmd"
        break
    fi
done

if [ -z "$SYSTEM_PYTHON" ]; then
    echo -e "${RED}[-] ERROR: Python 3 not found. Please install python3.${NC}"
    exit 1
fi

# Detect Google Colab environment or existing virtualenv
IS_COLAB=0
if [ -d "/content" ] || [ -n "$COLAB_RELEASE_TAG" ] || [ -n "$COLAB_GPU" ] || "$SYSTEM_PYTHON" -c "import google.colab" >/dev/null 2>&1; then
    IS_COLAB=1
fi

if [ "$IS_COLAB" -eq 1 ]; then
    echo -e " ${GREEN}[i] Step 1/7: Google Colab environment detected.${NC}"
    echo "     Using Colab's Python directly (skipping sub-virtualenv)."
    echo ""
    echo -e " ${GREEN}[i] Step 2/7: Environment ready.${NC}"
    echo ""
    PYTHON_CMD="$SYSTEM_PYTHON"
    PIP_CMD="$PYTHON_CMD -m pip"
elif [ -n "$VIRTUAL_ENV" ]; then
    echo " [i] Step 1/7: Active virtual environment detected: $VIRTUAL_ENV"
    echo " [i] Step 2/7: Virtual environment already active."
    echo ""
    PYTHON_CMD="$SYSTEM_PYTHON"
    PIP_CMD="$PYTHON_CMD -m pip"
else
    # [1/7] Create venv if it doesn't exist
    if [ ! -d "${SCRIPT_DIR}/venv" ]; then
        echo " [*] Step 1/7: Creating Python virtual environment..."
        if [ -f "${SCRIPT_DIR}/setup.sh" ]; then
            bash "${SCRIPT_DIR}/setup.sh" || true
        else
            "$SYSTEM_PYTHON" -m venv "${SCRIPT_DIR}/venv" 2>/dev/null || true
        fi
        echo " [+] Virtual environment step finished."
        echo ""
    else
        echo " [i] Step 1/7: Virtual environment found."
        echo ""
    fi

    # [2/7] Activate venv
    if [ -f "${SCRIPT_DIR}/venv/bin/activate" ]; then
        source "${SCRIPT_DIR}/venv/bin/activate"
        PYTHON_CMD="${SCRIPT_DIR}/venv/bin/python"
        PIP_CMD="${SCRIPT_DIR}/venv/bin/pip"
        echo " [i] Step 2/7: Virtual environment activated."
    elif [ -f "${SCRIPT_DIR}/venv/Scripts/activate" ]; then
        source "${SCRIPT_DIR}/venv/Scripts/activate"
        PYTHON_CMD="${SCRIPT_DIR}/venv/Scripts/python"
        PIP_CMD="${SCRIPT_DIR}/venv/Scripts/pip"
        echo " [i] Step 2/7: Virtual environment activated."
    else
        echo " [!] Step 2/7: Virtual environment activate script not found. Using system Python."
        PYTHON_CMD="$SYSTEM_PYTHON"
        PIP_CMD="$PYTHON_CMD -m pip"
    fi
    echo ""
fi

# Detect if --break-system-packages is needed (Google Colab / Ubuntu 24.04 / PEP 668)
PIP_FLAGS="--no-warn-script-location"
if [ "$IS_COLAB" -eq 1 ] || [ -z "${VIRTUAL_ENV:-}" ]; then
    if $PIP_CMD install --help 2>&1 | grep -q -- '--break-system-packages'; then
        PIP_FLAGS="$PIP_FLAGS --break-system-packages"
    fi
fi

# [3/7] Install / upgrade all dependencies
echo " [*] Step 3/7: Installing / updating dependencies..."
if $PIP_CMD install -r "${SCRIPT_DIR}/requirements.txt" -q $PIP_FLAGS; then
    echo " [+] Success: Core dependencies ready."
else
    echo " [-] Warning: Some packages may have failed. Continuing anyway..."
fi
echo ""

# [4/7] Auto-update yt-dlp to latest nightly
echo " [*] Step 4/7: Updating yt-dlp (keeps YouTube stream extraction working)..."
if $PIP_CMD install "yt-dlp[default]" --pre -U -q $PIP_FLAGS 2>/dev/null; then
    YTDLP_VER=$($PYTHON_CMD -c "import yt_dlp; print(yt_dlp.version.__version__)" 2>/dev/null || true)
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
    if ! $PYTHON_CMD -c "from database import create_tables; create_tables()"; then
        echo -e "${RED}[-] ERROR: Failed to create database tables!${NC}"
        exit 1
    fi
    if $PYTHON_CMD seed_songs.py; then
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
    echo "     Install via: sudo apt install ffmpeg"
    echo ""
else
    echo " [+] FFmpeg found."
    echo ""
fi

# Optional: Node.js check
if ! command -v node >/dev/null 2>&1; then
    echo " [-] Warning: Node.js not found. YouTube extraction may fail for some songs."
    echo "     Install via: sudo apt install nodejs"
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
if [ "$IS_COLAB" -eq 1 ]; then
    echo ""
    echo -e "   ${YELLOW}[i] Running inside Google Colab!${NC}"
    echo "   [i] Public Tunnel Options (run in another cell or terminal):"
    echo -e "       ${CYAN}!bash tunnel.sh pinggy${NC}      (Pinggy SSH Tunnel - Zero Install)"
    echo -e "       ${CYAN}!bash tunnel.sh cloudflare${NC}  (Cloudflare Tunnel)"
    echo ""
    echo -e "   [i] Or run server + tunnel together: ${CYAN}!bash start.sh --pinggy${NC}"
fi
echo ""
echo " ================================================================="
echo ""
echo " Press Ctrl+C to stop the server."
echo ""

# If tunnel mode was specified via command line, launch tunnel in background
if [ -n "$TUNNEL_MODE" ]; then
    echo -e " ${GREEN}[*] Auto-starting ${TUNNEL_MODE} tunnel in background...${NC}"
    ( sleep 3 && bash "${SCRIPT_DIR}/tunnel.sh" "$TUNNEL_MODE" ) &
    TUNNEL_PID=$!
    trap "kill $TUNNEL_PID 2>/dev/null || true; exit 0" SIGINT SIGTERM EXIT
fi

exec $PYTHON_CMD -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
