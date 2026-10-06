/**
 * inbound.ts 引用发送人渲染与解析的单元测试：
 * buildQuotePart（有/无发送人行）+ resolveQuoteSender（entry 直挂 / store 命中 / store miss）。
 */
import { describe, it, expect } from 'vitest';
import type { RefEntry, ResolvedQuote } from '@tencent-connect/qqbot-nodejs';
import { buildMergedUserContent, buildQuotePart, buildUserContent, resolveQuoteSender } from './inbound.ts';
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

describe('buildQuotePart', () => {
  it('renders the sender line before the quoted text when a sender is provided', () => {
    const out = buildQuotePart(mkQuote({ refKey: 'r1', text: '被引用的原句' }), senderA);
    expect(out).toBe(
      '[Quoted message begins]\n' +
        `[Quoted sender: 甲 (${senderA.senderId})]\n` +
        '被引用的原句\n' +
        '[Quoted message ends]\n' +
        '[Current message]\n',
    );
  });

  it('emits no sender line when no sender is provided', () => {
    const out = buildQuotePart(mkQuote({ refKey: 'r2', text: '被引用的原句' }));
    expect(out).toBe('[Quoted message begins]\n被引用的原句\n[Quoted message ends]\n[Current message]\n');
  });

  it('falls back to the entry content when text is empty', () => {
    const out = buildQuotePart(mkQuote({ refKey: 'r3', source: 'store', entry: senderA, text: '' }));
    expect(out).toBe('[Quoted message begins]\nhi\n[Quoted message ends]\n[Current message]\n');
  });

  it('returns empty for a missing or empty quote', () => {
    expect(buildQuotePart(undefined)).toBe('');
    expect(buildQuotePart(mkQuote({ source: 'none', text: '' }))).toBe('');
  });

  it('falls back to the anonymous short id when the sender has no nickname', () => {
    const noName: RefEntry = { messageId: 'm-n', senderId: 'AB12CD34EF56AB12', content: 'c', timestamp: '1' };
    const out = buildQuotePart(mkQuote({ refKey: 'r4', text: 't' }), noName);
    expect(out).toContain('[Quoted sender: AB12CD34 (AB12CD34EF56AB12)]');
  });
});

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

describe('buildUserContent / buildMergedUserContent (merged-batch inlined attachment tags)', () => {
  const noopLog = { info() {}, error() {}, debug() {}, warn() {} };
  type Msg = Parameters<typeof buildUserContent>[0];
  type St = Parameters<typeof buildUserContent>[1];
  const msg = {
    content: 'hello',
    attachments: [{ content_type: 'image', url: 'u1' }],
  } as unknown as Msg;

  it('single message renders block-level tags', () => {
    expect(buildUserContent(msg, {} as St, noopLog)).toBe('hello\n[图片]');
  });

  it('merged survivor renders no block-level tags (inlined per source)', () => {
    expect(buildMergedUserContent(msg, {} as St, noopLog)).toBe('hello');
  });
});
