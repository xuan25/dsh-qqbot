/**
 * agent-prompt.ts 引用消息块与用户内容渲染的单元测试：
 * buildQuotePart（有/无发送人行）+ buildUserContent / buildMergedUserContent（合并批次内联附件标签）。
 */
import { describe, it, expect } from 'vitest';
import type { RefEntry, ResolvedQuote } from '@tencent-connect/qqbot-nodejs';
import { buildMergedUserContent, buildQuotePart, buildUserContent } from './agent-prompt.ts';

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
