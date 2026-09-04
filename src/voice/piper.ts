import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { UserFacingError } from '../utils/errors.js';
import { MAX_SPEECH_LENGTH, type SpeechRequest, type SynthesizedSpeech, type TtsProvider } from './types.js';

export interface PiperOptions {
  /** piper 執行檔路徑。 */
  binaryPath: string;
  /** .onnx 模型路徑；同目錄下要有同名的 .onnx.json。 */
  modelPath: string;
  /** 模型的取樣率。zh_CN-huayan-medium 是 22050。 */
  sampleRate: number;
  voice: string;
}

/**
 * 本機 Piper TTS。
 *
 * 選它的原因是**沒有任何外部依賴**：不需要帳號、API key、信用卡，
 * 也沒有額度或條款問題，沒有人能單方面把它關掉。代價是音質不如
 * 雲端的神經語音，而且吃本機 CPU。
 *
 * VM 實測（Oracle 1 OCPU / 954MB，zh_CN-huayan-medium，2026-09-04）：
 * - 20 字 → 合成 **4.9 秒**，產出 4 秒語音（RTF 1.18）
 * - 120 字 → 合成 **24.1 秒**，產出 23 秒語音（RTF 1.05）
 * - 記憶體峰值約 150MB
 *
 * 也就是**比即時還慢**：播放會一路追著合成跑。舊註解寫的 RTF 0.62 是
 * 早期單次測試的數字，已被上面這組實測推翻。所以現在預設走
 * Microsoft Edge（見 edge.ts），Piper 只當它掛掉時的後備。
 *
 * 用 --output_raw 串流輸出而不是寫檔：它會「as it becomes available」
 * 邊合成邊吐，第一個字產生時就能開始播。等整段合成完的話，
 * 一段 30 秒的回覆會先靜默 18 秒。
 */
export class PiperTtsProvider implements TtsProvider {
  readonly id = 'piper';
  readonly label = 'Piper（本機）';
  readonly tier = 'free' as const;

  constructor(private readonly options: PiperOptions) {}

  async isAvailable(): Promise<boolean> {
    try {
      await access(this.options.binaryPath, constants.X_OK);
      await access(this.options.modelPath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async synthesize(request: SpeechRequest): Promise<SynthesizedSpeech> {
    const text = request.text.slice(0, MAX_SPEECH_LENGTH).replace(/\r?\n/g, ' ').trim();

    if (text.length === 0) {
      throw new UserFacingError('沒有可以唸出來的內容。');
    }

    const child = spawn(
      this.options.binaryPath,
      ['--model', this.options.modelPath, '--output_raw'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let settled = false;
    const kill = (): void => {
      if (settled) return;
      settled = true;
      // SIGKILL 而不是 SIGTERM：piper 收到 SIGTERM 不一定會馬上退出，
      // 而語音頻道裡一個沒收乾淨的行程會一直佔著那 150MB
      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => {
      logger.warn(`Piper 合成逾時（${request.timeoutMs}ms），已中止`);
      kill();
    }, request.timeoutMs);

    // stderr 是 piper 的進度訊息，不是錯誤；只有真的失敗時才需要看
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });

    child.on('error', (error) => {
      logger.error('Piper 啟動失敗', error);
      child.stdout.destroy(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null && !settled) {
        logger.warn(`Piper 以 code ${code} 結束：${stderr.trim()}`);
      }
    });

    child.stdin.end(`${text}\n`);

    return {
      audio: child.stdout,
      format: 'pcm-s16le',
      sampleRate: this.options.sampleRate,
      provider: this.id,
      voice: this.options.voice,
      dispose: () => {
        clearTimeout(timer);
        kill();
      },
    };
  }
}
