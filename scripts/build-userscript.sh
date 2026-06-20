#!/usr/bin/env bash
#
# Build ComfyPeeper into a Vencord userscript for use in a web browser via Tampermonkey.
#
# Discord in a browser has no Electron main process, so ComfyPeeper's native module is
# unavailable — but it ships a renderer fallback (webFallback.ts) that does the same work
# with plain fetch. Under a Tampermonkey userscript, Vencord rewrites fetch -> GM_xmlhttpRequest,
# which bypasses CORS AND mixed-content, so even a remote http ComfyUI can be queued.
#
# Tampermonkey ONLY. Violentmonkey / Greasemonkey-on-Firefox can't override window on CSP sites.
#
# Usage:   VENCORD_DIR=~/Vencord ./scripts/build-userscript.sh
# Then:    open the printed dist/Vencord.user.js in Tampermonkey to install it.
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VENCORD_DIR="${VENCORD_DIR:-$HOME/Vencord}"

# 1. ensure a from-source Vencord
if [ ! -f "$VENCORD_DIR/package.json" ]; then
    echo ">> cloning Vencord into $VENCORD_DIR"
    git clone https://github.com/Vendicated/Vencord "$VENCORD_DIR"
fi
cd "$VENCORD_DIR"
[ -d node_modules ] || { echo ">> pnpm install"; pnpm install; }

# 2. sync the plugin source
echo ">> installing comfyPeeper into $VENCORD_DIR/src/userplugins"
mkdir -p src/userplugins
rm -rf src/userplugins/comfyPeeper
cp -r "$REPO/comfyPeeper" src/userplugins/comfyPeeper

# 3. build the web targets (produces the userscript + browser extension)
echo ">> building Vencord web/userscript…"
pnpm buildWeb

OUT="$VENCORD_DIR/dist/Vencord.user.js"
if [ -f "$OUT" ] && grep -q ComfyPeeper "$OUT"; then
    echo ">> OK: ComfyPeeper is in the userscript."
    echo ">> Userscript: $OUT"
    echo ">> Install it: Tampermonkey dashboard -> Utilities -> Import from file (or open the file and confirm)."
    echo ">> Then on web Discord: open the Vencord cog, enable ComfyPeeper, set your ComfyUI endpoints."
else
    echo ">> WARNING: ComfyPeeper not found in $OUT"
    exit 1
fi
