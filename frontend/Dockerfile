# ── Build stage ────────────────────────────────────────────────────────
# Base image tags are re-pulled on each build so security patches land
# without needing a Dependabot PR every week. Dependabot (docker ecosystem)
# still opens PRs whenever the tag itself moves, and Trivy (CI image scan)
# gates HIGH/CRITICAL fixable CVEs so staleness cannot ship to main.
FROM node:26-alpine@sha256:e71ac5e964b9201072425d59d2e876359efa25dc96bb1768cb73295728d6e4ea AS builder

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY VERSION ../VERSION
COPY docs/ ../docs/
COPY frontend/ .
RUN npm run build

# ── Runtime stage (nginx) ─────────────────────────────────────────────
FROM nginx:alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de

# Pull the latest Alpine package security patches. `nginx:alpine` is often
# a few days behind on libcrypto/musl/zlib fixes — this shaves the lag so
# Trivy doesn't flag HIGH CVEs with an upstream fix already available.
# shellcheck disable=SC2155
RUN apk upgrade --no-cache && \
    apk add --no-cache nginx-mod-http-headers-more && \
    sed -i '1i load_module modules/ngx_http_headers_more_filter_module.so;' /etc/nginx/nginx.conf

COPY --from=builder /app/dist /usr/share/nginx/html

# Copy configuration fragments and SSL initialization script
COPY frontend/common.fragment /etc/nginx/common.fragment
COPY frontend/http_only.conf /etc/nginx/http_only.conf
COPY frontend/https_enabled.conf /etc/nginx/https_enabled.conf
COPY frontend/ssl-init.sh /docker-entrypoint.d/40-ssl-init.sh

# Ensure Unix line endings on all config files (Windows checkouts may have CRLF)
RUN sed -i 's/\r$//' /etc/nginx/common.fragment \
                      /etc/nginx/http_only.conf \
                      /etc/nginx/https_enabled.conf \
                      /docker-entrypoint.d/40-ssl-init.sh

# Run as non-root user — pre-create all required dirs
RUN mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp \
             /var/cache/nginx/fastcgi_temp /var/cache/nginx/uwsgi_temp \
             /var/cache/nginx/scgi_temp && \
    chmod +x /docker-entrypoint.d/40-ssl-init.sh && \
    chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/log/nginx /etc/nginx/conf.d \
                         /etc/nginx/common.fragment /etc/nginx/http_only.conf /etc/nginx/https_enabled.conf && \
    touch /var/run/nginx.pid && chown nginx:nginx /var/run/nginx.pid

USER nginx

EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
