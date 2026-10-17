# Skyline for the macOS menu bar

A menu bar app that opens the full Skyline city in a panel. It's the same web app as `../skyline`, running inside a native WebKit view, so every click, panel, draft and demo control works exactly as it does in the browser.

## Build and run

```bash
./macos/build.sh
open macos/build/Skyline.app
```

You need only the Xcode command-line tools. The app is ad-hoc signed for this Mac and isn't notarized. Re-run `build.sh` after you change anything in `skyline/`, because it copies the web files into the app.

To keep it in your menu bar, drag `macos/build/Skyline.app` into `/Applications` and add it under System Settings → General → Login Items.

## Using it

- **Click** the building icon to open or close the panel. Clicking anywhere else closes it.
- The number next to the icon is how many fires are burning across your region.
- **Right-click** the icon for **Open in Window** (a full-size, resizable window), **Reload Skyline** and **Quit**. The city keeps its state when you move between the panel and the window.
- Email links open in your mail app.

## Switching back

The pure web version is tagged `skyline-web-v1`, and `main` doesn't include this app. This work lives on the `menubar-app` branch.

## Adding a widget later

A WidgetKit widget can show a glance (fire count, top problem) and open this app when clicked, but it can't host the interactive city. Building one requires full Xcode, which isn't installed here.
