# syntax=docker/dockerfile:1.7

FROM oven/bun:1 AS deps

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1 AS runner

WORKDIR /app

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY index.ts ./index.ts
COPY package.json ./package.json
COPY tsconfig.json ./tsconfig.json
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV VPS_SSH_BINARY_PATH=/usr/bin/ssh

EXPOSE 3000

CMD ["bun", "index.ts"]
