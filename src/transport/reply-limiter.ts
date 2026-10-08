/**
 * 被动回复限额管理（参考 openclaw-qqbot 的 reply-limiter）。
 *
 * QQ Bot 被动回复有限额：同一条消息只能被动回复 N 次，超时后不能再被动回复。
 * 消息在入站时经 seed() 登记：firstSeenAt = 消息到达网关的时刻，过期窗口
 * （scopeTtlMs/ttlMs）自到达时刻起算，与 QQ 平台被动回复窗口同锚
 * （各 scope 的窗口与次数数值在配置组装处声明，见 gateway/bootstrap.ts）。
 * record() 仅累计已被动回复的次数；限额耗尽或窗口过期时降级为主动消息
 * （proactive，不传 msgId）。未经入站登记的消息 id（如进程重启后残留的
 * 显式锚点）在首次 record() 时按当前时刻建账。
 */
import type { ChatScope } from '../types.ts';

export interface ReplyLimiterConfig {
  /** 每条消息最大被动回复次数（默认 4，供平台上限未公布的 scope 兜底，如频道）；scopeLimit 中对应 scope 的值优先 */
  limit?: number;
  /** 消息 ID 全局过期时间 ms（默认 1 小时）；scopeTtlMs 中对应 scope 的值优先 */
  ttlMs?: number;
  /** 按 scope 的消息 ID 过期时间 ms（QQ 平台被动回复窗口，自消息入站起算，数值在配置组装处声明） */
  scopeTtlMs?: Partial<Record<ChatScope, number>>;
  /** 按 scope 的最大被动回复次数（QQ 平台各 scope 上限，数值在配置组装处声明） */
  scopeLimit?: Partial<Record<ChatScope, number>>;
  /** 最大跟踪消息数（按登记顺序 FIFO 驱逐最旧，默认 10000） */
  maxTrackedMessages?: number;
}

export interface ReplyLimitResult {
  allowed: boolean;
  remaining: number;
  fallbackReason?: 'expired' | 'limit_exceeded';
}

interface TrackedMessage {
  /** 已被动回复次数（入站 seed 时为 0） */
  count: number;
  /** 首次登记时刻：入站 seed = 消息到达时刻；未登记 id 首次 record() = 建账时刻 */
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

  /**
   * 消息入站时登记：建立跟踪记录（count 从 0 起），过期窗口自到达时刻起算。
   * 重复登记同一 id 为幂等操作（保留首次登记时刻）。
   */
  public seed(messageId: string, atMs?: number): void {
    if (this.messages.has(messageId)) return;
    if (this.messages.size >= this.maxTracked) {
      const firstKey = this.messages.keys().next().value;
      if (firstKey !== undefined) this.messages.delete(firstKey);
    }
    this.messages.set(messageId, { count: 0, firstSeenAt: atMs ?? Date.now() });
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

  /** 记录一次被动回复（未登记的 id 按当前时刻建账，覆盖重启后残留的锚点） */
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
