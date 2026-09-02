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
  AI_TIMEOUT_MS: envInt(60_000, 1000),
  AI_MAX_OUTPUT_TOKENS: envInt(2048, 64),

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
