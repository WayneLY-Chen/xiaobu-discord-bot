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

export type RateLimitWindow = 'minute' | 'day';

export interface RateLimitDenial {
  scope: RateLimitScope;
  /** 是短期（每分鐘）還是長期（每天）那一層擋的。訊息要講不同的話。 */
  window: RateLimitWindow;
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
  check(
    guildId: string,
    userId: string,
    now: number = Date.now(),
    window: RateLimitWindow = 'minute',
  ): RateLimitDenial | null {
    const userKey = `${guildId}:${userId}`;

    const checks: Array<[RateLimitScope, SlidingWindowRateLimiter, string]> = [
      ['user', this.user, userKey],
      ['guild', this.guild, guildId],
      ['global', this.global, 'global'],
    ];

    for (const [scope, limiter, key] of checks) {
      const result = limiter.check(key, now);
      if (!result.allowed) return { scope, window, retryAfterMs: result.retryAfterMs };
    }

    for (const [, limiter, key] of checks) {
      limiter.record(key, now);
    }

    return null;
  }

  /** 只檢查不記帳。給多層組合用：任何一層會擋就不該有人先扣額度。 */
  peek(
    guildId: string,
    userId: string,
    now: number = Date.now(),
    window: RateLimitWindow = 'day',
  ): RateLimitDenial | null {
    const checks: Array<[RateLimitScope, SlidingWindowRateLimiter, string]> = [
      ['user', this.user, `${guildId}:${userId}`],
      ['guild', this.guild, guildId],
      ['global', this.global, 'global'],
    ];

    for (const [scope, limiter, key] of checks) {
      const result = limiter.check(key, now);
      if (!result.allowed) return { scope, window, retryAfterMs: result.retryAfterMs };
    }

    return null;
  }

  prune(now: number = Date.now()): void {
    this.user.prune(now);
    this.guild.prune(now);
    this.global.prune(now);
  }
}


/** 一天。日限流的視窗長度。 */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 每分鐘 + 每天兩層限流。
 *
 * 只有每分鐘那層是不夠的：免費 API 真正會用完的是**每日**額度
 * （Gemini Flash-Lite 500 RPD、Groq 1000 RPD）。每分鐘 60 次的上限
 * 完全擋不住「整天細水長流把一天的份用光」—— 一小時就能耗盡。
 *
 * 兩層都通過才記帳。短期那層先擋，因為它的等待時間短、訊息比較有用。
 */
export class CombinedRateLimiter {
  private readonly perMinute: TieredRateLimiter;
  private readonly perDay: TieredRateLimiter;

  constructor(options: {
    windowMs: number;
    userLimit: number;
    guildLimit: number;
    globalLimit: number;
    dailyUserLimit: number;
    dailyGuildLimit: number;
    dailyGlobalLimit: number;
  }) {
    this.perMinute = new TieredRateLimiter({
      windowMs: options.windowMs,
      userLimit: options.userLimit,
      guildLimit: options.guildLimit,
      globalLimit: options.globalLimit,
    });

    this.perDay = new TieredRateLimiter({
      windowMs: ONE_DAY_MS,
      userLimit: options.dailyUserLimit,
      guildLimit: options.dailyGuildLimit,
      globalLimit: options.dailyGlobalLimit,
    });
  }

  /**
   * 兩層都通過才記帳。
   *
   * 這裡刻意「先檢查兩層、都過才各自記一次」而不是依序 check ——
   * 依序的話短期通過就會先記帳，之後被日限流擋下時那一次已經白白扣掉了。
   */
  check(guildId: string, userId: string, now: number = Date.now()): RateLimitDenial | null {
    const dayPeek = this.perDay.peek(guildId, userId, now);
    if (dayPeek) return dayPeek;

    const minuteDenial = this.perMinute.check(guildId, userId, now);
    if (minuteDenial) return minuteDenial;

    // 短期那層已經記帳了，日限流這層補記一次
    this.perDay.check(guildId, userId, now, 'day');
    return null;
  }

  prune(now: number = Date.now()): void {
    this.perMinute.prune(now);
    this.perDay.prune(now);
  }
}
