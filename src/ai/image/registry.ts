import type { Env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { CloudflareImageProvider } from './cloudflare.js';
import { PollinationsProvider } from './pollinations.js';
import { ImageRouter } from './router.js';
import type { ImageProvider } from './types.js';

/**
 * 依環境變數組出生圖來源。
 *
 * **陣列順序就是優先順序**，這裡刻意是 Pollinations → Cloudflare：
 *
 * - Pollinations 不需要 key、**沒有每日上限**，弱點是每 15 秒只能一張
 *   而且節流綁在來源 IP 上 —— 公開 Bot 人多時會先撞到這個。
 * - Cloudflare 每天只有 10,000 neurons（實測一張 172.80，約 57 張），
 *   但沒有短時間節流的問題，剛好補上 Pollinations 的弱點。
 *
 * 所以是「沒有每日上限的先用，被節流時換沒有節流的」。
 * 兩者的限制型態互補，不是單純的品質排序。
 *
 * Cloudflare 沒設定時只會有 Pollinations，生圖仍然可用；
 * 兩個都沒有時生圖工具不會提供給模型，聊天不受影響。
 */
export function createImageRouter(env: Env): ImageRouter {
  const providers: ImageProvider[] = [new PollinationsProvider()];

  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    providers.push(
      new CloudflareImageProvider({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN,
      }),
    );
  }

  const router = new ImageRouter(providers);
  logger.info(`已啟用的生圖來源：${router.labels.join('、') || '（無，生圖功能停用）'}`);

  return router;
}
