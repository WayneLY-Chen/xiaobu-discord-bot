# 使用 bookworm-slim（glibc）而不是 alpine（musl）：
# better-sqlite3 對 glibc 有官方 prebuild，不用從頭編譯。
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 萬一該平台沒有 prebuild，這些工具讓 better-sqlite3 與 @discordjs/opus
# 可以自行編譯。@discordjs/opus 是 optionalDependency，編不起來也不會中斷建置 ——
# prism-media 會自動退回純 JS 的 opusscript。
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


# --- Piper（本機 TTS，Phase 6）---
#
# 單獨一個階段下載，讓它的快取與 npm 安裝互不影響 ——
# 改一行程式碼不該重新下載 113MB 的模型。
#
# 注意：抓的是 **x86_64** 的執行檔。正式機是 Oracle 的 x86_64 VM；
# 要部署到 arm64（Ampere A1）的話這一行要改成對應的 aarch64 版本。
FROM node:22-bookworm-slim AS piper

ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_VOICE=zh_CN-huayan-medium
ARG PIPER_VOICE_URL=https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium
WORKDIR /opt

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL -o piper.tar.gz \
        "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
    && tar xzf piper.tar.gz \
    && rm piper.tar.gz \
    && curl -fsSL -o "piper/${PIPER_VOICE}.onnx" "${PIPER_VOICE_URL}/${PIPER_VOICE}.onnx" \
    && curl -fsSL -o "piper/${PIPER_VOICE}.onnx.json" "${PIPER_VOICE_URL}/${PIPER_VOICE}.onnx.json" \
    && rm -rf /var/lib/apt/lists/*


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# ffmpeg 負責語音的重新取樣與編解碼。刻意讓它做而不是在 Node 裡處理 ——
# 這台機器只有 1 顆 CPU，省下 JS 端的 Opus 編碼差很多。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Piper 的執行檔與中文語音模型（約 113MB）。
# 找不到這些檔案時語音功能會自動停用，文字聊天完全不受影響。
COPY --from=piper /opt/piper /opt/piper

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
