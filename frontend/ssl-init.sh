#!/bin/sh
set -e

# This script is executed by the Nginx entrypoint before starting the daemon.
# It checks for the presence of SSL certificates and enables HTTPS if found.

CERT_PATH="/etc/nginx/ssl/cert.pem"
KEY_PATH="/etc/nginx/ssl/key.pem"
TARGET_CONF="/etc/nginx/conf.d/default.conf"

echo "Checking for SSL certificates..."

if [ -f "$CERT_PATH" ] && [ -f "$KEY_PATH" ]; then
    echo "SSL certificates detected. Activating HTTPS configuration."
    cp /etc/nginx/https_enabled.conf "$TARGET_CONF"
else
    echo "SSL certificates missing. Activating HTTP-only fallback."
    cp /etc/nginx/http_only.conf "$TARGET_CONF"
fi

# Ensure common.fragment is always in the right place (if not already copied)
if [ ! -f /etc/nginx/common.fragment ]; then
    cp /etc/nginx/templates/common.fragment /etc/nginx/common.fragment
fi

echo "Nginx configuration prepared successfully."
