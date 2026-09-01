export interface RateLimitResult {
  allowed: boolean;
  /** 還要等多久才能再試（毫秒）。allowed 為 true 時是 0。 */
  retryAfterMs: number;
}

/**
 * 記憶體內的 sliding window rate limiter。
 *
 * 刻意不用 Redis：Planning §6 禁止引入額外資料庫，而 Bot 是單一 process，
 * 記憶體計數已足夠。重啟後計數歸零，對防濫用來說可以接受。
 *
 * check() 沒有副作用，record() 才真的記一次。分開是為了讓多層限流可以
 * 「全部通過才一起記帳」，不會因為某一層被擋而白白消耗另一層的額度。
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, now: number = Date.now()): RateLimitResult {
    const recent = this.recentHits(key, now);

    if (recent.length < this.limit) {
      return { allowed: true, retryAfterMs: 0 };
    }

    const oldest = recent[0] ?? now;
    return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
  }

  record(key: string, now: number = Date.now()): void {
    const recent = this.recentHits(key, now);
    recent.push(now);
    this.hits.set(key, recent);
  }

  /** 清掉已經完全過期的 key，避免 Map 無限成長。 */
  prune(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter((at) => at > cutoff);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }

  get size(): number {
    return this.hits.size;
  }

  private recentHits(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    return (this.hits.get(key) ?? []).filter((at) => at > cutoff);
  }
}

export type RateLimitScope = 'user' | 'guild' | 'global';

export interface RateLimitDenial {
  scope: RateLimitScope;
  retryAfterMs: number;
}

/**
 * 三層限流：user / guild / global，防止單一使用者或單一 server
 * 把免費 API 額度吃光（Planning §19）。
 */
export class TieredRateLimiter {
  private readonly user: SlidingWindowRateLimiter;
  private readonly guild: SlidingWindowRateLimiter;
  private readonly global: SlidingWindowRateLimiter;

  constructor(options: {
    windowMs: number;
    userLimit: number;
    guildLimit: number;
    globalLimit: number;
  }) {
    this.user = new SlidingWindowRateLimiter(options.userLimit, options.windowMs);
    this.guild = new SlidingWindowRateLimiter(options.guildLimit, options.windowMs);
    this.global = new SlidingWindowRateLimiter(options.globalLimit, options.windowMs);
  }

  /**
   * 三層都通過才記帳並回傳 null；任一層不通過則回傳是哪一層擋的，且不記帳。
   * 由窄到寬檢查，讓錯誤訊息盡量貼近使用者實際做錯的事。
   */
  check(guildId: string, userId: string, now: number = Date.now()): RateLimitDenial | null {
    const userKey = `${guildId}:${userId}`;

    const checks: Array<[RateLimitScope, SlidingWindowRateLimiter, string]> = [
      ['user', this.user, userKey],
      ['guild', this.guild, guildId],
      ['global', this.global, 'global'],
    ];

    for (const [scope, limiter, key] of checks) {
      const result = limiter.check(key, now);
      if (!result.allowed) return { scope, retryAfterMs: result.retryAfterMs };
    }

    for (const [, limiter, key] of checks) {
      limiter.record(key, now);
    }

    return null;
  }

  prune(now: number = Date.now()): void {
    this.user.prune(now);
    this.guild.prune(now);
    this.global.prune(now);
  }
}
