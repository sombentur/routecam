# Routecam installer for Windows (current user only, no administrator rights needed).
#   -Dev   link the extension folder instead of copying it (for development)
param([switch]$Dev)
$ErrorActionPreference = 'Stop'
$id = 'com.routecam.panel'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = @("$here\com.routecam.panel", "$here\..\extension") | Where-Object { Test-Path "$_\CSXS\manifest.xml" } | Select-Object -First 1
if (-not $src) { Write-Error 'Extension files not found next to this installer.'; exit 1 }
$src = (Resolve-Path $src).Path
$extDir = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$dst = Join-Path $extDir $id
New-Item -ItemType Directory -Force $extDir | Out-Null
if (Test-Path $dst) {
  $item = Get-Item $dst -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($dst) } else { Remove-Item $dst -Recurse -Force }
}
if ($Dev) { New-Item -ItemType Junction -Path $dst -Target $src | Out-Null; Write-Host "Linked $dst -> $src" }
else { Copy-Item $src $dst -Recurse; Write-Host "Installed to $dst" }

# Unsigned CEP extensions only load when Adobe's "PlayerDebugMode" flag is set for
# the CEP version in use (11 = After Effects 2022-2024, 12 = 2025 and later).
# It is a per-user setting; nothing is changed if it is already enabled.
foreach ($v in 11, 12) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  $cur = (Get-ItemProperty -Path $key -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode
  if ("$cur" -ne '1') {
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -Type String
    Write-Host "Enabled extension loading for CEP $v"
  }
}
Write-Host ''
Write-Host 'Done. Restart After Effects, then open  Window > Extensions > Routecam.'
