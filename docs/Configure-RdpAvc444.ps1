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

$gpus = Get-CimInstance -ClassName Win32_VideoController

if (-not $gpus) {
    Write-Host "No video controllers detected." -ForegroundColor Yellow
} else {
    $gpus |
        Select-Object Name, DriverVersion, VideoProcessor, PNPDeviceID |
        Format-Table -AutoSize | Out-String | Write-Host
}

# Heuristic: a real GPU exposes a PCI vendor ID. Hyper-V's synthetic video
# adapter and the RDP indirect display driver are software devices and do not.
# VRAM size cannot be used for this: Win32_VideoController.AdapterRAM is a
# deprecated uint32 that cannot represent 4 GB or more and reports empty on
# current Windows builds, so a 24 GB card and a synthetic adapter both read as
# nothing.
$gpuVendorPattern = 'PCI\\VEN_(10DE|1002|8086)'   # NVIDIA, AMD, Intel

$hwGpu = $gpus | Where-Object { $_.PNPDeviceID -match $gpuVendorPattern }
$hasHwGpu = [bool]$hwGpu

# A passthrough GPU whose driver is missing never becomes a video controller:
# it sits under Other devices as a raw PCI function. Azure N-series VMs arrive
# in exactly this state until the NVIDIA driver extension runs, which looks
# identical to having no GPU at all unless you go looking for it.
$driverless = @()
if (-not $hasHwGpu) {
    try {
        $driverless = Get-PnpDevice -PresentOnly -ErrorAction Stop |
            Where-Object { $_.InstanceId -match $gpuVendorPattern -and $_.Status -ne 'OK' }
    } catch {
        $driverless = @()
    }
}

# Server SKUs need an explicit policy to let RDP use the host GPU
$osInfo  = Get-CimInstance Win32_OperatingSystem
$isServer = $osInfo.ProductType -ne 1  # 1 = workstation
Write-Host "OS:        $($osInfo.Caption)"
Write-Host "Is Server: $isServer"
Write-Host "Hardware GPU available: $hasHwGpu"

if ($hasHwGpu) {
    Write-Host "Detected:  $(($hwGpu | ForEach-Object { $_.Name }) -join ', ')"
}

if ($driverless) {
    Write-Host ""
    Write-Host "A GPU is attached to this machine but has no working driver:" -ForegroundColor Yellow
    foreach ($d in $driverless) {
        Write-Host ("  [{0}] {1}" -f $d.Status, $d.FriendlyName) -ForegroundColor Yellow
        Write-Host ("        {0}" -f $d.InstanceId) -ForegroundColor DarkGray

        # The problem code is the only thing that distinguishes "no driver was
        # ever installed" from "a driver installed and then refused to start",
        # which need completely different fixes.
        try {
            $code = (Get-PnpDeviceProperty -InstanceId $d.InstanceId `
                        -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction Stop).Data
            $meaning = switch ($code) {
                28 { 'no driver installed for this device' }
                31 { 'driver present but Windows could not load it' }
                43 { 'driver loaded then the device reported a fault' }
                default { $null }
            }
            $text = if ($meaning) { "problem code $code - $meaning" } else { "problem code $code" }
            Write-Host ("        {0}" -f $text) -ForegroundColor Yellow
        } catch {
            # Property unavailable on some SKUs; the status above is enough.
        }
    }
    Write-Host ""
    Write-Host "  Until the driver is installed Windows cannot use it to encode,"  -ForegroundColor Yellow
    Write-Host "  and this script will keep reporting no hardware GPU."            -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  If the Azure driver extension already reports success, it only"  -ForegroundColor Yellow
    Write-Host "  means the extension ran. Check what it actually did:"            -ForegroundColor Yellow
    Write-Host "    Get-Content 'C:\WindowsAzure\Logs\Plugins\Microsoft.HpcCompute.NvidiaGpuDriverWindows\*\CommandExecution.log' -Tail 40" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Otherwise install the vendor driver:"                            -ForegroundColor Yellow
    Write-Host "    az account set --subscription <subscription-id>"               -ForegroundColor Gray
    Write-Host "    az vm extension set --name NvidiaGpuDriverWindows \"           -ForegroundColor Gray
    Write-Host "      --publisher Microsoft.HpcCompute --vm-name <vm> \"           -ForegroundColor Gray
    Write-Host "      --resource-group <rg>"                                        -ForegroundColor Gray
    Write-Host "  then reboot and re-run this script."                             -ForegroundColor Yellow
}

if ($isServer -and $hasHwGpu) {
    Write-Host ""
    Write-Host "NOTE: Server SKUs only let RDP use the host GPU when the policy"  -ForegroundColor Yellow
    Write-Host "      'Use hardware graphics adapters for all Remote Desktop"      -ForegroundColor Yellow
    Write-Host "      Services sessions' is enabled. That policy is the"           -ForegroundColor Yellow
    Write-Host "      bEnumerateHWBeforeSW value below, so applying these changes" -ForegroundColor Yellow
    Write-Host "      sets it; there is no need to visit gpedit.msc as well."      -ForegroundColor Yellow
    Write-Host "      A domain GPO setting it to Disabled would still win, and"    -ForegroundColor Yellow
    Write-Host "      gpedit.msc is where you would see that."                     -ForegroundColor Yellow
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
# This is the setting that matters: without it a host that prefers 4:4:4
# strips the AVC flag from an AVC420-only client rather than falling back,
# which negotiates a graphics pipeline with no codec the client can use.
$desired["$tsKey\AVC444ModePreferred"]  = 1   # Negotiate H.264 at all

# Deliberately NOT set: SelectTransport, fClientDisableUDP and
# MaxCompressionLevel. Strata connects over TCP with no sideband UDP
# transport and no bulk compression, so all three are inert here and would
# only change unrelated behaviour for other RDP clients on this host.

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
Write-Host "Verify from the Strata backend log, not Event Viewer: event IDs" -ForegroundColor Gray
Write-Host "162 (AVC444 mode) and 170 (hardware encoder) describe the host's"  -ForegroundColor Gray
Write-Host "own encoder and say nothing about what this client negotiated."    -ForegroundColor Gray
Write-Host ""
Write-Host "  docker compose logs backend | Select-String 'graphics pipeline'" -ForegroundColor Gray
Write-Host ""
Write-Host "Connect with 'Enable graphics pipeline (GFX)' ticked, then expect:" -ForegroundColor Gray
Write-Host ""
Write-Host "  'rdp graphics pipeline negotiated' with V10_7 or V8_1 caps"      -ForegroundColor Green
Write-Host "  'first rdp h264 frame passed through' with a codec_id"            -ForegroundColor Green
Write-Host ""
Write-Host "If the negotiated line reports capabilities without an AVC flag,"   -ForegroundColor Gray
Write-Host "the host declined H.264 and the session renders over the bitmap"    -ForegroundColor Gray
Write-Host "path; the backend logs an error saying so. If neither line appears" -ForegroundColor Gray
Write-Host "at all, the pipeline was never opened -- check the GFX toggle."      -ForegroundColor Gray

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
