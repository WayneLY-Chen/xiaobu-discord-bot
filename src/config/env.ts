import { existsSync } from 'node:fs';
import { z } from 'zod';
import { ALLOWED_MODELS, getModelSpec, PROVIDER_LABEL } from './constants.js';

/** 空字串等同沒設定 —— .env 裡留白的那一行不該被當成有效的 API Key。 */
const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined));

/** 環境變數只有字串，用這個把 "true"/"false" 轉成 boolean。 */
const envBoolean = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const envInt = (defaultValue: number, min = 1) =>
  z.coerce.number().int().min(min).default(defaultValue);

const envSchema = z.object({
  // --- Discord ---
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN 未設定'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID 未設定'),
  /** 設定後 slash command 會註冊到這個 guild（立即生效，開發用）。留空則註冊為全域指令。 */
  DEV_GUILD_ID: z.string().optional(),
  DEPLOY_COMMANDS_ON_START: envBoolean(true),

  // --- AI ---
  // 兩把 Key 都是選填，但至少要有一把（下面的 superRefine 會檢查）。
  // 這樣只想用 Groq 的人不必為了通過驗證去申請一把用不到的 Gemini Key。
  GEMINI_API_KEY: optionalSecret,
  GROQ_API_KEY: optionalSecret,
  DEFAULT_MODEL: z.enum(ALLOWED_MODELS).default('gemini-3.1-flash-lite'),
  /** 硬性要求：預設禁止任何付費 provider，且程式不得自動切換。 */
  ALLOW_PAID_PROVIDERS: envBoolean(false),
  /** 主要 provider 掛掉時，是否自動改用其他**免費** provider 回答。 */
  AI_FALLBACK_ENABLED: envBoolean(true),
  /**
   * 一次 API 呼叫的逾時。刻意不設太長：工具呼叫一輪問答會打好幾次 API，
   * 逾時開太久會讓「掛掉的那家」把整段對話拖住。實測 flash-lite 正常在 2~4 秒回覆。
   */
  AI_TIMEOUT_MS: envInt(25_000, 1000),
  AI_MAX_OUTPUT_TOKENS: envInt(2048, 64),

  // --- 工具（Phase 3）---
  /**
   * Tavily 搜尋。選填 —— 沒設定就只用 Gemini 的 Google 搜尋 grounding。
   * 免費層每月 1,000 次、每月 1 號重置、不需要綁信用卡。
   */
  TAVILY_API_KEY: optionalSecret,
  /** 單一工具呼叫的逾時。比 AI_TIMEOUT_MS 短，卡住的工具不該拖垮整輪對話。 */
  TOOL_TIMEOUT_MS: envInt(15_000, 1000),

  // --- 生圖（Phase 4）---
  /**
   * Cloudflare Workers AI 生圖。選填 —— 沒設定就只用 Pollinations。
   * 免費層每天 10,000 neurons，實測 flux-1-schnell 一張 172.80，約 57 張／天。
   * 兩個都要設定才會啟用。
   */
  CLOUDFLARE_ACCOUNT_ID: optionalSecret,
  CLOUDFLARE_API_TOKEN: optionalSecret,
  /** 生圖的逾時。生圖比文字慢得多（實測 2.5～4 秒），給的空間也要大一些。 */
  IMAGE_TIMEOUT_MS: envInt(60_000, 5000),
  /** 生圖的限流，與一般聊天分開算（規格 §19）。生圖比聊天貴，額度給得比較緊。 */
  IMAGE_RATE_LIMIT_USER: envInt(3),
  IMAGE_RATE_LIMIT_GUILD: envInt(10),
  IMAGE_RATE_LIMIT_GLOBAL: envInt(20),

  // --- 語音（Phase 6）---
  /**
   * Piper 的執行檔與模型。預設路徑對應 Docker image 裡的位置；
   * 本機開發時把它們放到別處的話用環境變數覆寫。
   * 檔案不存在時語音功能會停用，但文字聊天完全不受影響。
   */
  PIPER_BINARY_PATH: z.string().default('/opt/piper/piper'),
  PIPER_MODEL_PATH: z.string().default('/opt/piper/zh_CN-huayan-medium.onnx'),
  /** 語音合成逾時。RTF 約 0.62，600 字上限大約要 40 秒。 */
  TTS_TIMEOUT_MS: envInt(60_000, 5000),

  /**
   * Microsoft Edge 的聲線 ShortName。可用清單見
   * https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list
   * 常用的中文女聲：zh-CN-XiaoyiNeural（曉伊）、zh-CN-XiaoxiaoNeural（曉曉）、
   * zh-TW-HsiaoChenNeural（曉臻，台灣腔）、zh-TW-HsiaoYuNeural（曉雨，台灣腔）。
   */
  /**
   * Azure Speech（選用）。設了金鑰才會啟用，而且會排在 Edge 前面。
   *
   * 存在的理由是 Edge 的免費端點拿不到完整語音庫 —— 曉双這類兒童聲線只有
   * Azure 有。**務必用 F0 免費層**：每月 50 萬字元，用完直接回 429，不會
   * 溢出到付費。換成 S0 資源就是會計費的，程式擋不住。
   */
  AZURE_SPEECH_KEY: optionalSecret,
  AZURE_SPEECH_REGION: z.string().default(''),
  AZURE_TTS_VOICE: z.string().min(1).default('zh-CN-XiaoshuangNeural'),

  EDGE_TTS_VOICE: z.string().min(1).default('zh-CN-XiaoyiNeural'),

  /**
   * 音高與語速。
   *
   * 這兩個值會被 msedge-tts **原樣內插**進 `<prosody pitch="..." rate="...">`
   * 的 XML 屬性裡，套件本身不做任何跳脫，所以這裡用嚴格的樣式擋住 ——
   * 只接受相對數值（+30Hz、-2st、+10%）或那幾個具名等級。
   *
   * Edge 的免費中文聲線沒有兒童音，想要更年輕的感覺就把 pitch 調高，
   * 例如 `+25Hz`。調太多會變得不自然。
   */
  EDGE_TTS_PITCH: z
    .string()
    .regex(/^([+-]\d{1,3}(Hz|st|%)|x-low|low|medium|high|x-high|default)$/)
    .default('default'),
  EDGE_TTS_RATE: z
    .string()
    .regex(/^([+-]\d{1,3}%|x-slow|slow|medium|fast|x-fast|default)$/)
    .default('default'),
  /** 語音辨識逾時。實測 3.5 秒的語音約 0.5 秒回覆。 */
  STT_TIMEOUT_MS: envInt(20_000, 1000),
  /** 一段發言講多久之後強制切斷送去辨識，避免有人講不停把記憶體吃光。 */
  VOICE_MAX_UTTERANCE_MS: envInt(30_000, 3000),
  /** 靜音多久算一句話講完。太短會把句中的停頓切斷。 */
  VOICE_SILENCE_MS: envInt(1000, 200),
  /** 同時可以有幾個伺服器在使用語音。Piper 一次只跑得動一路，所以預設 1。 */
  /**
   * 一段語音最長播多久。與 TTS_TIMEOUT_MS 分開 —— 那個管合成，這個管播放。
   * 450 字的中文大約是 90～100 秒，所以預設留 3 分鐘。
   */
  VOICE_MAX_PLAYBACK_MS: envInt(180_000, 10_000),

  /** 多久沒人講話就自動離開語音頻道，把全域名額還回去。 */
  VOICE_IDLE_MS: envInt(300_000, 30_000),

  /**
   * 語音的喚醒詞。留空代表關閉，回到「每一句話都回應」。
   *
   * 沒有它的話，語音頻道裡三五個人閒聊，每一句都會送一次 AI ——
   * 一天 500 次的 Gemini 額度撐不到十分鐘，而且小步會一直插話。
   */
  VOICE_WAKE_WORD: z.string().default('小步'),

  /** 回答完之後這段時間內的追問不用再叫一次名字。 */
  VOICE_FOLLOW_UP_MS: envInt(30_000, 0),

  VOICE_MAX_SESSIONS: envInt(1, 1),

  /**
   * 語音對話專用的模型，與文字聊天的 /settings model 分開。
   *
   * 語音對延遲的敏感度比文字高得多 —— 文字慢個幾秒只是等，語音慢幾秒就是尷尬的沉默。
   * Groq 的推論速度遠快於 Gemini，所以預設走 Groq；文字聊天不受影響。
   */
  VOICE_MODEL: z.enum(ALLOWED_MODELS).default('openai/gpt-oss-20b'),

  // --- 對話上下文 ---
  /** 每次送進模型的歷史訊息則數（含 bot 回覆）。 */
  CONTEXT_MESSAGE_LIMIT: envInt(20, 2),
  /** 單則使用者訊息超過這個長度就截斷，避免一個人塞爆 context。 */
  MAX_INPUT_LENGTH: envInt(4000, 100),

  // --- Rate limit（防止單一 user / guild 吃光免費額度）---
  RATE_LIMIT_WINDOW_MS: envInt(60_000, 1000),
  RATE_LIMIT_USER: envInt(5),
  RATE_LIMIT_GUILD: envInt(20),
  RATE_LIMIT_GLOBAL: envInt(60),

  /**
   * 每日上限。只有每分鐘那層是不夠的 —— 免費 API 真正會用完的是每日額度
   * （Gemini Flash-Lite 500 RPD、Groq 1000 RPD），而每分鐘 60 次的上限
   * 一小時就能把一整天的份耗光。
   *
   * 全域預設 1200：低於 Gemini 500 + Groq 1000 的合計容量，留了換手的餘裕。
   */
  /**
   * 對話訊息保留幾天。設 0 代表永久保留（在這之前是唯一的行為）。
   * 這既是磁碟問題也是隱私問題：公開 Bot 累積的是所有伺服器所有頻道的全部對話。
   */
  MESSAGE_RETENTION_DAYS: envInt(30, 0),

  DAILY_LIMIT_USER: envInt(100),
  DAILY_LIMIT_GUILD: envInt(400),
  DAILY_LIMIT_GLOBAL: envInt(1200),

  // --- 基礎設施 ---
  DATABASE_PATH: z.string().default('./data/bot.db'),
  HEALTH_PORT: envInt(3000, 1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TZ: z.string().default('Asia/Taipei'),
})
  .superRefine((env, ctx) => {
    const configured = new Set(
      [
        env.GEMINI_API_KEY ? ('gemini' as const) : undefined,
        env.GROQ_API_KEY ? ('groq' as const) : undefined,
      ].filter((id) => id !== undefined),
    );

    if (configured.size === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEY'],
        message: '至少要設定一個 AI provider 的 API Key（GEMINI_API_KEY 或 GROQ_API_KEY）',
      });
      return;
    }

    // 預設模型指向一個沒有 Key 的 provider，會讓每一次對話都得靠 fallback 救援。
    // 這是設定錯誤，啟動時就講清楚，不要等使用者踩到。
    const spec = getModelSpec(env.DEFAULT_MODEL);
    if (spec && !configured.has(spec.provider)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEFAULT_MODEL'],
        message:
          `${env.DEFAULT_MODEL} 屬於 ${PROVIDER_LABEL[spec.provider]}，` +
          `但沒有設定它的 API Key。請改用已設定 provider 的模型，或補上該 Key。`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * 本機開發時把 .env 讀進 process.env。
 *
 * 用 Node 內建的 loadEnvFile，不需要 dotenv 套件。
 * Docker 的環境變數是由 compose 的 env_file 注入，image 裡沒有 .env，
 * 所以這裡找不到檔案是正常的，直接略過。
 */
export function loadDotEnvFile(path = '.env'): void {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}

let cached: Env | null = null;

/**
 * 讀取並驗證環境變數。驗證失敗直接讓 process 結束，
 * 不要讓 Bot 帶著壞設定半死不活地跑。
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`環境變數設定錯誤：\n${details}\n\n請參考 .env.example`);
  }

  return result.data;
}

export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}
