FROM node:20-bookworm-slim

ARG FB2CNG_VERSION=v1.1.8
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app-image

COPY package.json ./
RUN npm install --omit=dev

COPY public ./public
COPY scripts ./scripts
COPY src ./src
COPY .env.example ./
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

RUN node -e "const p=require('./package.json'); require('fs').writeFileSync('.image-version', p.version+'-'+Date.now())"

RUN ARCH="${TARGETARCH:-$(dpkg --print-architecture 2>/dev/null || uname -m)}" \
  && OS="${TARGETOS:-linux}" \
  && case "$ARCH" in \
    x86_64|amd64) FB2CNG_ARCH=amd64 ;; \
    aarch64|arm64) FB2CNG_ARCH=arm64 ;; \
    i386) FB2CNG_ARCH=386 ;; \
    *) echo "Unsupported architecture: $ARCH (converter will be skipped)" && FB2CNG_ARCH= ;; \
  esac \
  && if [ -n "$FB2CNG_ARCH" ]; then \
    mkdir -p /app-image/converter \
    && curl -fsSL "https://github.com/rupor-github/fb2cng/releases/download/${FB2CNG_VERSION}/fbc-${OS}-${FB2CNG_ARCH}.zip" -o /tmp/fbc.zip \
    && unzip -q /tmp/fbc.zip -d /app-image/converter \
    && rm -f /tmp/fbc.zip \
    && chmod +x /app-image/converter/fbc; \
  else \
    mkdir -p /app-image/converter; \
  fi

RUN apt-get purge -y --auto-remove unzip \
  && rm -rf /var/lib/apt/lists/*

COPY converter/fb2cng.yaml /app-image/converter/fb2cng.yaml

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV LIBRARY_ROOT=/library

VOLUME /app
VOLUME /library

EXPOSE 3000

# curl быстрее node -e fetch(...) — на слабом NAS (Synology) пробы Node часто превышали timeout 5s
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -fsS --connect-timeout 3 --max-time 8 http://127.0.0.1:3000/health

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "src/server-entry.js"]
