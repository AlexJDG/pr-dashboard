#!/usr/bin/env bash
# Create or update a Windows desktop shortcut that runs launch.sh in this WSL distro
set -euo pipefail

cd "$(dirname "$0")"

# Windows can't reliably load icons from inside WSL, so keep a copy on the Windows side
icon_dir="$(wslpath "$(powershell.exe -NoProfile -Command '[Environment]::GetFolderPath("LocalApplicationData")' | tr -d '\r')")/pr-dashboard"
mkdir -p "$icon_dir"
cp assets/icon.ico "$icon_dir/icon.ico"

ICON="$(wslpath -w "$icon_dir/icon.ico")" DISTRO="$WSL_DISTRO_NAME" LAUNCHER="$PWD/launch.sh" WSLENV="ICON:DISTRO:LAUNCHER" \
  powershell.exe -NoProfile -Command '
    $path = Join-Path ([Environment]::GetFolderPath("Desktop")) "PR Dashboard.lnk"
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
    $shortcut.TargetPath = "$env:SystemRoot\System32\wsl.exe"
    $shortcut.Arguments = "-d $env:DISTRO -e bash -lc $env:LAUNCHER"
    $shortcut.IconLocation = "$env:ICON,0"
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    Write-Output "Saved $path"
  '
