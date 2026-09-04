import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { UserFacingError } from '../utils/errors.js';
import { MAX_SPEECH_LENGTH, type SpeechRequest, type SynthesizedSpeech, type TtsProvider } from './types.js';

/** msedge-tts 的取樣率由輸出格式決定，AUDIO_24KHZ_* 就是 24000。 */
const EDGE_SAMPLE_RATE = 24_000;

const XML_ESCAPES = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&apos;'],
]);

/**
 * msedge-tts 會把文字**原樣**內插進 SSML 樣板（見其 _SSMLTemplate），
 * 完全不做跳脫。這裡的文字來自語言模型，而且是公開 Bot ——
 * 有人有辦法誘導模型吐出 `</prosody><voice name="...">` 之類的東西，
 * 就能換掉聲線甚至改寫整段 SSML。所以送出前一定要跳脫。
 */
export function escapeForSsml(text: string): string {
  return Array.from(text)
    .map((char) => XML_ESCAPES.get(char) ?? char)
    .join('');
}

export interface EdgeTtsOptions {
  /** 聲線的 ShortName，例如 zh-CN-XiaoyiNeural（曉伊）。 */
  voice: string;
  /** 音高，例如 `+30Hz`、`+2st`、`high`。調高會聽起來比較年輕。 */
  pitch: string;
  /** 語速，例如 `+10%`、`fast`。 */
  rate: string;
}

/**
 * Microsoft Edge 的「大聲朗讀」語音服務。
 *
 * 不需要帳號、API key 或信用卡 —— 用的是 Edge 瀏覽器本身在用的端點。
 * 這不是有正式文件的公開 API，微軟隨時可以改或關掉，所以 Piper 留著
 * 當後備：這一家掛掉時 TtsRouter 會自動換手，語音功能不會整個停擺。
 *
 * 選它的原因是 Piper 在正式機上**比即時還慢**（實測：合成 4 秒語音要
 * 4.9 秒，120 字的回覆要 24 秒），一顆 CPU 撐不起神經網路推論。
 * 同樣的內容 Edge 只要 1.6 秒，而且完全不吃本機 CPU。
 */
export class EdgeTtsProvider implements TtsProvider {
  readonly id = 'edge';
  readonly label = 'Microsoft Edge';
  readonly tier = 'free' as const;

  constructor(private readonly options: EdgeTtsOptions) {}

  /**
   * 永遠回報可用。
   *
   * TtsRouter 每次合成前都會呼叫這個方法，所以它必須是零成本的 ——
   * 在這裡打一次網路請求等於每句話都多付一次來回。網路服務的可用性
   * 本來就只有真的送出去才知道，失敗時 Router 會換手到 Piper。
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async synthesize(request: SpeechRequest): Promise<SynthesizedSpeech> {
    const text = request.text.slice(0, MAX_SPEECH_LENGTH).replace(/\r?\n/g, ' ').trim();

    if (text.length === 0) {
      throw new UserFacingError('沒有可以唸出來的內容。');
    }

    const tts = new MsEdgeTTS();

    // setMetadata 會建立 WebSocket 連線，連不上時會一直等，要自己設上限
    await withTimeout(
      tts.setMetadata(this.options.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3),
      request.timeoutMs,
      '連線到語音合成服務逾時',
    );

    // pitch / rate 一樣會被原樣內插進 <prosody> 的屬性裡，所以值在 env 那層
    // 就用嚴格的樣式擋過了 —— 這裡不做第二次驗證，但不能把使用者輸入接到這裡。
    const { audioStream } = tts.toStream(escapeForSsml(text), {
      pitch: this.options.pitch,
      rate: this.options.rate,
    });

    const close = (): void => {
      try {
        tts.close();
      } catch {
        // 連線已經關掉了，這裡沒什麼好做的
      }
    };

    // 連上了但一個位元組都不吐的情況也要收掉，否則會佔住語音頻道
    const firstByte = setTimeout(() => {
      audioStream.destroy(new Error('語音合成沒有回應'));
      close();
    }, request.timeoutMs);

    audioStream.once('data', () => clearTimeout(firstByte));

    return {
      audio: audioStream,
      format: 'mp3',
      sampleRate: EDGE_SAMPLE_RATE,
      provider: this.id,
      voice: this.options.voice,
      dispose: () => {
        clearTimeout(firstByte);
        audioStream.destroy();
        close();
      },
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UserFacingError(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
