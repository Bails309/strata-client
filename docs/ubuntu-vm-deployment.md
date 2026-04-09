# Ubuntu VM Deployment Guide

This guide provides a detailed, step-by-step walkthrough for deploying Strata Client on a fresh Ubuntu 22.04 or 24.04 LTS Virtual Machine.

## 1. System Requirements

| Component | Minimum | Recommended |
|---|---|---|
| **CPU** | 2 vCPUs | 4 vCPUs |
| **RAM** | 4 GB | 8 GB |
| **Disk** | 20 GB SSD | 50 GB SSD |
| **OS** | Ubuntu 22.04+ (LTS) | Ubuntu 24.04 (LTS) |

> [!TIP]
> **guacd** is a high-performance C daemon that handles RDP/SSH/VNC encoding. It is CPU-intensive, especially with H.264 enabled.

---

## 2. Phase 1: VM Preparation

### 2.1 Update System Packages
Start by ensuring your OS is up to date:
```bash
sudo apt update && sudo apt upgrade -y
```

### 2.2 Configure Firewall (UFW)
Strata Client requires ports 80 and 443 for web traffic, and 22 for SSH access.
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 2.3 Optimize Swap (For 4GB RAM or less)
If you are running on a lower-spec VM (4GB RAM or less), it is highly recommended to enable a swap file to prevent the `guacd` container from being killed during memory spikes.

```bash
# Create 4GB swap file
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 3. Phase 2: Install Docker Engine

The official Docker convenience script is the fastest way to get Docker and Docker Compose installed correctly on Ubuntu.

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add your user to the docker group (optional, requires re-login)
sudo usermod -aG docker $USER
```

Verify installation:
```bash
docker compose version
```

---

## 4. Phase 3: Application Deployment

### 4.1 Clone the Repository
```bash
git clone https://github.com/your-org/strata-client.git
cd strata-client
```

### 4.2 Configure Environment
Copy the example environment file and edit it:
```bash
cp .env.example .env
nano .env
```

**Essential variables to set:**
- `STRATA_DOMAIN`: Set this to your domain (e.g., `strata.example.com`). This is used for CORS and SSO callback identification.
- `DEFAULT_ADMIN_PASSWORD`: Set a strong initial password.

### 4.3 Launch the Stack
Start all services in the background:
```bash
docker compose up -d
```

Check the status of the containers:
```bash
docker compose ps
```

---

## 5. Phase 4: Domain and SSL

Strata Client uses **Nginx** as its primary gateway. To enable HTTPS, you must provide your own certificates.

1. Create a `certs/` directory in the project root:
   ```bash
   mkdir -p certs
   ```
2. Place your certificates inside as `cert.pem` and `key.pem`.
3. Ensure Port 80 is open. Nginx is configured to automatically redirect all port 80 (HTTP) traffic to port 443 (HTTPS).
4. Restart the stack to pick up the certificates:
   ```bash
   docker compose up -d
   ```

---

## 6. Phase 5: Post-Deployment

### 6.1 Setup Wizard
Navigate to `https://your-domain.com`. On your first visit, the **Setup Wizard** will guide you through:
- Initializing the internal Credential Vault.
- Configuring the database (Bundled or External).
- Finalizing the admin account.

### 6.2 Data Persistence
Strata Client uses Docker volumes to ensure your data survives container restarts and upgrades:
- `postgres-data`: Database entries (connections, users, audit logs).
- `vault-data`: Encrypted credential keys.
- `backend-config`: Application settings.
- `guac-recordings`: Session recording files.

---

## 7. Maintenance & Updates

### Updating Strata Client
To pull the latest version and update your containers:
```bash
git pull
docker compose up -d --build
```

### Viewing Logs
For troubleshooting:
```bash
docker compose logs -f frontend
docker compose logs -f backend
docker compose logs -f guacd
```

### Backup
To back up your PostgreSQL database:
```bash
docker compose exec postgres-local pg_dump -U strata strata > strata_backup_$(date +%F).sql
```
