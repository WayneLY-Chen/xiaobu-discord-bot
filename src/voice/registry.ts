import type { Env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { PiperTtsProvider } from './piper.js';
import { TtsRouter } from './router.js';
import type { TtsProvider } from './types.js';

/** zh_CN-huayan-medium 的取樣率，寫在模型的 .onnx.json 裡。 */
const PIPER_SAMPLE_RATE = 22_050;

export async function createTtsRouter(env: Env): Promise<TtsRouter> {
  const providers: TtsProvider[] = [
    new PiperTtsProvider({
      binaryPath: env.PIPER_BINARY_PATH,
      modelPath: env.PIPER_MODEL_PATH,
      sampleRate: PIPER_SAMPLE_RATE,
      voice: 'zh_CN-huayan-medium',
    }),
  ];

  const router = new TtsRouter(providers);
  const ready = await router.ready();

  if (ready.length === 0) {
    // 不是致命錯誤：語音功能會關閉，文字聊天完全不受影響
    logger.warn('沒有可用的語音合成服務（Piper 執行檔或模型不存在），語音功能停用。');
  } else {
    logger.info(`已啟用的語音合成：${ready.map((p) => p.label).join('、')}`);
  }

  return router;
}
