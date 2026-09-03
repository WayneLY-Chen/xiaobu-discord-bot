import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { UserFacingError } from '../utils/errors.js';
import type { SpeechRequest, SynthesizedSpeech, TtsProvider } from './types.js';

export interface PiperOptions {
  /** piper 執行檔路徑。 */
  binaryPath: string;
  /** .onnx 模型路徑；同目錄下要有同名的 .onnx.json。 */
  modelPath: string;
  /** 模型的取樣率。zh_CN-huayan-medium 是 22050。 */
  sampleRate: number;
  voice: string;
}

/** 一次最多合成多少字。太長的回覆在語音頻道裡本來就不該整段唸完。 */
const MAX_TEXT_LENGTH = 600;

/**
 * 本機 Piper TTS。
 *
 * 選它的原因是**沒有任何外部依賴**：不需要帳號、API key、信用卡，
 * 也沒有額度或條款問題，沒有人能單方面把它關掉。代價是音質不如
 * 雲端的神經語音，而且吃本機 CPU。
 *
 * VM 實測（Oracle 1 OCPU / 954MB，zh_CN-huayan-medium）：
 * - Real-time factor **0.62** —— 產生 4.47 秒語音約需 2.77 秒 CPU
 * - 記憶體峰值約 **150MB**
 *
 * RTF 0.62 表示一顆 CPU 大約只能撐 1.6 倍即時速度，所以同時間
 * 只跑得動一路語音。並行控制在上層（VoiceSession）處理。
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
    const text = request.text.slice(0, MAX_TEXT_LENGTH).replace(/\r?\n/g, ' ').trim();

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
      pcm: child.stdout,
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
