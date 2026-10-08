/**
 * 被动回复限额管理（参考 openclaw-qqbot 的 reply-limiter）。
 *
 * QQ Bot 被动回复有限额：同一条消息只能被动回复 N 次，超时后不能再被动回复。
 * 过期窗口与回复次数上限由 ReplyLimiterConfig 按 scope 配置
 * （QQ 平台各 scope 的窗口与次数数值在配置组装处声明，见 gateway/bootstrap.ts）。
 * 当限额耗尽或消息过期时，应降级为主动消息（proactive，不传 msgId）。
 */
import type { ChatScope } from '../types.ts';

export interface ReplyLimiterConfig {
  /** 每条消息最大被动回复次数（默认 4，留 1 次余量）；scopeLimit 中对应 scope 的值优先 */
  limit?: number;
  /** 消息 ID 全局过期时间 ms（默认 1 小时）；scopeTtlMs 中对应 scope 的值优先 */
  ttlMs?: number;
  /** 按 scope 的消息 ID 过期时间 ms（QQ 平台被动回复窗口，数值在配置组装处声明） */
  scopeTtlMs?: Partial<Record<ChatScope, number>>;
  /** 按 scope 的最大被动回复次数（QQ 平台各 scope 上限，数值在配置组装处声明） */
  scopeLimit?: Partial<Record<ChatScope, number>>;
  /** 最大跟踪消息数（LRU 驱逐，默认 10000） */
  maxTrackedMessages?: number;
}

export interface ReplyLimitResult {
  allowed: boolean;
  remaining: number;
  fallbackReason?: 'expired' | 'limit_exceeded';
}

interface TrackedMessage {
  count: number;
  firstSeenAt: number;
}

export class ReplyLimiter {
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly scopeTtlMs?: Partial<Record<ChatScope, number>>;
  private readonly scopeLimit?: Partial<Record<ChatScope, number>>;
  private readonly maxTracked: number;
  private readonly messages = new Map<string, TrackedMessage>();

  public constructor(config?: ReplyLimiterConfig) {
    this.limit = config?.limit ?? 4;
    this.ttlMs = config?.ttlMs ?? 3_600_000;
    this.scopeTtlMs = config?.scopeTtlMs;
    this.scopeLimit = config?.scopeLimit;
    this.maxTracked = config?.maxTrackedMessages ?? 10_000;
  }

  /** 回复次数上限：scopeLimit 对应 scope 优先，否则取全局 limit */
  private limitFor(scope?: ChatScope): number {
    const perScope = scope !== undefined ? this.scopeLimit?.[scope] : undefined;
    return perScope ?? this.limit;
  }

  /** 过期时间：scopeTtlMs 对应 scope 优先，否则取全局 ttlMs（默认 1 小时） */
  private ttlFor(scope?: ChatScope): number {
    const perScope = scope !== undefined ? this.scopeTtlMs?.[scope] : undefined;
    return perScope ?? this.ttlMs;
  }

  /** 检查是否允许对指定消息继续被动回复 */
  public checkLimit(messageId: string, scope?: ChatScope): ReplyLimitResult {
    const now = Date.now();
    const tracked = this.messages.get(messageId);
    const limit = this.limitFor(scope);

    if (!tracked) {
      return { allowed: true, remaining: limit };
    }

    if (now - tracked.firstSeenAt > this.ttlFor(scope)) {
      this.messages.delete(messageId);
      return { allowed: false, remaining: 0, fallbackReason: 'expired' };
    }

    const remaining = Math.max(0, limit - tracked.count);
    if (remaining <= 0) {
      return { allowed: false, remaining: 0, fallbackReason: 'limit_exceeded' };
    }

    return { allowed: true, remaining };
  }

  /** 记录一次被动回复 */
  public record(messageId: string): void {
    const now = Date.now();
    const tracked = this.messages.get(messageId);

    if (tracked) {
      tracked.count += 1;
      return;
    }

    if (this.messages.size >= this.maxTracked) {
      const firstKey = this.messages.keys().next().value;
      if (firstKey !== undefined) this.messages.delete(firstKey);
    }
    this.messages.set(messageId, { count: 1, firstSeenAt: now });
  }
}
