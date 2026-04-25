# Configure-RdpAvc444.ps1
# ---------------------------------------------------------------------------
# Inspects the current Remote Desktop AVC/H.264 settings and GPU capability
# on this Windows host, reports them, and prompts before applying changes.
#
# Mirrors sol1/rustguac's contrib/setup-rdp-performance.ps1 settings, with
# a read-first / diff-and-prompt UX layered on top.
#
# Run on the RDP HOST (the machine you connect TO), in an ELEVATED PowerShell
# session.
# ---------------------------------------------------------------------------

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

function Write-Section($title) {
    Write-Host ""
    Write-Host ("=" * 70) -ForegroundColor Cyan
    Write-Host " $title" -ForegroundColor Cyan
    Write-Host ("=" * 70) -ForegroundColor Cyan
}

function Get-RegValue($path, $name) {
    try {
        $v = Get-ItemProperty -Path $path -Name $name -ErrorAction Stop
        return $v.$name
    } catch {
        return $null
    }
}

# ---------------------------------------------------------------------------
# 1. GPU capability
# ---------------------------------------------------------------------------
Write-Section "GPU capability"

$gpus = Get-CimInstance -ClassName Win32_VideoController |
    Select-Object Name, AdapterRAM, DriverVersion, VideoProcessor

if (-not $gpus) {
    Write-Host "No video controllers detected." -ForegroundColor Yellow
} else {
    $gpus | Format-Table -AutoSize | Out-String | Write-Host
}

# Heuristic: a discrete or modern iGPU usually has > 256 MB VRAM and a real
# vendor name. Basic display adapters (e.g. "Microsoft Basic Display Adapter"
# or Hyper-V synthetic video) cannot do hardware AVC encoding.
$hasHwGpu = $false
foreach ($g in $gpus) {
    $isBasic = $g.Name -match 'Basic Display|Hyper-V|RemoteFX|Standard VGA'
    $hasRam  = ($g.AdapterRAM -as [int64]) -gt 256MB
    if (-not $isBasic -and $hasRam) { $hasHwGpu = $true; break }
}

# Server SKUs need an explicit policy to let RDP use the host GPU
$osInfo  = Get-CimInstance Win32_OperatingSystem
$isServer = $osInfo.ProductType -ne 1  # 1 = workstation
Write-Host "OS:        $($osInfo.Caption)"
Write-Host "Is Server: $isServer"
Write-Host "Hardware GPU available: $hasHwGpu"

if ($isServer -and $hasHwGpu) {
    Write-Host ""
    Write-Host "NOTE: On Server SKUs, RDP only uses the host GPU when the policy" -ForegroundColor Yellow
    Write-Host "      'Use hardware graphics adapters for all Remote Desktop"      -ForegroundColor Yellow
    Write-Host "      Services sessions' is enabled. Check gpedit.msc under:"      -ForegroundColor Yellow
    Write-Host "      Computer Configuration > Admin Templates > Windows"          -ForegroundColor Yellow
    Write-Host "      Components > Remote Desktop Services > Remote Desktop"       -ForegroundColor Yellow
    Write-Host "      Session Host > Remote Session Environment."                  -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 2. Build desired-state map
# ---------------------------------------------------------------------------
# All registry locations used. Note that DWMFRAMEINTERVAL (60 FPS unlock)
# lives under Terminal Server\WinStations — NOT under Dwm, which is a
# different subsystem. Writing it under Dwm has no effect on RDP frame rate.
$tsKey  = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
$wsKey  = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations'

$desired = [ordered]@{}

# ── AVC 4:4:4 (H.264 full-colour) ────────────────────────────────────────
$desired["$tsKey\AVC444ModePreferred"]  = 1   # Negotiate H.264 at all
$desired["$tsKey\SelectTransport"]      = 1   # Prefer UDP for video
$desired["$tsKey\MaxCompressionLevel"]  = 2   # Optimised compression

# ── 60 FPS frame rate (default is 30) ────────────────────────────────────
# Correct location is Terminal Server\WinStations, NOT \Windows\Dwm.
$desired["$wsKey\DWMFRAMEINTERVAL"]     = 15  # 15 = 60fps, 30 = 30fps

# ── GPU hardware encoding (only when a real GPU is present) ──────────────
if ($hasHwGpu) {
    $desired["$tsKey\AVCHardwareEncodePreferred"] = 1
    $desired["$tsKey\bEnumerateHWBeforeSW"]       = 1
}

# ── Desktop composition / RemoteFX / visual experience ──────────────────
$desired["$tsKey\fEnableDesktopComposition"]        = 1
$desired["$tsKey\fEnableRemoteFXAdvancedRemoteApp"] = 1
$desired["$tsKey\VisualExperiencePolicy"]           = 1   # Rich multimedia

# ── Network ──────────────────────────────────────────────────────────────
$desired["$tsKey\fClientDisableUDP"]    = 0   # Allow UDP transport
$desired["$tsKey\SelectNetworkDetect"]  = 1   # Auto-detect network quality

# ---------------------------------------------------------------------------
# 3. Diff against current values
# ---------------------------------------------------------------------------
Write-Section "Current registry values vs. desired"

$report = foreach ($full in $desired.Keys) {
    $path = Split-Path $full -Parent
    $name = Split-Path $full -Leaf
    $cur  = Get-RegValue $path $name
    [pscustomobject]@{
        Setting = $name
        Path    = $path -replace '^HKLM:\\',''
        Current = if ($null -eq $cur) { '<not set>' } else { $cur }
        Desired = $desired[$full]
        Action  = if ($null -eq $cur) { 'CREATE' }
                  elseif ($cur -ne $desired[$full]) { 'UPDATE' }
                  else { 'OK' }
    }
}

$report | Format-Table -AutoSize | Out-String | Write-Host

$pending = $report | Where-Object { $_.Action -ne 'OK' }
if (-not $pending) {
    Write-Host "All values already match the desired configuration. Nothing to do." -ForegroundColor Green
    return
}

# ---------------------------------------------------------------------------
# 4. Prompt
# ---------------------------------------------------------------------------
Write-Section "Apply changes?"

if (-not $hasHwGpu) {
    Write-Host "WARNING: no hardware GPU detected on this host." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  AVCHardwareEncodePreferred and bEnumerateHWBeforeSW will be"   -ForegroundColor Yellow
    Write-Host "  SKIPPED. Windows will use the SOFTWARE AVC encoder. This:"     -ForegroundColor Yellow
    Write-Host "    * Costs ~1-2 CPU cores per active 1080p@30 RDP session"      -ForegroundColor Yellow
    Write-Host "    * Bottlenecks at ~2-4 concurrent sessions on typical hosts"  -ForegroundColor Yellow
    Write-Host "    * Produces lower quality at the same bitrate vs hardware AVC" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Recommended choices:"                                           -ForegroundColor Yellow
    Write-Host "    PRODUCTION, multi-user, fast LAN  -> press N (skip), keep"    -ForegroundColor Yellow
    Write-Host "                                         the bitmap path"         -ForegroundColor Yellow
    Write-Host "    PRODUCTION, 1-2 users, slow WAN   -> press y, accept the"     -ForegroundColor Yellow
    Write-Host "                                         CPU cost for bandwidth"  -ForegroundColor Yellow
    Write-Host "                                         savings"                 -ForegroundColor Yellow
    Write-Host "    VERIFICATION / TESTING            -> press y, software AVC"   -ForegroundColor Yellow
    Write-Host "                                         is fine for proving"     -ForegroundColor Yellow
    Write-Host "                                         the pipeline works"      -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  See docs/h264-passthrough.md for the full decision matrix."     -ForegroundColor Yellow
    Write-Host ""
}

Write-Host "The following $($pending.Count) setting(s) will be changed:"
$pending | Format-Table Setting, Current, Desired, Action -AutoSize | Out-String | Write-Host

$answer = Read-Host "Apply these changes now? (y/N)"
if ($answer -notmatch '^[yY]') {
    Write-Host "Aborted. No changes made." -ForegroundColor Yellow
    return
}

# ---------------------------------------------------------------------------
# 5. Apply
# ---------------------------------------------------------------------------
Write-Section "Applying changes"

foreach ($full in $desired.Keys) {
    $path = Split-Path $full -Parent
    $name = Split-Path $full -Leaf
    $val  = $desired[$full]

    if (-not (Test-Path $path)) {
        New-Item -Path $path -Force | Out-Null
        Write-Host "  Created key $path"
    }

    New-ItemProperty -Path $path -Name $name -PropertyType DWord -Value $val -Force | Out-Null
    Write-Host ("  Set {0} = {1}" -f $name, $val) -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 6. Verification hint
# ---------------------------------------------------------------------------
Write-Section "Verification (after reboot + reconnect)"
Write-Host "Open Event Viewer on this host and watch for:" -ForegroundColor Gray
Write-Host "  Applications and Services Logs >" -ForegroundColor Gray
Write-Host "    Microsoft > Windows > RemoteDesktopServices-RdpCoreTS >" -ForegroundColor Gray
Write-Host "      Operational" -ForegroundColor Gray
Write-Host ""
Write-Host "  Event ID 162 = AVC444 mode active" -ForegroundColor Green
Write-Host "  Event ID 170 = Hardware encoding active" -ForegroundColor Green
Write-Host ""
Write-Host "If you see 162 but not 170, software AVC is in use (expected on" -ForegroundColor Gray
Write-Host "hosts without a usable GPU). If you see neither, AVC444 was not"  -ForegroundColor Gray
Write-Host "negotiated and the session is on the bitmap path."                -ForegroundColor Gray

# ---------------------------------------------------------------------------
# 7. Reboot prompt
# ---------------------------------------------------------------------------
Write-Section "Done"
Write-Host "A REBOOT is required for these settings to take effect." -ForegroundColor Yellow
$reboot = Read-Host "Reboot now? (y/N)"
if ($reboot -match '^[yY]') {
    Restart-Computer -Force
} else {
    Write-Host "Remember to reboot before testing RDP." -ForegroundColor Yellow
}
