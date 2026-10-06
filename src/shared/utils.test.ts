import { describe, it, expect } from 'vitest';
import { senderLine, senderTag } from './utils.ts';

describe('senderTag', () => {
  it('renders `<nickname> (<openid>)` when a nickname is present', () => {
    expect(senderTag('AB12CD34EF56AB12CD34EF56AB12CD34', '小美')).toBe(
      '小美 (AB12CD34EF56AB12CD34EF56AB12CD34)',
    );
  });

  it('falls back to the first 8 chars of openid when the nickname is undefined', () => {
    expect(senderTag('AB12CD34EF56AB12CD34EF56AB12CD34')).toBe(
      'AB12CD34 (AB12CD34EF56AB12CD34EF56AB12CD34)',
    );
  });

  it('keeps an empty-string nickname (?? semantics)', () => {
    expect(senderTag('AB12CD34EF56AB12CD34EF56AB12CD34', '')).toBe(
      ' (AB12CD34EF56AB12CD34EF56AB12CD34)',
    );
  });
});

describe('senderLine', () => {
  it('wraps the senderTag in brackets and appends the line', () => {
    expect(senderLine('AB12CD34EF56AB12CD34EF56AB12CD34', '小美', 'hello')).toBe(
      '[小美 (AB12CD34EF56AB12CD34EF56AB12CD34)] hello',
    );
  });

  it('keeps the space after the bracket for an empty line', () => {
    expect(senderLine('AB12CD34EF56AB12CD34EF56AB12CD34', '小美', '')).toBe(
      '[小美 (AB12CD34EF56AB12CD34EF56AB12CD34)] ',
    );
  });
});
