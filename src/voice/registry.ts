import type { Env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AzureTtsProvider } from './azure.js';
import { EdgeTtsProvider } from './edge.js';
import { PiperTtsProvider } from './piper.js';
import { TtsRouter } from './router.js';
import type { TtsProvider } from './types.js';

/** zh_CN-huayan-medium 的取樣率，寫在模型的 .onnx.json 裡。 */
const PIPER_SAMPLE_RATE = 22_050;

export async function createTtsRouter(env: Env): Promise<TtsRouter> {
  // 順序＝優先序。Azure 有完整語音庫但要自己申請金鑰；Edge 不用帳號、
  // 音質一樣是神經語音；Piper 在正式機上比即時還慢，只當最後的保險。
  // 任何一家掛掉 TtsRouter 都會往下換手，語音不會整個啞掉。
  const azure = new AzureTtsProvider({
    apiKey: env.AZURE_SPEECH_KEY ?? '',
    region: env.AZURE_SPEECH_REGION,
    voice: env.AZURE_TTS_VOICE,
    pitch: env.EDGE_TTS_PITCH,
    rate: env.EDGE_TTS_RATE,
  });

  const providers: TtsProvider[] = [
    azure,
    new EdgeTtsProvider({
      voice: env.EDGE_TTS_VOICE,
      pitch: env.EDGE_TTS_PITCH,
      rate: env.EDGE_TTS_RATE,
    }),
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
    logger.warn('沒有可用的語音合成服務，語音功能停用。');
  } else {
    logger.info(`已啟用的語音合成：${ready.map((p) => p.label).join('、')}`);
  }

  // 金鑰打錯的話，症狀只是「聲音還是曉伊」—— 看不出是 Azure 沒接上。
  // 啟動時實際打一次，把問題變成看得懂的記錄。
  await azure.verify();

  return router;
}
