# syntax=docker/dockerfile:1.7
# Two images from one file, built from the repository root (deploy/docker-compose.yml does this):
#   --target web   the Next.js site (next build at image build, next start at run time)
#   --target cli   the specfirst CLI with forge and git: both watchers, the desk worker and the gate keeper
# Neither image holds a key or reads .env: the CLI services get theirs from a compose secret at run time.
# Runbook: docs/deploy.md.

# The CLI runs on the Node the live services ran on (node --version on the Mac), so the signers behave as they did
# there; the site, the part the internet talks to, runs on Node 24 LTS (tested: build-board, next start). pnpm is
# packageManager in package.json.
ARG NODE_VERSION=25.4.0
ARG WEB_NODE_VERSION=24.21.0
ARG PNPM_VERSION=10.28.1

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV NEXT_TELEMETRY_DISABLED=1
# Node 25 no longer ships corepack, so pnpm comes from npm, pinned.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "pnpm@${PNPM_VERSION}" \
 && npm cache clean --force
WORKDIR /app

# forge 1.5.1, the version the reports so far were made with, from the release tarball, checked against the
# sha256 GitHub publishes for each asset. A new version needs both sums replaced.
FROM base AS foundry
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) sum=73640b01bd9ed29fdb4965085099371f8cf0dbbec3e2086cf54564efc4dcfe88 ;; \
      arm64) sum=cccf28bdf202289e837a9e21ed213b2b80dc1e806e12f1717bc98a44315c331e ;; \
      *) echo "no forge release for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/foundry.tar.gz "https://github.com/foundry-rs/foundry/releases/download/v1.5.1/foundry_v1.5.1_linux_${TARGETARCH}.tar.gz"; \
    echo "${sum}  /tmp/foundry.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin forge; \
    rm /tmp/foundry.tar.gz; \
    forge --version

# Everything is built here in the repository's order: contracts (forge build; the CLI and the web copy the
# CertificateRegistry ABI from its out/), core, then the CLI.
FROM base AS build
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages/contracts packages/contracts
RUN cd packages/contracts && forge build
COPY packages/core packages/core
COPY packages/cli packages/cli
RUN pnpm --filter @specfirst/core build && pnpm --filter @specfirst/cli build

# The board data is built from the reports in certs/checks at build time (Monad mainnet only, as on the Mac) and
# the testnet registry; / is prerendered from it, so a newer board needs a new image (docs/deploy.md, Board).
# The public testnet RPC allows 15 requests per second, so the registry read defaults to a fallback RPC.
FROM build AS web-build
ARG SPECFIRST_BOARD_RPC=https://rpc.ankr.com/monad_testnet
ARG SPECFIRST_BOARD_REGISTRY=
COPY packages/web packages/web
COPY certs/checks certs/checks
RUN cd packages/web \
 && node scripts/sync-abi.mjs \
 && node scripts/build-board.mjs \
 && pnpm exec next build \
 && rm -rf .next/cache

FROM node:${WEB_NODE_VERSION}-bookworm-slim AS web
ARG PNPM_VERSION
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
RUN npm install -g "pnpm@${PNPM_VERSION}" && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
# pnpm installs the musl builds of next's swc and sharp next to the glibc ones; this image is glibc (Debian).
RUN pnpm install --prod --frozen-lockfile --filter "@specfirst/web..." \
 && find node_modules/.pnpm -maxdepth 1 -name '*linux*musl*' -exec rm -rf {} + \
 && rm -rf /root/.local/share/pnpm /root/.cache
COPY --from=web-build /app/packages/core/dist packages/core/dist
COPY --from=web-build /app/packages/web/next.config.mjs packages/web/
# next start writes the revalidated routes (/badge/<address>, /api/cert) under .next, so the node user owns it.
COPY --from=web-build --chown=node:node /app/packages/web/.next packages/web/.next
COPY --from=web-build /app/packages/web/public packages/web/public
COPY --from=web-build /app/packages/web/data packages/web/data
# The repository root is /app (two above packages/web), so the web finds .specfirst/watch, .specfirst/worker and
# certs/checks where the compose file mounts them.
RUN mkdir -p .specfirst/watch .specfirst/worker certs/checks && chown -R node:node .specfirst
USER node
WORKDIR /app/packages/web
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]

FROM base AS cli
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
RUN pnpm install --prod --frozen-lockfile --filter "@specfirst/cli..." \
 && rm -rf /root/.local/share/pnpm /root/.cache
COPY --from=build /app/packages/core/dist packages/core/dist
# The harness and Specfirst's properties are read from core's src/standards at check time.
COPY packages/core/src/standards packages/core/src/standards
COPY --from=build /app/packages/cli/dist packages/cli/dist
COPY packages/cli/templates packages/cli/templates
COPY examples/watch examples/watch
COPY --chmod=0755 deploy/supervise.sh /usr/local/bin/specfirst-supervise
# /app is the project directory of every CLI service (--project defaults to the working directory): .specfirst and
# certs/checks are mounted here, the standards cache (the a16z harness checkout, issuer locks) at ~/.cache/specfirst.
RUN mkdir -p .specfirst certs/checks /home/node/.cache/specfirst \
 && chown -R node:node .specfirst certs /home/node/.cache
USER node
# solc 0.8.28, which every check compiles with, fetched once here instead of by the first check.
RUN set -eu; d="$(mktemp -d)"; mkdir "$d/src"; \
    printf '[profile.default]\nsolc_version = "0.8.28"\n' > "$d/foundry.toml"; \
    printf '// SPDX-License-Identifier: MIT\npragma solidity 0.8.28;\ncontract Warm {}\n' > "$d/src/Warm.sol"; \
    (cd "$d" && forge build --quiet); rm -rf "$d"
ENTRYPOINT ["node", "/app/packages/cli/dist/index.js"]
CMD ["--help"]
