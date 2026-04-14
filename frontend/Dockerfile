# ── Build stage ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY VERSION ../VERSION
COPY frontend/ .
RUN npm run build

# ── Runtime stage (nginx) ─────────────────────────────────────────────
FROM nginx:alpine

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
