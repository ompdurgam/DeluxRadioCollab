#!/usr/bin/env bash
# ==============================================================================
# Delux Radio — Public Internet Tunnel
# Exposes local Delux Radio server to the public internet.
# Supports:
#   1. Cloudflare Tunnel (trycloudflare.com) [Recommended]
#   2. Pinggy (pinggy.io - SSH tunnel, zero installation)
#   3. LocalTunnel (loca.lt via npx)
#   4. Localhost.run (SSH tunnel - zero installation)
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
    echo -e "     Make sure to start the server using: ${CYAN}./start.sh${NC}"
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

# ── Function: Pinggy (SSH) ───────────────────────────────────────────────────
start_pinggy() {
    echo -e "${BOLD}[*] Starting Pinggy SSH Tunnel for port ${PORT}...${NC}"
    if ! command -v ssh >/dev/null 2>&1; then
        echo -e "${RED}[-] Error: ssh client not found. Install openssh-client via: sudo apt install openssh-client${NC}"
        exit 1
    fi

    # Read optional PINGGY_TOKEN from env or backend/.env
    TOKEN="${PINGGY_TOKEN:-}"
    if [ -z "$TOKEN" ] && [ -f "${SCRIPT_DIR}/backend/.env" ]; then
        TOKEN=$(grep -E '^PINGGY_TOKEN=' "${SCRIPT_DIR}/backend/.env" | cut -d '=' -f 2 | tr -d ' "\r' || true)
    fi

    PINGGY_HOST="a.pinggy.io"
    if [ -n "$TOKEN" ]; then
        PINGGY_HOST="${TOKEN}@a.pinggy.io"
        echo -e " ${GREEN}[+] Authenticating with custom Pinggy token...${NC}"
    else
        echo -e " ${GREEN}[+] Using public free Pinggy tunnel...${NC}"
    fi

    echo -e " ${CYAN}[i] Watch below for your public Pinggy URL (https://*.a.pinggy.link):${NC}"
    echo " -----------------------------------------------------------------"
    echo ""

    ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -p 443 -R0:127.0.0.1:"${PORT}" "$PINGGY_HOST"
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

# Parse command line argument or prompt
METHOD="$1"

if [ -z "$METHOD" ]; then
    if [ -t 0 ]; then
        echo -e "${BOLD}Select Tunnel Provider:${NC}"
        echo -e "  ${CYAN}[1]${NC} Cloudflare Tunnel (trycloudflare.com) ${GREEN}(Default)${NC}"
        echo -e "  ${CYAN}[2]${NC} Pinggy (pinggy.io - SSH Tunnel, zero install) ${GREEN}(Fast & Simple)${NC}"
        echo -e "  ${CYAN}[3]${NC} LocalTunnel (loca.lt)"
        echo -e "  ${CYAN}[4]${NC} Localhost.run (SSH Tunnel - zero install)"
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

if [ "$METHOD" = "-h" ] || [ "$METHOD" = "--help" ]; then
    echo "Usage: ./tunnel.sh [provider]"
    echo ""
    echo "Providers:"
    echo "  1, cloudflare   : Cloudflare Tunnel (trycloudflare.com) [Default]"
    echo "  2, pinggy       : Pinggy SSH Tunnel (a.pinggy.link) [Fast, zero-install]"
    echo "  3, localtunnel  : LocalTunnel (loca.lt)"
    echo "  4, localhostrun : Localhost.run SSH Tunnel"
    exit 0
fi

case "$METHOD" in
    1|--cloudflare|-cf|cloudflare)
        start_cloudflare
        ;;
    2|--pinggy|--pinngy|-p|pinggy|pinngy|Pinggy|Pinngy)
        start_pinggy
        ;;
    3|--localtunnel|-lt|localtunnel)
        start_localtunnel
        ;;
    4|--localhostrun|-lhr|localhostrun)
        start_localhostrun
        ;;
    *)
        # Also handle previous '4' mapping if someone explicitly passed 4 for pinggy
        if [ "$METHOD" = "4" ]; then
            start_pinggy
        else
            echo -e "${YELLOW}[!] Unknown option '${METHOD}'. Defaulting to Cloudflare Tunnel.${NC}"
            start_cloudflare
        fi
        ;;
esac
