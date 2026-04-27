# Strata VDI sample image

A minimal **starting-point** xrdp container that Strata can spawn as a
`vdi` connection. **Not a production target** — fork and bake in your
own apps, fonts, language packs, and corporate cert bundle before
shipping it to users.

## Build

```sh
docker build -t strata/vdi-sample:1.0.0 .
```

Then add the resulting image to **Admin → Settings → VDI image
whitelist** (newline- or comma-separated, exact match — no glob, no
tag substitution, no digest fuzziness; pinning is a security feature
of the whitelist).

## Runtime contract

Any image you publish for `vdi` consumption must preserve:

| Requirement | Why |
|---|---|
| `xrdp` listens on port `3389` | The Strata backend connects through guacd over RDP. Other ports require routing changes. |
| Reads `VDI_USERNAME` / `VDI_PASSWORD` from the env at start | Strata injects these at container creation. They are never written to disk by the backend; the container is responsible for materialising the local account. |
| `/home/<user>` is the persistent-home root | When `persistent_home=true` Strata bind-mounts `<vdi_home_base>/<container_name>` here. Anything outside `/home/<user>` is destroyed with the container. |
| Container exits when xrdp exits | The reaper destroys containers based on the xrdp WTSChannel disconnect frame; long-living orphans waste resources and a leaked PID-1 is a security smell. |

## Threat model notes

- **`docker.sock` = host root.** Mounting `/var/run/docker.sock` into
  the Strata backend (required for the live `DockerVdiDriver`) gives
  the backend root on the host. Treat the backend as a privileged
  service in your network policy.
- **Image whitelist is strict-equality.** `strata/vdi-sample:1.0.0`
  does **not** match `strata/vdi-sample:latest`. Pin the exact tag (or
  digest) you've reviewed.
- **Reserved env keys.** `VDI_USERNAME` / `VDI_PASSWORD` are stripped
  from operator-supplied `env_vars` on the Strata side; the runtime
  always wins. Don't try to pre-set them in the connection editor.
- **`MaxSessions=1`** in `sesman.ini` is intentional: each Strata
  `vdi` container is single-user. If you need multi-user xrdp,
  publish a separate image and a separate connection per user.

## See also

- [`docs/vdi.md`](../../docs/vdi.md) — operator runbook
- [`docs/security.md`](../../docs/security.md) — extended threat model
