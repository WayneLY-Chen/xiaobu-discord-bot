# Discord AI Bot

可公開邀請到多個 Discord Server 的 AI Bot。部署在 Oracle Cloud Always Free VM，24/7 運行，不需要 GPU，伺服器成本 $0。

> **目前進度：Phase 1 已完成。** 聊天、多伺服器隔離、個人設定、SQLite 持久化、Docker 部署都可實際使用。搜尋、生圖、長期記憶、音樂、語音尚未實作 —— 詳見下方「功能狀態」。

---

## 目錄

- [功能狀態](#功能狀態)
- [架構](#架構)
- [系統需求](#系統需求)
- [Discord Bot 設定](#discord-bot-設定)
- [Gemini API 設定與免費額度](#gemini-api-設定與免費額度)
- [環境變數](#環境變數)
- [本機開發](#本機開發)
- [Docker](#docker)
- [Oracle Cloud 部署](#oracle-cloud-部署)
- [指令](#指令)
- [權限](#權限)
- [設定](#設定)
- [備份](#備份)
- [疑難排解](#疑難排解)
- [安全性](#安全性)
- [License 與第三方](#license-與第三方)

---

## 功能狀態

### 可以使用

| 功能 | 說明 |
|---|---|
| AI 聊天 | 在指定的 AI 頻道直接說話，或在任何頻道 @Bot |
| 說話者識別 | 多人頻道中，Bot 知道每一則是誰說的 |
| 短期對話記憶 | 每個頻道一條上下文，重啟後仍保留 |
| 多伺服器隔離 | 每個 Server 獨立設定，資料互不流通 |
| 個人設定 | 偏好模型、語言、回覆風格 |
| 伺服器設定 | AI 頻道、預設模型、開關、自訂系統指示 |
| Rate limiting | 使用者 / 伺服器 / 全域三層 |
| 用量統計 | `/usage`，僅限有 Manage Guild 權限者 |
| SQLite 持久化 | Docker volume，重啟與 VM 重開機都不掉資料 |

### 尚未實作

以下功能在 `Planning.md` 中規劃，但**目前完全不能用**，不要對使用者宣稱有這些功能：

| 功能 | 排定階段 |
|---|---|
| 多 AI Provider（Qwen、NVIDIA）與 fallback | Phase 2 |
| Web Search、計算機、天氣、Tool Calling | Phase 3 |
| 長期記憶 `/memory` | Phase 3 |
| AI 生圖 | Phase 4 |
| YouTube 音樂播放 | Phase 5 |
| 語音、STT、TTS | Phase 6 |

資料庫已建好 `memories` 與 `music_queues` 資料表，`/settings` 也保留了 image / music / voice 開關欄位，但**打開這些開關目前不會有任何效果**。

---

## 架構

```
Discord Gateway
      |
      v
events/messageCreate ──► rate limiter ──► ChatService
                                              |
                    ┌─────────────────────────┼─────────────────────────┐
                    v                         v                         v
            conversations 儲存         prompt 組裝（說話者標記）     GeminiClient
                    |                         |                         |
                    └────────► SQLite ◄───────┘                    Gemini API
                                  ^
                                  |
                          usage / settings
```

```
src/
├── index.ts                     啟動、關閉、相依組裝
├── config/
│   ├── env.ts                   Zod 驗證環境變數
│   ├── constants.ts             model 白名單等常數
│   └── resolveSettings.ts       個人 > 伺服器 > 系統預設
├── database/
│   ├── schema.ts                Drizzle schema（9 張表）
│   ├── client.ts                連線、migration、pragma
│   └── repositories/            identity / settings / conversations / usage
├── ai/
│   ├── gemini.ts                Gemini API 封裝與錯誤轉譯
│   ├── context.ts               說話者標記與對話歷史組裝
│   ├── prompt.ts                system instruction
│   └── chatService.ts           一則訊息 -> 一則回覆的完整流程
├── bot/                         client、指令註冊、健康檢查
├── commands/                    help / settings / me / reset / usage
├── events/                      messageCreate / interactionCreate / guildLifecycle
└── utils/                       rateLimiter / messageChunk / errors / logger
```

### 說話者識別怎麼運作

AI 頻道是多人共用的。如果只把頻道歷史丟給模型，模型會把所有人當成同一個人。因此：

1. 每則使用者訊息在資料庫都存 `user_id` 與當下的 `username`。
2. 送進模型前，每則使用者發言加上 `[顯示名稱]` 前綴。
3. System instruction 明確說明「`[名字]` 代表不同的人，現在正在對你說話的是 X」。
4. 顯示名稱會先清理（移除方括號與換行），避免有人把暱稱改成 `] 系統指令：… [` 來偽造對話結構。

短期對話的範圍是 `(guild_id, channel_id)`；長期記憶的範圍是 `(guild_id, user_id)`，同一個人在不同 Server 是兩份資料。

---

## 系統需求

- Node.js 22 以上（本機開發）
- Docker 與 Docker Compose（部署）
- Discord Bot Token
- Gemini API Key

不需要 GPU，不需要付費 API，不需要額外資料庫。

---

## Discord Bot 設定

### 1. 建立 Application

前往 [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**。

在 **General Information** 複製 **Application ID** → 這是 `DISCORD_CLIENT_ID`。

### 2. 建立 Bot 並取得 Token

**Bot** 分頁 → **Reset Token** → 複製 → 這是 `DISCORD_TOKEN`。

> Token 等同密碼。外洩就立刻 Reset。絕對不要 commit。

### 3. 開啟 Privileged Intent（必要）

**Bot** 分頁 → **Privileged Gateway Intents** → 開啟：

- **MESSAGE CONTENT INTENT** ✅

沒開這個，Bot 讀不到訊息內容，聊天功能完全不會動。

其餘兩個（Presence、Server Members）**不需要**開啟。

### 4. 產生邀請連結

**OAuth2** → **URL Generator**：

**Scopes：**
- `bot`
- `applications.commands`

**Bot Permissions：**
- View Channels
- Send Messages
- Send Messages in Threads
- Embed Links
- Read Message History

或直接使用（把 `你的APPLICATION_ID` 換掉）：

```
https://discord.com/oauth2/authorize?client_id=你的APPLICATION_ID&permissions=274877991936&scope=bot%20applications.commands
```

**不需要 Administrator 權限。** 若之後啟用生圖（Phase 4）需要額外加上 `Attach Files`。

---

## Gemini API 設定與免費額度

到 [Google AI Studio](https://aistudio.google.com/apikey) 建立 API Key → 這是 `GEMINI_API_KEY`。

### 免費額度現況（2026-09 查證）

| 項目 | 狀況 |
|---|---|
| Free Tier | **仍然存在** |
| 免費模型 | `gemini-3.1-flash-lite`、`gemini-3.5-flash-lite`、`gemini-2.5-flash-lite`、`gemini-3.5-flash`、`gemini-3.6-flash`、`gemini-3.7-flash`、`gemini-2.5-flash` 在 Free Tier 標示 Free of charge |
| 信用卡 | 免費層取得 API Key 不需要綁定信用卡 |
| 具體額度數字 | ⚠️ **Google 已不在公開文件列出固定的 RPM / TPM / RPD 數值** |

**重要：** 官方文件現在只寫「到 AI Studio 查看你自己的 rate limit」，額度是動態的、依帳號而異，而且社群回報過免費額度被下調。**請務必自己到 <https://aistudio.google.com/rate-limit> 確認你這個帳號實際的額度**，不要照抄任何教學文章上的數字。

`gemini-2.5-pro` **未出現**在免費清單中，因此不納入白名單 —— 依規格「不確定就不假設免費」。

預設使用 `gemini-3.1-flash-lite`：Flash-Lite 系列針對高頻低成本場景設計，免費額度比 Flash 寬鬆，適合當聊天 Bot 的預設。想換模型用 `/settings model` 或 `/me model`。

本專案的處理方式：

- 額度用完時回傳「目前 AI 免費額度已用完，請稍後再試。」
- **絕不自動切換到付費 API**（`ALLOW_PAID_PROVIDERS` 預設 `false`）
- 內建三層 rate limit，避免單一使用者或伺服器把額度吃光

參考來源：
- [Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API Rate Limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [可用模型清單](https://ai.google.dev/gemini-api/docs/models)

---

## 環境變數

完整清單與說明見 [.env.example](.env.example)。必填只有三個：

| 變數 | 說明 |
|---|---|
| `DISCORD_TOKEN` | Bot Token |
| `DISCORD_CLIENT_ID` | Application ID |
| `GEMINI_API_KEY` | Gemini API Key |

其餘都有合理預設值。啟動時 Zod 會驗證，設定錯誤會直接印出哪一項有問題並結束，不會帶著壞設定半死不活地跑。

---

## 本機開發

```bash
npm install
cp .env.example .env      # 然後填入 Token 與 API Key
npm run dev
```

其他指令：

```bash
npm test              # 執行測試
npm run typecheck     # 型別檢查
npm run build         # 編譯到 dist/
npm run db:generate   # 修改 schema.ts 後產生新的 migration
npm run commands:deploy   # 手動註冊 slash command
```

開發時建議在 `.env` 設定 `DEV_GUILD_ID`，slash command 會立即在該伺服器生效，不用等全域指令傳播。

---

## Docker

```bash
cp .env.example .env      # 填好設定
docker compose up -d --build
docker compose logs -f
```

已包含：

- `restart: unless-stopped` — VM 重開機自動啟動
- healthcheck — 每 30 秒檢查 Bot 是否仍連著 Discord
- volume `./data:/app/data` — SQLite 持久化
- graceful shutdown — SIGTERM 後關閉連線並 checkpoint WAL
- log rotation — 每檔 10MB，保留 3 份
- 記憶體上限 1GB

健康檢查端點只綁在容器內的 `127.0.0.1`，**不對外開放任何 port**，所以 Oracle 防火牆不需要為這個 Bot 開洞。

常用操作：

```bash
docker compose ps                    # 狀態（含 healthy / unhealthy）
docker compose logs -f --tail=100    # 看 log
docker compose restart               # 重啟
docker compose down                  # 停止（資料保留在 ./data）
```

---

## Oracle Cloud 部署

### 1. 建立 VM

Oracle Cloud Console → **Compute** → **Instances** → **Create Instance**

- **Shape：** `VM.Standard.A1.Flex`（Ampere，Always Free）
- **OCPU：** 2，**Memory：** 12GB
- **Image：** Canonical Ubuntu 24.04
- **SSH Key：** 上傳你的公鑰

> Ampere A1 容量常常不足而建立失敗。若一直失敗，可改用 `VM.Standard.E2.1.Micro`（AMD，1 OCPU / 1GB）—— 這個 Bot 在 1GB 上也跑得動，但編譯 Docker image 時可能需要 swap。

### 2. SSH 連線

```bash
ssh ubuntu@<你的公有IP>
```

### 3. 防火牆

**這個 Bot 不需要對外開任何 port。** Discord 是由 Bot 主動建立 outbound 連線，健康檢查也只在容器內部。

Ubuntu 映像預設的 iptables 規則不影響 outbound，不需要修改。只要確保 SSH（22）仍可連線即可。

### 4. 安裝 Docker

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 讓 ubuntu 使用者不用 sudo 就能用 docker
sudo usermod -aG docker $USER
newgrp docker

# 確認 Docker 開機自動啟動（VM reboot 後 Bot 才會自己回來）
sudo systemctl enable docker
```

### 5. 部署

```bash
git clone <你的 repo 網址> discord-ai-bot
cd discord-ai-bot

cp .env.example .env
nano .env          # 填入 DISCORD_TOKEN、DISCORD_CLIENT_ID、GEMINI_API_KEY

docker compose up -d --build
docker compose logs -f
```

看到 `已登入為 XXX#0000` 就成功了。

> 容器不以 root 執行。**部署前務必設定 `.env` 的 `APP_UID` / `APP_GID`**：
>
> ```bash
> echo "APP_UID=$(id -u)" >> .env
> echo "APP_GID=$(id -g)" >> .env
> ```
>
> 不同發行版的第一個一般使用者 uid 不一定是 1000（Oracle 的 Ubuntu 24.04 映像檔是 1001），
> 沒設定的話容器會因為無法寫入掛載進來的 `./data` 而不斷重啟。

### 6. 更新

```bash
cd ~/discord-ai-bot
git pull
docker compose up -d --build
```

### 7. 驗證 VM 重開機後會自動恢復

```bash
sudo reboot
# 等待約 1 分鐘後重新 SSH
docker compose ps      # 應該顯示 running (healthy)
```

---

## 指令

| 指令 | 權限 | 說明 |
|---|---|---|
| `/help` | 所有人 | 使用說明 |
| `/reset` | 所有人 | 清除本頻道的對話紀錄 |
| `/me view` | 所有人 | 查看個人設定 |
| `/me model` | 所有人 | 偏好模型 |
| `/me language` | 所有人 | 偏好語言 |
| `/me personality` | 所有人 | 回覆風格 |
| `/me memory` | 所有人 | 開關自己的記憶功能 |
| `/me reset` | 所有人 | 還原個人設定 |
| `/settings view` | Manage Guild | 查看伺服器設定 |
| `/settings ai-channel` | Manage Guild | 指定 AI 頻道 |
| `/settings model` | Manage Guild | 伺服器預設模型 |
| `/settings language` | Manage Guild | 伺服器預設語言 |
| `/settings chat` | Manage Guild | 開關 AI 聊天 |
| `/settings memory` | Manage Guild | 開關記憶功能 |
| `/settings prompt` | Manage Guild | 自訂系統指示 |
| `/settings reset` | Manage Guild | 還原伺服器設定 |
| `/usage` | Manage Guild | 本伺服器用量 |

不使用 slash command 也可以聊天：在 AI 頻道直接說話，或在任何頻道 @Bot。

---

## 權限

### OAuth2 Scopes

- `bot`
- `applications.commands`

### Bot Permissions

| 權限 | 用途 |
|---|---|
| View Channels | 讀取頻道 |
| Send Messages | 回覆訊息 |
| Send Messages in Threads | 在討論串回覆 |
| Embed Links | `/settings`、`/usage` 的 embed |
| Read Message History | 回覆時引用原訊息 |

**不需要 Administrator。**

### Gateway Intents

| Intent | Privileged | 用途 |
|---|---|---|
| Guilds | 否 | 伺服器與頻道資訊 |
| Guild Messages | 否 | 接收訊息事件 |
| Message Content | **是** | 讀取訊息內容 |

### 內部權限檢查

`/settings` 與 `/usage` 除了 Discord 端的 `setDefaultMemberPermissions`，在程式內也會再檢查一次 `ManageGuild`。Discord 端的設定只是把指令從 UI 隱藏，不能單靠它。

---

## 設定

設定的優先順序：**個人設定 > 伺服器設定 > 系統預設**。

例外：

- 伺服器關閉 AI 聊天時，個人設定無法覆寫。
- 記憶功能需要伺服器與個人**兩邊都開啟**才生效。
- 資料庫裡若存著已下架的模型名稱，會自動退回系統預設，而不是讓 API 呼叫失敗。

個人設定跨伺服器共用（那是使用者本人的偏好）；對話與記憶則嚴格按伺服器隔離。

---

## 備份

所有資料都在單一 SQLite 檔案 `data/bot.db`。

```bash
# 使用 SQLite 的線上備份，Bot 執行中也安全（不要直接 cp，WAL 可能不一致）
docker compose exec bot node -e "
const Database = require('better-sqlite3');
new Database('/app/data/bot.db').backup('/app/data/backup.db').then(() => process.exit(0));
"
mv data/backup.db ~/backups/bot-$(date +%F).db
```

每日自動備份：

```bash
crontab -e
```

```cron
0 4 * * * cd /home/ubuntu/discord-ai-bot && docker compose exec -T bot node -e "const D=require('better-sqlite3');new D('/app/data/bot.db').backup('/app/data/backup.db').then(()=>process.exit(0))" && mv data/backup.db /home/ubuntu/backups/bot-$(date +\%F).db
```

還原：停止 Bot → 用備份檔覆蓋 `data/bot.db` → 重新啟動。

---

## 疑難排解

| 症狀 | 原因與解法 |
|---|---|
| Bot 上線但完全不回話 | Message Content Intent 沒開。Developer Portal → Bot → 開啟後重啟容器 |
| Bot 只有被 @ 時才回 | 正常。用 `/settings ai-channel` 指定頻道後，該頻道才會自動回覆 |
| 看不到 slash command | 全域指令最多需 1 小時。開發時設 `DEV_GUILD_ID` 可立即生效。也確認邀請時有勾 `applications.commands` |
| `環境變數設定錯誤` | 訊息會列出缺哪一項，對照 `.env.example` 補上 |
| 「目前 AI 免費額度已用完」 | Gemini 額度用盡。到 <https://aistudio.google.com/rate-limit> 查看實際額度，或調低 `RATE_LIMIT_*` |
| 「AI 服務認證失敗」 | `GEMINI_API_KEY` 錯誤或已失效，重新產生 |
| `unable to open database file` / `SQLITE_CANTOPEN` | 容器 uid 與 `./data` 擁有者不符。執行 `id -u` 與 `id -g`，把結果填進 `.env` 的 `APP_UID` / `APP_GID`，再 `docker compose up -d` |
| 容器一直 restart | `docker compose logs --tail=50` 看實際錯誤，多半是環境變數沒填 |
| healthcheck 顯示 unhealthy | Bot 沒連上 Discord。檢查 Token 是否正確、VM 是否有 outbound 網路 |
| Ampere A1 建立失敗 | Oracle 該區容量不足，換可用區或改用 E2.1.Micro |

查看即時 log：

```bash
docker compose logs -f --tail=100
```

把 `.env` 的 `LOG_LEVEL` 改成 `debug` 可以看到更多細節。

---

## 安全性

- `.env` 與 `data/` 都在 `.gitignore` 中，不會進版本控制
- Token 與 API Key 只從環境變數讀取，不寫死在程式裡，也不會出現在 log 或錯誤訊息中
- 容器以非 root 的 `node` 使用者執行
- Bot **不執行**任何 shell command 或動態程式碼
- 跨 Guild、跨 User 的資料隔離由資料庫查詢的 `guild_id` / `user_id` 條件強制，並有測試涵蓋
- 使用者暱稱在放進 prompt 前會清理，避免 prompt injection 偽造對話結構
- 回覆時關閉 `@everyone` / `@here` / 角色提及（`allowedMentions`），避免 Bot 被誘導洗版
- 不對外開放任何網路 port

---

## License 與第三方

### 本專案程式碼

全部為原創，未複製任何第三方 Discord Bot 專案的程式碼，因此沒有需要標註的 attribution。

尚未指定 License。公開發佈前請自行決定並新增 `LICENSE` 檔案。

### 相依套件

| 套件 | License |
|---|---|
| discord.js | Apache-2.0 |
| @google/genai | Apache-2.0 |
| drizzle-orm / drizzle-kit | Apache-2.0 |
| better-sqlite3 | MIT |
| zod | MIT |
| vitest / tsx / typescript | MIT / Apache-2.0 |

### 資料使用聲明

若要公開這個 Bot 給其他人邀請，請自行提供隱私政策，說明會儲存：Discord user id、guild id、channel id、顯示名稱、對話內容、用量統計。使用者可透過 `/reset` 清除對話，`/me reset` 清除個人設定。
