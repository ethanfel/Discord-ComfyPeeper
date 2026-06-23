#!/usr/bin/env bash
#
# Build and install ComfyPeeper into a from-source Vencord on Linux.
#
# Supports Discord desktop, Vesktop, and the browser userscript. The script is
# safe to rerun: it reuses an existing Vencord checkout, clones into an empty
# one, replaces an older comfyPeeper user-plugin copy, and verifies that the
# built bundle contains ComfyPeeper.
#
# Usage:
#   ./scripts/install-linux.sh
#   ./scripts/install-linux.sh --client vesktop --yes
#   ./scripts/install-linux.sh --client browser --vencord-dir "$HOME/Vencord"
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENCORD_DIR="${VENCORD_DIR:-$HOME/Vencord}"
VESKTOP_DIR="${VESKTOP_VENCORD_DIR:-}"
CLIENT="menu"
YES=0
SKIP_PNPM_INSTALL=0
SKIP_DEPENDENCY_INSTALL=0

usage() {
    cat <<'EOF'
Usage: ./scripts/install-linux.sh [options]

Options:
  --client <menu|discord|vesktop|browser|all>
      Select the target client. Default: menu.
  --repo-dir <path>
      Discord-ComfyPeeper repo path. Default: this script's parent directory.
  --vencord-dir <path>
      Vencord source checkout path. Default: $VENCORD_DIR or ~/Vencord.
  --vesktop-dir <path>
      Vesktop managed vencordFiles directory. Default: auto-detect.
  --yes
      Accept default yes answers.
  --skip-pnpm-install
      Do not offer to install pnpm if missing.
  --skip-dependency-install
      Skip pnpm install --frozen-lockfile in Vencord.
  -h, --help
      Show this help.

Examples:
  ./scripts/install-linux.sh
  ./scripts/install-linux.sh --client vesktop --yes
  ./scripts/install-linux.sh --client browser
EOF
}

step() {
    printf '>> %s\n' "$*"
}

ok() {
    printf 'OK: %s\n' "$*"
}

warn() {
    printf 'WARNING: %s\n' "$*" >&2
}

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

confirm() {
    local prompt="$1"

    if [ "$YES" -eq 1 ]; then
        return 0
    fi

    local answer
    read -r -p "$prompt [Y/n] " answer
    [ -z "$answer" ] || [[ "$answer" =~ ^[Yy]$ ]]
}

run() {
    local cwd="$1"
    shift

    step "$*"
    (cd "$cwd" && "$@")
}

require_command() {
    local name="$1"
    local hint="$2"

    if ! command -v "$name" >/dev/null 2>&1; then
        fail "Missing '$name'. $hint"
    fi
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --client)
                [ "$#" -ge 2 ] || fail "--client requires a value"
                CLIENT="$2"
                shift 2
                ;;
            --repo-dir)
                [ "$#" -ge 2 ] || fail "--repo-dir requires a value"
                REPO_DIR="$2"
                shift 2
                ;;
            --vencord-dir)
                [ "$#" -ge 2 ] || fail "--vencord-dir requires a value"
                VENCORD_DIR="$2"
                shift 2
                ;;
            --vesktop-dir)
                [ "$#" -ge 2 ] || fail "--vesktop-dir requires a value"
                VESKTOP_DIR="$2"
                shift 2
                ;;
            --yes)
                YES=1
                shift
                ;;
            --skip-pnpm-install)
                SKIP_PNPM_INSTALL=1
                shift
                ;;
            --skip-dependency-install)
                SKIP_DEPENDENCY_INSTALL=1
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                fail "Unknown option: $1"
                ;;
        esac
    done

    case "$CLIENT" in
        menu|discord|vesktop|browser|all) ;;
        *) fail "Unknown client '$CLIENT'. Use menu, discord, vesktop, browser, or all." ;;
    esac
}

select_client() {
    printf '\nChoose where to install ComfyPeeper:\n'
    printf '  1. Discord desktop (Vencord inject)\n'
    printf '  2. Vesktop\n'
    printf '  3. Browser userscript (Tampermonkey)\n'
    printf '  4. All\n\n'

    local choice
    read -r -p "Selection: " choice
    case "$choice" in
        1) CLIENT="discord" ;;
        2) CLIENT="vesktop" ;;
        3) CLIENT="browser" ;;
        4) CLIENT="all" ;;
        *) fail "Unknown selection '$choice'" ;;
    esac
}

set_targets() {
    TARGETS=()
    case "$CLIENT" in
        discord) TARGETS=("discord") ;;
        vesktop) TARGETS=("vesktop") ;;
        browser) TARGETS=("browser") ;;
        all) TARGETS=("discord" "vesktop" "browser") ;;
        *) fail "Internal error: target selection was not resolved" ;;
    esac
}

target_enabled() {
    local wanted="$1"
    local target
    for target in "${TARGETS[@]}"; do
        [ "$target" = "$wanted" ] && return 0
    done
    return 1
}

remove_target() {
    local unwanted="$1"
    local kept=()
    local target
    for target in "${TARGETS[@]}"; do
        [ "$target" = "$unwanted" ] || kept+=("$target")
    done
    TARGETS=("${kept[@]}")
}

join_targets() {
    local out=""
    local target
    for target in "${TARGETS[@]}"; do
        if [ -n "$out" ]; then
            out="$out, "
        fi
        out="$out$target"
    done
    printf '%s' "$out"
}

path_has_child() {
    local path="$1"
    [ -n "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]
}

check_file_contains() {
    local path="$1"
    local needle="$2"

    [ -f "$path" ] && grep -qF "$needle" "$path"
}

warn_if_running() {
    local display="$1"
    shift

    command -v pgrep >/dev/null 2>&1 || return 0

    local pattern
    for pattern in "$@"; do
        if pgrep -x "$pattern" >/dev/null 2>&1; then
            warn "$display appears to be running. Fully quit it before continuing."
            if ! confirm "Continue anyway?"; then
                fail "Close $display and rerun this installer."
            fi
            return 0
        fi
    done
}

ensure_linux_environment() {
    [ -n "${HOME:-}" ] || fail "HOME is not set."

    if [ "$(uname -s)" != "Linux" ]; then
        warn "This installer targets Linux. The manual install guide is safer on this platform."
        confirm "Continue anyway?" || fail "Stopped."
    fi
}

ensure_tools() {
    step "Checking required tools"
    require_command git "Install git with your distro package manager."
    require_command node "Install Node.js 18 or newer, then open a fresh terminal."

    local version major
    version="$(node --version)"
    major="${version#v}"
    major="${major%%.*}"
    if ! [[ "$major" =~ ^[0-9]+$ ]] || [ "$major" -lt 18 ]; then
        fail "Node.js 18 or newer is required. Found $version."
    fi

    if ! command -v pnpm >/dev/null 2>&1; then
        if [ "$SKIP_PNPM_INSTALL" -eq 1 ]; then
            fail "Missing 'pnpm'. Install it with: npm install -g pnpm"
        fi

        require_command npm "Node.js should include npm. Reinstall Node.js LTS if npm is missing."
        if confirm "pnpm is missing. Install it globally with 'npm install -g pnpm' now?"; then
            run "$REPO_DIR" npm install -g pnpm
        else
            fail "pnpm is required. Install it with: npm install -g pnpm"
        fi
    fi

    ok "git, node, and pnpm are available"
}

ensure_vencord() {
    local package_json="$VENCORD_DIR/package.json"

    if [ -d "$VENCORD_DIR" ] && [ ! -f "$package_json" ] && path_has_child "$VENCORD_DIR"; then
        fail "'$VENCORD_DIR' exists, but it does not look like a Vencord source checkout. Use --vencord-dir with another path, or move that folder first."
    fi

    if [ ! -f "$package_json" ]; then
        if ! confirm "Clone Vencord into '$VENCORD_DIR'?"; then
            fail "A from-source Vencord checkout is required."
        fi

        mkdir -p "$(dirname "$VENCORD_DIR")"
        run "$(dirname "$VENCORD_DIR")" git clone https://github.com/Vendicated/Vencord "$VENCORD_DIR"
    fi

    ok "Vencord source found at $VENCORD_DIR"
}

install_vencord_dependencies() {
    if [ "$SKIP_DEPENDENCY_INSTALL" -eq 1 ]; then
        warn "Skipped dependency install. Build may fail if Vencord dependencies are stale or missing."
        return
    fi

    step "Installing Vencord dependencies"
    run "$VENCORD_DIR" pnpm install --frozen-lockfile
}

sync_plugin() {
    local plugin_src="$REPO_DIR/comfyPeeper"
    local plugin_dest="$VENCORD_DIR/src/userplugins/comfyPeeper"

    [ -f "$plugin_src/index.tsx" ] || fail "Could not find the plugin at '$plugin_src'. Run this script from the Discord-ComfyPeeper repo, or pass --repo-dir."

    step "Copying ComfyPeeper into Vencord userplugins"
    mkdir -p "$VENCORD_DIR/src/userplugins"
    rm -rf "$plugin_dest"
    cp -R "$plugin_src" "$plugin_dest"

    [ -f "$plugin_dest/index.tsx" ] || fail "Plugin copy failed. Expected '$plugin_dest/index.tsx'."
    ok "Plugin installed at $plugin_dest"
}

build_desktop() {
    step "Building Vencord desktop bundles"
    run "$VENCORD_DIR" pnpm build

    local renderer="$VENCORD_DIR/dist/vencordDesktopRenderer.js"
    [ -f "$renderer" ] || fail "Desktop build did not produce '$renderer'."

    if check_file_contains "$renderer" "ComfyPeeper"; then
        ok "Desktop bundle contains ComfyPeeper"
    else
        warn "ComfyPeeper was not found in the desktop renderer bundle. Check the build output above."
    fi
}

inject_discord() {
    printf '\nBefore injecting: fully quit Discord from the tray or process manager.\n'
    warn_if_running "Discord" Discord DiscordCanary DiscordPTB discord discordcanary discordptb

    if confirm "Run 'pnpm inject' now?"; then
        run "$VENCORD_DIR" pnpm inject
        ok "Injection command finished. Restart Discord and enable ComfyPeeper in Settings > Vencord > Plugins."
    else
        printf "Skipped inject. Run this later from '%s': pnpm inject\n" "$VENCORD_DIR"
    fi
}

vesktop_base_candidates() {
    if [ -n "$VESKTOP_DIR" ]; then
        dirname "$(dirname "$VESKTOP_DIR")"
        return
    fi

    printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/vesktop"
    printf '%s\n' "$HOME/.var/app/dev.vencord.Vesktop/config/vesktop"
    printf '%s\n' "$HOME/snap/vesktop/current/.config/vesktop"
}

detect_vesktop_base() {
    local candidate
    while IFS= read -r candidate; do
        [ -d "$candidate" ] && {
            printf '%s\n' "$candidate"
            return 0
        }
    done < <(vesktop_base_candidates)
    return 1
}

normalize_targets() {
    target_enabled vesktop || return

    if [ -n "$VESKTOP_DIR" ]; then
        return
    fi

    if detect_vesktop_base >/dev/null; then
        return
    fi

    if [ "$CLIENT" = "all" ]; then
        warn "No Vesktop config folder was found."
        if confirm "Skip Vesktop and continue with the other targets?"; then
            remove_target vesktop
            return
        fi
    fi

    fail "Vesktop config folder was not found. Install Vesktop and launch it once, then rerun this installer."
}

vesktop_managed_dir() {
    if [ -n "$VESKTOP_DIR" ]; then
        printf '%s\n' "$VESKTOP_DIR"
        return
    fi

    local base
    base="$(detect_vesktop_base)" || fail "Vesktop config folder was not found. Install Vesktop and launch it once, then rerun this installer."
    printf '%s/sessionData/vencordFiles\n' "$base"
}

ensure_vesktop_ready() {
    local managed="$1"
    local session_data
    session_data="$(dirname "$managed")"

    if [ ! -d "$(dirname "$session_data")" ]; then
        fail "Vesktop config folder was not found. Install Vesktop and launch it once, then rerun this installer."
    fi

    if [ ! -d "$session_data" ]; then
        warn "Vesktop exists, but '$session_data' does not. This usually means Vesktop has not been launched yet."
        if ! confirm "Create the sessionData folder anyway?"; then
            fail "Launch Vesktop once, fully quit it, then rerun this installer."
        fi
        mkdir -p "$session_data"
    fi
}

deploy_vesktop() {
    local managed
    managed="$(vesktop_managed_dir)"

    ensure_vesktop_ready "$managed"
    warn_if_running "Vesktop" Vesktop vesktop

    step "Deploying built Vencord files to Vesktop"
    if [ -d "$managed" ] && [ ! -e "$managed.bak" ]; then
        cp -a "$managed" "$managed.bak" 2>/dev/null || true
    fi
    mkdir -p "$managed"

    local file src
    for file in \
        vencordDesktopMain.js vencordDesktopMain.js.map \
        vencordDesktopPreload.js vencordDesktopPreload.js.map \
        vencordDesktopRenderer.js vencordDesktopRenderer.js.map \
        vencordDesktopRenderer.css vencordDesktopRenderer.css.map; do
        src="$VENCORD_DIR/dist/$file"
        [ -f "$src" ] && cp -f "$src" "$managed/$file"
    done

    [ -f "$managed/package.json" ] || printf '{}\n' > "$managed/package.json"

    local renderer="$managed/vencordDesktopRenderer.js"
    [ -f "$renderer" ] || fail "Vesktop deploy failed. Expected '$renderer'."

    if check_file_contains "$renderer" "ComfyPeeper"; then
        ok "Vesktop deployed bundle contains ComfyPeeper"
    else
        warn "ComfyPeeper was not found in Vesktop's deployed renderer. Check the build output above."
    fi

    printf "Fully quit Vesktop, reopen it, then enable ComfyPeeper in Settings > Plugins.\n"
}

build_browser_userscript() {
    step "Building browser userscript"
    run "$VENCORD_DIR" pnpm buildWeb

    local out="$VENCORD_DIR/dist/Vencord.user.js"
    [ -f "$out" ] || fail "Browser build did not produce '$out'."

    if check_file_contains "$out" "ComfyPeeper"; then
        ok "Userscript contains ComfyPeeper"
    else
        warn "ComfyPeeper was not found in the userscript. Check the build output above."
    fi

    printf "Install or update this file in Tampermonkey:\n  %s\n" "$out"
}

parse_args "$@"

if [ "$CLIENT" = "menu" ]; then
    select_client
fi

set_targets
ensure_linux_environment
normalize_targets

printf '\nComfyPeeper Linux installer\n'
printf 'Repo:    %s\n' "$REPO_DIR"
printf 'Vencord: %s\n' "$VENCORD_DIR"
printf 'Target:  %s\n\n' "$(join_targets)"

ensure_tools
ensure_vencord
install_vencord_dependencies
sync_plugin

if target_enabled discord || target_enabled vesktop; then
    build_desktop
fi

if target_enabled discord; then
    inject_discord
fi

if target_enabled vesktop; then
    deploy_vesktop
fi

if target_enabled browser; then
    build_browser_userscript
fi

printf '\n'
ok "Done"
