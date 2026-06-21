#!/usr/bin/env bash
#
# Build ComfyPeeper into a from-source Vencord and deploy it for Vesktop.
#
# Vesktop ships its own Vencord and (as of 1.6.5) ignores the custom "Vencord location"
# setting, so this overwrites the Vencord copy Vesktop actually loads from.
#
# Usage:   VENCORD_DIR=~/Vencord ./scripts/install-vesktop.sh
# Then:    fully quit Vesktop from the tray and reopen it; enable "ComfyPeeper".
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VENCORD_DIR="${VENCORD_DIR:-$HOME/Vencord}"
MANAGED="${VESKTOP_VENCORD_DIR:-$HOME/.config/vesktop/sessionData/vencordFiles}"

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

# 3. build
echo ">> building Vencord…"
pnpm build

# 4. deploy to the dir Vesktop loads (if present)
if [ -d "$(dirname "$MANAGED")" ]; then
    echo ">> deploying to Vesktop managed dir: $MANAGED"
    mkdir -p "$MANAGED"
    [ -e "$MANAGED.bak" ] || { [ -d "$MANAGED" ] && cp -a "$MANAGED" "$MANAGED.bak" 2>/dev/null || true; }
    for f in vencordDesktopMain.js vencordDesktopMain.js.map \
             vencordDesktopPreload.js vencordDesktopPreload.js.map \
             vencordDesktopRenderer.js vencordDesktopRenderer.js.map \
             vencordDesktopRenderer.css vencordDesktopRenderer.css.map; do
        [ -f "dist/$f" ] && cp -f "dist/$f" "$MANAGED/$f"
    done
    [ -f "$MANAGED/package.json" ] || echo '{}' > "$MANAGED/package.json"
    if grep -q ComfyPeeper "$MANAGED/vencordDesktopRenderer.js"; then
        echo ">> OK: ComfyPeeper is in the deployed build."
    else
        echo ">> WARNING: ComfyPeeper not found in deployed renderer."
    fi
else
    echo ">> Vesktop config dir not found; built to $VENCORD_DIR/dist (use 'pnpm inject' for desktop Vencord)."
fi

# 5. also refresh the browser userscript so it never lags behind the desktop build
#    (runs after the desktop deploy above, since buildWeb overwrites dist/). Set
#    SKIP_USERSCRIPT=1 to skip if you only care about desktop.
if [ "${SKIP_USERSCRIPT:-0}" != "1" ]; then
    echo ">> rebuilding browser userscript…"
    pnpm buildWeb
    OUT="$VENCORD_DIR/dist/Vencord.user.js"
    if [ -f "$OUT" ] && grep -q ComfyPeeper "$OUT"; then
        echo ">> OK: userscript refreshed → $OUT"
    else
        echo ">> WARNING: ComfyPeeper not found in the userscript build."
    fi
fi

echo ">> Done. Fully QUIT Vesktop from the tray, reopen it, and enable ComfyPeeper."
