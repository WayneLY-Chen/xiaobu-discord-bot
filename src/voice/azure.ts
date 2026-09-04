import { Readable } from 'node:stream';
import { UserFacingError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { escapeForSsml } from './ssml.js';
import { MAX_SPEECH_LENGTH, type SpeechRequest, type SynthesizedSpeech, type TtsProvider } from './types.js';

/** 取樣率由 X-Microsoft-OutputFormat 決定，這裡選 24kHz 好跟 Edge 那條路一致。 */
const AZURE_SAMPLE_RATE = 24_000;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export interface AzureTtsOptions {
  /** Speech 資源的金鑰。空字串代表沒設定，這條路等於不存在。 */
  apiKey: string;
  /** 資源所在區域，例如 eastasia、southeastasia、japaneast。 */
  region: string;
  /** 聲線 ShortName，例如 zh-CN-XiaoshuangNeural（曉双，兒童女聲）。 */
  voice: string;
  pitch: string;
  rate: string;
}

/**
 * Azure Speech 的文字轉語音。
 *
 * 存在的理由只有一個：**Edge 的免費端點拿不到完整的語音庫**。曉双這類兒童
 * 聲線只在 Azure 有，Edge 的伺服器端白名單直接拒絕 —— 實測會關閉連線、
 * 一個位元組都不吐，不是客戶端參數的問題。
 *
 * 只該搭配 **F0（免費層）**：每月 50 萬字元，用完直接回 429。F0 **不會**
 * 自動溢出到付費層，所以帳單長不出來。要是有人把金鑰換成 S0 資源，那就是
 * 會計費的，這一層擋不住（README 有寫）。
 *
 * 沒設金鑰時 isAvailable() 回 false，TtsRouter 直接用 Edge（曉伊）。
 * 額度用完或金鑰失效時 synthesize 會丟錯，Router 一樣會換手 ——
 * 語音功能不會因為 Azure 出問題就整個啞掉。
 */
export class AzureTtsProvider implements TtsProvider {
  readonly id = 'azure';
  readonly label = 'Azure Speech';
  readonly tier = 'free' as const;

  constructor(private readonly options: AzureTtsOptions) {}

  async isAvailable(): Promise<boolean> {
    return this.options.apiKey.length > 0 && this.options.region.length > 0;
  }

  async synthesize(request: SpeechRequest): Promise<SynthesizedSpeech> {
    const text = request.text.slice(0, MAX_SPEECH_LENGTH).replace(/\r?\n/g, ' ').trim();

    if (text.length === 0) {
      throw new UserFacingError('沒有可以唸出來的內容。');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    let response: Response;
    try {
      response = await fetch(
        `https://${this.options.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': this.options.apiKey,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
            'User-Agent': 'xiaobu-discord-bot',
          },
          body: buildSsml(this.options, text),
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timer);
      throw new UserFacingError('連線到 Azure 語音服務失敗。', error);
    }

    if (!response.ok || !response.body) {
      clearTimeout(timer);
      throw new UserFacingError(explainStatus(response.status));
    }

    const audio = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    audio.once('close', () => clearTimeout(timer));

    return {
      audio,
      format: 'mp3',
      sampleRate: AZURE_SAMPLE_RATE,
      provider: this.id,
      voice: this.options.voice,
      dispose: () => {
        clearTimeout(timer);
        audio.destroy();
        controller.abort();
      },
    };
  }

  /**
   * 啟動時打一次，把設定錯誤變成看得懂的記錄。
   *
   * 不做這件事的話，金鑰打錯只會表現成「語音聽起來還是曉伊」——
   * 使用者完全看不出來是 Azure 沒接上，只會覺得設定沒生效。
   */
  async verify(): Promise<void> {
    if (!(await this.isAvailable())) return;

    try {
      const speech = await this.synthesize({ text: '測試', timeoutMs: 10_000 });
      speech.dispose();
      logger.info(`Azure Speech 已就緒，聲線 ${this.options.voice}`);
    } catch (error) {
      logger.warn(
        `Azure Speech 無法使用（${error instanceof Error ? error.message : String(error)}），` +
          '語音會退回 Microsoft Edge。',
      );
    }
  }
}

function buildSsml(options: AzureTtsOptions, text: string): string {
  // xml:lang 要跟聲線的 locale 一致，否則 Azure 回 400。
  // zh-CN-XiaoshuangNeural → zh-CN
  const locale = options.voice.split('-').slice(0, 2).join('-');

  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${options.voice}">` +
    `<prosody pitch="${options.pitch}" rate="${options.rate}">` +
    escapeForSsml(text) +
    '</prosody></voice></speak>'
  );
}

/**
 * 把 HTTP 狀態碼翻成能直接照著處理的話。
 *
 * 429 是額度用完，那是預期內的事、不是設定錯誤；如果訊息含糊，
 * 使用者會跑去翻金鑰設定，但其實只要等下個月或讓它換手就好。
 */
export function explainStatus(status: number): string {
  if (status === 429) return '這個月的 Azure 免費額度已經用完了。';
  if (status === 401 || status === 403) return 'Azure 的金鑰或區域設定不正確。';
  if (status === 400) return 'Azure 不認得這個聲線名稱，或它在你選的區域不提供。';
  return `Azure 語音服務回應 ${status}。`;
}
