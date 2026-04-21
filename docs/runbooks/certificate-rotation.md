# Runbook — Certificate Rotation

**Purpose:** Rotate the TLS certificate that fronts the Strata deployment,
covering both ACME (Let's Encrypt) and internal-CA deployments.

## When to use

- Scheduled rotation (ACME does this itself; for internal CA, every ≤ 90 days).
- Certificate expiry alert fires (threshold: 14 days).
- The cert has been exposed (treat as compromise, rotate immediately).
- The public hostname changed.

## Prerequisites

- Shell access to the Strata host.
- For ACME: port 80 reachable from the public internet during the challenge,
  or DNS-01 credentials for the zone.
- For internal CA: the CA's signing key and the ability to issue a server cert
  for the Strata hostname.
- The new cert and key in PEM form.

## Safety checks

1. Confirm the current cert expiry:

   ```bash
   docker compose exec nginx \
     openssl x509 -in /etc/nginx/ssl/fullchain.pem -noout -dates
   ```
2. Confirm the new cert's CN / SAN matches the public hostname:

   ```bash
   openssl x509 -in new-fullchain.pem -noout -subject -ext subjectAltName
   ```
3. Confirm the new key matches the new cert:

   ```bash
   diff <(openssl x509 -in new-fullchain.pem -noout -modulus | openssl sha256) \
        <(openssl rsa -in new-privkey.pem -noout -modulus | openssl sha256)
   ```

   Both hashes must match.

## Procedure — ACME (Let's Encrypt)

> Certbot runs as a sidecar; renewal is automatic. This section
> covers **manual** renewal when the sidecar is unhealthy or
> when you need to issue for the first time.

### 1. Issue or renew

```bash
docker run --rm -it \
  -v $PWD/certs:/etc/letsencrypt \
  -v $PWD/certs/www:/var/www/certbot \
  certbot/certbot:latest \
  certonly --webroot -w /var/www/certbot \
  -d <host.example.com> \
  --agree-tos -m ops@example.com --non-interactive
```

Expected: `Successfully received certificate.` The new files land
in `./certs/live/<host>/fullchain.pem` and `privkey.pem`.

### 2. Promote into nginx's expected paths

```bash
cp ./certs/live/<host>/fullchain.pem ./certs/fullchain.pem
cp ./certs/live/<host>/privkey.pem   ./certs/privkey.pem
chmod 600 ./certs/privkey.pem
```

### 3. Reload nginx

```bash
docker compose exec nginx nginx -t && \
  docker compose exec nginx nginx -s reload
```

Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`
then a clean reload with no error output.

## Procedure — Internal CA

### 1. Generate a CSR on the Strata host

```bash
openssl req -new -newkey rsa:4096 -nodes \
  -keyout new-privkey.pem \
  -out strata.csr \
  -subj "/CN=<host.example.com>" \
  -addext "subjectAltName=DNS:<host.example.com>"
```

### 2. Sign the CSR with the internal CA

Ship `strata.csr` to the CA, receive `new-fullchain.pem` back.

### 3. Promote into nginx's expected paths

```bash
cp new-fullchain.pem ./certs/fullchain.pem
cp new-privkey.pem   ./certs/privkey.pem
chmod 600 ./certs/privkey.pem
```

### 4. Reload nginx

```bash
docker compose exec nginx nginx -t && \
  docker compose exec nginx nginx -s reload
```

## Verification

1. External handshake probe:

   ```bash
   openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null \
     | openssl x509 -noout -dates -issuer -subject
   ```

   `notAfter` should reflect the new validity window.
2. `curl -fsSL https://<host>/api/health` returns `{"status":"ok"}`
   with no cert warning.
3. SSLLabs / internal scanner reports grade unchanged or better.

## Rollback

Nginx does not cut over until `nginx -s reload` succeeds. If
validation failed, revert:

```bash
cp ./certs/fullchain.pem.bak ./certs/fullchain.pem   # if you kept one
cp ./certs/privkey.pem.bak   ./certs/privkey.pem
docker compose exec nginx nginx -s reload
```

Best practice: always `cp -a fullchain.pem fullchain.pem.bak` and
`cp -a privkey.pem privkey.pem.bak` **before** step 3 / step 2-ACME.

## Related

- [disaster-recovery.md](disaster-recovery.md)
- [../deployment.md](../deployment.md)

---

_Last reviewed: 2026-04-21_
