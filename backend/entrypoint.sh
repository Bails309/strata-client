#!/bin/sh
# Fix ownership on mount points (needed when volumes were created by root)
chown -R strata:strata /app/config 2>/dev/null || true
chown -R strata:strata /var/lib/guacamole 2>/dev/null || true
chown -R strata:strata /etc/krb5 2>/dev/null || true
exec su-exec strata strata-backend "$@"
