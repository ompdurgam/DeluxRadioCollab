#!/usr/bin/env bash
# ==============================================================================
# Delux Radio — Virtual Environment Setup Script (Linux)
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "========================================================"
echo "Setting up unified Delux Radio virtual environment..."
echo "========================================================"

# Determine Python 3 binary
PYTHON_BIN=""
for cmd in python3 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
        PYTHON_BIN="$cmd"
        break
    fi
done

if [ -z "$PYTHON_BIN" ]; then
    echo "[-] ERROR: Python 3 not found. Please install python3 & python3-venv."
    exit 1
fi

echo "Creating virtual environment at ${SCRIPT_DIR}/venv..."
"$PYTHON_BIN" -m venv "${SCRIPT_DIR}/venv"

echo "Activating virtual environment..."
source "${SCRIPT_DIR}/venv/bin/activate"

echo "Upgrading pip..."
pip install --upgrade pip -q

echo "Installing PyTorch..."
pip install torch==2.7.0 torchvision==0.22.0 torchaudio==2.7.0 --index-url https://download.pytorch.org/whl/cu128 || pip install torch torchvision torchaudio || true

echo "Installing remaining requirements..."
pip install -r "${SCRIPT_DIR}/requirements.txt"

echo "========================================================"
echo "Setup Complete!"
echo "You can now run the server using: ./start.sh"
echo "========================================================"
