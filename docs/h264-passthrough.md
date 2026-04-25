# H.264 GFX passthrough

Strata's RDP pipeline streams **raw H.264 NAL units** from the Windows host all
the way to the browser's `VideoDecoder` (WebCodecs API). There is no
server-side decode/re-encode step. This document covers the moving parts, the
Windows host prerequisites, and how to verify the codec is actually flowing.

## Pipeline overview

```
Windows RDP host  ──RDPGFX/AVC444──►  guacd (patched)  ──"4.h264" Guac op──►  browser
                                          │                                       │
                                          │                                       └─ Guacamole.H264Decoder
                                          │                                          (WebCodecs VideoDecoder)
                                          └─ guacd/patches/004-h264-display-worker.patch
                                             hooks RDPGFX SurfaceCommand → enqueues NAL
                                             units → emits "4.h264,<len>.<bytes>;"
```

### Components

| Layer | File / artefact | Role |
|---|---|---|
| guacd patch | [`guacd/patches/004-h264-display-worker.patch`](../guacd/patches/004-h264-display-worker.patch) | Hooks FreeRDP 3's RDPGFX `SurfaceCommand` callback. Queues AVC NAL units on each `guac_display_layer` and emits them as a custom `4.h264` Guacamole instruction during the per-frame flush. Byte-identical to the upstream sol1/rustguac patch (SHA `7a13504c2b051ec651d39e1068dc7174dc796f97`). |
| Backend defaults | [`backend/src/tunnel.rs`](../backend/src/tunnel.rs) `full_param_map()` | Seeds the RDP defaults required for AVC444 negotiation: `color-depth=32`, `disable-gfx=false`, `enable-h264=true`, `force-lossless=false`, `cursor=local`, plus the explicit `enable-*` / `disable-*` toggles FreeRDP `settings.c` requires. Per-connection extras override via the allowlist in `is_allowed_guacd_param()`. |
| Frontend decoder | [`frontend/src/lib/guacamole-vendor.js`](../frontend/src/lib/guacamole-vendor.js) | Vendored `guacamole-common-js` **1.6.0** (upgraded from 1.5.0 in v0.28.0) with `H264Decoder` bundled (line ~13408), `4.h264` opcode handler (line ~16755), and the `waitForPending` sync gate (line ~17085). The 1.6.0 line is required because the H.264 opcode, decoder class, and sync gate are all 1.6.0-only additions; stock 1.5.0 has no H.264 support. The npm `guacamole-common-js` dep in `package.json` remains at `^1.5.0` for TypeScript types only — it is never executed at runtime, because Vite redirects every `import Guacamole from "guacamole-common-js"` to the vendored 1.6.0 adapter. |
| Admin UI toggle | [`frontend/src/pages/admin/connectionForm.tsx`](../frontend/src/pages/admin/connectionForm.tsx) | Per-connection **Disable H.264 codec** checkbox. Bound to `enable-h264` (sets `"false"` to force RemoteFX fallback). Default unchecked → backend default `true` applies. |

## Windows host prerequisites

H.264 will only flow if the RDP host is configured to use AVC444. Without
this, `enable-h264=true` is a silent no-op: guacd loads the H.264 hook (you
will see `H.264 passthrough enabled for RDPGFX channel.` in the logs) but the
host never produces `SurfaceCommand` AVC callbacks, so no `4.h264`
instructions are ever emitted.

### Required registry values

These mirror sol1/rustguac's `contrib/setup-rdp-performance.ps1` exactly.

**`HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services`**

| Value | DWORD | Purpose |
|---|---|---|
| `AVC444ModePreferred` | `1` | Tells RDP to negotiate H.264 / AVC444 with the client at all. **Without this, H.264 will not flow regardless of GPU.** |
| `SelectTransport` | `1` | Prefer UDP transport (lower latency, better for AVC video). |
| `MaxCompressionLevel` | `2` | Optimised RDP compression level. |
| `AVCHardwareEncodePreferred` | `1` *(GPU only)* | Use the GPU's hardware AVC encoder when available. **Skip on hosts without a real GPU.** |
| `bEnumerateHWBeforeSW` | `1` *(GPU only)* | Enumerate hardware encoders before falling back to software. |
| `fEnableDesktopComposition` | `1` | Enable DWM compositing in remote sessions (improves video overlays / smooth scroll). |
| `fEnableRemoteFXAdvancedRemoteApp` | `1` | Enable RemoteFX features for remote app sessions. |
| `VisualExperiencePolicy` | `1` | Visual experience preset = "Rich multimedia". |
| `fClientDisableUDP` | `0` | Allow UDP transport (do not disable). |
| `SelectNetworkDetect` | `1` | Auto-detect network quality. |

**`HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations`**

| Value | DWORD | Purpose |
|---|---|---|
| `DWMFRAMEINTERVAL` | `15` | Unlocks 60 FPS RDP rendering (default is 30). `15` = 60 fps; `30` = 30 fps. |

> **⚠️ Common mistake:** older versions of this doc and helper script wrote
> `DWMFRAMEINTERVAL` under `HKLM\SOFTWARE\Microsoft\Windows\Dwm`. That key
> controls the *local* DWM and has **no effect** on RDP frame rate. The
> correct location is `Terminal Server\WinStations` as shown above.

The first three Terminal Services values (`AVC444ModePreferred`,
`SelectTransport`, `MaxCompressionLevel`) are what actually **enable H.264
negotiation** between client and server. `AVCHardwareEncodePreferred` only
chooses between the hardware and software encoder *once* H.264 is negotiated
— it does **not** turn H.264 on by itself.

### Should I run the script if the host has no hardware GPU?

Short answer: **usually no for production, yes for verification**. Long
answer:

Without a GPU, Windows falls back to the **software AVC encoder** (an MFT
in `mfh264enc.dll`). It works, but the trade-off table is unforgiving:

| Aspect | Hardware AVC | Software AVC |
|---|---|---|
| CPU on host | ~near-zero | High (1–2 cores busy per active 1080p@30 session) |
| Latency | Low | Medium-to-high under load |
| Quality at given bitrate | Good | Lower (CPU encoders trade quality for speed) |
| Concurrency ceiling | Limited only by GPU encode slots | CPU bottleneck typically at 2–4 sessions |

**Decision matrix:**

| Your situation | Recommendation |
|---|---|
| Bare metal Windows, or Windows VM with GPU passthrough / vGPU | **Run the script, reboot, use H.264.** This is the intended deployment. |
| VM with no GPU, low concurrency (1–2 users), bandwidth-constrained network | Run the script (accept software AVC trade-off). Bandwidth saving may justify the CPU cost. |
| VM with no GPU, multiple concurrent users on a fast LAN | **Don't run the script.** Keep the bitmap path — JPEG/WebP tile encoding is cheaper on the CPU than software AVC at scale, and Strata still renders fine. |
| You just want to verify the H.264 pipeline works end-to-end | Run the script. Software AVC is fine for testing; the script auto-sets `AVCHardwareEncodePreferred=0` and warns. |

### Can H.264 be used **without** running the script?

In practice, **no**. The script does two conceptually different things:

1. **Enables AVC444 negotiation** (`AVC444ModePreferred`,
   `bEnumerateHWBeforeSW`, `SelectTransport`) — these are what tell Windows
   to negotiate H.264 with the client at all. Without them, H.264 will not
   flow regardless of GPU.
2. **Picks hardware vs software encoder** (`AVCHardwareEncodePreferred`) —
   only relevant once H.264 is negotiated.

So:

- **No script run + no GPU** → No H.264. Strata uses the bitmap path.
- **No script run + GPU** → Still no H.264 in most cases. Some Windows
  builds enable AVC444 by default if a Quick Sync / NVENC adapter is
  detected on first boot of the RDP service, but it's inconsistent. The
  script makes it deterministic.
- **Script run + no GPU** → H.264 via software encoder (works, but
  CPU-heavy; see the decision matrix above).
- **Script run + GPU** → H.264 via hardware encoder (the intended target).

### Applying the values: `Configure-RdpAvc444.ps1`

[`docs/Configure-RdpAvc444.ps1`](Configure-RdpAvc444.ps1) is a read-first
helper that:

1. Enumerates `Win32_VideoController` and decides whether the host has a
   usable hardware GPU (filtering out Microsoft Basic Display Adapter,
   Hyper-V synthetic video, RemoteFX virtual adapters, and adapters with
   < 256 MB VRAM).
2. Reads the current registry values for all five settings.
3. Prints a diff table (`Setting / Path / Current / Desired / Action`).
4. **Prompts `y/N` before changing anything.** When no GPU is detected, the
   prompt explicitly explains the software-AVC CPU cost so you can opt out.
5. Auto-adjusts `AVCHardwareEncodePreferred` to `0` if no real GPU was
   detected.
6. Optionally reboots at the end (also prompted).

Exits silently with no changes if every value is already correct.

#### Running it

On the **Windows RDP host** (the machine you connect *to*, not the Strata
container host), in an **elevated PowerShell** session:

```powershell
# Copy the script to the host first (SMB share, RDP clipboard, scp, etc.)
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\Configure-RdpAvc444.ps1
```

A reboot is required for the settings to take effect; the script offers to do
this for you when it finishes.

#### Server-SKU caveat

On Windows Server SKUs, RDP only uses the host GPU if the additional Group
Policy

> Computer Configuration → Administrative Templates → Windows Components →
> Remote Desktop Services → Remote Desktop Session Host → Remote Session
> Environment → **Use hardware graphics adapters for all Remote Desktop
> Services sessions**

is **Enabled**. The helper script detects Server SKUs and prints a reminder
about this policy; it does not attempt to set the policy itself because GPO
edits require `gpedit.msc` rather than registry writes on Server.

## Verifying H.264 is flowing

Four independent layers can report activity. The Windows Event Log is the
**authoritative** source — it tells you what the RDP server itself decided
to negotiate, before any client-side observation. Use it first; the others
are useful when you can't get on the host.

### 1. Windows Event Viewer (authoritative)

On the **RDP host**, open Event Viewer:

```
Applications and Services Logs
  └─ Microsoft
     └─ Windows
        └─ RemoteDesktopServices-RdpCoreTS
           └─ Operational
```

After connecting a session, look for:

| Event ID | Meaning |
|---|---|
| **162** | AVC444 mode active — H.264 is being negotiated. |
| **170** | Hardware AVC encoder is in use (i.e. GPU is doing the encoding). |

| You see... | Diagnosis |
|---|---|
| 162 + 170 | Hardware H.264. Best case. |
| 162 only | Software H.264. Working, but CPU-heavy. See the decision matrix above. |
| Neither | AVC444 was not negotiated. Session is on the bitmap path — re-run `Configure-RdpAvc444.ps1`, reboot, reconnect. |

### 2. guacd logs

```powershell
docker compose logs --tail=200 guacd | Select-String "H\.264|AVC|RDPGFX"
```

Expected after a working H.264 session:

- One-off: `H.264 passthrough enabled for RDPGFX channel.` *(this only proves
  the hook installed; it does NOT prove frames are flowing.)*
- Repeating during activity: AVC `SurfaceCommand` debug lines (only at
  `-L debug` or `-L trace`).

If you only see the first line and no AVC activity even while moving windows,
the host is not producing AVC frames → run `Configure-RdpAvc444.ps1`.

### 3. WebSocket trace

In Chrome DevTools → Network → WS → click the tunnel → Messages. Look for
frames starting with `4.h264,` — these are H.264 NAL units being sent to the
browser. If you only see `5.image,` and `4.blob,` frames (and similar), the
host is on the bitmap path.

### 4. Browser console

```js
window.client?._h264Decoder?.stats()
```

The `_h264Decoder` field is **created lazily** on the first `4.h264`
instruction, so:

- `undefined` → no H.264 instruction has ever arrived in this session.
  Combine with check #2 to decide whether it is the host (no AVC) or the
  patch (no `4.h264` emit).
- An object with `framesDecoded > 0` → H.264 is fully active.

## Troubleshooting matrix

| Symptom | Likely cause | Action |
|---|---|---|
| Event Viewer shows neither 162 nor 170 | AVC444 was never negotiated; host is on bitmap path | Run `Configure-RdpAvc444.ps1`, reboot, reconnect |
| Event Viewer shows 162 but not 170 | Software AVC in use (no GPU, or GPU not exposed to RDP) | Expected on hosts without a GPU. On Server SKUs with a GPU, also enable "Use hardware graphics adapters for all RDP sessions" GPO. |
| `_h264Decoder` is `undefined` after several minutes of activity | Windows host is not producing AVC frames | As above (Event 162 missing) |
| guacd logs say `H.264 passthrough enabled` but no AVC debug lines, even at `-L debug` | As above | As above |
| `framesDecoded > 0` but rendering still appears to ghost during fast window animations | Browser DevTools is open and throttling GPU compositing | Close DevTools or detach it to a separate window |
| Connection works but is on the bitmap path even after host config | `color-depth` is set to `8`/`16`/`24` on the connection extras (forces RemoteFX) | Change Color Depth to "Default (32-bit, required for H.264)" in the connection form |
| Persistent ghost frames on a host you cannot reconfigure | RemoteFX fallback may be more reliable for that host | Tick **Disable H.264 codec** on that connection only |

## Why this replaced the v0.27.0 Refresh Rect mitigation

v0.27.0 shipped a guacd patch that translated a no-op resize instruction
into an RDP `Refresh Rect` PDU, asking the host to retransmit a full frame
to clear ghosting in the H.264 reference chain. That worked, but it was
treating the symptom: the ghost frames only existed because guacd was
decoding H.264 server-side and re-encoding tiles for the browser, and the
re-encoder's tile cache could fall out of sync with the AVC reference
chain on rapid window animations.

The v0.28.0 passthrough patch removes the server-side decoder entirely. The
browser's WebCodecs `VideoDecoder` consumes NAL units directly, so the tile
cache that produced the ghosts no longer exists, and Refresh Rect is no
longer necessary. The Refresh Display button in the session bar still works
— it now only does the compositor nudge.
