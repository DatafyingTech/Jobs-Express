#!/bin/bash
# Double-click this file on macOS to start Jobs Express.
# If macOS says it cannot be opened: right-click it and choose Open, then confirm. On macOS 15 and newer that
# bypass is gone: try to open it once, then go to System Settings, Privacy & Security, and choose Open Anyway.
# If nothing happens, run once in Terminal:  chmod +x start.command
cd "$(dirname "$0")" || exit 1

echo
echo "  Jobs Express"
echo "  ------------"
echo

if [ ! -f server.mjs ]; then
  echo "  Some files are missing: start.command must sit next to server.mjs and the lib folder."
  echo "  If you downloaded a ZIP, extract the whole ZIP first (double-click it in Finder), then open start.command from the new folder."
  read -r -p "  Press Return to close. " _
  exit 2
fi

need_node() {
  echo "  $1"
  echo
  if command -v brew >/dev/null 2>&1; then
    read -r -p "  Install Node.js with Homebrew now? [y/N] " answer
    if [[ "$answer" =~ ^[Yy]$ ]]; then
      brew install node && echo && echo "  Done. Close this window and open start.command again."
      read -r -p "  Press Return to close. " _
      exit 0
    fi
  fi
  echo "  Opening the Node.js download page. Install the LTS version, then open start.command again."
  open "https://nodejs.org/en/download"
  read -r -p "  Press Return to close. " _
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  need_node "Node.js is not installed. It is the free engine this app runs on."
fi
major="$(node -p "process.versions.node.split('.')[0]")"
if [ "$major" -lt 18 ]; then
  need_node "Your Node.js is version $major. This app needs version 18 or newer."
fi

echo "  Starting... your browser will open in a moment."
echo "  Leave this window open while you use the app. Close it to stop."
echo
node server.mjs "$@"
status=$?
if [ $status -ne 0 ]; then
  echo
  echo "  The app stopped with an error. The message above says why."
  read -r -p "  Press Return to close. " _
fi
exit $status
