#!/bin/bash
# Builds macos/build/Skyline.app from ../skyline (the web app) and Sources/main.swift.
# Needs only the Xcode command-line tools. Re-run after changing anything in skyline/.
set -euo pipefail
cd "$(dirname "$0")"

APP=build/Skyline.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"

cp Info.plist "$APP/Contents/Info.plist"
cp ../skyline/index.html ../skyline/styles.css ../skyline/*.js "$APP/Contents/Resources/web/"

# Remember where the live server and node are, so the app can start the server itself
# (even after you move Skyline.app to /Applications).
/usr/libexec/PlistBuddy -c "Add :SkylineServerDir string $(cd ../server && pwd)" "$APP/Contents/Info.plist"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] && /usr/libexec/PlistBuddy -c "Add :SkylineNode string $NODE_BIN" "$APP/Contents/Info.plist"

swiftc -swift-version 5 -O -o "$APP/Contents/MacOS/Skyline" Sources/main.swift -framework AppKit -framework WebKit

# Ad-hoc signature so macOS will run it locally. Not notarized: for this Mac only.
codesign --force --sign - "$APP"

echo "Built $(pwd)/$APP"
echo "Run it with: open \"$(pwd)/$APP\""
