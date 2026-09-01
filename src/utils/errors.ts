/**
 * 給使用者看的錯誤。message 會直接顯示在 Discord，所以必須是友善中文，
 * 不可以夾帶 stack trace 或 API key。
 */
export class UserFacingError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'UserFacingError';
  }
}

/** 免費額度用完。Planning §3 明確要求顯示友善訊息，且不得自動切換到付費 API。 */
export class QuotaExceededError extends UserFacingError {
  constructor(cause?: unknown) {
    super('目前 AI 免費額度已用完，請稍後再試。', cause);
    this.name = 'QuotaExceededError';
  }
}

export class ProviderTimeoutError extends UserFacingError {
  constructor(cause?: unknown) {
    super('AI 回應逾時，請稍後再試一次。', cause);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderAuthError extends UserFacingError {
  constructor(cause?: unknown) {
    super('AI 服務認證失敗，請通知 Bot 管理員檢查 API Key 設定。', cause);
    this.name = 'ProviderAuthError';
  }
}

export class ContentBlockedError extends UserFacingError {
  constructor(cause?: unknown) {
    super('這個內容被 AI 安全機制擋下了，換個說法試試看。', cause);
    this.name = 'ContentBlockedError';
  }
}

export function toUserMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  return '發生未預期的錯誤，請稍後再試。';
}
