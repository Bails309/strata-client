# Strata VDI Kali image

Full-fat Kali Linux XFCE desktop reachable as a Strata `vdi` connection.
Forked from `contrib/vdi-sample/` — same runtime contract, same
ephemeral-credential entrypoint, just a bigger toolbox and Kali's
XFCE theming.

## Build

The default metapackage is `kali-linux-large` — the practical "all
the tools" tier (~9 GB image, every Kali tool category except the
multi-GB tail of `kali-linux-everything`):

```sh
docker build -t strata/vdi-kali:2026.06.09 ./contrib/vdi-kali
```

Pick a different tool set at build time:

| Metapackage | Approx image size | Notes |
|---|---|---|
| `kali-linux-core` | ~2 GB | Bare minimum. |
| `kali-linux-headless` | ~4 GB | All CLI tools, no GUI apps. Not useful with this image — it's a desktop. |
| `kali-linux-default` | ~6 GB | What the Kali installer "default" gives you. Good if you want a familiar Kali desktop. |
| **`kali-linux-large`** *(default)* | ~9 GB | Every category. The recommended "all tools" target. |
| `kali-linux-everything` | ~15 GB+ | Absolutely every package in the Kali repos. Slow to pull, painful to refresh. |

```sh
docker build \
    --build-arg KALI_METAPACKAGE=kali-linux-everything \
    -t strata/vdi-kali-everything:2026.06.09 \
    ./contrib/vdi-kali
```

The base tag is also a build arg (`KALI_BASE_TAG`, defaults to
`latest`) — set it explicitly if you want to track a specific Kali
snapshot rather than rolling.

## Publish + whitelist

The same drill as any VDI image:

1. Tag immutably (`yourorg/vdi-kali:2026.06.09`, **never `:latest`** —
   the whitelist demands strict equality).
2. Push to a registry the Strata backend host can reach.
3. Add the exact `<repo>:<tag>` to **Admin -> Settings -> VDI image
   whitelist**.

See [`docs/vdi.md`](../../docs/vdi.md) for the full operator runbook.

## Runtime contract

Inherited unchanged from `contrib/vdi-sample/`:

| Requirement | Why |
|---|---|
| `xrdp` listens on port `3389` | The Strata backend connects through guacd over RDP. |
| Reads `VDI_USERNAME` / `VDI_PASSWORD` from the env at start | Strata injects these at container creation. The runtime materialises the local account; the backend never persists either value. |
| `/home/<user>` is the persistent-home root | When `persistent_home=true` Strata bind-mounts `<vdi_home_base>/<container_name>` here. Anything outside is destroyed with the container. |
| Container exits when xrdp exits | The reaper destroys containers based on the xrdp WTSChannel disconnect frame; orphans waste host resources. |

## Kali-specific operational notes

- **Egress matters.** Many Kali tools (`msfconsole` updates,
  `searchsploit` refresh, recon DNS, exploit downloads, reverse-shell
  payloads) assume outbound internet. Decide up front whether the
  container is allowed off `guac-internal` and document it in your
  runbook — the audit story is much cleaner if outbound is denied by
  default and explicitly opened per tool.
- **Capabilities.** Some Kali tools want raw sockets (`nmap -sS`,
  `tcpdump`, `aircrack-ng`). Strata's spawn path does not grant
  `--cap-add NET_RAW` / `NET_ADMIN`; tools that need them will fail
  silently or with EPERM. If you genuinely need privileged tooling,
  that's a connection-level discussion — the VDI driver deliberately
  refuses to pass through arbitrary capabilities.
- **Wireless / Bluetooth tools** (`aircrack-ng`, `bluez`) require
  host device access and won't function in an unprivileged
  containerised desktop. They're installed but inert. Use a dedicated
  hardware testbed for those workflows.
- **Disk and memory.** A `kali-linux-large` install with a working
  desktop is happiest with **>= 4 GB RAM** and **>= 4 vCPU** in the
  connection's `memory_limit_bytes` / `cpu_quota` columns.
  `kali-linux-everything` realistically wants 8 GB RAM and ample
  ephemeral disk for tool caches.
- **First-boot pull cost.** The image is big. On any new backend
  host the first VDI spawn will block for the duration of the pull
  (minutes, not seconds). Pre-pulling on each backend host
  (`docker pull <repo>:<tag>`) is the operator's responsibility —
  Strata does not pre-warm the registry.

## Threat model notes

Everything in [`contrib/vdi-sample/README.md`](../vdi-sample/README.md)
applies unchanged, plus:

- **Offensive tooling lives in this container.** Treat the network
  segment it lands on as compromised by default. Do not run Kali VDI
  containers on the same Docker network as production services
  (postgres, vault, backend). The `guac-internal` bridge isolation
  helps, but a misconfigured connection that joins `guac-default` or
  the host network would expose neighbours.
- **Audit retention.** Per-session containers are destroyed on
  logout; tool output, history files, and `~/.bash_history` go with
  them unless `persistent_home=true`. If you need forensic retention,
  enable persistent home **and** turn on Strata session recording —
  not one or the other.

## See also

- [`contrib/vdi-sample/`](../vdi-sample/) — the minimal reference
  image this one was forked from
- [`docs/vdi.md`](../../docs/vdi.md) — operator runbook
- [`docs/security.md`](../../docs/security.md) — extended threat model
