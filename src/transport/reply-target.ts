/**
 * 出站回复目标解析与发送 — 被动回复三级兜底 + msg_id/event_id 区分。
 *
 * 从 gateway 层抽离，保持 bootstrap 只做组装。三级兜底：
 *   1. 优先显式 target.msgId；
 *   2. 超频/过期后，用缓存里「最近一条未超频未过期」的 target；
 *   3. 全部候选都超频/过期，才降级为主动推送（proactive）。
 * 另有 sendMarkdownWithFallback：平台拒绝被动锚点（过期/超限）时去除
 * msg_id/event_id 按主动消息重发一次，避免回复内容丢失。
 */
import { ApiError, MsgType, QQBot } from '@tencent-connect/qqbot-nodejs';
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { Logger, ReplyTarget } from '../types.ts';
import { getCachedReplyIds } from './msgid-cache.ts';
import type { CachedReplyId } from './msgid-cache.ts';
import type { ReplyLimiter } from './reply-limiter.ts';

/**
 * 解析被动回复目标。
 *
 * @param allowEvent 是否允许返回互动事件 eventId。markdown 发送支持 event_id
 *   （bot.send 的 extra），传 true；文件发送 SDK 暂不支持 event_id，传 false
 *   跳过 event 候选，降级为 msg 候选或主动推送。
 */
export function resolveReplyTarget(
  target: ReplyTarget,
  limiter: ReplyLimiter,
  allowEvent: boolean,
): ReplyTarget {
  const candidates: CachedReplyId[] = [];
  if (target.msgId) candidates.push({ kind: 'msg', id: target.msgId });
  for (const c of getCachedReplyIds(target.scope, target.targetId)) {
    candidates.push(c);
  }

  for (const c of candidates) {
    if (c.kind === 'event' && !allowEvent) continue;
    if (limiter.checkLimit(c.id, target.scope).allowed) {
      limiter.record(c.id);
      if (c.kind === 'event') {
        return { ...target, msgId: undefined, eventId: c.id };
      }
      return { ...target, msgId: c.id, eventId: undefined };
    }
  }

  return { ...target, msgId: undefined, eventId: undefined };
}

/**
 * 发送 markdown：区分 msg_id 与 event_id。
 * 带 eventId 时通过 bot.send 的 extra 填 event_id（SDK sendMarkdown 不支持）；
 * 否则走 sendMarkdown 填 msg_id。
 */
export function sendResolvedMarkdown(
  bot: QQBot,
  target: ReplyTarget,
  content: string,
  opts?: { keyboard?: InlineKeyboard },
): Promise<unknown> {
  if (target.eventId) {
    return bot.send({
      target: { scope: target.scope, targetId: target.targetId, msgId: undefined },
      msgType: MsgType.MARKDOWN,
      markdown: { content },
      keyboard: opts?.keyboard,
      extra: { event_id: target.eventId },
    });
  }
  return bot.sendMarkdown(target, content, opts);
}

/**
 * 平台拒绝被动锚点（msg_id/event_id 不可用）的业务错误码。
 * 来源：QQ 开放平台「发送单聊消息」「发送群聊消息」错误码表：
 * 304103 消息ID已过期；40034005 被回复消息 msg_id 已过期；
 * 40034024 msg_id 无效或超出范围；40034025 event_id 无效；
 * 40034026 event_id 已过期；40034027 该事件不支持回复消息；
 * 40034128 被动回复时间或次数超限。
 */
export const PASSIVE_REPLY_REJECTED_CODES: ReadonlySet<number> = new Set([
  304103, 40034005, 40034024, 40034025, 40034026, 40034027, 40034128,
]);

/** 判断错误是否为「被动锚点被平台拒绝」（用于触发主动重发） */
export function isPassiveReplyRejected(err: unknown): boolean {
  return (
    err instanceof ApiError
    && typeof err.bizCode === 'number'
    && PASSIVE_REPLY_REJECTED_CODES.has(err.bizCode)
  );
}

/**
 * 发送 markdown 回复（带平台拒绝兜底）。
 *
 * 先经 resolveReplyTarget 解析被动锚点；若平台拒绝该锚点（过期/超限/无效），
 * 去除 msg_id/event_id 后按主动消息重发一次，避免回复内容丢失。
 * 其他错误原样抛出。
 */
export function sendMarkdownWithFallback(
  bot: QQBot,
  target: ReplyTarget,
  limiter: ReplyLimiter,
  content: string,
  opts?: { keyboard?: InlineKeyboard },
  logger?: Logger,
): Promise<unknown> {
  const resolved = resolveReplyTarget(target, limiter, true);
  return sendResolvedMarkdown(bot, resolved, content, opts).catch((err: unknown) => {
    if (isPassiveReplyRejected(err) && (resolved.msgId !== undefined || resolved.eventId !== undefined)) {
      logger?.warn(`im-qqbot: passive reply rejected (code=${(err as ApiError).bizCode}), resending as proactive`);
      return sendResolvedMarkdown(bot, { scope: resolved.scope, targetId: resolved.targetId }, content, opts);
    }
    return Promise.reject(err);
  });
}
