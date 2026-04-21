# ── Build stage ────────────────────────────────────────────────────────
# Pinned base images (W1-6): digests refreshed automatically by Renovate /
# Dependabot (see [.github/dependabot.yml](.github/dependabot.yml) docker ecosystem).
FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS builder
# tag: node:24-alpine

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY VERSION ../VERSION
COPY docs/ ../docs/
COPY frontend/ .
RUN npm run build

# ── Runtime stage (nginx) ─────────────────────────────────────────────
FROM nginx:alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de
# tag: nginx:alpine

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
