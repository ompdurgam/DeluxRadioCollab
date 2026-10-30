@echo off
echo ========================================================
echo Setting up unified Delux Radio virtual environment...
echo ========================================================

if not exist "%~dp0venv" (
    echo Creating virtual environment at %~dp0venv...
    python -m venv "%~dp0venv"
)

echo Activating virtual environment...
call "%~dp0venv\Scripts\activate.bat"

echo Installing Delux Radio requirements...
pip install -r "%~dp0requirements.txt"

echo ========================================================
echo Setup Complete!
echo You can now run the server using: start.bat
echo ========================================================