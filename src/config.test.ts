import { describe, it, expect } from 'vitest';
import Schema from '@deepseek-ai/schemastery';
import { ConfigSchema } from './config.ts';

/** 无默认值的必填字段由输入提供；两个工具展示开关刻意缺省，验证 schema 默认回填 */
const requiredInput = {
  provider: 'p',
  model: 'm',
  preset: 'pr',
  cwd: '/tmp',
  groupPrompt: '',
  directPrompt: '',
};

describe('ConfigSchema 工具展示开关默认值', () => {
  it('缺省 showToolResults / showToolErrors 时回填 schema 默认', () => {
    const [value] = Schema.resolve({ ...requiredInput }, ConfigSchema, {});

    expect(value.showToolResults).toBe(false);
    expect(value.showToolErrors).toBe(true);
  });

  it('显式值优先于默认', () => {
    const [value] = Schema.resolve(
      { ...requiredInput, showToolResults: true, showToolErrors: false },
      ConfigSchema,
      {},
    );

    expect(value.showToolResults).toBe(true);
    expect(value.showToolErrors).toBe(false);
  });
});
