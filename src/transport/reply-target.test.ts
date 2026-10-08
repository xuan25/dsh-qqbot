import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import { ReplyLimiter } from './reply-limiter.ts';
import { cacheMsgId, cacheEventId } from './msgid-cache.ts';
import {
  isPassiveReplyRejected,
  resolveReplyTarget,
  sendMarkdownWithFallback,
  sendResolvedMarkdown,
} from './reply-target.ts';
import type { Logger, ReplyTarget } from '../types.ts';

function makeTarget(msgId?: string, targetId = 'peer-1'): ReplyTarget {
  return { scope: 'c2c', targetId, msgId };
}

function makeApiError(bizCode: number): ApiError {
  return new ApiError(`API Error: code ${bizCode}`, 400, '/v2/test/messages', bizCode, `code ${bizCode}`);
}

describe('resolveReplyTarget', () => {
  it('prefers explicit target.msgId', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    const result = resolveReplyTarget(makeTarget('m1'), limiter, true);
    expect(result.msgId).toBe('m1');
    expect(result.eventId).toBeUndefined();
  });

  it('falls back to cached msgId after target.msgId is exhausted', () => {
    const limiter = new ReplyLimiter({ limit: 1 });
    cacheMsgId('c2c', 'peer-2', 'cached-1');
    limiter.record('m-exhausted');
    const result = resolveReplyTarget(makeTarget('m-exhausted', 'peer-2'), limiter, true);
    expect(result.msgId).toBe('cached-1');
  });

  it('skips event candidates when allowEvent is false', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheEventId('c2c', 'peer-3', 'evt-1');
    const result = resolveReplyTarget(makeTarget(undefined, 'peer-3'), limiter, false);
    expect(result.eventId).toBeUndefined();
    expect(result.msgId).toBeUndefined();
  });

  it('returns eventId when allowEvent is true', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheEventId('c2c', 'peer-4', 'evt-2');
    const result = resolveReplyTarget(makeTarget(undefined, 'peer-4'), limiter, true);
    expect(result.eventId).toBe('INTERACTION_CREATE:evt-2');
    expect(result.msgId).toBeUndefined();
  });
});

describe('sendResolvedMarkdown', () => {
  it('fills event_id via bot.send when target has eventId', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'c2c', targetId: 'p', eventId: 'INTERACTION_CREATE:evt' };
    await sendResolvedMarkdown(bot, target, 'hello');
    expect(bot.send).toHaveBeenCalledWith(expect.objectContaining({
      extra: { event_id: 'INTERACTION_CREATE:evt' },
    }));
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('uses sendMarkdown for msgId targets', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'c2c', targetId: 'p', msgId: 'm1' };
    await sendResolvedMarkdown(bot, target, 'hello');
    expect(bot.sendMarkdown).toHaveBeenCalledWith(target, 'hello', undefined);
    expect(bot.send).not.toHaveBeenCalled();
  });
});

describe('isPassiveReplyRejected', () => {
  it('matches the platform passive-anchor rejection codes', () => {
    for (const code of [304103, 40034005, 40034024, 40034025, 40034026, 40034027, 40034128]) {
      expect(isPassiveReplyRejected(makeApiError(code))).toBe(true);
    }
  });

  it('does not match other platform errors or non-ApiError', () => {
    expect(isPassiveReplyRejected(makeApiError(40034100))).toBe(false);
    expect(isPassiveReplyRejected(makeApiError(40054005))).toBe(false);
    expect(isPassiveReplyRejected(new TypeError('network down'))).toBe(false);
  });
});

describe('sendMarkdownWithFallback', () => {
  it('sends the resolved passive target on success', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const limiter = new ReplyLimiter({ limit: 4 });
    await sendMarkdownWithFallback(bot, { scope: 'c2c', targetId: 'p', msgId: 'm1' }, limiter, 'hello');
    expect(bot.sendMarkdown).toHaveBeenCalledWith({ scope: 'c2c', targetId: 'p', msgId: 'm1' }, 'hello', undefined);
    expect(bot.send).not.toHaveBeenCalled();
  });

  it('resends once as proactive when the platform rejects the passive anchor', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async (target: ReplyTarget) => {
        if (target.msgId) throw makeApiError(40034128);
        return {};
      }),
    } as unknown as QQBot;
    const limiter = new ReplyLimiter({ limit: 4 });
    const logger = { info: () => {}, error: () => {}, warn: vi.fn() } as Logger;
    await sendMarkdownWithFallback(
      bot,
      { scope: 'group', targetId: 'g1', msgId: 'stale' },
      limiter,
      'hello',
      undefined,
      logger,
    );
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(2);
    expect(bot.sendMarkdown).toHaveBeenNthCalledWith(1, { scope: 'group', targetId: 'g1', msgId: 'stale' }, 'hello', undefined);
    expect(bot.sendMarkdown).toHaveBeenNthCalledWith(2, { scope: 'group', targetId: 'g1' }, 'hello', undefined);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('propagates the error when the proactive resend itself fails', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async (target: ReplyTarget) => {
        if (target.msgId) throw makeApiError(40034128);
        throw makeApiError(40034100);
      }),
    } as unknown as QQBot;
    const limiter = new ReplyLimiter({ limit: 4 });
    await expect(
      sendMarkdownWithFallback(bot, { scope: 'group', targetId: 'g1', msgId: 'stale' }, limiter, 'hello'),
    ).rejects.toThrow();
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the platform rejects with an unrelated code', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => { throw makeApiError(40034100); }),
    } as unknown as QQBot;
    const limiter = new ReplyLimiter({ limit: 4 });
    await expect(
      sendMarkdownWithFallback(bot, { scope: 'c2c', targetId: 'p', msgId: 'm1' }, limiter, 'hello'),
    ).rejects.toThrow();
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-ApiError failures', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => { throw new TypeError('fetch failed'); }),
    } as unknown as QQBot;
    const limiter = new ReplyLimiter({ limit: 4 });
    await expect(
      sendMarkdownWithFallback(bot, { scope: 'c2c', targetId: 'p', msgId: 'm1' }, limiter, 'hello'),
    ).rejects.toThrow(TypeError);
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
  });

  it('resends via sendMarkdown when an eventId anchor is rejected', async () => {
    const bot = {
      send: vi.fn(async () => { throw makeApiError(40034026); }),
      sendMarkdown: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheEventId('c2c', 'peer-evt', 'evt-x');
    await sendMarkdownWithFallback(bot, { scope: 'c2c', targetId: 'peer-evt' }, limiter, 'hello');
    expect(bot.send).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).toHaveBeenCalledWith({ scope: 'c2c', targetId: 'peer-evt' }, 'hello', undefined);
  });

  it('does not retry when the target is already proactive', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => { throw makeApiError(40034128); }),
    } as unknown as QQBot;
    const limiter = new ReplyLimiter({ limit: 4 });
    // 无 msgId 且该 peer 无缓存候选 → 解析结果即主动发送，没有可降级的锚点
    await expect(
      sendMarkdownWithFallback(bot, { scope: 'c2c', targetId: 'lonely-peer' }, limiter, 'hello'),
    ).rejects.toThrow();
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
  });
});
