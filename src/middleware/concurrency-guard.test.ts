/**
 * concurrency-guard 合并路径单元测试（含 message.replyTarget 的最小 MiddlewareContext mock，
 * guard 的 targetKey 依赖它）：
 * - group scope：逐条发送人前缀 + 逐条内联附件标签、附件源集合 = buffered 全量、
 *   非 survivor 补写 quote store
 * - c2c scope：无前缀、内联附件标签、附件源集合 = buffered 全量
 * - cut-in-with-preview：group preview 行带前缀、整行 120 字符截断；c2c 无前缀
 *
 * 注：部署中 mentionGate 对非群消息强制 wasMentioned=true，c2c 流量走 urgent
 * cut-in，merge 分支对 c2c 近乎死路径；此处 c2c 用例以合成的非 urgent
 * context 驱动 scope 门控逻辑本身。
 */
import { describe, it, expect, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { concurrencyGuard } from './concurrency-guard.ts';
import { getQuoteStore } from '../features/quote-store.ts';

const noopLog = { info() {}, error() {}, debug() {}, warn() {} };

interface CtxSpec {
  scope: 'group' | 'c2c';
  targetId: string;
  senderId: string;
  senderName?: string;
  content?: string;
  attachments?: Array<{ content_type: string; url: string }>;
  msgIdx?: string;
  wasMentioned?: boolean;
  envelope?: string;
}

/** 最小 MiddlewareContext mock：guard 只读 message/state/log 并调用 next()/stop()/abort()。 */
function makeCtx(spec: CtxSpec): MiddlewareContext {
  const message = {
    kind: spec.scope,
    senderId: spec.senderId,
    senderName: spec.senderName,
    content: spec.content,
    attachments: spec.attachments,
    msgIdx: spec.msgIdx,
    messageId: spec.msgIdx ?? `mid-${spec.senderId}`,
    timestamp: '1700000000',
    senderIsBot: false,
    replyTarget: { scope: spec.scope, targetId: spec.targetId, msgId: spec.msgIdx },
  };
  const state: Record<string, unknown> = {};
  if (spec.wasMentioned !== undefined) state.mention = { wasMentioned: spec.wasMentioned };
  if (spec.envelope !== undefined) state.envelope = spec.envelope;
  return {
    bot: {},
    state,
    message: message as unknown as MiddlewareContext['message'],
    replyTarget: message.replyTarget,
    log: noopLog,
    stop() {},
    stopped: false,
    stopReason: undefined,
    signal: new AbortController().signal,
    abort() {},
  } as unknown as MiddlewareContext;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface Topology {
  guard: ReturnType<typeof concurrencyGuard>;
  ownerCtx: MiddlewareContext;
  bCtx: MiddlewareContext;
  cCtx: MiddlewareContext;
  dCtx: MiddlewareContext;
  bNext: ReturnType<typeof vi.fn>;
  cNext: ReturnType<typeof vi.fn>;
  dNext: ReturnType<typeof vi.fn>;
  release: () => void;
  awaitAll: () => Promise<void>;
}

/**
 * 标准合并拓扑：owner A active（next 挂起），B/C/D 入缓冲。
 * B：文本 + envelope；C：文本 + envelope + 1 附件；D：media-only（1 附件）。
 */
function startTopology(
  guardOpts: { urgentPredicate?: (ctx: MiddlewareContext) => boolean; urgentStrategy?: string },
  scope: 'group' | 'c2c',
): Topology {
  const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 10, ...guardOpts });
  const targetId = scope === 'group' ? 'g1' : 'p1';

  const ownerCtx = makeCtx({ scope, targetId, senderId: 'A000', senderName: 'A', content: 'A msg' });
  const ownerHold = deferred();
  const ownerRun = guard(ownerCtx, async () => { await ownerHold.promise; });

  const bCtx = makeCtx({ scope, targetId, senderId: 'B000', senderName: 'B', content: 'B msg', envelope: 'B-env', msgIdx: `cm-${scope}-b` });
  const cCtx = makeCtx({ scope, targetId, senderId: 'C000', senderName: 'C', content: 'C msg', envelope: 'C-env', attachments: [{ content_type: 'image', url: 'u-c' }], msgIdx: `cm-${scope}-c` });
  const dCtx = makeCtx({ scope, targetId, senderId: 'D000', senderName: 'D', content: '', attachments: [{ content_type: 'image', url: 'u-d' }], msgIdx: `cm-${scope}-d` });

  const bNext = vi.fn(async () => {});
  const cNext = vi.fn(async () => {});
  const dNext = vi.fn(async () => {});
  const bRun = guard(bCtx, bNext);
  const cRun = guard(cCtx, cNext);
  const dRun = guard(dCtx, dNext);

  return {
    guard,
    ownerCtx,
    bCtx,
    cCtx,
    dCtx,
    bNext,
    cNext,
    dNext,
    release: () => ownerHold.resolve(),
    awaitAll: () => Promise.all([ownerRun, bRun, cRun, dRun]),
  };
}

describe('concurrency-guard merge (defaultMerge)', () => {
  it('group: per-line sender prefixes + inlined attachment tags + full-buffered attachments + quote-store backfill', async () => {
    const t = startTopology({}, 'group');
    // 预置 survivor 的哨兵 entry，验证补写不覆盖 survivor
    const sentinel = { messageId: 'pre-b', senderId: 'PRE', content: 'sentinel', timestamp: '0' };
    getQuoteStore().set('cm-group-b', sentinel);

    await tick();
    t.release();
    await t.awaitAll();

    // survivor = B：B 的 next 恰好被调用一次；C/D 静默返回
    expect(t.bNext).toHaveBeenCalledTimes(1);
    expect(t.cNext).not.toHaveBeenCalled();
    expect(t.dNext).not.toHaveBeenCalled();

    // survivor 内容：逐条 = 单独进来时的 Layer 1 形态（C/D 的 [图片] 内联在各自行）
    expect(t.bCtx.message.content).toBe(
      'B msg\n[C (C000)] C msg\n[图片]\n[D (D000)] [图片]',
    );

    // 附件源集合 = buffered 全量（media-only 附件随 survivor 下载，与内联标签一一对应）
    expect(t.bCtx.message.attachments).toEqual([
      { content_type: 'image', url: 'u-c' },
      { content_type: 'image', url: 'u-d' },
    ]);

    // envelope 合并：非空 envelope 以空行连接
    expect(t.bCtx.state.envelope).toBe('B-env\n\nC-env');

    // quote store：非 survivor 补写（key = msgIdx）；survivor 不被覆盖
    const store = getQuoteStore();
    expect(await store.get('cm-group-b')).toBe(sentinel);
    expect(await store.get('cm-group-c')).toMatchObject({ senderId: 'C000', senderName: 'C', content: 'C msg' });
    expect(await store.get('cm-group-d')).toMatchObject({ senderId: 'D000', senderName: 'D', content: '' });
  });

  it('c2c: no prefixes, inlined attachment tags, full-buffered attachments', async () => {
    const t = startTopology({}, 'c2c');
    await tick();
    t.release();
    await t.awaitAll();

    expect(t.bCtx.message.content).toBe('B msg\nC msg\n[图片]\n[图片]');
    expect(t.bCtx.message.attachments).toEqual([
      { content_type: 'image', url: 'u-c' },
      { content_type: 'image', url: 'u-d' },
    ]);
    expect(t.bCtx.state.envelope).toBe('B-env\n\nC-env');
  });

  it('a single buffered message passes through unmutated (survivor continues to quoteRef)', async () => {
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 10 });
    const owner = makeCtx({ scope: 'group', targetId: 'g9', senderId: 'A000', content: 'A msg' });
    const hold = deferred();
    const ownerRun = guard(owner, async () => { await hold.promise; });

    const b = makeCtx({ scope: 'group', targetId: 'g9', senderId: 'B000', senderName: 'B', content: 'only B', msgIdx: 'cm-single-b' });
    const bNext = vi.fn(async () => {});
    const bRun = guard(b, bNext);

    await tick();
    hold.resolve();
    await ownerRun;
    await bRun;

    expect(bNext).toHaveBeenCalledTimes(1);
    expect(b.message.content).toBe('only B');
    expect(b.message.attachments).toBeUndefined();
    // 单条缓冲 = survivor，续链由 quoteRef 记录，不走补写
    expect(await getQuoteStore().get('cm-single-b')).toBeUndefined();
  });
});

describe('concurrency-guard cut-in-with-preview', () => {
  const urgentOpts = {
    urgentPredicate: (ctx: MiddlewareContext) => ctx.state.mention?.wasMentioned === true,
    urgentStrategy: 'cut-in-with-preview' as const,
  };

  it('group: preview lines carry sender prefixes; c2c: plain lines', async () => {
    const g = startTopology(urgentOpts, 'group');
    await tick();

    const uG = makeCtx({ scope: 'group', targetId: 'g1', senderId: 'U000', content: 'urgent @bot', wasMentioned: true });
    const uGNext = vi.fn(async () => {});
    await g.guard(uG, uGNext);
    expect(uGNext).toHaveBeenCalledTimes(1);
    expect(uG.message.content).toContain('[previous messages preview]');
    expect(uG.message.content).toContain('[B (B000)] B msg');
    expect(uG.message.content).toContain('[C (C000)] C msg');
    expect(uG.message.content).toContain('[D (D000)] (media-only, content omitted)');

    const c = startTopology(urgentOpts, 'c2c');
    await tick();

    const uC = makeCtx({ scope: 'c2c', targetId: 'p1', senderId: 'U000', content: 'urgent', wasMentioned: true });
    const uCNext = vi.fn(async () => {});
    await c.guard(uC, uCNext);
    expect(uC.message.content).toContain('[previous messages preview]');
    expect(uC.message.content).toContain('\nB msg\n');
    expect(uC.message.content).not.toContain('[B (B000)]');
    expect(uC.message.content).toContain('(media-only, content omitted)');

    g.release();
    c.release();
    await g.awaitAll();
    await c.awaitAll();
  });

  it('preview lines are truncated to 120 chars on the whole line (prefix included)', async () => {
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 10, ...urgentOpts });
    const targetId = 'g2';
    const owner = makeCtx({ scope: 'group', targetId, senderId: 'A000', content: 'A msg' });
    const hold = deferred();
    const ownerRun = guard(owner, async () => { await hold.promise; });

    const longContent = 'x'.repeat(200);
    const b = makeCtx({ scope: 'group', targetId, senderId: 'B000', senderName: 'B', content: longContent });
    const bRun = guard(b, vi.fn(async () => {}));
    await tick();

    const u = makeCtx({ scope: 'group', targetId, senderId: 'U000', content: 'urgent', wasMentioned: true });
    const uNext = vi.fn(async () => {});
    await guard(u, uNext);

    const section = u.message.content!.split('[previous messages preview]\n')[1]!;
    const line = section.split('\n')[0]!;
    expect(line).toHaveLength(120);
    expect(line.endsWith('…')).toBe(true);
    expect(line.startsWith('[B (B000)] ')).toBe(true);

    hold.resolve();
    await ownerRun;
    await bRun;
  });
});
