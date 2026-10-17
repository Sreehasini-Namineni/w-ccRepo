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

swiftc -swift-version 5 -O -o "$APP/Contents/MacOS/Skyline" Sources/main.swift -framework AppKit -framework WebKit

# Ad-hoc signature so macOS will run it locally. Not notarized: for this Mac only.
codesign --force --sign - "$APP"

echo "Built $(pwd)/$APP"
echo "Run it with: open \"$(pwd)/$APP\""
