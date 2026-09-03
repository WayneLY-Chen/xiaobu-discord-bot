import type { Readable } from 'node:stream';

export interface SpeechRequest {
  text: string;
  /** 逾時。超過就中止合成，不要讓一個卡住的請求佔住語音頻道。 */
  timeoutMs: number;
}

/**
 * 合成結果刻意是**串流**而不是完整的 Buffer。
 *
 * Piper 支援邊合成邊輸出（--output_raw），一段長回覆可以在第一個字產生時
 * 就開始播，而不是等整段做完。以 RTF 0.62 計算，一段 30 秒的回覆
 * 若要等全部合成完會先靜默 18 秒 —— 那在語音頻道裡是不能接受的。
 */
export interface SynthesizedSpeech {
  /** 原始 PCM（s16le, mono），取樣率見 sampleRate。 */
  pcm: Readable;
  sampleRate: number;
  provider: string;
  voice: string;
  /** 呼叫端播完或放棄時一定要呼叫，用來收掉底層的子行程。 */
  dispose(): void;
}

export interface TtsProvider {
  readonly id: string;
  readonly label: string;
  /**
   * 與 AI provider、生圖來源同樣的規則：付費的永遠不會被自動使用。
   * 目前只有本機方案，保留這個欄位是為了之後接雲端服務時規則一致。
   */
  readonly tier: 'free' | 'paid';
  /** 服務是否真的可用（例如模型檔案存不存在）。 */
  isAvailable(): Promise<boolean>;
  synthesize(request: SpeechRequest): Promise<SynthesizedSpeech>;
}

/** Discord 語音固定用 48kHz 立體聲，所有輸出最後都要轉成這個規格。 */
export const DISCORD_SAMPLE_RATE = 48_000;
export const DISCORD_CHANNELS = 2;
