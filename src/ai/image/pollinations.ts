import { ProviderTimeoutError, QuotaExceededError, UserFacingError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { IMAGE_SIZES, type GeneratedImage, type ImageProvider, type ImageRequest } from './types.js';

/**
 * Pollinations 生圖（2026-09 實測）。
 *
 * 不需要 API key、不需要註冊、沒有每日上限，回傳的就是圖片本身。
 * 匿名層的節流是每 15 秒一張且綁在來源 IP 上 —— 對公開 Bot 來說
 * 這是最容易先撞到的牆，所以 429 一定要能正確地往上傳，讓 Router 換手。
 *
 * 注意：這是免費專案，它的 README 已經在講 pay-as-you-go 的 Pollen 點數，
 * 與 APIDOCS 描述的免費匿名層互相矛盾。目前實測仍可匿名使用，
 * 但隨時可能變。這正是 Router 要留備援位置的原因。
 */
const BASE_URL = 'https://image.pollinations.ai/prompt';

/** 服務目前只有這一個模型（GET /models 回傳 ["sana"]）。 */
const MODEL = 'sana';

export class PollinationsProvider implements ImageProvider {
  readonly id = 'pollinations';
  readonly tier = 'free' as const;
  readonly label = 'Pollinations';

  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    const { width, height } = IMAGE_SIZES[request.size];

    const url = new URL(`${BASE_URL}/${encodeURIComponent(request.prompt)}`);
    url.searchParams.set('width', String(width));
    url.searchParams.set('height', String(height));
    url.searchParams.set('model', MODEL);
    // 公開邀請的 Bot 一定會收到成人向的 prompt，這個開關不給呼叫端關掉
    url.searchParams.set('safe', 'true');
    // 不要浮水印。實測目前有沒有帶這個參數結果都一樣，但明講比較保險
    url.searchParams.set('nologo', 'true');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });

      if (!response.ok) throw translateStatus(response.status);

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) {
        // 服務異常時可能回 HTML 錯誤頁而不是圖片，那不能當成圖送出去
        logger.warn(`Pollinations 回傳非圖片內容：${contentType || '(空)'}`);
        throw new UserFacingError('生圖服務回傳了非預期的內容，請再試一次。', contentType);
      }

      const data = Buffer.from(await response.arrayBuffer());
      if (data.length === 0) {
        throw new UserFacingError('生圖服務回傳了空的圖片，請再試一次。');
      }

      return {
        data,
        filename: `xiaobu-${Date.now()}.${extensionFor(contentType)}`,
        provider: this.id,
        model: MODEL,
      };
    } catch (error) {
      throw translateError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function translateStatus(status: number): UserFacingError {
  // 429 是匿名層的節流（每 15 秒一張），不是永久沒額度 —— 讓 Router 換手
  if (status === 429) return new QuotaExceededError(`Pollinations HTTP ${status}`);

  return new UserFacingError('生圖服務暫時無法使用，請稍後再試。', `HTTP ${status}`);
}

function translateError(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) return error;

  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new ProviderTimeoutError(error);
  }

  logger.error('Pollinations 未分類錯誤', error);
  return new UserFacingError('生圖服務暫時無法使用，請稍後再試。', error);
}

function extensionFor(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  return 'jpg';
}
