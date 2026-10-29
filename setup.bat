@echo off
echo ========================================================
echo Setting up unified Delux Radio virtual environment...
echo ========================================================

echo Creating virtual environment at %~dp0venv...
python -m venv "%~dp0venv"

echo Activating virtual environment...
call "%~dp0venv\Scripts\activate.bat"

echo Installing PyTorch 2.7.0 + CUDA 12.8 wheel (Qwen3-TTS requirement)...
pip install torch==2.7.0 torchvision==0.22.0 torchaudio==2.7.0 --index-url https://download.pytorch.org/whl/cu128

echo Installing remaining requirements...
pip install -r "%~dp0requirements.txt"

echo ========================================================
echo Setup Complete!
echo You can now run the server:
echo venv\Scripts\python backend\main.py (or uvicorn from backend)
echo ======================================================