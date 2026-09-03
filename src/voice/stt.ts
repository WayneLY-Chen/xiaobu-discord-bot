import * as OpenCC from 'opencc-js';
import { ProviderAuthError, QuotaExceededError, UserFacingError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Groq Whisper 語音辨識（2026-09 實測）。
 *
 * 免費層 **2,000 次／天**，一段 3.5 秒的語音約 0.53 秒回覆。
 *
 * 送出的是 16kHz 單聲道 WAV —— 那正好是 Whisper 的原生取樣率，
 * 而且 WAV 不需要編碼運算，對這台 1 OCPU 的機器來說比再壓一次 Opus 便宜。
 */
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

/** turbo 版本比 large-v3 快得多，準確度對日常對話足夠。 */
const MODEL = 'whisper-large-v3-turbo';

/**
 * Whisper 對 `language=zh` 一律輸出簡體，而且沒有 zh-TW 可選
 *（支援清單只有 `zh`）。官方建議用 `prompt` 參數偏置輸出風格，
 * 但 **Groq 的端點只要 prompt 帶中文就回 HTTP 500**（turbo 與
 * large-v3 都試過），英文 prompt 則完全沒有效果。
 *
 * 所以只能在自己這端轉。用 `twp` 而不是 `tw`：後者只換字形
 *（軟件／默認／網絡），前者連詞彙一起換成台灣用法（軟體／預設／網路）。
 */
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

/** 短到不可能是一句話的辨識結果直接丟掉，多半是雜訊或咳嗽。 */
const MIN_MEANINGFUL_LENGTH = 2;

/**
 * Whisper 對靜音或雜訊常常會「幻聽」出這些固定字串 —— 那是模型訓練資料裡
 * 大量存在的字幕組署名。把它們當成沒聽到，不要送進 AI。
 */
const HALLUCINATIONS = [
  '字幕由Amara.org社群提供',
  '字幕志愿者',
  '請不吝點贊',
  '訂閱轉發打賞支持明鏡與點點欄目',
  '謝謝觀看',
  '謝謝大家',
  'MING PAO CANADA',
  'Amara.org',
];

export interface TranscriptionOptions {
  timeoutMs: number;
}

export class GroqWhisperStt {
  readonly label = 'Groq Whisper';

  constructor(private readonly apiKey: string) {}

  /**
   * @param audio  16kHz 單聲道的 WAV 位元組。
   * @returns 繁體中文逐字稿；判定為靜音或雜訊時回傳空字串。
   */
  async transcribe(audio: Buffer, options: TranscriptionOptions): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', MODEL);
    form.append('language', 'zh');
    form.append('response_format', 'json');
    // 不送 prompt：Groq 收到中文 prompt 會回 500（見上方註解）

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) throw await this.translateError(response);

      const payload = (await response.json()) as { text?: string };
      return normalize(payload.text ?? '');
    } catch (error) {
      if (error instanceof UserFacingError) throw error;

      if (error instanceof Error && error.name === 'AbortError') {
        throw new UserFacingError('語音辨識逾時，請再說一次。', error);
      }

      logger.error('Groq Whisper 未分類錯誤', error);
      throw new UserFacingError('語音辨識暫時無法使用。', error);
    } finally {
      clearTimeout(timer);
    }
  }

  private async translateError(response: Response): Promise<UserFacingError> {
    const detail = await response.text().catch(() => '');

    if (response.status === 429) return new QuotaExceededError(detail.slice(0, 200));
    if (response.status === 401 || response.status === 403) {
      return new ProviderAuthError(detail.slice(0, 200));
    }

    logger.error(`Groq Whisper HTTP ${response.status}`, detail.slice(0, 300));
    return new UserFacingError('語音辨識暫時無法使用。', detail.slice(0, 200));
  }
}

/**
 * 比對前先把兩邊都磨平：去掉空白與標點、英文一律小寫。
 *
 * 兩邊**一定要用同一套規則** —— 之前只磨了被比對的那一邊，
 * 結果 `Amara.org` 在乾草堆裡變成 `Amaraorg`、在針裡還留著點，
 * 永遠對不上，過濾器等於沒作用。
 */
function flatten(text: string): string {
  return text.replace(/[\s。，、！？．·,.!?~-]/g, '').toLowerCase();
}

/** 轉繁體、去掉幻聽字串，判定為無意義時回空字串。 */
export function normalize(raw: string): string {
  const text = toTraditional(raw).trim();

  if (text.length < MIN_MEANINGFUL_LENGTH) return '';

  const flat = flatten(text);
  if (flat.length < MIN_MEANINGFUL_LENGTH) return '';

  for (const noise of HALLUCINATIONS) {
    // 幻聽字串通常就是整段內容，只有它的話等於沒聽到東西
    if (flat.includes(flatten(noise))) {
      logger.debug(`辨識結果疑似幻聽，已丟棄：${text}`);
      return '';
    }
  }

  return text;
}
