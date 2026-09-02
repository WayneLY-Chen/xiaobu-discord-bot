import {
  getModelSpec,
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_LABEL,
  type ProviderId,
} from '../config/constants.js';
import { ContentBlockedError, UserFacingError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { ChatProvider, ChatRequest, ChatResponse } from './providers/types.js';

export interface RouteResult extends ChatResponse {
  /** 實際回答的 provider 與 model —— 可能與使用者選的不同（換手時）。 */
  provider: ProviderId;
  model: string;
  /** 有沒有因為原本的 provider 失敗而換手。 */
  fellBack: boolean;
  /** 換手的原因，只有 fellBack 時才有值。 */
  fallbackReason?: UserFacingError;
}

export interface AiRouterOptions {
  /**
   * 硬性規定（Planning §30）：預設 false，程式**絕不**自動切換到付費 provider。
   * 只有明確設成 true 才允許把付費 provider 納入候選。
   */
  allowPaidProviders: boolean;
  /** 關掉的話，主要 provider 失敗就直接報錯，不換手。 */
  fallbackEnabled: boolean;
}

/**
 * 決定用哪個 provider 回答，失敗時在免費 provider 之間換手。
 *
 * 換手規則：
 * - 使用者選的 model 決定第一順位 provider。
 * - 那家掛了（額度、逾時、認證、暫時性錯誤）就依註冊順序換下一家，
 *   換手時用該 provider 的 production 預設模型。
 * - **內容被安全機制擋下時絕不換手**：那不是「這家壞了」，
 *   而是這個內容不該被產生。換一家重試等於在找一個肯講的 provider。
 * - 付費 provider 只有 allowPaidProviders=true 才會進候選名單。
 */
export class AiRouter {
  private readonly providers: ChatProvider[];

  constructor(
    providers: ChatProvider[],
    private readonly options: AiRouterOptions,
  ) {
    this.providers = providers;

    const blocked = providers.filter((p) => p.tier === 'paid' && !options.allowPaidProviders);
    for (const provider of blocked) {
      logger.warn(
        `${PROVIDER_LABEL[provider.id]} 是付費 provider，ALLOW_PAID_PROVIDERS=false，已排除在候選之外。`,
      );
    }
  }

  /** 目前可用（且被允許）的 provider。 */
  get availableProviders(): ProviderId[] {
    return this.usableProviders().map((provider) => provider.id);
  }

  isConfigured(id: ProviderId): boolean {
    return this.usableProviders().some((provider) => provider.id === id);
  }

  async chat(request: ChatRequest): Promise<RouteResult> {
    const usable = this.usableProviders();

    if (usable.length === 0) {
      throw new UserFacingError('目前沒有可用的 AI 服務，請通知 Bot 管理員檢查設定。');
    }

    const attempts = this.planAttempts(request.model, usable);
    let firstError: UserFacingError | undefined;

    for (const [index, attempt] of attempts.entries()) {
      try {
        const response = await attempt.provider.chat({ ...request, model: attempt.model });

        return {
          ...response,
          provider: attempt.provider.id,
          model: attempt.model,
          fellBack: index > 0,
          ...(index > 0 && firstError ? { fallbackReason: firstError } : {}),
        };
      } catch (error) {
        const failure = toUserFacing(error);

        // 內容被擋不是服務故障，換一家只是在繞過安全機制 —— 直接往上拋
        if (failure instanceof ContentBlockedError) throw failure;

        firstError ??= failure;

        const remaining = attempts.length - index - 1;
        logger.warn(
          `${PROVIDER_LABEL[attempt.provider.id]}（${attempt.model}）失敗：${failure.message}` +
            (remaining > 0 ? `　還有 ${remaining} 個 provider 可以試` : '　已無其他 provider'),
        );
      }
    }

    // 全部失敗時回報第一個錯誤：那是使用者原本選的 provider 的真正問題
    throw firstError ?? new UserFacingError('AI 服務暫時無法使用，請稍後再試。');
  }

  private usableProviders(): ChatProvider[] {
    return this.providers.filter(
      (provider) => provider.tier === 'free' || this.options.allowPaidProviders,
    );
  }

  /** 排出嘗試順序：第一順位是使用者選的 model，其餘是其他 provider 的預設 model。 */
  private planAttempts(
    requestedModel: string,
    usable: ChatProvider[],
  ): { provider: ChatProvider; model: string }[] {
    const spec = getModelSpec(requestedModel);
    const owner = spec ? usable.find((provider) => provider.id === spec.provider) : undefined;

    const primary = owner
      ? { provider: owner, model: requestedModel }
      : // 使用者存的 model 屬於一個沒設定 key（或已被停用）的 provider。
        // 這時退回第一個可用 provider 的預設模型，而不是讓呼叫直接失敗。
        (() => {
          const first = usable[0];
          if (!first) throw new UserFacingError('目前沒有可用的 AI 服務，請通知 Bot 管理員。');
          logger.warn(
            `model ${requestedModel} 沒有對應的可用 provider，改用 ${PROVIDER_LABEL[first.id]} 的預設模型。`,
          );
          return { provider: first, model: PROVIDER_DEFAULT_MODEL[first.id] };
        })();

    if (!this.options.fallbackEnabled) return [primary];

    const rest = usable
      .filter((provider) => provider.id !== primary.provider.id)
      .map((provider) => ({ provider, model: PROVIDER_DEFAULT_MODEL[provider.id] }));

    return [primary, ...rest];
  }
}

function toUserFacing(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) return error;
  return new UserFacingError('AI 服務暫時無法使用，請稍後再試。', error);
}
