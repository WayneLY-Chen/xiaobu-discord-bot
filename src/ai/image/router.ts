import {
  ImageQuotaExceededError,
  QuotaExceededError,
  UserFacingError,
} from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { GeneratedImage, ImageProvider, ImageRequest } from './types.js';

/**
 * 依序嘗試各個生圖來源，全部失敗才放棄。
 *
 * 與 AiRouter 同樣的原則：付費來源永遠不進候選名單，
 * 免費的用完就是用完，不會偷偷幫使用者花錢。
 */
export class ImageRouter {
  private readonly providers: ImageProvider[];

  constructor(providers: ImageProvider[]) {
    this.providers = providers.filter((provider) => provider.tier === 'free');

    for (const dropped of providers.filter((provider) => provider.tier === 'paid')) {
      logger.warn(`${dropped.label} 是付費生圖服務，已排除在候選之外（Planning §13）。`);
    }
  }

  get enabled(): boolean {
    return this.providers.length > 0;
  }

  get labels(): string[] {
    return this.providers.map((provider) => provider.label);
  }

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    if (this.providers.length === 0) {
      throw new UserFacingError('目前沒有可用的生圖服務。');
    }

    // 每一家都沒額度時要回規格指定的那句話，所以要記住是不是全部都因為額度而失敗
    let allQuota = true;
    let firstError: UserFacingError | undefined;

    for (const [index, provider] of this.providers.entries()) {
      try {
        const image = await provider.generate(request);
        if (index > 0) logger.info(`生圖改由 ${provider.label} 完成`);
        return image;
      } catch (error) {
        const failure = error instanceof UserFacingError ? error : new UserFacingError('生圖失敗。', error);

        if (!(failure instanceof QuotaExceededError)) allQuota = false;
        firstError ??= failure;

        const remaining = this.providers.length - index - 1;
        logger.warn(
          `${provider.label} 生圖失敗：${failure.message}` +
            (remaining > 0 ? `　還有 ${remaining} 個來源可以試` : '　已無其他來源'),
        );
      }
    }

    // 規格 §13：全部免費來源都沒額度時就是這句話，不會改用付費服務
    if (allQuota) throw new ImageQuotaExceededError(firstError);

    throw firstError ?? new UserFacingError('生圖服務暫時無法使用，請稍後再試。');
  }
}
