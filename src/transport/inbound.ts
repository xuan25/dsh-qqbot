/**
 * 入站处理器 — 经 SDK 中间件链处理后的消息 → dsh Agent followup
 *
 * 职责：会话获取/创建、空消息门控、引用发送人回查（quote store）、
 * Layer 1–5 组装调度（各层渲染在 agent-prompt.ts，内容原语在 shared/content-render.ts）、
 * 路由判定（steer/followup）、followup 发送。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger, RawAttachment, ReplyTarget } from '../types.ts';
import { clearGroupHistory } from '../features/history-store.ts';
import { getQuoteStore } from '../features/quote-store.ts';
import {
  buildAgentBody,
  buildDynamicCtx,
  buildMergedUserContent,
  buildQuotePart,
  buildUserContent,
  buildUserMessage,
  type MiddlewareState,
  type ProcessedMessage,
} from './agent-prompt.ts';
import type { MiddlewareContext, RefEntry, ResolvedQuote } from '@tencent-connect/qqbot-nodejs';

// ── 主处理函数 ──

/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(
  ctx: MiddlewareContext,
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  const msg = ctx.message as unknown as ProcessedMessage;
  const mwState = ctx.state as MiddlewareState;
  const { bot } = ctx;

  const scope: ChatScope = msg.kind === 'group' ? 'group' : 'c2c';
  const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;

  const replyTarget: ReplyTarget = {
    scope,
    targetId: peerId,
    msgId: msg.messageId,
  };

  // ── 获取或创建会话 ──
  let record;
  try {
    record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
  } catch (err) {
    logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
    // 兜底回复：会话创建失败时告知用户，避免静默无响应
    try {
      await bot.sendMarkdown(replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。');
    } catch (sendErr) {
      logger.error(`fallback reply failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
    }
    return;
  }

  // ── 构建 UserMessage → followup ──
  // ── 路由判定 ──
  const wasMentioned = mwState.mention?.wasMentioned === true;
  const agentStatus = record.agent.status;
  const route = decideRoute(scope, agentStatus, wasMentioned);
  const omitHistory = route === 'steer'; // steer 时不带历史，followup 时带历史

  // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
  const agentBody = await assembleAgentBody(msg, mwState, scope, omitHistory, logger);

  if (!agentBody) return;

  logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);

  const content: ContentBlock[] = [{ type: 'text' as const, text: agentBody }];

  const message = createUserMessage({
    content,
    source: { kind: 'user' as const },
  });

  if (route === 'steer') {
    record.agent.steer(message);
    logger.info(`→ steer sent: key=${scope}:${peerId}`);
  }
  else {
    record.agent.followup(message);
    logger.info(`→ followup sent: key=${scope}:${peerId}`);
  }

  // 群消息回复后清空历史缓存（避免下次 @ 时重复组包）
  if (scope === 'group') {
    clearGroupHistory(config.appId, msg.groupOpenid ?? msg.senderId);
  }

  // 阻塞等待本轮 turn 收敛，避免后续消息在 turn 运行期间被 followup 打断
  try {
    await record.agent.whenIdle();
  } catch (err) {
    logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ══════════════════════════════════════════════════════════════
// Body Assembly（5 层组装，各层渲染在 agent-prompt.ts）
// ══════════════════════════════════════════════════════════════

/**
 * 组装 agentBody — AI 实际看到的完整上下文
 */
async function assembleAgentBody(
  msg: ProcessedMessage,
  state: MiddlewareState,
  scope: ChatScope,
  omitHistory: boolean,
  logger: Logger,
): Promise<string | null> {
  const isGroup = scope === 'group';
  const wasMentioned = state.mention?.wasMentioned ?? false;

  // 合并 survivor 的 content 已含逐条内联渲染，走 buildMergedUserContent（无块级附件标签）
  const userContent = state.contentIsMerged
    ? buildMergedUserContent(msg, state, logger)
    : buildUserContent(msg, state, logger);

  if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned)) return null;

  // 发送人行仅群聊生效：c2c 不解析引用发送人（无发送人行）
  const quoteSender = isGroup ? await resolveQuoteSender(state.quote) : undefined;
  const quotePart = buildQuotePart(state.quote, quoteSender);
  const userMessage = buildUserMessage(userContent, quotePart, msg.senderId, msg.senderName, isGroup, wasMentioned);

  const dynamicCtx = buildDynamicCtx(msg, state);

  const base = dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
  if (omitHistory) return base;
  const agentBody = buildAgentBody(base, state.history, isGroup, wasMentioned);

  return agentBody;
}

/**
 * 判断消息是否为空：无文本/语音/附件，且非群聊 @。
 * 群聊被 @ 视为有效触发信号，即使内容为空也保留给 agent。
 */
function isEmptyMessage(
  userContent: string,
  attachments: RawAttachment[] | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
): boolean {
  if (userContent) return false;
  if (attachments && attachments.length > 0) return false;
  if (isGroup && wasMentioned) return false;
  return true;
}

/**
 * 解析被引用原消息的发送人：优先取 quote.entry（SDK 解析时直挂），
 * 否则按 refKey 回查插件共享 quote store（与 quoteRef 写入同一实例），
 * miss 返回 undefined（不捏造发送人）。导出供单元测试。
 */
export async function resolveQuoteSender(quote?: ResolvedQuote): Promise<RefEntry | undefined> {
  if (!quote) return undefined;
  if (quote.entry) return quote.entry;
  if (!quote.refKey) return undefined;
  return await getQuoteStore().get(quote.refKey);
}

// ══════════════════════════════════════════════════════════════
// 路由
// ══════════════════════════════════════════════════════════════

function decideRoute(scope: 'c2c' | 'group', status: 'idle' | 'running', wasMentioned: boolean): 'steer' | 'followup' {
  // agent running 中 c2c 或（群内被@）⇒ 即时 steer（next-step）
  // 其余 ⇒ followup（next-turn）
  if (status === 'running' && (scope === 'c2c' || wasMentioned)) return 'steer';
  return 'followup';
}
