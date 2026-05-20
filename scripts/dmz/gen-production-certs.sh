#!/usr/bin/env bash
# scripts/dmz/gen-production-certs.sh — generate production-grade mTLS certs
# or CSRs for the Strata DMZ split-topology link.
#
# Safety first: This script will NEVER overwrite existing certs without confirmation.

set -euo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

OUT_DIR=${OUT_DIR:-./certs/dmz}
DAYS=${DAYS:-825} # ~2 years default for production compliance
EXTRA_SERVER_SANS=${EXTRA_SERVER_SANS:-}

log() {
    echo -e "\033[1;32m[prod-certs]\033[0m $1"
}

warn() {
    echo -e "\033[1;33m[WARNING]\033[0m $1"
}

error() {
    echo -e "\033[1;31m[ERROR]\033[0m $1" >&2
    exit 1
}

# Check OpenSSL availability
command -v openssl >/dev/null 2>&1 || error "OpenSSL is required but not installed."

# Ensure output directory exists
mkdir -p "$OUT_DIR"

echo "================================================================="
echo "        Strata Production DMZ Link mTLS Certificate Helper"
echo "================================================================="
echo "This script helps you generate production-grade mTLS certificates"
echo "for the secure link tunnel between your internal host and the DMZ."
echo ""
echo "Output directory: $OUT_DIR"
echo "Validity:         $DAYS days"
echo "================================================================="
echo ""

# Prevent accidental overwrites
if [ -f "$OUT_DIR/ca.crt" ] || [ -f "$OUT_DIR/server.crt" ] || [ -f "$OUT_DIR/client.crt" ]; then
    warn "Existing certificate files were detected in $OUT_DIR."
    read -p "Are you sure you want to proceed? This may overwrite files! (y/N): " confirm
    if [[ ! "$confirm" =~ ^[yY]$ ]]; then
        log "Aborted by user."
        exit 0
    fi
fi

# Ask for the DNS/IP the internal backend will dial to reach the DMZ
if [ -z "$EXTRA_SERVER_SANS" ]; then
    # Try to auto-detect from .env or .env.dmz in common paths
    AUTO_DETECTED=""
    for env_path in "./.env" "../.env" "../../.env" "./.env.dmz" "../.env.dmz"; do
        if [ -f "$env_path" ]; then
            # Grep for STRATA_DMZ_ENDPOINTS or DMZ_PUBLIC_PORT/DMZ_LINK_PORT hosts
            parsed=$(grep -E '^STRATA_DMZ_ENDPOINTS=' "$env_path" | head -n 1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
            if [ -n "$parsed" ]; then
                # Take first if comma-separated, then strip port
                AUTO_DETECTED=$(echo "$parsed" | cut -d',' -f1 | cut -d':' -f1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
                if [ -n "$AUTO_DETECTED" ]; then
                    break
                fi
            fi
        fi
    done

    echo "To issue a valid server certificate, you must specify the external"
    echo "DNS name or IP address that your internal backend will dial to reach the DMZ"
    echo "(e.g., strata-edge.example.com)."
    echo ""
    if [ -n "$AUTO_DETECTED" ]; then
        log "Auto-detected configured endpoint: '$AUTO_DETECTED' (from environment config)"
        read -p "Enter DMZ Link DNS/IP dial target [default: $AUTO_DETECTED]: " dial_target
        dial_target=${dial_target:-$AUTO_DETECTED}
    else
        read -p "Enter DMZ Link DNS/IP dial target: " dial_target
    fi

    if [ -z "$dial_target" ]; then
        error "Dial target is required to secure the server SAN."
    fi
    EXTRA_SERVER_SANS="$dial_target"
fi

echo ""
echo "Choose your certificate issuance mode:"
echo "1) Generate a Standalone Private CA & issue all mTLS certificates immediately."
echo "   (Best if you want a dedicated private PKI managed locally for Strata)"
echo ""
echo "2) Generate only Private Keys & Certificate Signing Requests (CSRs)."
echo "   (Best if you must submit CSRs to your enterprise CA / active Active Directory CS)"
echo ""
read -p "Enter choice (1 or 2): " mode_choice
echo ""

case "$mode_choice" in
    1)
        log "Starting standalone Private CA & Certificate generation..."
        
        # 1. Standalone CA
        log "Generating Private CA..."
        openssl req -x509 -newkey rsa:4096 -nodes -days "$DAYS" \
            -subj "/CN=Strata Production Link CA" \
            -keyout "$OUT_DIR/ca.key" -out "$OUT_DIR/ca.crt" 2>/dev/null
        chmod 600 "$OUT_DIR/ca.key"
        chmod 644 "$OUT_DIR/ca.crt"

        # 2. Server Cert (DMZ Link Server)
        log "Generating Server Key and CSR..."
        openssl req -newkey rsa:2048 -nodes \
            -subj "/CN=strata-dmz" \
            -keyout "$OUT_DIR/server.key" -out "$OUT_DIR/server.csr" 2>/dev/null
        
        log "Signing Server Certificate with Private CA..."
        SAN_LINE="subjectAltName=DNS:strata-dmz,DNS:localhost,DNS:$EXTRA_SERVER_SANS,IP:127.0.0.1"
        printf '%s\n' "$SAN_LINE" > "$OUT_DIR/server.ext"
        openssl x509 -req -in "$OUT_DIR/server.csr" -CA "$OUT_DIR/ca.crt" -CAkey "$OUT_DIR/ca.key" \
            -CAcreateserial -days "$DAYS" -out "$OUT_DIR/server.crt" -extfile "$OUT_DIR/server.ext" 2>/dev/null
        
        rm "$OUT_DIR/server.csr" "$OUT_DIR/server.ext"
        chmod 600 "$OUT_DIR/server.key"
        chmod 644 "$OUT_DIR/server.crt"

        # 3. Client Cert (Internal Backend Client)
        log "Generating Client Key and CSR..."
        openssl req -newkey rsa:2048 -nodes \
            -subj "/CN=strata-internal" \
            -keyout "$OUT_DIR/client.key" -out "$OUT_DIR/client.csr" 2>/dev/null

        log "Signing Client Certificate with Private CA..."
        printf 'extendedKeyUsage=clientAuth\n' > "$OUT_DIR/client.ext"
        openssl x509 -req -in "$OUT_DIR/client.csr" -CA "$OUT_DIR/ca.crt" -CAkey "$OUT_DIR/ca.key" \
            -CAcreateserial -days "$DAYS" -out "$OUT_DIR/client.crt" -extfile "$OUT_DIR/client.ext" 2>/dev/null
        
        rm "$OUT_DIR/client.csr" "$OUT_DIR/client.ext"
        chmod 600 "$OUT_DIR/client.key"
        chmod 644 "$OUT_DIR/client.crt"
        
        if [ -f "$OUT_DIR/ca.srl" ]; then rm "$OUT_DIR/ca.srl"; fi

        log "Success! All mTLS certificates generated under $OUT_DIR."
        echo ""
        echo "Next Steps:"
        echo "1. Distribute files to your hosts:"
        echo "   - On the DMZ Host (under your mount dir, e.g. ./certs/dmz/):"
        echo "     ca.crt, server.crt, server.key"
        echo "   - On the Internal Host (under your mount dir, e.g. ./certs/dmz/):"
        echo "     ca.crt, client.crt, client.key"
        echo ""
        echo "2. Apply correct non-root permissions:"
        echo "   - DMZ Host (UID 65532):"
        echo "     sudo chown -R 65532:65532 ./certs/dmz"
        echo "     sudo chmod 600 ./certs/dmz/*.key"
        echo "   - Internal Host (UID 999):"
        echo "     sudo chown -R 999:999 ./certs/dmz"
        echo "     sudo chmod 600 ./certs/dmz/*.key"
        ;;

    2)
        log "Starting Key & CSR generation for Enterprise CA..."
        
        # 1. Server CSR
        log "Generating Server Key and CSR..."
        openssl req -newkey rsa:2048 -nodes \
            -subj "/CN=strata-dmz" \
            -keyout "$OUT_DIR/server.key" -out "$OUT_DIR/server.csr" 2>/dev/null
        chmod 600 "$OUT_DIR/server.key"
        
        SAN_LINE="subjectAltName=DNS:strata-dmz,DNS:localhost,DNS:$EXTRA_SERVER_SANS,IP:127.0.0.1"
        printf '%s\n' "$SAN_LINE" > "$OUT_DIR/server.ext"
        
        log "Created Server CSR: $OUT_DIR/server.csr"
        log "Created Server SAN config extension: $OUT_DIR/server.ext"

        # 2. Client CSR
        log "Generating Client Key and CSR..."
        openssl req -newkey rsa:2048 -nodes \
            -subj "/CN=strata-internal" \
            -keyout "$OUT_DIR/client.key" -out "$OUT_DIR/client.csr" 2>/dev/null
        chmod 600 "$OUT_DIR/client.key"

        printf 'extendedKeyUsage=clientAuth\n' > "$OUT_DIR/client.ext"
        
        log "Created Client CSR: $OUT_DIR/client.csr"
        log "Created Client EKU config extension: $OUT_DIR/client.ext"

        log "Success! CSRs and Private Keys generated under $OUT_DIR."
        echo ""
        echo "Next Steps:"
        echo "1. Submit the CSRs to your Enterprise CA to sign them."
        echo "   - Sign server.csr ensuring you include the extensions from server.ext (especially SANs)."
        echo "   - Sign client.csr ensuring you include the extensions from client.ext (extendedKeyUsage = clientAuth)."
        echo "2. Retrieve the signed certificates and your Enterprise CA root cert."
        echo "3. Save them into $OUT_DIR as:"
        echo "   - ca.crt (The Enterprise CA root certificate)"
        echo "   - server.crt (The signed server certificate)"
        echo "   - client.crt (The signed client certificate)"
        echo "4. Distribute files to the hosts as detailed in option 1."
        ;;

    *)
        error "Invalid selection. Please choose 1 or 2."
        ;;
esac
