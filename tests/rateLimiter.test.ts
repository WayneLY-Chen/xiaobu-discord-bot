import { describe, expect, it } from 'vitest';
import { SlidingWindowRateLimiter, TieredRateLimiter } from '../src/utils/rateLimiter.js';

describe('SlidingWindowRateLimiter', () => {
  it('在額度內放行，超過就擋下', () => {
    const limiter = new SlidingWindowRateLimiter(2, 60_000);

    expect(limiter.check('a', 0).allowed).toBe(true);
    limiter.record('a', 0);
    limiter.record('a', 10);

    expect(limiter.check('a', 20).allowed).toBe(false);
  });

  it('視窗滑過之後恢復', () => {
    const limiter = new SlidingWindowRateLimiter(1, 1000);
    limiter.record('a', 0);

    expect(limiter.check('a', 500).allowed).toBe(false);
    expect(limiter.check('a', 1001).allowed).toBe(true);
  });

  it('回報還要等多久', () => {
    const limiter = new SlidingWindowRateLimiter(1, 1000);
    limiter.record('a', 0);

    expect(limiter.check('a', 400).retryAfterMs).toBe(600);
  });

  it('不同 key 各自計算', () => {
    const limiter = new SlidingWindowRateLimiter(1, 60_000);
    limiter.record('a', 0);

    expect(limiter.check('a', 0).allowed).toBe(false);
    expect(limiter.check('b', 0).allowed).toBe(true);
  });

  it('check 本身沒有副作用', () => {
    const limiter = new SlidingWindowRateLimiter(1, 60_000);

    limiter.check('a', 0);
    limiter.check('a', 0);
    limiter.check('a', 0);

    expect(limiter.check('a', 0).allowed).toBe(true);
  });

  it('prune 清掉過期的 key', () => {
    const limiter = new SlidingWindowRateLimiter(5, 1000);
    limiter.record('a', 0);
    expect(limiter.size).toBe(1);

    limiter.prune(2000);
    expect(limiter.size).toBe(0);
  });
});

describe('TieredRateLimiter', () => {
  const build = (userLimit: number, guildLimit: number, globalLimit: number) =>
    new TieredRateLimiter({ windowMs: 60_000, userLimit, guildLimit, globalLimit });

  it('三層都通過才放行', () => {
    const limiter = build(10, 10, 10);
    expect(limiter.check('g1', 'u1', 0)).toBeNull();
  });

  it('使用者超量時只擋那個人，不影響同伺服器其他人', () => {
    const limiter = build(1, 10, 10);

    limiter.check('g1', 'u1', 0);
    expect(limiter.check('g1', 'u1', 0)?.scope).toBe('user');
    expect(limiter.check('g1', 'u2', 0)).toBeNull();
  });

  it('同一個 user id 在不同伺服器分開計算', () => {
    const limiter = build(1, 10, 10);

    limiter.check('g1', 'u1', 0);
    expect(limiter.check('g1', 'u1', 0)?.scope).toBe('user');
    expect(limiter.check('g2', 'u1', 0)).toBeNull();
  });

  it('伺服器超量時擋下該伺服器，其他伺服器不受影響', () => {
    const limiter = build(10, 1, 100);

    limiter.check('g1', 'u1', 0);
    expect(limiter.check('g1', 'u2', 0)?.scope).toBe('guild');
    expect(limiter.check('g2', 'u3', 0)).toBeNull();
  });

  it('全域超量時所有人都被擋', () => {
    const limiter = build(10, 10, 1);

    limiter.check('g1', 'u1', 0);
    expect(limiter.check('g2', 'u2', 0)?.scope).toBe('global');
  });

  it('被某一層擋下時，不會白白消耗其他層的額度', () => {
    const limiter = build(1, 10, 10);

    limiter.check('g1', 'u1', 0); // u1 用掉自己唯一的額度
    limiter.check('g1', 'u1', 0); // 被 user 層擋下，guild / global 不該記帳
    limiter.check('g1', 'u1', 0);
    limiter.check('g1', 'u1', 0);

    // guild 額度是 10，若剛才那三次有記帳這裡就會被擋
    for (let i = 0; i < 9; i += 1) {
      expect(limiter.check('g1', `other${i}`, 0)).toBeNull();
    }
  });
});
