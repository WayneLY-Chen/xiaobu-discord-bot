import { ProviderAuthError, ProviderTimeoutError, QuotaExceededError, UserFacingError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { GeneratedImage, ImageProvider, ImageRequest } from './types.js';

/**
 * Cloudflare Workers AI 生圖（2026-09 實測）。
 *
 * 免費層每天 10,000 neurons，所有使用者都有、不需要綁信用卡。
 * 條款查證過沒有「僅限開發／測試」這類限制 —— 這正是 NVIDIA NIM 被排除的原因。
 *
 * 實測數字（flux-1-schnell，steps=4）：
 * - 一張圖 **172.80 neurons** → 每天約 **57 張**
 * - 耗時約 2.5 秒，回傳 1024×1024 JPEG
 *
 * 已知限制：這個模型**不接受 width/height**（給了會回 HTTP 400），
 * 固定產出 1024×1024。所以 ImageRequest.size 在這裡只能忽略，
 * 換手到這一家時使用者要的橫幅／直幅會變成方形。
 * 因為它是備援而不是主力，這個取捨可以接受。
 */
const MODEL = '@cf/black-forest-labs/flux-1-schnell';

/**
 * flux-1-schnell 是蒸餾過的少步數模型，官方建議 4 步。
 * 實測 8 步耗用 326.40 neurons（幾乎兩倍）但品質沒有明顯提升，
 * 每天可生成張數卻直接砍半，不划算。
 */
const STEPS = 4;

export interface CloudflareImageOptions {
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

interface CloudflareResponse {
  success?: boolean;
  result?: { image?: string };
  errors?: { message?: string; code?: number }[];
}

export class CloudflareImageProvider implements ImageProvider {
  readonly id = 'cloudflare';
  readonly tier = 'free' as const;
  readonly label = 'Cloudflare Workers AI';

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CloudflareImageOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}/ai/run/${MODEL}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiToken}`,
          'content-type': 'application/json',
        },
        // 刻意不送 width/height：這個模型不接受，送了整個請求會被拒絕
        body: JSON.stringify({ prompt: request.prompt, steps: STEPS }),
        signal: controller.signal,
      });

      // 這個 header 是實際扣掉的額度，記下來才知道每天還剩多少
      const neurons = response.headers.get('cf-ai-neurons');
      if (neurons) logger.debug(`Cloudflare 生圖耗用 ${neurons} neurons`);

      const payload = await this.readJson(response);

      if (!response.ok || payload.success !== true) {
        throw this.translateFailure(response.status, payload);
      }

      const encoded = payload.result?.image ?? '';
      if (encoded.length === 0) {
        throw new UserFacingError('生圖服務回傳了空的圖片，請再試一次。');
      }

      return {
        data: Buffer.from(encoded, 'base64'),
        filename: `xiaobu-${Date.now()}.jpg`,
        provider: this.id,
        model: MODEL,
      };
    } catch (error) {
      throw translateError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson(response: Response): Promise<CloudflareResponse> {
    try {
      return (await response.json()) as CloudflareResponse;
    } catch {
      return {};
    }
  }

  private translateFailure(status: number, payload: CloudflareResponse): UserFacingError {
    const detail = payload.errors?.[0]?.message ?? `HTTP ${status}`;

    // 額度用完要讓 Router 知道這是「沒額度」而不是「壞掉」，
    // 全部來源都沒額度時才會回規格 §13 指定的那句話
    if (status === 429) return new QuotaExceededError(detail);
    if (status === 401 || status === 403) return new ProviderAuthError(detail);

    logger.error(`Cloudflare 生圖失敗 HTTP ${status}`, detail);
    return new UserFacingError('生圖服務暫時無法使用，請稍後再試。', detail);
  }
}

function translateError(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) return error;

  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new ProviderTimeoutError(error);
  }

  logger.error('Cloudflare 生圖未分類錯誤', error);
  return new UserFacingError('生圖服務暫時無法使用，請稍後再試。', error);
}
