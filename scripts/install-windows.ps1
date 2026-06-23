#requires -Version 5.1
<#
.SYNOPSIS
Build and install ComfyPeeper into a from-source Vencord on Windows.

.DESCRIPTION
This helper automates the Windows install path for Discord desktop, Vesktop,
and the browser userscript. It creates Vencord's src\userplugins directory,
copies comfyPeeper into the exact shape Vencord expects, builds Vencord, and
then deploys the result for the selected client.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Client Vesktop -Yes
#>

[CmdletBinding()]
param(
    [ValidateSet("Menu", "Discord", "Vesktop", "Browser", "All")]
    [string] $Client = "Menu",

    [string] $RepoDir,

    [string] $VencordDir = (Join-Path $env:USERPROFILE "Vencord"),

    [switch] $Yes,

    [switch] $SkipPnpmInstall,

    [switch] $SkipDependencyInstall
)

$ErrorActionPreference = "Stop"

if (-not $RepoDir) {
    $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).ProviderPath
}

function Write-Step {
    param([string] $Message)
    Write-Host ">> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string] $Message)
    Write-Host "OK: $Message" -ForegroundColor Green
}

function Fail {
    param([string] $Message)
    throw $Message
}

function Confirm-Step {
    param([string] $Message)

    if ($Yes) {
        return $true
    }

    $answer = Read-Host "$Message [Y/n]"
    return ($answer -eq "" -or $answer -match "^[Yy]")
}

function Run-Command {
    param(
        [string] $Command,
        [string[]] $Arguments,
        [string] $WorkingDirectory
    )

    $tool = Resolve-Tool $Command
    if (-not $tool) {
        Fail "Missing '$Command'."
    }

    Write-Step "$tool $($Arguments -join ' ')"
    Push-Location $WorkingDirectory
    try {
        & $tool @Arguments
        if ($LASTEXITCODE -ne 0) {
            Fail "$Command exited with code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

function Resolve-Tool {
    param([string] $Name)

    # Prefer .cmd shims on Windows so npm/pnpm do not trip over PowerShell's
    # script execution policy when the user did not launch with -ExecutionPolicy Bypass.
    $cmdShim = Get-Command "$Name.cmd" -CommandType Application -ErrorAction SilentlyContinue
    if ($cmdShim) {
        return $cmdShim.Source
    }

    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    return $null
}

function Require-Command {
    param(
        [string] $Name,
        [string] $InstallHint
    )

    if (-not (Resolve-Tool $Name)) {
        Fail "Missing '$Name'. $InstallHint"
    }
}

function Select-Client {
    Write-Host ""
    Write-Host "Choose where to install ComfyPeeper:"
    Write-Host "  1. Discord desktop (Vencord inject)"
    Write-Host "  2. Vesktop"
    Write-Host "  3. Browser userscript (Tampermonkey)"
    Write-Host "  4. All"
    Write-Host ""

    $choice = Read-Host "Selection"
    switch ($choice) {
        "1" { return "Discord" }
        "2" { return "Vesktop" }
        "3" { return "Browser" }
        "4" { return "All" }
        default { Fail "Unknown selection '$choice'" }
    }
}

function Test-FileContains {
    param(
        [string] $Path,
        [string] $Needle
    )

    return [bool](Select-String -Path $Path -SimpleMatch $Needle -Quiet -ErrorAction SilentlyContinue)
}

function Warn-IfProcessRunning {
    param(
        [string[]] $Names,
        [string] $DisplayName
    )

    $running = @()
    foreach ($name in $Names) {
        $running += @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    }

    if ($running.Count -eq 0) {
        return
    }

    Write-Warning "$DisplayName appears to be running. Fully quit it from the system tray before continuing."
    if (-not (Confirm-Step "Continue anyway?")) {
        Fail "Close $DisplayName and rerun this installer."
    }
}

function Ensure-WindowsEnvironment {
    if (-not $env:USERPROFILE) {
        Fail "USERPROFILE is not set. Run this from a normal Windows PowerShell session."
    }

    if (($targets -contains "Vesktop") -and -not $env:APPDATA) {
        Fail "APPDATA is not set. Vesktop deployment needs the Windows AppData folder."
    }
}

function Normalize-Targets {
    if (-not ($targets -contains "Vesktop")) {
        return
    }

    $vesktopRoot = Join-Path $env:APPDATA "vesktop"
    if (Test-Path $vesktopRoot) {
        return
    }

    if ($Client -eq "All") {
        Write-Warning "Vesktop config folder was not found at '$vesktopRoot'."
        if (Confirm-Step "Skip Vesktop and continue with the other targets?") {
            $script:targets = @($script:targets | Where-Object { $_ -ne "Vesktop" })
            return
        }
    }

    Fail "Vesktop config folder was not found at '$vesktopRoot'. Install Vesktop and launch it once, then rerun this installer."
}

function Ensure-Tools {
    Write-Step "Checking required tools"
    Require-Command "git" "Install Git for Windows from https://git-scm.com/download/win, then open a fresh PowerShell window."
    Require-Command "node" "Install Node.js LTS from https://nodejs.org, then open a fresh PowerShell window."

    $nodeVersion = (& node --version).Trim()
    $nodeMajor = [int](($nodeVersion -replace "^v", "").Split(".")[0])
    if ($nodeMajor -lt 18) {
        Fail "Node.js 18 or newer is required. Found $nodeVersion."
    }

    if (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) {
        if ($SkipPnpmInstall) {
            Fail "Missing 'pnpm'. Install it with: npm install -g pnpm"
        }

        Require-Command "npm" "Node.js should include npm. Reinstall Node.js LTS if npm is missing."
        if (Confirm-Step "pnpm is missing. Install it globally with 'npm install -g pnpm' now?") {
            Run-Command -Command "npm" -Arguments @("install", "-g", "pnpm") -WorkingDirectory $RepoDir
        } else {
            Fail "pnpm is required. Install it with: npm install -g pnpm"
        }
    }

    Write-Ok "git, node, and pnpm are available"
}

function Ensure-Vencord {
    $packageJson = Join-Path $VencordDir "package.json"

    if ((Test-Path $VencordDir) -and -not (Test-Path $packageJson)) {
        $firstChild = Get-ChildItem -Force -Path $VencordDir -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($firstChild) {
            Fail "'$VencordDir' exists, but it does not look like a Vencord source checkout. Use -VencordDir with another path, or move that folder first."
        }
    }

    if (-not (Test-Path $packageJson)) {
        if (-not (Confirm-Step "Clone Vencord into '$VencordDir'?")) {
            Fail "A from-source Vencord checkout is required."
        }

        $parent = Split-Path -Parent $VencordDir
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        Run-Command -Command "git" -Arguments @("clone", "https://github.com/Vendicated/Vencord", $VencordDir) -WorkingDirectory $parent
    }

    Write-Ok "Vencord source found at $VencordDir"
}

function Install-VencordDependencies {
    if ($SkipDependencyInstall) {
        Write-Host "Skipped dependency install. Build may fail if Vencord dependencies are stale or missing."
        return
    }

    Write-Step "Installing Vencord dependencies"
    Run-Command -Command "pnpm" -Arguments @("install", "--frozen-lockfile") -WorkingDirectory $VencordDir
}

function Sync-Plugin {
    $pluginSrc = Join-Path $RepoDir "comfyPeeper"
    $pluginIndex = Join-Path $pluginSrc "index.tsx"
    if (-not (Test-Path $pluginIndex)) {
        Fail "Could not find the plugin at '$pluginSrc'. Run this script from the Discord-ComfyPeeper repo, or pass -RepoDir."
    }

    $userPlugins = Join-Path $VencordDir "src\userplugins"
    $pluginDest = Join-Path $userPlugins "comfyPeeper"

    Write-Step "Copying ComfyPeeper into Vencord userplugins"
    New-Item -ItemType Directory -Force -Path $userPlugins | Out-Null
    Remove-Item -Recurse -Force $pluginDest -ErrorAction SilentlyContinue
    Copy-Item -Recurse -Force $pluginSrc $pluginDest

    if (-not (Test-Path (Join-Path $pluginDest "index.tsx"))) {
        Fail "Plugin copy failed. Expected '$pluginDest\index.tsx'."
    }

    Write-Ok "Plugin installed at $pluginDest"
}

function Build-Desktop {
    Write-Step "Building Vencord desktop bundles"
    Run-Command -Command "pnpm" -Arguments @("build") -WorkingDirectory $VencordDir

    $renderer = Join-Path $VencordDir "dist\vencordDesktopRenderer.js"
    if (-not (Test-Path $renderer)) {
        Fail "Desktop build did not produce '$renderer'."
    }
    if (-not (Test-FileContains $renderer "ComfyPeeper")) {
        Write-Warning "ComfyPeeper was not found in the desktop renderer bundle. Check the build output above."
    } else {
        Write-Ok "Desktop bundle contains ComfyPeeper"
    }
}

function Inject-Discord {
    Write-Host ""
    Write-Host "Before injecting: fully quit Discord from the system tray." -ForegroundColor Yellow
    Warn-IfProcessRunning -Names @("Discord", "DiscordCanary", "DiscordPTB") -DisplayName "Discord"

    if (Confirm-Step "Run 'pnpm inject' now?") {
        Run-Command -Command "pnpm" -Arguments @("inject") -WorkingDirectory $VencordDir
        Write-Ok "Injection command finished. Restart Discord and enable ComfyPeeper in Settings > Vencord > Plugins."
    } else {
        Write-Host "Skipped inject. Run this later from '$VencordDir': pnpm inject"
    }
}

function Ensure-VesktopReady {
    $vesktopRoot = Join-Path $env:APPDATA "vesktop"
    $sessionData = Join-Path $vesktopRoot "sessionData"

    if (-not (Test-Path $vesktopRoot)) {
        Fail "Vesktop config folder was not found at '$vesktopRoot'. Install Vesktop and launch it once, then rerun this installer."
    }

    if (-not (Test-Path $sessionData)) {
        Write-Warning "Vesktop exists, but '$sessionData' does not. This usually means Vesktop has not been launched yet."
        if (-not (Confirm-Step "Create the sessionData folder anyway?")) {
            Fail "Launch Vesktop once, fully quit it from the tray, then rerun this installer."
        }
        New-Item -ItemType Directory -Force -Path $sessionData | Out-Null
    }
}

function Deploy-Vesktop {
    Ensure-VesktopReady
    Warn-IfProcessRunning -Names @("Vesktop", "vesktop") -DisplayName "Vesktop"

    $managed = Join-Path $env:APPDATA "vesktop\sessionData\vencordFiles"
    $renderer = Join-Path $managed "vencordDesktopRenderer.js"

    Write-Step "Deploying built Vencord files to Vesktop"
    $managedExisted = Test-Path $managed
    $backup = "$managed.bak"
    if ($managedExisted -and -not (Test-Path $backup)) {
        Copy-Item -Recurse -Force $managed $backup -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $managed | Out-Null

    $files = @(
        "vencordDesktopMain.js",
        "vencordDesktopMain.js.map",
        "vencordDesktopPreload.js",
        "vencordDesktopPreload.js.map",
        "vencordDesktopRenderer.js",
        "vencordDesktopRenderer.js.map",
        "vencordDesktopRenderer.css",
        "vencordDesktopRenderer.css.map"
    )

    foreach ($file in $files) {
        $src = Join-Path $VencordDir "dist\$file"
        if (Test-Path $src) {
            Copy-Item -Force $src (Join-Path $managed $file)
        }
    }

    $managedPackage = Join-Path $managed "package.json"
    if (-not (Test-Path $managedPackage)) {
        Set-Content -Path $managedPackage -Value "{}" -Encoding ASCII
    }

    if (-not (Test-Path $renderer)) {
        Fail "Vesktop deploy failed. Expected '$renderer'."
    }
    if (-not (Test-FileContains $renderer "ComfyPeeper")) {
        Write-Warning "ComfyPeeper was not found in Vesktop's deployed renderer. Check the build output above."
    } else {
        Write-Ok "Vesktop deployed bundle contains ComfyPeeper"
    }

    Write-Host "Fully quit Vesktop from the tray, reopen it, then enable ComfyPeeper in Settings > Plugins."
}

function Build-BrowserUserscript {
    Write-Step "Building browser userscript"
    Run-Command -Command "pnpm" -Arguments @("buildWeb") -WorkingDirectory $VencordDir

    $out = Join-Path $VencordDir "dist\Vencord.user.js"
    if (-not (Test-Path $out)) {
        Fail "Browser build did not produce '$out'."
    }
    if (-not (Test-FileContains $out "ComfyPeeper")) {
        Write-Warning "ComfyPeeper was not found in the userscript. Check the build output above."
    } else {
        Write-Ok "Userscript contains ComfyPeeper"
    }

    Write-Host "Install or update this file in Tampermonkey:"
    Write-Host "  $out"
}

if ($Client -eq "Menu") {
    $Client = Select-Client
}

$targets = if ($Client -eq "All") {
    @("Discord", "Vesktop", "Browser")
} else {
    @($Client)
}

Ensure-WindowsEnvironment
Normalize-Targets

Write-Host ""
Write-Host "ComfyPeeper Windows installer"
Write-Host "Repo:    $RepoDir"
Write-Host "Vencord: $VencordDir"
Write-Host "Target:  $($targets -join ', ')"
Write-Host ""

Ensure-Tools
Ensure-Vencord
Install-VencordDependencies
Sync-Plugin

$needsDesktopBuild = ($targets -contains "Discord") -or ($targets -contains "Vesktop")
if ($needsDesktopBuild) {
    Build-Desktop
}

if ($targets -contains "Discord") {
    Inject-Discord
}

if ($targets -contains "Vesktop") {
    Deploy-Vesktop
}

if ($targets -contains "Browser") {
    Build-BrowserUserscript
}

Write-Host ""
Write-Ok "Done"
