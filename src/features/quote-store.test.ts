/**
 * quote-store 与 SDK quoteRef 中间件（真实实现）集成测试：
 * 验证插件自持 store 写入的 entry 可被 resolve 步骤按 refKey 回查——
 * 即 msg_elements 命中时 entry 被丢弃、发送人仅能靠 store 回查的路径，
 * 以及 store 直挂 / miss 的行为。
 */
import { describe, it, expect } from 'vitest';
import { quoteRef } from '@tencent-connect/qqbot-nodejs';
import type { MiddlewareContext, ResolvedQuote } from '@tencent-connect/qqbot-nodejs';
import { getQuoteStore } from './quote-store.ts';
import { resolveQuoteSender } from '../transport/inbound.ts';

const noopLog = { debug() {}, info() {}, error() {} };

interface MsgSpec {
  msgIdx?: string;
  refMsgIdx?: string;
  senderId: string;
  senderName?: string;
  content?: string;
  kind?: 'group' | 'c2c';
  msgElements?: Array<{ content?: string; attachments?: Array<{ content_type: string; url: string }> }>;
}

/** 最小 MiddlewareContext mock：quoteRef 只读 message/state/log 并调用 next()。 */
function makeCtx(spec: MsgSpec): MiddlewareContext {
  const kind = spec.kind ?? 'group';
  const message = {
    kind,
    senderId: spec.senderId,
    senderName: spec.senderName,
    content: spec.content,
    msgIdx: spec.msgIdx,
    refMsgIdx: spec.refMsgIdx,
    msgElements: spec.msgElements,
    messageId: spec.msgIdx ?? `mid-${spec.senderId}`,
    timestamp: '1700000000',
    senderIsBot: false,
    replyTarget: { scope: kind, targetId: 't-1', msgId: spec.msgIdx },
  };
  return {
    bot: {},
    state: {},
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

/** 按插件接线方式跑一遍 quoteRef（共享 store + preferMsgElements）。 */
async function runQuoteRef(ctx: MiddlewareContext): Promise<void> {
  await quoteRef({ store: getQuoteStore(), preferMsgElements: true })(ctx, async () => {});
}

describe('quote-store', () => {
  it('getQuoteStore() returns the same singleton instance', () => {
    expect(getQuoteStore()).toBe(getQuoteStore());
  });

  it('records the current message into the plugin-owned store with sender preserved', async () => {
    const ctx = makeCtx({ msgIdx: 'qs-rec-1', senderId: 'A000', senderName: '甲', content: 'hello' });
    await runQuoteRef(ctx);

    const entry = await getQuoteStore().get('qs-rec-1');
    expect(entry).toBeDefined();
    expect(entry!.senderId).toBe('A000');
    expect(entry!.senderName).toBe('甲');
    expect(entry!.content).toBe('hello');
  });

  it('msg_elements hit: SDK drops the entry, store reverse lookup restores the sender (production loss path)', async () => {
    const orig = makeCtx({ msgIdx: 'qs-orig-2', senderId: 'B000', senderName: '乙', content: '被引用的原句' });
    await runQuoteRef(orig);

    const quoter = makeCtx({
      msgIdx: 'qs-quote-2',
      refMsgIdx: 'qs-orig-2',
      senderId: 'C000',
      content: '问上面那句',
      msgElements: [{ content: '被引用的原句' }],
    });
    await runQuoteRef(quoter);

    const quote = quoter.state.quote as ResolvedQuote;
    expect(quote.source).toBe('msg_elements');
    expect(quote.entry).toBeUndefined();

    const sender = await resolveQuoteSender(quote);
    expect(sender).toEqual(expect.objectContaining({ senderId: 'B000', senderName: '乙' }));
  });

  it('store hit (no msg_elements): entry attached directly', async () => {
    const orig = makeCtx({ msgIdx: 'qs-orig-3', senderId: 'D000', senderName: '丁', content: '原文内容' });
    await runQuoteRef(orig);

    const quoter = makeCtx({ msgIdx: 'qs-quote-3', refMsgIdx: 'qs-orig-3', senderId: 'E000', content: '无平台内容' });
    await runQuoteRef(quoter);

    const quote = quoter.state.quote as ResolvedQuote;
    expect(quote.source).toBe('store');
    expect(quote.entry).toBeDefined();
    expect(await resolveQuoteSender(quote)).toBe(quote.entry);
  });

  it('store miss without msg_elements: source=none, sender resolves to undefined (no fabrication)', async () => {
    const quoter = makeCtx({ msgIdx: 'qs-quote-4', refMsgIdx: 'qs-never-recorded', senderId: 'F000', content: '引用一条未知消息' });
    await runQuoteRef(quoter);

    const quote = quoter.state.quote as ResolvedQuote;
    expect(quote.source).toBe('none');
    expect(await resolveQuoteSender(quote)).toBeUndefined();
  });
});
