# Discord AI Bot Project Specification

你現在是一名資深 Full-Stack / AI Engineer。

請幫我建立一個可以實際部署到雲端、24/7 運行、可以加入多個 Discord Server 的 AI Discord Bot。

這不是私人 Bot。

這是一個可以公開邀請到不同 Discord Server 使用的通用 Discord AI Bot。

---

# 1. 最終目標

我要建立一個 Discord AI Bot，使用者可以直接把 Bot 邀請到自己的 Discord Server。

Bot 主要功能：

* 💬 AI Chat
* 🧠 Conversation Memory
* 🔎 Web Search
* 🎨 AI Image Generation
* 🎵 YouTube Music
* 🎙️ Discord Voice
* 🗣️ Speech-to-Text
* 🔊 Text-to-Speech
* 🧰 Tool Calling
* ⚙️ Server Settings
* 👤 User Settings
* 🤖 多 AI Provider

Bot 必須真正可以在 Discord 使用。

不要做 Demo。

不要 Mock API。

不要寫「未來可以實作」來假裝功能完成。

---

# 2. 核心限制

這些是硬性要求。

## Server

使用：

Oracle Cloud Always Free VM

優先：

Ampere A1

2 OCPU / 12GB RAM

不要使用 GPU。

不要租 GPU Server。

不要使用我的個人電腦。

不要使用我的 RTX 3070 Ti。

Bot 必須可以完全在雲端運作。

---

# 3. 成本要求

目標：

## Server = $0

Oracle Cloud 使用 Always Free 資源。

AI 服務：

優先使用：

* Free Tier
* Free Endpoint
* Open Source
* 免費 quota

不要預設使用付費 API。

不要讓程式自動切換到付費 API。

如果某個 API 超過免費 quota：

→ 顯示友善錯誤

例如：

「目前 AI 免費額度已用完，請稍後再試。」

不要自動刷信用卡。

建立：

ALLOW_PAID_PROVIDERS=false

預設：

false

---

# 4. 多 Discord Server

這是公開 Bot。

Bot 可以加入：

Server A

Server B

Server C

等等。

每個 Server 必須獨立設定。

例如：

Server A：

AI Model = Gemini

AI Channel = #ai

Image = enabled

Music = enabled

Voice = disabled

Server B：

AI Model = Qwen

AI Channel = #chat

Image = disabled

Music = enabled

每個 Server 的設定不能互相影響。

---

# 5. User Settings

每個 Discord User 也可以有自己的設定。

例如：

* preferred model
* language
* personality
* memory enabled/disabled
* voice settings

User 設定不能影響其他 User。

---

# 6. Database

不要使用：

* PostgreSQL
* MySQL
* SQL Server
* MongoDB
* Redis

第一版只使用：

## SQLite

Database：

data/bot.db

SQLite 必須透過 Docker volume 持久化。

Oracle VM 重開後資料不能消失。

---

# 7. Database Schema

至少建立：

users

guilds

guild_settings

user_settings

conversations

messages

memories

music_queues

usage

可以使用：

Drizzle ORM

或其他輕量 SQLite ORM。

不要為了 SQLite 引入大型複雜 infrastructure。

---

# 8. AI Chat

使用者可以在指定 AI Channel 直接聊天。

例如：

User：

「你覺得 Qwen 怎麼樣？」

Bot：

正常回答。

不需要每次都使用 Slash Command。

可以設定：

AI Channel

只有指定 Channel 會自動回覆。

也支援：

@Bot

觸發。

例如：

@Bot 幫我查一下 NVIDIA 最新消息

---

# 9. AI Provider Architecture

建立 Provider abstraction。

不要把 Gemini 寫死。

例如：

src/ai/providers/

gemini.ts

qwen.ts

nvidia.ts

providers 必須提供統一介面。

例如：

chat()

vision()

image()

audio()

實際支援哪些功能，要根據 Provider 真實 API 能力。

不要假設某模型支援不存在的功能。

---

# 10. Model Router

建立 Model Router。

例如：

一般聊天：

→ Gemini / Qwen

圖片理解：

→ 支援 Vision 的模型

需要搜尋：

→ Search Tool + AI

生圖：

→ Image Provider

語音：

→ Voice Provider

Router 不應該盲目把所有請求丟給最昂貴模型。

---

# 11. 免費 Provider

優先研究目前仍存在的：

Gemini Free Tier

Qwen Free / Free Quota

NVIDIA Free Endpoint

OpenRouter Free Models

以及其他真正免費的 provider。

開始實作之前必須確認：

* 官方文件
* API 是否仍存在
* Free Tier 是否仍存在
* quota
* rate limits
* 是否需要信用卡
* 是否有地區限制

如果免費政策已經改變：

不要假設免費。

README 必須寫清楚。

---

# 12. Web Search

AI 可以自行判斷是否需要搜尋。

例如：

「幫我查 NVIDIA 今天新聞」

→ Search Tool

「React 是什麼？」

→ 不一定需要 Search

搜尋結果必須：

* 有來源
* 顯示標題
* 顯示 URL
* 顯示日期（如果 API 提供）
* 不得捏造來源

Search Provider 必須可替換。

---

# 13. Image Generation

使用者可以直接：

「幫我生成一張狐狸」

Bot：

→ 呼叫 Image Provider

→ 取得圖片

→ 發到 Discord

要求：

* 不使用本機 GPU
* 不使用 RTX 3070 Ti
* 不租 GPU
* 優先 Free Tier

如果免費額度用完：

不要自動切到付費服務。

回傳：

「目前免費生圖額度已用完。」

---

# 14. YouTube Music

Bot 必須可以進入 Discord Voice Channel 播放音樂。

使用者：

「播放 YOASOBI」

Bot：

1. 找到使用者所在 Voice Channel
2. 搜尋 YouTube
3. 加入 Voice Channel
4. 播放音訊

至少支援：

/play

/pause

/resume

/skip

/stop

/queue

/nowplaying

/volume

音樂播放系統必須與 AI Provider 分離。

AI 只負責理解：

「播放 YOASOBI」

然後呼叫：

music.play()

Music engine 負責真正播放。

---

# 15. Voice AI

支援 Discord Voice Channel。

使用者可以讓 Bot 加入語音頻道。

流程：

Discord Voice

↓

Speech-to-Text

↓

AI

↓

Text-to-Speech

↓

Discord Voice

優先研究：

Gemini Live

Groq Whisper

其他目前存在的 Free Tier STT / TTS

不要假設免費。

如果某服務不是免費：

找免費替代方案。

---

# 16. Memory

建立真正的長期 Memory。

分成：

Short-term Conversation

Long-term Memory

不要把所有聊天訊息都直接存成長期 Memory。

例如：

User：

「記住我喜歡 Qwen。」

Bot：

儲存 memory。

之後：

「我喜歡什麼模型？」

Bot：

從 memory 找回。

提供：

/memory list

/memory delete

/memory clear

User 可以控制自己的 Memory。

---

# 17. Guild Memory Isolation

這非常重要。

不同 Discord Server 的資料必須隔離。

至少使用：

guild_id

user_id

例如：

Server A

User 123

Memory A

Server B

User 123

Memory B

兩者不能互相洩漏。

如果設計上允許 Global User Memory，必須明確取得使用者同意。

預設：

Guild isolated memory

---

# 17.5 Speaker Identity（說話者識別）

AI Channel 是多人共用的。

如果只把頻道歷史訊息丟給模型，

模型看到的是一段沒有署名的文字，

會把所有人當成同一個人。

因此：

## 訊息必須標記發話者

送進模型的每一則使用者訊息，必須加上發話者標記。

例如：

[Wayne] 記住我喜歡 Qwen

[Bot] 好的，已記住。

[Ming] 我喜歡什麼模型？

標記使用 Discord displayName。

user_id 不放進 prompt（避免模型複述 ID），

但必須存進資料庫。

## 短期對話 Conversation = 每頻道一條

範圍：

(guild_id, channel_id)

同一個頻道的所有人共用同一條上下文。

理由：符合 Discord 群聊習慣。

messages 必須存：

user_id

username（當下快照，用於標記）

role（user / assistant）

## 長期記憶 Memory = 每人一份

範圍：

(guild_id, user_id)

「記住我喜歡 Qwen」

→ 綁定發話者本人

→ 不是綁頻道

讀取時只撈：

guild_id = 當前 server

AND

user_id = 當前發話者

所以：

Server A 的 User 123

與

Server B 的 User 123

是兩份記憶，互不相通。

（呼應 §17 Guild Memory Isolation）

## 預設不跨使用者讀取

Bot 不會用 A 的長期記憶回答 B 的問題。

---

# 18. Permissions

不要要求：

Administrator

除非真的必要。

使用最小權限。

README 必須說明：

Discord OAuth2 Scopes

Bot Permissions

Gateway Intents

Voice Permissions

---

# 19. Rate Limiting

因為 Bot 會公開給其他 Server 使用。

必須有：

Per-user rate limit

Per-guild rate limit

Global rate limit

Cooldown

防止某個 User / Guild 把免費 API quota 全部吃掉。

例如：

一般 AI：

每 User 每分鐘 N 次

圖片：

每 User 每分鐘 N 次

搜尋：

每 User 每分鐘 N 次

這些數值放到 config。

---

# 20. Usage Tracking

SQLite 儲存：

user_id

guild_id

provider

model

requests

tokens（如果 API 提供）

images

searches

voice_seconds

可以讓管理員查看 Server 使用量。

例如：

/usage

只允許：

Manage Guild

權限的使用者查看 Server usage。

---

# 21. Server Configuration

建立：

/settings

例如：

/settings ai-channel

/settings model

/settings image on

/settings music on

/settings voice on

/settings memory on

只有具有：

Manage Guild

權限的使用者可以修改。

---

# 22. AI Channel

Server 可以指定：

AI Channel

例如：

#ai

在這個 Channel：

使用者直接說話

Bot 回答。

其他 Channel：

Bot 不自動回覆。

@Bot

仍然可以觸發。

---

# 23. Help

建立：

/help

顯示：

Chat

Image

Search

Music

Voice

Memory

Settings

Models

Usage

---

# 24. 技術

優先：

TypeScript

Node.js

discord.js

SQLite

Drizzle ORM

Zod

Vitest

Docker

Docker Compose

---

# 25. Project Structure

建議：

src/

bot/

ai/

providers/

router/

tools/

memory/

music/

voice/

database/

config/

commands/

events/

utils/

tests/

docker/

docs/

data/

.env.example

Dockerfile

docker-compose.yml

README.md

不要把所有東西放在 index.ts。

---

# 26. Docker

必須：

docker compose up -d

可以啟動。

要求：

* restart: unless-stopped
* healthcheck
* persistent volume
* graceful shutdown
* logs
* timezone
* environment variables

SQLite：

/app/data/bot.db

必須透過 volume 保存。

---

# 27. Oracle Deployment

README 必須完整說明：

1. Oracle Cloud VM
2. Ubuntu
3. SSH
4. Firewall
5. Docker
6. Docker Compose
7. Discord Developer Portal
8. Bot Token
9. OAuth2 Invite
10. Environment Variables
11. 啟動
12. 更新
13. Backup
14. Logs
15. Troubleshooting

Bot 必須可以在 Oracle Always Free VM 上運作。

不要要求 GPU。

---

# 28. Security

禁止：

* API Key commit
* Token commit
* 任意 shell command
* 任意 code execution
* 未授權讀取 server data
* 跨 Guild memory access
* 跨 User memory access

建立：

.env.example

.gitignore

---

# 29. AI Tool Calling

AI 可以呼叫：

search

weather

calculator

youtube

image

memory

time

工具必須：

* 有 schema
* 有 input validation
* 有 timeout
* 有 error handling
* 有 permission control

不要讓 AI 直接執行任意 JavaScript / Shell。

---

# 30. 免費服務失敗處理

如果：

Gemini quota exceeded

→ 嘗試下一個**免費** provider

（實作結果：Groq。原訂的 Qwen 官方 API 與 NVIDIA 查證後不適用，理由見 Phase 2）

換手時使用該 provider 標示為 production 的預設模型。

**例外：內容被安全機制擋下時絕不換手。**

那不是「這家壞了」，而是這個內容不該被產生；
換一家重試等於在找一個肯講的 provider。

但是：

如果下一個 Provider 是付費 API：

禁止自動 fallback。

只有：

ALLOW_PAID_PROVIDERS=true

才可以使用付費 Provider。

預設：

false

---

# 31. Third-party Projects

可以參考：

Gemini Discord Bot

Gemini Live Discord

BeatDock

AlphaLLM

其他 GitHub 開源 Discord AI 專案。

但：

不要直接複製大量程式碼。

先確認 License。

如果使用第三方程式碼：

README 必須列出 attribution。

---

# 32. 開發順序

不要一次全部完成。

## Phase 1

完成：

Discord Bot

Gemini Chat

SQLite

Guild isolation

User settings

Docker

Oracle deployment

完成並測試後再進下一階段。

---

## Phase 2

加入：

AI Router

Provider abstraction

第二個免費 Provider

Fallback

完成測試。

### Provider 查證結果（2026-09）

開始實作前依 §11 查證官方文件，原訂的兩家都不適用：

**NVIDIA NIM —— 排除，這是條款問題不是額度問題。**

官方 FAQ 原文：

> Production use involves any use of NIM for purposes other than
> development, testing, research or evaluation such as conducting
> business transactions and any non-testing activity
> including activity serving real end-users.
> Using NIM in production requires an NVIDIA AI Enterprise license.

本 Bot 是可公開邀請、給真實 Discord 使用者用的，
正好命中 serving real end-users。
免費的 Developer Program 明文只給 prototyping / testing / research。
要合法必須購買 NVIDIA AI Enterprise（起價 $4,500 / GPU / 年）。

**Qwen 官方 DashScope —— 排除，那是試用不是免費層。**

每個模型約 100 萬 token，只有新加坡區有，90 天後歸零且不補發、不延長。
之後自動轉 pay-as-you-go。
拿它當 fallback，三個月後 fallback 會自己先失效。

**採用：Groq。**

免費層每個模型 30 RPM / 1,000 RPD / 8K TPM / 200K TPD。
Services Agreement §3.1 明文允許
「make the Cloud Services and AI Model Services available to End Users
through your Customer Applications」，
與 NVIDIA 相反，公開 Bot 沒有條款問題。
OpenAI 相容 API，抽象層可共用一份實作。

而且 Groq 的免費層就有 Qwen，等於仍然達成原本「要有 Qwen」的目標。
但官方把 Qwen 標為 preview（intended for evaluation purposes only、可能隨時下架），
因此：不當預設、不當換手目標，只在選單中提供並標註風險。

**未採用但可隨時加上：**

OpenRouter 免費模型每天只有 50 次請求（除非歷史累積購買過 $10），
太少不能當主力，但可以當第三層墊底 ——
OpenAiCompatibleProvider 換個 baseUrl 就能接。

Cerebras 只有 $5 試用額度，不是免費層。

### 實作要點

Provider 陣列的順序就是優先順序。

至少要設定一把 provider API Key，
且 DEFAULT_MODEL 所屬的 provider 必須有 Key —— 啟動時驗證。

ALLOW_PAID_PROVIDERS=false 時，
Router 直接把 tier=paid 的 provider 排除在候選之外，
就算免費的全部失敗也不會使用，只回報錯誤。

---

## Phase 3

加入：

Web Search

Calculator

Weather

Memory

Guild Facts（/settings facts）

Tool Calling（§29）

完成測試。

### 查證結果（2026-09）

**搜尋 —— 採用 Tavily 為主、Gemini grounding 為備援。**

Tavily 免費層每月 1,000 credits、每月 1 號重置、不需要綁信用卡。
回傳乾淨的原始網址，新聞類查詢還附 published_date，
符合 §12「顯示 URL、顯示日期」的要求。

Gemini 的 Google Search grounding 每天 500 次免費，額度大 15 倍，
但只有 gemini-2.5-flash 與 2.5-flash-lite 有這個免費資格，
3.x 全系列官方標示「Not available」。
來源是 Google 轉址連結、沒有日期，品質較差，所以當備援。

實作方式是把 grounding 包成一般的搜尋工具（內部固定叫 2.5-flash-lite），
所以主回答由 Groq 產生時一樣能搜尋，不會被綁在特定模型上。

Brave Search 需要綁信用卡，不符合 $0 前提，排除。

**天氣 —— Open-Meteo。**

免費、不需要 API Key、每天 10,000 次。條款為 non-commercial use。

實測發現它的地理編碼只認英文／羅馬拼音：
查「台北」回空結果，查「Taipei」才回台北市。
因此工具描述明確要求模型轉換城市名，查不到時回傳可行動的訊息讓模型重試。

**計算機 —— 自寫遞迴下降解析器。**

依 §28「不要讓 AI 直接執行任意 JavaScript / Shell」，
絕不使用 eval 或 new Function，只認白名單內的運算子與函式。

### 實作要點

工具最多連續呼叫 3 輪，第 4 輪不提供工具，
逼模型用手上的資料作答而不是無限繞圈。
繞完仍未產生文字時回報錯誤，不寫入空的 assistant 訊息污染上下文。

來源清單由程式直接從 API 回應組出，不經過模型（§12 不得捏造來源）。

記憶關閉時，記憶類工具不會提供給模型、注入也停止 ——
關掉就是真的關掉，不是靠 prompt 拜託模型不要用。
但 /memory list、delete、clear 仍可使用：
使用者必須永遠看得到也刪得掉自己的資料。

### 踩到的坑

Gemini 3.x 要求把工具呼叫寫回歷史時附上原本的 thought_signature，
少了它會回 400 INVALID_ARGUMENT，整個工具流程直接失敗。
而 thoughtSignature 掛在 Part 上而不是 FunctionCall 上，
用方便的 response.functionCalls 取不到，必須自己走 candidates[].content.parts。

### Guild Facts 說明

伺服器共用的背景知識，與個人記憶分開。

範圍：

guild_id

用途：

讓 Bot 知道這個伺服器的人事物 —— 綽號、內部術語、誰負責什麼。

與 Memory 的差別：

memories

→ (guild_id, user_id)

→ 每人一份

→ 使用者自己說「記住我…」

guild_facts

→ (guild_id)

→ 全伺服器共用

→ 只有 Manage Guild 權限可以新增/刪除

指令：

/settings facts add

/settings facts list

/settings facts remove

內容由伺服器管理員自行決定並負責。

---

## Phase 4

加入：

Image Generation

完成測試。

---

## Phase 5

加入：

YouTube Music

完成測試。

---

## Phase 6

加入：

Voice

STT

TTS

Gemini Live

完成測試。

---

# 33. Testing

每個 Phase 必須實際測試。

至少：

Unit Tests

Integration Tests

Manual Discord Test

Docker Test

Restart Test

Database Persistence Test

Permission Test

Rate Limit Test

Multi-Guild Isolation Test

---

# 34. Acceptance Tests

最後必須可以實際做到：

## Chat

User：

「你好」

Bot：

回答。

---

## Multi-Guild

Server A：

Gemini

Server B：

Qwen

兩邊設定互不影響。

---

## Memory

User：

「記住我喜歡 Qwen。」

重新啟動 Bot。

User：

「我喜歡什麼？」

Bot：

回答 Qwen。

---

## Search

「查 NVIDIA 今天新聞」

Bot：

搜尋並提供來源。

---

## Image

「生成一張狐狸」

Bot：

Discord 收到圖片。

---

## Music

User 進入 Voice Channel。

「播放 YOASOBI」

Bot：

加入 Voice Channel

播放 YouTube 音訊。

---

## Voice

Bot 加入 Voice Channel。

User 說話。

Bot：

理解語音

AI 回答

TTS 播放。

---

## Restart

Docker restart。

資料不消失。

Bot 自動恢復。

---

## Oracle Reboot

Oracle VM reboot。

Docker 自動啟動。

Bot 自動上線。

---

# 35. README

README 必須包含：

Project Overview

Features

Architecture

Requirements

Discord Bot Setup

API Setup

Free Tier Information

Environment Variables

Local Development

Docker

Oracle Cloud Deployment

Commands

Permissions

Configuration

Architecture

Troubleshooting

Backup

Security

License

Third-party attribution

---

# 36. 最重要的原則

不要為了讓功能「看起來完成」而假裝某個 API 可以使用。

如果某個功能目前：

* 免費方案不存在
* API 已關閉
* API 需要付款
* API 需要信用卡
* API 有地區限制
* GitHub 專案已經失效
* Discord API 已經改變
* YouTube 播放方案失效

必須明確告訴我。

標記：

NOT CURRENTLY AVAILABLE

並提出最接近的免費替代方案。

---

# 37. 最終產品

最終產品應該是一個：

## 免費 Discord AI Bot

可以被邀請到多個 Discord Server。

使用者可以：

💬 Chat

🧠 Memory

🔎 Search

🎨 Image

🎵 YouTube Music

🎙️ Voice

🔊 TTS

🧰 Tools

而且：

* Cloud hosted
* 24/7
* Oracle Always Free
* No GPU
* No personal computer
* No RTX 3070 Ti
* SQLite only
* Multi-Guild
* Multi-User
* Free AI providers
* No automatic paid API

請從 Phase 1 開始。

不要跳到 Phase 2。

完成 Phase 1 後：

1. 執行測試
2. 修正錯誤
3. 告訴我實際完成了什麼
4. 告訴我如何啟動
5. 再等待我確認是否進入 Phase 2。


---

# 已解決的問題

## Q：memory 他會知道是誰在跟他說話？

A：會。設計寫在 §17.5 Speaker Identity。

重點：

1. Discord 訊息本身就帶 author.id / guildId / channelId，程式層一定拿得到。
2. 但模型不會自己知道，必須在 prompt 裡用 `[displayName]` 標記發話者。
3. 短期對話綁 (guild_id, channel_id)，多人共用。
4. 長期記憶綁 (guild_id, user_id)，每人一份，不互通。