# Kubernetes Deployment Guide

This document covers deploying Strata to a Kubernetes cluster using
Helm-style values. It is written against Kubernetes 1.28+ and assumes
you are familiar with `kubectl`, persistent volumes, ingress
controllers, and external-secret stores.

For single-node Docker Compose deployments see
[deployment.md](deployment.md). For VM-on-Ubuntu deployments see
[ubuntu-vm-deployment.md](ubuntu-vm-deployment.md).

> **Status note.** Strata does not currently ship an official Helm
> chart in this repository. The manifests below are the canonical
> reference shape. They are derived from the
> [docker-compose.yml](../docker-compose.yml) topology and the
> environment-variable surface in [backend/src/config.rs](../backend/src/config.rs).
> Operators are expected to maintain their own values overlay and
> kustomize/helm wrapper.

## Topology

A production deployment is composed of these workloads:

| Workload          | Kind                     | Replicas | Notes |
|-------------------|--------------------------|----------|-------|
| `strata-backend`  | Deployment               | 1 today  | See **Multi-replica caveats** below before scaling out. |
| `strata-frontend` | Deployment               | 2+       | Stateless nginx; safe to scale freely. |
| `strata-guacd`    | Deployment               | 2+       | Stateless; sticky session per active connection enforced via the backend. |
| `strata-dmz`      | Deployment (in DMZ namespace) | 1+ | Optional; only when running the DMZ edge. See [dmz-implementation-plan.md](dmz-implementation-plan.md). |
| `vault`           | StatefulSet              | 1        | Or use a managed Vault. |
| `postgres`        | StatefulSet or external  | 1        | Strongly prefer a managed Postgres. |
| `recordings-pvc`  | PersistentVolumeClaim    | —        | RWO if single backend; RWX (NFS / Azure Files) if scaled. |

## Multi-replica caveats

As of v1.5.x the backend keeps several pieces of state in process-local
memory. Running more than one `strata-backend` replica without
addressing them will cause correctness bugs:

* **Rate-limit counters** — login throttle, change-password throttle,
  edge accept-rate. A second pod has its own counters; an attacker can
  multiply the limit by `replicas`. See
  [backend/src/services/middleware.rs](../backend/src/services/middleware.rs).
* **Settings cache** — admin-toggleable settings (`sso_enabled`,
  `local_auth_enabled`, watermark, etc.) cache for 5 seconds per pod.
  Toggles take up to that long to propagate. See
  [backend/src/services/settings.rs](../backend/src/services/settings.rs).
* **OIDC discovery cache** — independent per pod; benign but wasteful.
* **Active session bookkeeping** — sessions are anchored to the pod
  that accepted the WebSocket. Pod restarts terminate active sessions
  on that pod (no cross-pod migration).

Run `replicas: 1` for `strata-backend` until a release notes that the
shared backends (Redis, PostgreSQL `LISTEN/NOTIFY`) are wired in. The
frontend and `guacd` can be scaled freely today.

When that work lands, move the cache layers to Redis and the
share-revocation broadcast to `LISTEN/NOTIFY`, then bump
`strata-backend` to `replicas: 2+` with a leader-elected cleanup
worker.

## Namespaces

```
strata-system     # backend, frontend, guacd, postgres, vault
strata-dmz        # optional DMZ edge, in a separate namespace with its
                  # own NetworkPolicy that only allows egress to the
                  # backend's link-server port.
```

## Secrets

Use [External Secrets Operator](https://external-secrets.io/) backed by
Vault, AWS Secrets Manager, or Azure Key Vault. Do **not** mount raw
`Secret` resources containing the Vault root token, JWT signing key,
or DB credentials.

Required secrets (one ExternalSecret each, mounted as env vars):

| Env var                  | Source                | Notes |
|--------------------------|-----------------------|-------|
| `DATABASE_URL`           | Postgres credentials  | Include `sslmode=verify-full` and CA path. |
| `JWT_SECRET`             | Generated 64-byte hex | Rotate by dual-running with `JWT_SECRET_NEXT`; see [runbooks/](runbooks/). |
| `VAULT_ADDR`             | Plain config          | Not secret. |
| `VAULT_TOKEN`            | Vault AppRole login   | Use a periodic, renewable token. |
| `DEFAULT_ADMIN_PASSWORD` | One-time-use          | Set only on first boot; remove after setup completes. |
| `SMTP_USERNAME`          | SMTP relay creds      | If notifications enabled. |
| `SMTP_PASSWORD`          | SMTP relay creds      | If notifications enabled. |

For the DMZ edge:

| Env var                  | Source                | Notes |
|--------------------------|-----------------------|-------|
| `LINK_PSK`               | Generated 32-byte hex | Must match the backend's expected PSK. Rotate per [ADR-0010](adr/ADR-0010-dmz-phase6-hardening.md). |
| `LINK_TLS_CERT`          | mTLS edge cert        | Issued by an internal CA the backend trusts. |
| `LINK_TLS_KEY`           | mTLS edge key         | |
| `PUBLIC_TLS_CERT`        | Public-facing cert    | Or use cert-manager + Let's Encrypt. |
| `PUBLIC_TLS_KEY`         | Public-facing key     | |

## Persistent volumes

| PVC name             | Workload          | Access mode | Size (start) | Storage class |
|----------------------|-------------------|-------------|--------------|---------------|
| `strata-postgres`    | postgres          | RWO         | 100Gi        | fast-ssd      |
| `strata-vault`       | vault             | RWO         | 5Gi          | fast-ssd      |
| `strata-recordings`  | strata-backend    | RWO (RWX if scaled) | 500Gi+ | bulk-ssd or NFS |
| `strata-config`      | strata-backend    | RWO         | 1Gi          | fast-ssd      |

Recordings grow unbounded; configure a retention job (see
[runbooks/database-operations.md](runbooks/database-operations.md)) and
plan for cold-tier offload (Azure Blob, S3) once the pluggable
recording-store work lands.

## Ingress

A single public ingress fronts the frontend; `/api` is proxied to the
backend, `/api/sessions/.../ws` is upgraded to WebSocket.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: strata
  namespace: strata-system
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-body-size: "256m"
    # WebSocket upgrade
    nginx.ingress.kubernetes.io/proxy-http-version: "1.1"
    # HSTS (also enforced by the backend, but belt-and-braces)
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "Strict-Transport-Security: max-age=31536000; includeSubDomains";
spec:
  ingressClassName: nginx
  tls:
    - hosts: [strata.example.com]
      secretName: strata-public-tls   # cert-manager
  rules:
    - host: strata.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: strata-backend
                port:
                  number: 8443
          - path: /
            pathType: Prefix
            backend:
              service:
                name: strata-frontend
                port:
                  number: 8080
```

If you front with Traefik, the equivalent annotations are
`traefik.ingress.kubernetes.io/router.tls=true` and a custom
`Middleware` for WebSocket support.

## NetworkPolicy

The backend should be reachable only by the frontend, the guacd pool,
the DMZ edge (if deployed), and cluster-scrape monitors:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-allow
  namespace: strata-system
spec:
  podSelector: { matchLabels: { app: strata-backend } }
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: strata-frontend } }
        - podSelector: { matchLabels: { app: strata-guacd } }
        - namespaceSelector: { matchLabels: { name: strata-dmz } }
          podSelector: { matchLabels: { app: strata-dmz } }
        - namespaceSelector: { matchLabels: { name: monitoring } }
          podSelector: { matchLabels: { app: prometheus } }
  egress:
    # postgres
    - to: [{ podSelector: { matchLabels: { app: postgres } } }]
      ports: [{ port: 5432 }]
    # vault
    - to: [{ podSelector: { matchLabels: { app: vault } } }]
      ports: [{ port: 8200 }]
    # guacd pool
    - to: [{ podSelector: { matchLabels: { app: strata-guacd } } }]
      ports: [{ port: 4822 }]
    # DNS, AD/LDAP, SMTP, OIDC discovery — open per environment
```

The DMZ namespace gets its own restrictive policy that only permits
egress on the link-server port to the backend service in
`strata-system`.

## Probes

Use the split health endpoints:

```yaml
livenessProbe:
  httpGet:
    path: /api/health/live
    port: 8443
    scheme: HTTPS
  initialDelaySeconds: 10
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /api/health/ready
    port: 8443
    scheme: HTTPS
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 6
```

`/api/health/live` returns 200 whenever the process is up. The
`/api/health/ready` endpoint additionally verifies database, Vault,
and AD/LDAP reachability and returns 503 if any critical dependency
is degraded. See [backend/src/routes/health.rs](../backend/src/routes/health.rs).

## Resource requests & limits

Starting points for a 50–200 user deployment:

| Workload          | CPU request | CPU limit | Memory request | Memory limit |
|-------------------|------------:|----------:|---------------:|-------------:|
| strata-backend    |       250m  |       2   |         512Mi  |        2Gi   |
| strata-frontend   |        50m  |     200m  |          64Mi  |       128Mi  |
| strata-guacd      |       500m  |       2   |         256Mi  |        1Gi   |
| strata-dmz (edge) |       100m  |     500m  |         128Mi  |       512Mi  |
| postgres          |       500m  |       2   |        1024Mi  |        4Gi   |
| vault             |       100m  |     500m  |         256Mi  |        1Gi   |

Scale CPU on guacd horizontally first (it is the bottleneck under
many concurrent RDP sessions). Scale memory on the backend if you run
many concurrent file transfers.

## Graceful shutdown

The backend honours `SIGTERM` and drains active sessions for up to
~30 seconds before exiting. Set:

```yaml
terminationGracePeriodSeconds: 45
```

Shorter values will kill in-progress sessions abruptly.

## Monitoring

Once the Prometheus exporter is wired (planned for v1.6) the backend
exposes metrics at `/api/metrics`. Until then, scrape the
`/api/health/ready` endpoint and alert on non-200 responses, plus the
postgres, vault, and ingress controller exporters.

Recommended dashboards live under [docs/grafana/](grafana/).

## Backups

* **Postgres**: nightly `pg_dump` to off-cluster object storage.
  Retain 30 days. Verify monthly with a restore drill against an
  ephemeral environment. See
  [runbooks/disaster-recovery.md](runbooks/disaster-recovery.md).
* **Vault**: snapshot the storage backend (Raft snapshot for
  integrated storage) nightly. Snapshots are encrypted with the seal
  key — protect them as carefully as production.
* **Recordings PVC**: snapshot the underlying volume nightly. Apply
  retention per legal/compliance requirements.

## Upgrades

Strata uses semantic versioning. See
[API-LIFECYCLE.md](API-LIFECYCLE.md) for the API support window.

For minor and patch upgrades:

1. Drain traffic from one backend pod.
2. Roll the backend Deployment with `maxUnavailable: 1`.
3. Wait for `/api/health/ready` to return 200 on the new pod.
4. Continue until all replicas are on the new image.
5. Run any post-deploy data migrations the release notes call out.

For major upgrades, follow the release-specific upgrade guide in
[CHANGELOG](../CHANGELOG.md) and exercise the disaster-recovery
runbook against a staging environment first.

## Common pitfalls

* **WebSocket idle timeouts.** The default ingress idle timeout is
  often 60 seconds; long-lived guacd sessions need an extended
  `proxy-read-timeout` (3600s). Symptoms: sessions disconnect after
  ~60s with no client error.
* **TLS termination at the ingress only.** The backend expects to see
  `X-Forwarded-Proto: https` and a stable `X-Forwarded-For`. Configure
  your ingress to set both, and configure the backend to trust the
  ingress IP.
* **PVC RWO when scaled.** Recordings on RWO with multiple backend
  replicas → ContainerCreating loops on rollout. Use RWX or pin
  recordings writes to a single replica until the S3 store ships.
* **NFS for recordings without `noatime`.** Causes spurious metadata
  writes that block recording finalisation. Mount with
  `noatime,nodiratime`.

## Antivirus scanning sidecar (v1.12.0+)

> Reference: [ADR-0011](adr/ADR-0011-av-scanning.md), [av-scanning.md](av-scanning.md), [runbooks/av-operations.md](runbooks/av-operations.md).

Strata's antivirus scanner trait supports three backends. On
Kubernetes the recommended shape is a dedicated `clamav`
Deployment + ClusterIP Service, with a PVC for the signature
database so freshclam pulls survive pod restarts.

### Deployment + Service + PVC

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: strata-clamav-db
  namespace: strata
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 4Gi
  storageClassName: fast-ssd
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: strata-clamav
  namespace: strata
spec:
  replicas: 1                       # clamd is single-writer to the DB volume
  strategy:
    type: Recreate                  # avoid two pods racing the PVC
  selector:
    matchLabels: { app: strata-clamav }
  template:
    metadata:
      labels: { app: strata-clamav }
    spec:
      securityContext:
        runAsNonRoot: false         # upstream clamav/clamav:stable runs as clamav uid 100
        fsGroup: 100
      containers:
        - name: clamav
          image: clamav/clamav:stable
          imagePullPolicy: IfNotPresent
          ports:
            - { name: clamd, containerPort: 3310, protocol: TCP }
          env:
            - { name: CLAMAV_NO_FRESHCLAMD, value: "false" }   # daily signature pull
            - { name: CLAMAV_NO_CLAMD,      value: "false" }
            - { name: CLAMAV_NO_MILTERD,    value: "true" }    # not needed
          readinessProbe:
            exec:
              command: [clamdcheck.sh]
            initialDelaySeconds: 300   # absorb first-boot freshclam pull (~250 MB)
            periodSeconds: 30
            timeoutSeconds: 5
          livenessProbe:
            exec:
              command: [clamdcheck.sh]
            initialDelaySeconds: 600
            periodSeconds: 60
            timeoutSeconds: 5
            failureThreshold: 3
          resources:
            requests: { cpu: "500m", memory: "1.5Gi" }
            limits:   { cpu: "2",    memory: "3Gi"   }
          volumeMounts:
            - { name: clamav-db, mountPath: /var/lib/clamav }
      volumes:
        - name: clamav-db
          persistentVolumeClaim:
            claimName: strata-clamav-db
---
apiVersion: v1
kind: Service
metadata:
  name: strata-clamav
  namespace: strata
spec:
  type: ClusterIP                   # internal-only — never expose to ingress
  selector: { app: strata-clamav }
  ports:
    - { name: clamd, port: 3310, targetPort: 3310, protocol: TCP }
```

### Backend env wiring

Add the AV variables to the backend Deployment's `env:`:

```yaml
- { name: STRATA_AV_BACKEND,        value: clamav }
- { name: STRATA_AV_FAIL_MODE,      value: block }      # default; reject on scanner error
- { name: STRATA_AV_CLAMD_HOST,     value: strata-clamav }     # the Service DNS name above
- { name: STRATA_AV_CLAMD_PORT,     value: "3310" }
- { name: STRATA_AV_MAX_SCAN_SIZE,  value: "104857600" }  # 100 MiB
- { name: STRATA_AV_TIMEOUT_MS,     value: "30000" }
```

### NetworkPolicy — restrict clamd access to backend pods only

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: strata-clamav-ingress
  namespace: strata
spec:
  podSelector:
    matchLabels: { app: strata-clamav }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: strata-backend }
      ports:
        - { protocol: TCP, port: 3310 }
```

This ensures the public ingress, the frontend nginx pods, and any
unrelated workloads in the namespace cannot reach `clamd:3310` —
only the backend can. Combined with the ClusterIP Service type,
clamd has no path to the outside world.

### Verification

```bash
# 1. Pod is Running and Ready (signature pull may take ~3-5 min on first boot)
kubectl -n strata wait --for=condition=Ready pod -l app=strata-clamav --timeout=10m

# 2. Backend logs report the scanner is wired
kubectl -n strata logs -l app=strata-backend | grep 'av scanner ready'

# 3. EICAR smoke test
kubectl -n strata exec deploy/strata-backend -- \
  sh -c 'printf "X5O!P%%@AP[4\\PZX54(P^)7CC)7}\$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H+H*" > /tmp/eicar.com \
         && curl -sS -o /dev/null -w "%{http_code}\n" \
              -X POST http://localhost:8080/api/files/upload \
              -H "Cookie: access_token=$STRATA_AV_SMOKE_TOKEN" \
              -F session_id=$STRATA_AV_SMOKE_SESSION \
              -F file=@/tmp/eicar.com'
# Expected: 400
```

### Resource sizing notes

- **PVC size:** 4 Gi is generous. The signature DB is ~1.4 GB
  resident; clamav writes update files alongside, peaking around
  3 Gi during freshclam runs.
- **Memory:** budget 1.5 Gi requests / 3 Gi limit. Below 1.5 Gi
  clamd will OOM-kill mid-load and freshclam will fail to refresh.
- **CPU:** 500m requests / 2 limit. clamd is largely IO-bound on
  scan operations; the CPU ceiling matters most during freshclam.
- **High-availability note:** clamd is single-writer to the PVC.
  Run a single replica with `strategy: Recreate`. If your Quick
  Share throughput justifies horizontal scale, deploy multiple
  independent `strata-clamav-N` Deployments each backed by its own
  PVC and front them with a Service whose selector spans all
  replicas — the backend hashes the file independently per scan so
  any healthy replica suffices.

### Command-driven alternative

The `command` backend (Microsoft Defender, Sophos, ESET, etc.)
requires the scanner binary to be reachable inside the backend
container. Two patterns:

1. **Re-base the backend image** with the scanner installed at
   build time, then set `STRATA_AV_BACKEND=command` and
   `STRATA_AV_CMD=...`. Recommended for Defender for Endpoint
   which already publishes a Linux installer.
2. **Sidecar pattern with shared `emptyDir`** — run the scanner
   in its own container in the same pod, mount a shared
   `emptyDir` volume at the path Strata writes temp files to,
   and have the scanner read from the same mount. This loses
   the network-isolation benefit of the ClamAV Service /
   NetworkPolicy pattern above, so prefer pattern (1) where
   feasible.

