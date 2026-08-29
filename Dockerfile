# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app
# CN mirror for apk (used by builder and runner stages)
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories

FROM base AS builder

# glibc base (NODE_IMAGE=node:22) uses apt; default alpine uses apk
RUN if command -v apk >/dev/null 2>&1; then \
      apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers; \
    else \
      apt-get update && \
      apt-get install -y --no-install-recommends python3 make g++ && \
      apt-get clean && rm -rf /var/lib/apt/lists/*; \
    fi

COPY package.json ./
RUN npm install --registry=https://registry.npmmirror.com

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Tailscale (Funnel): glibc base only (no musl build) — compose sets NODE_IMAGE=node:22.
# procps provides pgrep/pkill which the app uses to detect/reuse the daemon.
# policy-rc.d stub prevents the .deb postinst from trying to start services at build time.
RUN if command -v apk >/dev/null 2>&1; then \
      apk --no-cache upgrade && apk --no-cache add su-exec; \
    else \
      apt-get update && \
      apt-get install -y --no-install-recommends curl procps && \
      printf 'exit 101\n' > /usr/sbin/policy-rc.d && \
      curl -fsSL https://tailscale.com/install.sh | sh && \
      rm -f /usr/sbin/policy-rc.d && \
      apt-get clean && rm -rf /var/lib/apt/lists/*; \
    fi

# Fix permissions at runtime (handles mounted volumes)
# Privilege drop: su-exec on alpine, setpriv on glibc (util-linux, present in the debian node image)
# userspace networking: no /dev/net/tun needed (often unavailable in Docker); the app detects and reuses this daemon
RUN printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nif command -v tailscaled >/dev/null; then\n  mkdir -p /app/data/tailscale\n  tailscaled --socket=/app/data/tailscale/tailscaled.sock --statedir=/app/data/tailscale --tun=userspace-networking >/app/data/tailscale/daemon.log 2>&1 &\n  sleep 3\n  chown -R node:node /app/data/tailscale 2>/dev/null\nfi\nif command -v su-exec >/dev/null 2>&1; then exec su-exec "$@"; else exec setpriv --reuid=node --regid=node --init-groups "$@"; fi\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
