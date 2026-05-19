# ── Build stage ────────────────────────────────────────────────────────
# Base image tags are re-pulled on each build so security patches land
# without needing a Dependabot PR every week. Dependabot (docker ecosystem)
# still opens PRs whenever the tag itself moves, and Trivy (CI image scan)
# gates HIGH/CRITICAL fixable CVEs so staleness cannot ship to main.
FROM node:26-alpine@sha256:e71ac5e964b9201072425d59d2e876359efa25dc96bb1768cb73295728d6e4ea AS builder

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --legacy-peer-deps
COPY VERSION ../VERSION
COPY docs/ ../docs/
COPY frontend/ .
RUN npm run build

# ── Runtime stage (nginx) ─────────────────────────────────────────────
FROM nginx:1.31.0-alpine@sha256:dc48b7a872a79fb541ba5081d320b11b549231bc63ba465a7495afaa7d2ebcb8

# Pull the latest Alpine package security patches. `nginx:alpine` is often
# a few days behind on libcrypto/musl/zlib fixes — this shaves the lag so
# Trivy doesn't flag HIGH CVEs with an upstream fix already available.
# shellcheck disable=SC2155
RUN apk upgrade --no-cache && \
    apk add --no-cache nginx-module-njs curl && \
    # Add load_module if not already present (njs is preinstalled in official image)
    if ! grep -q 'ngx_http_js_module' /etc/nginx/nginx.conf; then \
        echo "Adding njs module to nginx.conf"; \
        sed -i '1i load_module modules/ngx_http_js_module.so;' /etc/nginx/nginx.conf; \
    else \
        echo "njs module already configured in nginx.conf"; \
    fi && \
    # Suppress 'user' directive warning (container runs as non-root nginx user)
    sed -i 's/^user /#user /' /etc/nginx/nginx.conf && \
    # Verify module exists (diagnostic)
    echo "=== Module files ===" && \
    (ls -la /etc/nginx/modules/ngx_http_js_module.so 2>/dev/null || \
     ls -la /usr/lib/nginx/modules/ngx_http_js_module.so 2>/dev/null || \
     echo "WARNING: module .so not found at expected paths") && \
    echo "=== nginx.conf first 3 lines ===" && head -3 /etc/nginx/nginx.conf

COPY --from=builder /app/dist /usr/share/nginx/html

# Copy configuration fragments and SSL initialization script
COPY frontend/common.fragment /etc/nginx/common.fragment
COPY frontend/http_only.conf /etc/nginx/http_only.conf
COPY frontend/https_enabled.conf /etc/nginx/https_enabled.conf
COPY frontend/ssl-init.sh /docker-entrypoint.d/40-ssl-init.sh
COPY frontend/njs.conf /etc/nginx/njs/njs.conf
COPY frontend/remove_server.js /etc/nginx/njs/remove_server.js

# Ensure Unix line endings on all config files (Windows checkouts may have CRLF)
RUN sed -i 's/\r$//' /etc/nginx/common.fragment \
                      /etc/nginx/http_only.conf \
                      /etc/nginx/https_enabled.conf \
                      /docker-entrypoint.d/40-ssl-init.sh \
                      /etc/nginx/njs/njs.conf \
                      /etc/nginx/njs/remove_server.js

# Run as non-root user — pre-create all required dirs
RUN mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp \
             /var/cache/nginx/fastcgi_temp /var/cache/nginx/uwsgi_temp \
             /var/cache/nginx/scgi_temp && \
    chmod +x /docker-entrypoint.d/40-ssl-init.sh && \
    chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/log/nginx /etc/nginx/conf.d \
                         /etc/nginx/common.fragment /etc/nginx/http_only.conf /etc/nginx/https_enabled.conf \
                         /etc/nginx/njs && \
    touch /var/run/nginx.pid && chown nginx:nginx /var/run/nginx.pid

USER nginx

EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
