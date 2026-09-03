import { UserFacingError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { SpeechRequest, SynthesizedSpeech, TtsProvider } from './types.js';

/**
 * 依序嘗試各個 TTS 來源。
 *
 * 目前只有本機 Piper，但保留這一層是為了讓之後接雲端服務（Azure、
 * Cloudflare MeloTTS 等）時只要多一個檔案，不用動任何呼叫端 ——
 * 跟 AiRouter、SearchRouter、ImageRouter 同一套做法。
 *
 * 與其他 Router 一致：付費來源永遠不進候選名單。
 */
export class TtsRouter {
  private readonly providers: TtsProvider[];

  constructor(providers: TtsProvider[]) {
    this.providers = providers.filter((provider) => provider.tier === 'free');

    for (const dropped of providers.filter((provider) => provider.tier === 'paid')) {
      logger.warn(`${dropped.label} 是付費 TTS，已排除在候選之外。`);
    }
  }

  get labels(): string[] {
    return this.providers.map((provider) => provider.label);
  }

  /** 啟動時檢查一次：模型檔案沒放好的話，語音功能不該對使用者開放。 */
  async ready(): Promise<TtsProvider[]> {
    const checked = await Promise.all(
      this.providers.map(async (provider) => ((await provider.isAvailable()) ? provider : null)),
    );

    return checked.filter((provider): provider is TtsProvider => provider !== null);
  }

  async synthesize(request: SpeechRequest): Promise<SynthesizedSpeech> {
    const usable = await this.ready();

    if (usable.length === 0) {
      throw new UserFacingError('目前沒有可用的語音合成服務。');
    }

    let firstError: unknown;

    for (const [index, provider] of usable.entries()) {
      try {
        const speech = await provider.synthesize(request);
        if (index > 0) logger.info(`語音合成改由 ${provider.label} 完成`);
        return speech;
      } catch (error) {
        firstError ??= error;
        logger.warn(`${provider.label} 語音合成失敗：${String(error)}`);
      }
    }

    if (firstError instanceof UserFacingError) throw firstError;
    throw new UserFacingError('語音合成暫時無法使用，請稍後再試。', firstError);
  }
}
