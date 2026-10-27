#!/data/data/com.termux/files/usr/bin/bash
set -eu
cd "$HOME/qqrobot-termux-e"
bash ./run-termux-e.sh
exec bash ./start-managed.sh
