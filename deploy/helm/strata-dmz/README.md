# strata-dmz Helm chart

Public-facing DMZ proxy for Strata Client. See
[ADR-0009](../../../docs/adr/ADR-0009-dmz-deployment-mode.md) for the
architecture and [the deployment guide §DMZ](../../../docs/deployment.md#dmz-deployment-mode)
for the operator-facing summary.

> **Looking for an end-to-end walkthrough?** See
> [Walkthrough B in the deployment guide](../../../docs/deployment.md#walkthrough-b--kubernetes-helm-chart)
> — it covers namespace prep, all three required Secrets (app + link
> mTLS + public TLS), values tuning, install, wiring the internal
> backend release, verification, and rollback. The notes below are a
> chart-level reference; the walkthrough is the canonical install path.

## Quick install

```bash
# 1. Generate the three application secrets and load them into a
#    Kubernetes Secret. Production deployments should use external-secrets,
#    sealed-secrets, or vault-injector instead.
kubectl create secret generic strata-dmz-secrets \
    --from-literal=operatorToken="$(openssl rand -base64 32)" \
    --from-literal=linkPsks="current:$(openssl rand -base64 32)" \
    --from-literal=edgeHmacKey="$(openssl rand -base64 32)"

# 2. Load the link mTLS material (server cert + key + CA).
kubectl create secret generic strata-dmz-link-tls \
    --from-file=server.crt --from-file=server.key --from-file=ca.crt

# 3. Load the public TLS cert (cert-manager produces this automatically
#    if you're using it; otherwise:)
kubectl create secret tls strata-dmz-public-tls \
    --cert=public.crt --key=public.key

# 4. Install the chart.
helm install strata-dmz ./deploy/helm/strata-dmz \
    --set image.tag=1.5.0 \
    --set config.nodeId=dmz-1 \
    --set config.clusterId=strata-cluster-prod \
    --set ingress.hosts[0].host=strata.example.com
```

The internal `strata-backend` Helm release should be configured with
matching `STRATA_DMZ_*` env (see the deployment guide §B.7). The link
PSK on the backend (`STRATA_DMZ_LINK_PSK_CURRENT`) must equal the
base64 portion after `current:` in the DMZ's `linkPsks`; the
`edgeHmacKey` must be listed in `STRATA_DMZ_EDGE_HMAC_KEYS`.

## NetworkPolicy

`networkPolicy.enabled: true` (the default) emits a NetworkPolicy
that:

- Allows public 8443 traffic ONLY from the configured ingress
  controller pod selector.
- Allows link 8444 traffic ONLY from pods matching the configured
  internal-backend selector.
- Allows operator 9444 traffic ONLY from pods labelled
  `strata.io/dmz-operator: "true"`.
- Allows DNS egress to kube-dns and NOTHING ELSE — the DMZ never
  initiates cluster-internal connections.

You **must** customise `networkPolicy.internalBackendSelector` to
match your backend's actual labels — the default `app.kubernetes.io/name:
strata-backend` will not match if your release name prefixes the
labels.

## Values

See [`values.yaml`](values.yaml). Key tunables:

| Key | Default | Notes |
|---|---|---|
| `replicaCount` | 2 | >= 2 for HA. Each replica accepts independent links. |
| `secrets.existingSecret` | `strata-dmz-secrets` | Kubernetes Secret with `operatorToken`, `linkPsks`, `edgeHmacKey`. |
| `publicTls.existingSecret` | `strata-dmz-public-tls` | TLS Secret. |
| `linkTls.existingSecret` | `strata-dmz-link-tls` | Opaque Secret with `server.crt`, `server.key`, `ca.crt`. |
| `config.trustForwardedFrom` | `[]` | CIDRs whose `X-Forwarded-For` is honoured. |
| `networkPolicy.enabled` | `true` | Strongly recommended. |
| `serviceMonitor.enabled` | `false` | Set to true if Prometheus Operator is in cluster. |

## Upgrade

The DMZ is stateless — `helm upgrade` performs a rolling restart with
the configured PodDisruptionBudget keeping at least one replica
serving public traffic at any moment. Existing links from the
internal backend will reconnect to a healthy replica within the
backoff window (see the runbook).

## Uninstall

```bash
helm uninstall strata-dmz
```

The Secrets created in step 1 are **not** removed by uninstall —
remove them manually if you're decommissioning the deployment.
