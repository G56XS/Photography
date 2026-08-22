@echo off
python build_manifest.py
if errorlevel 1 (
    echo.
    echo If you see "python is not recognized", install Python from python.org
    echo then run:  pip install pillow
)
pause
