#!/usr/bin/env bash
# ==============================================================================
# Delux Radio — Public Internet Tunnel
# Exposes local Delux Radio server to the public internet.
# Supports:
#   1. Cloudflare Tunnel (trycloudflare.com) [Default / Recommended]
#   2. LocalTunnel (loca.lt via npx)
#   3. Localhost.run (SSH tunnel - no binary download)
#   4. Pinggy (SSH tunnel - no binary download)
# ==============================================================================

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/bin"
mkdir -p "${BIN_DIR}"

# 1. Determine Port from backend/.env or environment variable or default 8000
PORT="${PORT:-8000}"
if [ -f "${SCRIPT_DIR}/backend/.env" ]; then
    ENV_PORT=$(grep -E '^PORT=' "${SCRIPT_DIR}/backend/.env" | cut -d '=' -f 2 | tr -d ' "\r' || true)
    if [ -n "$ENV_PORT" ]; then
        PORT="$ENV_PORT"
    fi
fi

echo ""
echo -e "${CYAN}${BOLD}"
echo " ########  #######  ##       ##     ## ##     ## "
echo " ##     ## ##       ##       ##     ##  ##   ##  "
echo " ##     ## ##       ##       ##     ##   ## ##   "
echo " ##     ## ######   ##       ##     ##    ###    "
echo " ##     ## ##       ##       ##     ##   ## ##   "
echo " ##     ## ##       ##       ##     ##  ##   ##  "
echo " ########  #######  ########  #######  ##     ## "
echo -e "${NC}"
echo -e "${BOLD} Delux Radio — Public Tunnel Launcher (Port ${PORT})${NC}"
echo "================================================================="
echo ""

# Check if radio server is responding locally
if curl -s -m 1 "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
    echo -e " ${GREEN}[+] Local Delux Radio server detected running on port ${PORT}.${NC}"
else
    echo -e " ${YELLOW}[!] Notice: Delux Radio is not currently detected on http://127.0.0.1:${PORT}.${NC}"
    echo -e "     Make sure to start the server in another terminal using: ${CYAN}./start.sh${NC}"
fi
echo ""

# Clean up child processes on exit
cleanup() {
    echo ""
    echo -e " ${YELLOW}[*] Shutting down tunnel...${NC}"
    kill $(jobs -p) 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# ── Function: Cloudflare Tunnel ───────────────────────────────────────────────
start_cloudflare() {
    echo -e "${BOLD}[*] Starting Cloudflare Tunnel...${NC}"
    CLOUDFLARED_BIN=""

    if command -v cloudflared >/dev/null 2>&1; then
        CLOUDFLARED_BIN="$(command -v cloudflared)"
    elif [ -x "${BIN_DIR}/cloudflared" ]; then
        CLOUDFLARED_BIN="${BIN_DIR}/cloudflared"
    else
        echo -e " ${YELLOW}[*] Downloading cloudflared binary...${NC}"
        ARCH="$(uname -m)"
        CF_URL=""
        case "$ARCH" in
            x86_64|amd64)
                CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
                ;;
            aarch64|arm64)
                CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
                ;;
            armv7l|armhf)
                CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm"
                ;;
            i386|i686)
                CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-386"
                ;;
            *)
                echo -e "${RED}[-] Unsupported architecture: ${ARCH}${NC}"
                exit 1
                ;;
        esac

        if command -v curl >/dev/null 2>&1; then
            curl -sSL "$CF_URL" -o "${BIN_DIR}/cloudflared"
        elif command -v wget >/dev/null 2>&1; then
            wget -qO "${BIN_DIR}/cloudflared" "$CF_URL"
        else
            echo -e "${RED}[-] Neither curl nor wget found. Cannot download cloudflared.${NC}"
            exit 1
        fi

        chmod +x "${BIN_DIR}/cloudflared"
        CLOUDFLARED_BIN="${BIN_DIR}/cloudflared"
        echo -e " ${GREEN}[+] cloudflared downloaded successfully.${NC}"
    fi

    echo ""
    echo -e " ${GREEN}[+] Launching Cloudflare Tunnel for http://127.0.0.1:${PORT}...${NC}"
    echo -e " ${CYAN}[i] Watch below for your public https://*.trycloudflare.com link:${NC}"
    echo " -----------------------------------------------------------------"
    echo ""

    # Run cloudflared and display output
    "$CLOUDFLARED_BIN" tunnel --url "http://127.0.0.1:${PORT}"
}

# ── Function: LocalTunnel ─────────────────────────────────────────────────────
start_localtunnel() {
    echo -e "${BOLD}[*] Starting LocalTunnel...${NC}"
    if command -v npx >/dev/null 2>&1; then
        echo -e " ${GREEN}[+] Using npx localtunnel...${NC}"
        echo ""
        npx --yes localtunnel --port "${PORT}"
    elif command -v lt >/dev/null 2>&1; then
        echo -e " ${GREEN}[+] Using installed localtunnel (lt)...${NC}"
        echo ""
        lt --port "${PORT}"
    else
        echo -e "${RED}[-] Error: npx or Node.js not found. LocalTunnel requires Node.js/npx.${NC}"
        exit 1
    fi
}

# ── Function: Localhost.run (SSH) ─────────────────────────────────────────────
start_localhostrun() {
    echo -e "${BOLD}[*] Starting Localhost.run SSH Tunnel...${NC}"
    if ! command -v ssh >/dev/null 2>&1; then
        echo -e "${RED}[-] Error: ssh client not found.${NC}"
        exit 1
    fi
    echo -e " ${GREEN}[+] Connecting to localhost.run...${NC}"
    ssh -o StrictHostKeyChecking=no -R 80:127.0.0.1:"${PORT}" nokey@localhost.run
}

# ── Function: Pinggy (SSH) ───────────────────────────────────────────────────
start_pinggy() {
    echo -e "${BOLD}[*] Starting Pinggy SSH Tunnel...${NC}"
    if ! command -v ssh >/dev/null 2>&1; then
        echo -e "${RED}[-] Error: ssh client not found.${NC}"
        exit 1
    fi
    echo -e " ${GREEN}[+] Connecting to Pinggy...${NC}"
    ssh -o StrictHostKeyChecking=no -p 443 -R0:127.0.0.1:"${PORT}" a.pinggy.io
}

# Parse command line argument or prompt
METHOD="$1"

if [ -z "$METHOD" ]; then
    if [ -t 0 ]; then
        echo -e "${BOLD}Select Tunnel Provider:${NC}"
        echo -e "  ${CYAN}[1]${NC} Cloudflare Tunnel (trycloudflare.com) ${GREEN}(Default - Recommended)${NC}"
        echo -e "  ${CYAN}[2]${NC} LocalTunnel (loca.lt)"
        echo -e "  ${CYAN}[3]${NC} Localhost.run (SSH Tunnel - zero installation)"
        echo -e "  ${CYAN}[4]${NC} Pinggy (SSH Tunnel - zero installation)"
        echo ""
        echo -n "Choose [1-4] (auto-selects [1] in 5s): "
        if read -t 5 user_choice; then
            echo ""
            METHOD="$user_choice"
        else
            echo ""
            METHOD="1"
        fi
    else
        METHOD="1"
    fi
fi

case "$METHOD" in
    1|--cloudflare|-cf|cloudflare)
        start_cloudflare
        ;;
    2|--localtunnel|-lt|localtunnel)
        start_localtunnel
        ;;
    3|--localhostrun|-lhr|localhostrun)
        start_localhostrun
        ;;
    4|--pinggy|-p|pinggy)
        start_pinggy
        ;;
    *)
        echo -e "${YELLOW}[!] Unknown option '${METHOD}'. Defaulting to Cloudflare Tunnel.${NC}"
        start_cloudflare
        ;;
esac
