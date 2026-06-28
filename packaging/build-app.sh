#!/usr/bin/env bash
# Assemble Continuum.app — an unsigned, local-dev macOS app bundle.
# For distribution you additionally need: codesign (Developer ID) + notarization
# (xcrun notarytool) + a bundled Node runtime.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/packaging/dist/Continuum.app"
MACOS="$APP/Contents/MacOS"
RES="$APP/Contents/Resources"

mkdir -p "$ROOT/packaging/dist"
echo "→ compiling menu-bar app"
swiftc "$ROOT/packaging/menubar.swift" -o "$ROOT/packaging/dist/Continuum.bin"

# Ship the SCREEN (OCR) capture binary, not capture.swift (AX-only). Measured fact-recall: screen+XY-cut
# ~0.97 across 11 surfaces vs AX-only 0.31. screen.swift OCRs the focused window AND captures the AX
# scene/input; it needs Screen Recording (granted at first run via the system prompt screen.swift triggers).
echo "→ compiling screen-capture (OCR) helper"
swiftc "$ROOT/daemon/stage1/screen.swift" -o "$ROOT/daemon/stage1/screen"

echo "→ assembling bundle"
rm -rf "$APP"
mkdir -p "$MACOS" "$RES/daemon"
cp "$ROOT/packaging/dist/Continuum.bin" "$MACOS/Continuum"
cp "$ROOT/packaging/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/daemon/stage1/screen" "$RES/screen"
# bundle the JS pipeline (the part Node runs)
cp -R "$ROOT/daemon/"*.mjs "$RES/daemon/" 2>/dev/null || true
for d in stage2 stage3 stage4; do mkdir -p "$RES/daemon/$d"; cp "$ROOT/daemon/$d/"*.mjs "$RES/daemon/$d/" 2>/dev/null || true; done
find "$RES/daemon" -name '*.test.mjs' -delete                 # ship runtime only
chmod +x "$MACOS/Continuum" "$RES/screen"
rm -f "$ROOT/packaging/dist/Continuum.bin"

echo "✓ built: $APP"
echo "  (unsigned — first launch: right-click → Open. Needs system Node + Screen Recording permission"
echo "   for OCR capture; Accessibility is optional, for capturing typed input.)"
