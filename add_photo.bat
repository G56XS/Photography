@echo off
python add_photo.py
if errorlevel 1 (
    echo.
    echo If you see "python is not recognized", install Python from python.org.
    echo If a git step failed, make sure this folder is a git repo with a
    echo remote set up ^(git remote -v^) and that you're logged in.
)
pause
