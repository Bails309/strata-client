# Runbook — Managing Production DMZ mTLS Certificates

**Purpose:** Configure, issue, deploy, and troubleshoot production-grade mTLS certificates for the secure link tunnel (port `8444`) between the `strata-backend` (internal host) and `strata-dmz` (public edge host).

---

## 1. Why mTLS is Critical for the Split-Topology DMZ

In a split-topology deployment, the DMZ host sits on the edge network and terminates all public browser requests. The internal database, Vault, and Active Directory controllers sit behind the secure internal network. 

To bridge these two zones securely without opening internal ports to the DMZ, the internal backend initiates a persistent **mTLS reverse tunnel** to the DMZ's private listener port (`8444`). 

Because this is a private tunnel:
* **Do not use a public CA (e.g. Let's Encrypt)**. Public CAs do not issue client authentication certificates with arbitrary internal SANs.
* **Use a dedicated standalone Private CA** or integrate directly with your **Enterprise PKI / Active Directory Certificate Services (AD CS)**.
* Both sides mutually authenticate: the DMZ validates the backend client certificate, and the backend validates the DMZ's server certificate.

---

## 2. Using the Production Certificate Generator

To simplify production certificate creation, a robust generator script is available at `scripts/dmz/gen-production-certs.sh`. This script supports two operation modes:

```bash
# Run the script from the root of the repository
./scripts/dmz/gen-production-certs.sh
```

### Option A: Standalone Private CA (Recommended for Simplicity)
This mode automatically generates a secure, standalone Private CA key and certificate, then immediately generates and signs both the DMZ server and backend client mTLS certificates.

1. Select **Option 1** when prompted by the script.
2. Enter the DNS name or IP the internal host will dial to reach the DMZ (e.g., `strata-edge.capita-ic.com`). 
   > [!TIP]
   > The script automatically attempts to scan `./.env` or `.env.dmz` files in parent/current paths for `STRATA_DMZ_ENDPOINTS` and parses out the host name as the default suggestion (e.g., `strata-dmz`), preventing typing and alignment errors!
3. The script outputs:
   * `ca.crt` & `ca.key` (CA Root)
   * `server.crt` & `server.key` (DMZ Listener Cert)
   * `client.crt` & `client.key` (Backend mTLS Client Cert)

### Option B: Enterprise PKI Integration (CSR Generation)
If your organization requires all certificates to be signed by an enterprise certificate authority (such as Active Directory Certificate Services or HashiCorp Vault PKI):

1. Select **Option 2** when prompted by the script.
2. The script generates the secure private keys and two Certificate Signing Requests (CSRs) along with their required extension configuration files:
   * `server.key` & `server.csr` + `server.ext` (Includes SANs for server authentication)
   * `client.key` & `client.csr` + `client.ext` (Includes `extendedKeyUsage = clientAuth`)
3. Submit the CSRs to your Enterprise PKI administrator, ensuring the extensions in `.ext` are applied during signing.
4. Once signed, name the resulting files `server.crt` and `client.crt`, and download your Enterprise CA's root certificate as `ca.crt`. Place all files back into `./certs/dmz/`.

---

## 3. Deployment Checklist & File Mapping

Once your production mTLS material is prepared under `./certs/dmz/`, distribute them to the target hosts.

> [!IMPORTANT]
> **Keep your public TLS certificates separate.** 
> Your public-facing browser certificates (e.g. Let's Encrypt or your enterprise public cert) should be named `public.crt` and `public.key` inside the `./certs/dmz/` folder on the DMZ host. They are entirely separate from the mTLS link certificates.

### DMZ Host File Mapping
On the DMZ Host, copy the files into your volume mount path (default: `./certs/dmz/`):
```text
./certs/dmz/
├── ca.crt           # Your private CA root certificate
├── server.crt       # Link server cert (presented by DMZ to internal)
├── server.key       # Link server private key
├── public.crt       # Public TLS cert (browser-facing)
└── public.key       # Public TLS private key (browser-facing)
```

### Internal Host File Mapping
On the Internal Host, copy the files into your volume mount path:
```text
./certs/dmz/
├── ca.crt           # Your private CA root certificate (MUST match the DMZ's ca.crt)
├── client.crt       # Link client cert (presented by internal to DMZ)
└── client.key       # Link client private key
```

---

## 4. Permission Boundaries (Critical)

Because Strata's production images run as non-root users for security compliance, failing to set proper file permissions will result in a crash loop with `Permission denied (os error 13)`.

### On the DMZ Host
The `strata-dmz` container runs as the distroless `nonroot` user (**UID 65532**). Lock down the keys:
```bash
sudo chown -R 65532:65532 ./certs/dmz
sudo chmod 644 ./certs/dmz/*.crt
sudo chmod 600 ./certs/dmz/*.key
```

### On the Internal Host
The `strata-backend` container runs as the custom `strata` user (**UID 999**). Lock down the keys:
```bash
sudo chown -R 999:999 ./certs/dmz
sudo chmod 644 ./certs/dmz/*.crt
sudo chmod 600 ./certs/dmz/*.key
```

---

## 5. Applying Changes

After distributing the files and setting the permissions, restart the services to load the new certificate material:

**1. Restart the DMZ Container (DMZ Host):**
```bash
docker compose -f docker-compose.yml -f docker-compose.dmz-edge.yml up -d --force-recreate strata-dmz
```

**2. Restart the Backend Container (Internal Host):**
```bash
docker compose up -d --force-recreate backend
```

---

## 6. Common Troubleshooting Scenarios

### A. Container Crash-Loops with `Permission Denied`
* **Symptoms:** Container logs show `Permission denied (os error 13) while reading server.key` (or `client.key`).
* **Fix:** Re-run the permission commands in **Section 4**. Ensure you are applying the commands to the actual host directory that is mounted into the container.

### B. Internal Backend Logs `certificate not valid for name "<hostname>"`
* **Symptoms:** The DMZ link remains down, and the backend logs show rustls rejecting the server's certificate.
* **Cause:** The host name or IP defined in `STRATA_DMZ_ENDPOINTS` on the internal backend was not included in the Server Certificate's Subject Alternative Names (SANs) when it was issued.
* **Fix:** Re-run the certificate script, providing the exact dial hostname when prompted, and deploy the new `server.crt`.

### C. DMZ Logs `TLS Handshake Failed: client certificate missing`
* **Symptoms:** Handshake fails during mTLS negotiation.
* **Cause:** The client certificate presented by the internal node is missing the required Extended Key Usage (EKU) `clientAuth` extension.
* **Fix:** Ensure you include the extensions defined in `client.ext` when signing your client certificate with your CA.
