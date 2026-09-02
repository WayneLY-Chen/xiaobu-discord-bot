import type { Db } from '../../database/client.js';
import type { ImageRouter } from '../image/router.js';
import type { GeneratedImage } from '../image/types.js';
import type { SearchRouter } from '../search/router.js';
import type { SearchResult } from '../search/types.js';
import type { ToolDefinition, ToolParameterSchema } from '../providers/types.js';

/** 執行工具時需要的東西。刻意不含 Discord 型別，方便測試。 */
export interface ToolContext {
  db: Db;
  guildId: string;
  userId: string;
  locale: string;
  /** 使用者或伺服器關閉記憶時，記憶類工具不會被提供給模型。 */
  memoryEnabled: boolean;
  /** 伺服器關閉生圖時，生圖工具不會被提供給模型。 */
  imageEnabled: boolean;
  search: SearchRouter;
  image: ImageRouter;
  timeoutMs: number;
  /** 生圖比文字慢得多，用獨立的逾時。 */
  imageTimeoutMs: number;
  timezone: string;
  /**
   * 檢查這位使用者的生圖配額。回傳 null 表示可以生，
   * 否則回傳要等多久（毫秒）。生圖比聊天貴，所以在一般限流之外另有一層。
   */
  checkImageQuota(): { retryAfterMs: number } | null;
}

export interface ToolResult {
  /** 回給模型看的內容。 */
  text: string;
  /**
   * 要附在最終回覆下方的來源。
   *
   * 刻意由**實際 API 回傳的資料**組成，不經過模型 —— 規格 §12 要求
   * 「不得捏造來源」，讓模型自己轉述網址就一定會有它改寫或編造的風險。
   */
  sources?: SearchResult[];
  /**
   * 要當成 Discord 附件送出的圖片。
   *
   * 與 sources 同理：圖片位元組不可能塞進工具的文字回覆裡讓模型轉述，
   * 所以走這條旁路交給呼叫端，模型只會看到 text 說「圖產好了」。
   */
  images?: GeneratedImage[];
}

export interface Tool {
  definition: ToolDefinition;
  /**
   * 這個工具是否需要記憶功能。memoryEnabled=false 時不會提供給模型 ——
   * 使用者關掉記憶就是真的關掉，不是「模型自己決定不要用」。
   */
  requiresMemory?: boolean;
  /** 這個工具是否需要生圖功能。imageEnabled=false 時不會提供給模型。 */
  requiresImage?: boolean;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export type ValidationOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * 依 schema 驗證模型給的參數（規格 §29 要求工具必須有 input validation）。
 *
 * 模型產生的參數不保證正確：可能少欄位、型別不對、enum 給了不存在的值。
 * 驗證失敗時回傳訊息而不是丟例外 —— 那段訊息會送回給模型，讓它自己修正重試，
 * 比直接讓整輪對話失敗好得多。
 */
export function validateArgs(schema: ToolParameterSchema, args: unknown): ValidationOutcome {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, message: '參數必須是一個物件。' };
  }

  const input = args as Record<string, unknown>;
  const value: Record<string, unknown> = {};

  for (const name of schema.required) {
    if (input[name] === undefined || input[name] === null) {
      return { ok: false, message: `缺少必填參數 ${name}。` };
    }
  }

  for (const [name, property] of Object.entries(schema.properties)) {
    const raw = input[name];
    if (raw === undefined || raw === null) continue;

    switch (property.type) {
      case 'number': {
        // 模型常常把數字塞成字串，能安全轉就轉，不要為此讓整個呼叫失敗
        const parsed = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(parsed)) {
          return { ok: false, message: `參數 ${name} 必須是數字。` };
        }
        value[name] = parsed;
        break;
      }

      case 'boolean': {
        if (typeof raw === 'boolean') value[name] = raw;
        else if (raw === 'true') value[name] = true;
        else if (raw === 'false') value[name] = false;
        else return { ok: false, message: `參數 ${name} 必須是 true 或 false。` };
        break;
      }

      default: {
        if (typeof raw !== 'string') {
          return { ok: false, message: `參數 ${name} 必須是字串。` };
        }
        if (property.enum && !property.enum.includes(raw)) {
          return {
            ok: false,
            message: `參數 ${name} 只能是：${property.enum.join('、')}。`,
          };
        }
        value[name] = raw;
      }
    }
  }

  return { ok: true, value };
}

export function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

export function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' ? value : undefined;
}
