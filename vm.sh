#!/usr/bin/env bash
# ==============================================================================
# Delux Radio — Automated All-in-One Deployment Script
# Supports:
#   1. Google Colab (Automatic Cloudflare HTTPS Tunnel, no systemd needed)
#   2. Standard Linux Cloud VMs (Ubuntu/Debian with Systemd + Nginx)
# ==============================================================================

set -euo pipefail

# Visual colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${SCRIPT_DIR}/backend"
VENV_DIR="${SCRIPT_DIR}/venv"
BIN_DIR="${SCRIPT_DIR}/bin"
mkdir -p "${BIN_DIR}"

echo -e "${CYAN}${BOLD}"
echo "=================================================================="
echo " 📻 Delux Radio — Automated Hosting & Deployment"
echo "=================================================================="
echo -e "${NC}"

# Detect Google Colab
IS_COLAB=0
if [ -d "/content" ] || [ -n "${COLAB_RELEASE_TAG:-}" ] || [ -n "${COLAB_GPU:-}" ] || python3 -c "import google.colab" >/dev/null 2>&1; then
    IS_COLAB=1
fi

# Detect Python command
PYTHON_CMD="python3"
if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_CMD="python"
fi

# ══════════════════════════════════════════════════════════════════════════════
# MODE A: GOOGLE COLAB DEPLOYMENT (Instant HTTPS Tunnel via Cloudflare)
# ══════════════════════════════════════════════════════════════════════════════
if [ "$IS_COLAB" -eq 1 ]; then
    echo -e "${GREEN}${BOLD}[i] Google Colab Environment Detected!${NC}"
    echo "    Running lightweight Colab pipeline with automatic Cloudflare Tunnel..."
    echo ""

    # 1. System packages
    echo -e "${CYAN}[1/5] Installing FFmpeg and Node.js in Colab...${NC}"
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y -qq ffmpeg nodejs >/dev/null 2>&1 || true

    # 2. Python dependencies
    echo -e "${CYAN}[2/5] Installing Python dependencies...${NC}"
    $PYTHON_CMD -m pip install --upgrade pip -q
    $PYTHON_CMD -m pip install -r "${SCRIPT_DIR}/requirements.txt" -q --break-system-packages 2>/dev/null || \
    $PYTHON_CMD -m pip install -r "${SCRIPT_DIR}/requirements.txt" -q

    # 3. Directories & Env
    echo -e "${CYAN}[3/5] Setting up environment and audio directories...${NC}"
    mkdir -p "${BACKEND_DIR}/audio/rj" \
             "${BACKEND_DIR}/audio/mixed" \
             "${BACKEND_DIR}/audio/tts" \
             "${SCRIPT_DIR}/assets"

    if [ ! -f "${BACKEND_DIR}/.env" ]; then
        if [ -f "${BACKEND_DIR}/.env.example" ]; then
            cp "${BACKEND_DIR}/.env.example" "${BACKEND_DIR}/.env"
        fi
    fi

    # 4. Seed Database
    echo -e "${CYAN}[4/5] Initializing song catalog database...${NC}"
    (cd "${BACKEND_DIR}" && $PYTHON_CMD seed_songs.py) || true

    # 5. Cloudflare Tunnel & Launch
    echo -e "${CYAN}[5/5] Launching Cloudflare Tunnel & Delux Radio...${NC}"
    
    # Download cloudflared if not present
    if [ ! -x "${BIN_DIR}/cloudflared" ]; then
        echo " [*] Downloading Cloudflare tunnel binary..."
        curl -sSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" -o "${BIN_DIR}/cloudflared"
        chmod +x "${BIN_DIR}/cloudflared"
    fi

    echo ""
    echo -e "${GREEN}${BOLD}=================================================================="
    echo " 🚀 Delux Radio is launching on Colab!"
    echo " Look below for your public https://*.trycloudflare.com link!"
    echo "==================================================================${NC}"
    echo ""

    # Start Cloudflare tunnel in background
    "${BIN_DIR}/cloudflared" tunnel --url http://127.0.0.1:8000 2>&1 | grep --line-buffered -E "trycloudflare\.com" &
    TUNNEL_PID=$!

    # Start FastAPI server
    cd "${BACKEND_DIR}"
    trap "kill $TUNNEL_PID 2>/dev/null || true; exit 0" SIGINT SIGTERM EXIT
    exec $PYTHON_CMD -m uvicorn main:app --host 0.0.0.0 --port 8000
    exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# MODE B: STANDARD LINUX CLOUD VM (AWS EC2 / DigitalOcean / Hetzner / GCP)
# ══════════════════════════════════════════════════════════════════════════════

# Require root/sudo for standard VM systemd & nginx
if [ "$EUID" -ne 0 ]; then
    echo -e "${YELLOW}[!] This script needs sudo privileges on a standard Linux VM to configure Nginx and systemd.${NC}"
    echo "    Re-running with sudo..."
    exec sudo bash "$0" "$@"
fi

RUN_USER="${SUDO_USER:-$USER}"

echo -e "${CYAN}[1/7] Installing system packages (Python, FFmpeg, Node.js, Nginx)...${NC}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv ffmpeg nodejs nginx curl git ufw >/dev/null

echo -e "${CYAN}[2/7] Setting up Python virtual environment...${NC}"
if [ ! -d "${VENV_DIR}" ]; then
    python3 -m venv "${VENV_DIR}"
fi

"${VENV_DIR}/bin/pip" install --upgrade pip -q
"${VENV_DIR}/bin/pip" install -r "${SCRIPT_DIR}/requirements.txt" -q

echo -e "${CYAN}[3/7] Setting up audio directories and environment...${NC}"
mkdir -p "${BACKEND_DIR}/audio/rj" \
         "${BACKEND_DIR}/audio/mixed" \
         "${BACKEND_DIR}/audio/tts" \
         "${SCRIPT_DIR}/assets"

if [ ! -f "${BACKEND_DIR}/.env" ]; then
    if [ -f "${BACKEND_DIR}/.env.example" ]; then
        cp "${BACKEND_DIR}/.env.example" "${BACKEND_DIR}/.env"
    fi
fi
chown -R "${RUN_USER}:${RUN_USER}" "${SCRIPT_DIR}"

echo -e "${CYAN}[4/7] Seeding song database...${NC}"
sudo -u "${RUN_USER}" "${VENV_DIR}/bin/python3" "${BACKEND_DIR}/seed_songs.py" || true

echo -e "${CYAN}[5/7] Setting up 24/7 systemd background service...${NC}"
SERVICE_FILE="/etc/systemd/system/delux-radio.service"
cat <<EOF > "${SERVICE_FILE}"
[Unit]
Description=Delux Radio 24/7 Live Stream Station
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${BACKEND_DIR}
ExecStart=${VENV_DIR}/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=always
RestartSec=5
EnvironmentFile=${BACKEND_DIR}/.env
LimitNOFILE=65536
ReadWritePaths=${BACKEND_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable delux-radio.service
systemctl restart delux-radio.service

echo -e "${CYAN}[6/7] Setting up Nginx reverse proxy with WebSockets...${NC}"
cat <<'EOF' > /etc/nginx/sites-available/delux-radio
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8000/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF

ln -sf /etc/nginx/sites-available/delux-radio /etc/nginx/sites-enabled/delux-radio
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx && systemctl enable nginx

echo -e "${CYAN}[7/7] Configuring firewall...${NC}"
if command -v ufw >/dev/null 2>&1; then
    ufw allow 22/tcp >/dev/null 2>&1 || true
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
fi

PUBLIC_IP=$(curl -s -m 5 https://api.ipify.org || curl -s -m 5 https://ifconfig.me || hostname -I | awk '{print $1}')

echo -e "${GREEN}${BOLD}"
echo "=================================================================="
echo " 🎉 Delux Radio is LIVE on your VM!"
echo "=================================================================="
echo -e "${NC}"
echo -e " 🎵 Radio Player:  ${CYAN}http://${PUBLIC_IP}/${NC}"
echo -e " 🔧 Admin Panel:   ${CYAN}http://${PUBLIC_IP}/admin.html${NC}"
echo ""
echo -e " 📋 Service Commands:"
echo -e "   • Status:  sudo systemctl status delux-radio"
echo -e "   • Logs:    sudo journalctl -u delux-radio -f"
echo -e "   • Restart: sudo systemctl restart delux-radio"
echo "=================================================================="
