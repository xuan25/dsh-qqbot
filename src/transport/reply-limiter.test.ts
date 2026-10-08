import { describe, it, expect, vi } from 'vitest';
import { ReplyLimiter } from './reply-limiter.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ReplyLimiter', () => {
  it('allows passive replies up to the limit', () => {
    const limiter = new ReplyLimiter({ limit: 4 });

    for (let i = 0; i < 4; i += 1) {
      const result = limiter.checkLimit('m1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
      limiter.record('m1');
    }

    const exceeded = limiter.checkLimit('m1');
    expect(exceeded.allowed).toBe(false);
    expect(exceeded.fallbackReason).toBe('limit_exceeded');
  });

  it('tracks different messages independently', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    limiter.record('m1');
    limiter.record('m1');

    const other = limiter.checkLimit('m2');
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(4);
  });

  it('falls back to proactive when the message expires', async () => {
    const limiter = new ReplyLimiter({ limit: 4, ttlMs: 30 });
    limiter.record('m1');

    await sleep(50);

    const expired = limiter.checkLimit('m1');
    expect(expired.allowed).toBe(false);
    expect(expired.fallbackReason).toBe('expired');
  });

  it('applies the configured passive window per scope (group 5 min, c2c 60 min)', () => {
    vi.useFakeTimers();
    try {
      const base = new Date('2026-10-08T10:00:00Z').getTime();
      vi.setSystemTime(base);
      const limiter = new ReplyLimiter({ limit: 4, scopeTtlMs: { c2c: 60 * 60_000, group: 5 * 60_000 } });
      limiter.record('g1');
      limiter.record('c1');

      // +4 min：两种 scope 都在配置的窗口内
      vi.setSystemTime(base + 4 * 60_000);
      expect(limiter.checkLimit('g1', 'group').allowed).toBe(true);
      expect(limiter.checkLimit('c1', 'c2c').allowed).toBe(true);

      // +6 min：group 窗口（5 分钟）已过期，c2c（60 分钟）仍有效
      vi.setSystemTime(base + 6 * 60_000);
      const group = limiter.checkLimit('g1', 'group');
      expect(group.allowed).toBe(false);
      expect(group.fallbackReason).toBe('expired');
      expect(limiter.checkLimit('c1', 'c2c').allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('measures the passive window from message arrival (seed), not from the first reply', () => {
    vi.useFakeTimers();
    try {
      const base = new Date('2026-10-08T10:00:00Z').getTime();
      vi.setSystemTime(base);
      const limiter = new ReplyLimiter({ limit: 4, scopeTtlMs: { group: 5 * 60_000 } });
      limiter.seed('g1');

      // 到达后 4 分钟首次回复：距到达 4 min，群窗口（5 min）内
      vi.setSystemTime(base + 4 * 60_000);
      expect(limiter.checkLimit('g1', 'group').allowed).toBe(true);
      limiter.record('g1');

      // 到达后 6 分钟第二次回复：自到达起算已超群窗口
      // （旧语义自首回复起算仅 2 分钟，会误放行）
      vi.setSystemTime(base + 6 * 60_000);
      const expired = limiter.checkLimit('g1', 'group');
      expect(expired.allowed).toBe(false);
      expect(expired.fallbackReason).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires an arrival-seeded message even if never replied to', () => {
    vi.useFakeTimers();
    try {
      const base = new Date('2026-10-08T10:00:00Z').getTime();
      vi.setSystemTime(base);
      const limiter = new ReplyLimiter({ limit: 4, scopeTtlMs: { group: 5 * 60_000 } });
      limiter.seed('g1');

      // 到达后 6 分钟（未回复过）：窗口自到达起算，已过期
      vi.setSystemTime(base + 6 * 60_000);
      const expired = limiter.checkLimit('g1', 'group');
      expect(expired.allowed).toBe(false);
      expect(expired.fallbackReason).toBe('expired');

      // 过期记录被删除：再次检查按未登记消息放行（锚点已死，由发送层 fallback 兜底）
      expect(limiter.checkLimit('g1', 'group').allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('seed is idempotent and does not overwrite an existing entry', () => {
    vi.useFakeTimers();
    try {
      const base = new Date('2026-10-08T10:00:00Z').getTime();
      vi.setSystemTime(base);
      const limiter = new ReplyLimiter({ limit: 4, ttlMs: 30_000 });
      limiter.record('m1'); // 未登记 id 建账于 base
      limiter.seed('m1', base - 30_000); // 重复登记不得覆盖 firstSeenAt

      // 仍以建账时刻 base 起算（20s < 30s 窗口）→ 放行
      vi.setSystemTime(base + 20_000);
      expect(limiter.checkLimit('m1').allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the per-scope limit to arrival-seeded messages', () => {
    const limiter = new ReplyLimiter({ limit: 4, scopeLimit: { group: 5 } });
    limiter.seed('g1');

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.checkLimit('g1', 'group').allowed).toBe(true);
      limiter.record('g1');
    }
    expect(limiter.checkLimit('g1', 'group').fallbackReason).toBe('limit_exceeded');
  });

  it('resolves ttl with priority scopeTtlMs > ttlMs > default', () => {
    vi.useFakeTimers();
    try {
      const base = new Date('2026-10-08T10:00:00Z').getTime();
      vi.setSystemTime(base);
      const limiter = new ReplyLimiter({ limit: 4, ttlMs: 60_000, scopeTtlMs: { group: 5 * 60_000 } });
      limiter.record('g1');
      limiter.record('c1');

      // +4 min：group 在 scopeTtlMs 窗口（5 min）内；c2c 无 scope 配置，走全局 ttlMs（1 min）已过期
      vi.setSystemTime(base + 4 * 60_000);
      expect(limiter.checkLimit('g1', 'group').allowed).toBe(true);
      const c2c = limiter.checkLimit('c1', 'c2c');
      expect(c2c.allowed).toBe(false);
      expect(c2c.fallbackReason).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the default 1h ttl when no window is configured', () => {
    vi.useFakeTimers();
    try {
      const base = new Date('2026-10-08T10:00:00Z').getTime();
      vi.setSystemTime(base);
      const limiter = new ReplyLimiter({ limit: 4 });
      limiter.record('m1');
      limiter.record('m2');

      // 60 分钟内仍有效（过期按严格大于判定，边界值不算）
      vi.setSystemTime(base + 60 * 60_000);
      expect(limiter.checkLimit('m1').allowed).toBe(true);

      // 61 分钟后，无配置的两种 scope 均按默认 1 小时过期（过期判定会删除记录，分用两条消息）
      vi.setSystemTime(base + 61 * 60_000);
      const c2c = limiter.checkLimit('m1', 'c2c');
      expect(c2c.allowed).toBe(false);
      expect(c2c.fallbackReason).toBe('expired');
      const group = limiter.checkLimit('m2', 'group');
      expect(group.allowed).toBe(false);
      expect(group.fallbackReason).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the configured per-scope reply limit', () => {
    const limiter = new ReplyLimiter({ limit: 4, scopeLimit: { group: 5 } });

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.checkLimit('g1', 'group').allowed).toBe(true);
      limiter.record('g1');
    }
    expect(limiter.checkLimit('g1', 'group').fallbackReason).toBe('limit_exceeded');

    // c2c 无 scope 配置，仍受全局 limit=4 约束
    for (let i = 0; i < 4; i += 1) limiter.record('c1');
    expect(limiter.checkLimit('c1', 'c2c').fallbackReason).toBe('limit_exceeded');
  });
});
