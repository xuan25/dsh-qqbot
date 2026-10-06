/**
 * inbound.ts 引用发送人解析的单元测试：
 * resolveQuoteSender（entry 直挂 / store 命中 / store miss）。
 */
import { describe, it, expect } from 'vitest';
import type { RefEntry, ResolvedQuote } from '@tencent-connect/qqbot-nodejs';
import { resolveQuoteSender } from './inbound.ts';
import { getQuoteStore } from '../features/quote-store.ts';

const senderA: RefEntry = {
  messageId: 'm-a',
  senderId: 'A00000000000000000000000000000000',
  senderName: '甲',
  content: 'hi',
  timestamp: '1700000000',
};

function mkQuote(partial: Partial<ResolvedQuote> & { text?: string }): ResolvedQuote {
  return {
    refKey: '',
    source: 'msg_elements',
    text: '',
    ...partial,
  } as ResolvedQuote;
}

describe('resolveQuoteSender', () => {
  it('returns undefined when there is no quote', async () => {
    expect(await resolveQuoteSender(undefined)).toBeUndefined();
  });

  it('prefers the directly attached entry', async () => {
    const quote = mkQuote({ refKey: 'r5', source: 'store', entry: senderA, text: 'x' });
    expect(await resolveQuoteSender(quote)).toBe(senderA);
  });

  it('looks up the shared quote store by refKey on hit', async () => {
    const key = 'inb-hit-1';
    getQuoteStore().set(key, { ...senderA });
    const quote = mkQuote({ refKey: key, source: 'store', text: 'x' });
    expect(await resolveQuoteSender(quote)).toEqual(senderA);
  });

  it('returns undefined on store miss (no fabrication)', async () => {
    const quote = mkQuote({ refKey: 'inb-miss-1', source: 'none', text: '' });
    expect(await resolveQuoteSender(quote)).toBeUndefined();
  });
});
