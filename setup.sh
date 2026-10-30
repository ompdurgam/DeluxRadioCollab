#!/usr/bin/env bash
# ==============================================================================
# Delux Radio — Virtual Environment Setup Script (Linux & Colab)
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "========================================================"
echo "Setting up unified Delux Radio environment..."
echo "========================================================"

# Determine Python binary (prefer python3, fallback to python)
PYTHON_BIN=""
for cmd in python3 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
        PYTHON_BIN="$cmd"
        break
    fi
done

if [ -z "$PYTHON_BIN" ]; then
    echo "[-] ERROR: Python 3 not found. Please install python3."
    exit 1
fi

# Detect Google Colab or existing virtual environment
IS_COLAB=0
if [ -d "/content" ] || [ -n "$COLAB_RELEASE_TAG" ] || [ -n "$COLAB_GPU" ] || "$PYTHON_BIN" -c "import google.colab" >/dev/null 2>&1; then
    IS_COLAB=1
fi

if [ "$IS_COLAB" -eq 1 ]; then
    echo " [i] Detected Google Colab environment."
    echo " [i] Skipping sub-virtualenv creation; using Colab Python directly."
    PIP_EXEC="$PYTHON_BIN -m pip"
elif [ -n "$VIRTUAL_ENV" ]; then
    echo " [i] Detected active virtual environment: $VIRTUAL_ENV"
    PIP_EXEC="$PYTHON_BIN -m pip"
else
    # Standard Linux machine: set up venv
    if [ ! -d "${SCRIPT_DIR}/venv" ]; then
        echo "Creating virtual environment at ${SCRIPT_DIR}/venv..."
        if ! "$PYTHON_BIN" -m venv "${SCRIPT_DIR}/venv" 2>/dev/null; then
            echo "[!] Standard venv creation failed (ensurepip may be missing). Trying --without-pip..."
            if ! "$PYTHON_BIN" -m venv --without-pip "${SCRIPT_DIR}/venv" 2>/dev/null; then
                echo "[!] Virtual environment creation not supported on this host. Using system Python directly."
                PIP_EXEC="$PYTHON_BIN -m pip"
            fi
        fi
    fi

    if [ -f "${SCRIPT_DIR}/venv/bin/activate" ]; then
        echo "Activating virtual environment..."
        source "${SCRIPT_DIR}/venv/bin/activate"
        PIP_EXEC="pip"
    else
        PIP_EXEC="$PYTHON_BIN -m pip"
    fi
fi

PIP_FLAGS="--no-warn-script-location"
if [ "$IS_COLAB" -eq 1 ] || [ -z "${VIRTUAL_ENV:-}" ]; then
    if $PIP_EXEC install --help 2>&1 | grep -q -- '--break-system-packages'; then
        PIP_FLAGS="$PIP_FLAGS --break-system-packages"
    fi
fi

echo "Checking pip..."
$PIP_EXEC install --upgrade pip -q $PIP_FLAGS 2>/dev/null || true

echo "Installing Delux Radio requirements..."
$PIP_EXEC install -r "${SCRIPT_DIR}/requirements.txt" $PIP_FLAGS

echo "========================================================"
echo "Setup Complete!"
echo "You can now run the server using: ./start.sh"
echo "========================================================"
