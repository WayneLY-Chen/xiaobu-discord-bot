import type { Readable } from 'node:stream';

export interface SpeechRequest {
  text: string;
  /** 逾時。超過就中止合成，不要讓一個卡住的請求佔住語音頻道。 */
  timeoutMs: number;
}

/** 一次最多合成多少字。太長的回覆在語音頻道裡本來就不該整段唸完。 */
export const MAX_SPEECH_LENGTH = 600;

/**
 * 合成結果刻意是**串流**而不是完整的 Buffer。
 *
 * 兩家來源都能邊合成邊吐，一段長回覆可以在第一個字產生時就開始播，
 * 而不是等整段做完。等全部合成完的話，一段 30 秒的回覆會先靜默好幾秒 ——
 * 那在語音頻道裡是不能接受的。
 */
export interface SynthesizedSpeech {
  /** 音訊串流，實際編碼見 format。 */
  audio: Readable;
  /**
   * 音訊格式。ffmpeg 的輸入參數要照這個決定 ——
   * 裸 PCM 必須明講取樣率與聲道數，MP3 自帶標頭不用。
   */
  format: 'pcm-s16le' | 'mp3';
  /** 取樣率。format 是 mp3 時僅供參考，ffmpeg 自己讀得出來。 */
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
