#!/bin/sh
# Routecam installer for macOS (current user only). NOTE: not yet tested on a Mac.
set -e
ID=com.routecam.panel
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/$ID/CSXS/manifest.xml" ]; then SRC="$HERE/$ID"; else SRC="$HERE/../extension"; fi
DST="$HOME/Library/Application Support/Adobe/CEP/extensions/$ID"
mkdir -p "$(dirname "$DST")"
rm -rf "$DST"
cp -R "$SRC" "$DST"
# Unsigned CEP extensions need the PlayerDebugMode flag (per user).
for v in 11 12; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
echo "Installed to $DST"
echo "Restart After Effects, then open Window > Extensions > Routecam."
