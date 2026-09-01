# 使用 bookworm-slim（glibc）而不是 alpine（musl）：
# better-sqlite3 對 glibc 有官方 prebuild，在 Oracle Ampere A1（arm64）上不用從頭編譯。
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 萬一該平台沒有 prebuild，這些工具讓 better-sqlite3 可以自行編譯
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 只留下 production 相依，native module 已在這個階段編譯完成
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle

# SQLite 檔案放在這裡，由 docker-compose 掛載成 volume
RUN mkdir -p /app/data && chown -R node:node /app

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用 exec 形式，讓 node 直接成為 PID 1 並收得到 SIGTERM（graceful shutdown 需要）
CMD ["node", "dist/index.js"]
