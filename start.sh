#!/usr/bin/env bash
# Start Jobs Express on Linux:  ./start.sh   (run "chmod +x start.sh" once if needed)
# Claude in Chrome is not supported inside WSL. Use Windows, macOS, or desktop Linux.
cd "$(dirname "$0")" || exit 1

echo
echo "  Jobs Express"
echo "  ------------"
echo

if grep -qi microsoft /proc/version 2>/dev/null; then
  echo "  Note: this looks like WSL. The Claude in Chrome integration does not work inside WSL."
  echo "  Run the app from Windows instead (double-click Start.bat)."
  echo
fi

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed. Install the LTS version from https://nodejs.org"
  echo "  or with your package manager (for example: sudo apt install nodejs), then run this again."
  exit 1
fi
major="$(node -p "process.versions.node.split('.')[0]")"
if [ "$major" -lt 18 ]; then
  echo "  Your Node.js is version $major. This app needs version 18 or newer."
  echo "  Get the LTS release from https://nodejs.org (your distribution's package is often too old)."
  exit 1
fi

echo "  Starting... your browser will open in a moment."
echo "  Press Ctrl+C to stop."
echo
exec node server.mjs "$@"
