/**
 * Agent prompt 组装 — 发给 dsh Agent 的 user message 各层渲染
 *
 * 层地图（由 inbound 的 assembleAgentBody 按序调度）：
 * - Layer 1: userContent（文本 + 语音行 + 附件类型标签）
 * - Layer 2: quotePart（引用消息块）
 * - Layer 3: userMessage（带发送人行，仅群聊）
 * - Layer 4: dynamicCtx（媒体元数据）
 * - Layer 5: agentBody（history + base 拼合）
 *
 * 内容原语（textPart/buildAttachmentTags/senderLine 等）在 shared/content-render.ts 与 shared/utils.ts；
 * 空消息门控、引用发送人回查（quote store）、路由判定在 inbound.ts。
 */
import type { Logger, RawAttachment } from '../types.ts';
import type { DownloadedFile } from './attachment.ts';
import {
  buildAttachmentTags,
  classifyContentType,
  isVoiceContentType,
  senderLine,
  senderTag,
  textPart,
  type MediaKind,
} from '../shared/index.ts';
import type { RefEntry, ResolvedQuote } from '@tencent-connect/qqbot-nodejs';

// ── 输入类型契约 ──

export interface ProcessedMessage {
  rawEventType: string;
  kind: 'c2c' | 'group';
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  groupOpenid?: string;
  msgType?: number;
  attachments?: RawAttachment[];
  [key: string]: unknown;
}

export interface HistoryEntry {
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  messageId: string;
}

export interface MentionState {
  wasMentioned?: boolean;
}

export interface MiddlewareState {
  /** 使用 SDK 根导出的 ResolvedQuote（{ refKey, source, entry?, rawContent?, attachments?, text }），不维护本地镜像类型 */
  quote?: ResolvedQuote;
  history?: HistoryEntry[];
  envelope?: string;
  mention?: MentionState;
  processedAttachments?: ProcessedAttachment[];
  downloadedFiles?: DownloadedFile[];
  downloadedQuoteFiles?: DownloadedFile[];
  /** content 为 defaultMerge 拼合的逐条渲染（逐条附件标签已内联其中，message.attachments 为拍平全量集合）。
   * true 时 inbound 走 buildMergedUserContent（不渲染块级附件标签）。 */
  contentIsMerged?: boolean;
  [key: string]: unknown;
}

export interface ProcessedAttachment {
  type: 'voice' | 'image' | 'video' | 'file' | 'unknown';
  filename?: string;
  url?: string;
  localPath?: string;
  voiceText?: string;
  voiceSource?: 'stt' | 'asr' | 'fallback';
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
}

// ── Layer 1: userContent ──

interface VoiceText {
  text: string;
  duration?: number;
  source: 'stt' | 'asr' | 'fallback';
}

function extractVoiceTexts(
  attachments?: RawAttachment[],
  processed?: ProcessedAttachment[],
  _logger?: Logger,
): VoiceText[] {
  const results: VoiceText[] = [];

  if (processed) {
    for (const pa of processed) {
      if (pa.type === 'voice' && pa.voiceText) {
        results.push({
          text: pa.voiceText,
          duration: pa.duration,
          source: pa.voiceSource ?? 'stt',
        });
      }
    }
  }

  if (results.length === 0 && attachments) {
    for (const att of attachments) {
      if (isVoiceContentType(att.content_type) && att.asr_refer_text) {
        results.push({
          text: att.asr_refer_text.trim(),
          source: 'asr',
        });
      }
    }
  }

  return results;
}

/** Layer 1 共享部分：文本 + 语音行（语音行依赖附件下载后的转写）。
 *  buildUserContent 与 buildMergedUserContent 共用，保证两形态的顺序（文本 → 语音行）一致。 */
function userContentParts(
  msg: ProcessedMessage,
  state: MiddlewareState,
  logger: Logger,
): string[] {
  const parts: string[] = [];

  const text = textPart(msg);
  if (text) {
    parts.push(text);
  }

  for (const vt of extractVoiceTexts(msg.attachments, state.processedAttachments, logger)) {
    const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
    parts.push(`[Voice message${durationTag}] ${vt.text}`);
  }

  return parts;
}

/** 单条消息：文本 + 语音行 + 附件类型标签（媒体路径由 buildDynamicCtx 提供，标签只提示「带了什么」）。 */
export function buildUserContent(msg: ProcessedMessage, state: MiddlewareState, logger: Logger): string {
  const parts = userContentParts(msg, state, logger);
  const attachmentTags = buildAttachmentTags(msg.attachments);
  if (attachmentTags) {
    parts.push(attachmentTags);
  }
  return parts.join('\n');
}

/** 合并 survivor：content 已含逐条内联渲染（文本 + 附件标签），
 *  块级只渲染文本 + 语音行（语音来自附件下载后的转写，对拍平附件集）。 */
export function buildMergedUserContent(msg: ProcessedMessage, state: MiddlewareState, logger: Logger): string {
  return userContentParts(msg, state, logger).join('\n');
}

// ── Layer 2: quotePart ──

/**
 * Layer 2: 引用消息块（提供 sender 时在引用文本前加一行发送人行）
 */
export function buildQuotePart(quote?: ResolvedQuote, sender?: RefEntry): string {
  if (!quote?.text && !quote?.entry?.content) return '';

  const quoteText = quote.text || quote.entry?.content || 'Original content unavailable';
  const senderPart = sender
    ? `\n[Quoted sender: ${senderTag(sender.senderId, sender.senderName)}]`
    : '';

  return `[Quoted message begins]${senderPart}\n${quoteText}\n[Quoted message ends]\n[Current message]\n`;
}

// ── Layer 3: userMessage ──

/**
 * Layer 3: 带发送者标签的用户消息
 */
export function buildUserMessage(
  userContent: string,
  quotePart: string,
  senderId: string,
  senderName: string | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
): string {
  if (!isGroup) {
    return `${quotePart}${userContent}`;
  }

  const mentionTag = wasMentioned ? ' (@you)' : '';
  return `${quotePart}${senderLine(senderId, senderName, userContent)}${mentionTag}`;
}

// ── Layer 4: dynamicCtx ──

/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
export function buildDynamicCtx(msg: ProcessedMessage, state: MiddlewareState): string {
  const lines: string[] = [];

  if (msg.attachments && msg.attachments.length > 0) {
    const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));
    const voices: RawAttachment[] = [];

    // 一次遍历归类 + 生成媒体行
    for (const att of msg.attachments) {
      const kind = classifyContentType(att.content_type);
      if (kind === 'voice') {
        voices.push(att);
        continue;
      }
      const d = downloadedByFilename.get(att.filename);
      lines.push(`- ${renderMediaLine(kind, att.filename, d?.localPath, att.url, att.size)}`);
    }

    // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
    if (voices.length > 0) {
      const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
      if (asrTexts.length > 0) {
        lines.push(`- ASR: ${asrTexts.join(' | ')}`);
      } else {
        const urls = voices.map(a => a.url).filter(Boolean);
        if (urls.length > 0) lines.push(`- Voice: ${urls.join(', ')}`);
      }
    }
  }

  // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
  const quoteAttachments = state.quote?.attachments;
  if (quoteAttachments && quoteAttachments.length > 0) {
    const downloadedQuote = new Map((state.downloadedQuoteFiles ?? []).map(d => [d.filename, d]));
    lines.push('[Reference attachments]');
    for (const qa of quoteAttachments) {
      const kind = classifyContentType(qa.contentType);
      const d = downloadedQuote.get(qa.filename ?? '');
      if (kind === 'voice') {
        if (qa.asrText) lines.push(`  - Voice: ${qa.asrText}`);
        continue;
      }
      lines.push(`  - ${renderMediaLine(kind, qa.filename, d?.localPath, qa.url, undefined)}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}

/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理（见 buildDynamicCtx）。
 */
function renderMediaLine(
  kind: Exclude<MediaKind, 'voice'>,
  filename: string | undefined,
  localPath: string | undefined,
  url: string | undefined,
  size: number | undefined,
): string {
  switch (kind) {
    case 'image':
      return localPath
        ? `Image: ${localPath}`
        : `Image: ${url ?? filename ?? 'image'}`;
    case 'video':
      return localPath
        ? `Video: ${localPath}`
        : `Video: ${filename ?? 'video'} (download failed)`;
    case 'file':
      return localPath
        ? `File: ${localPath}`
        : `File: ${filename ?? 'file'} (${formatFileSize(size ?? 0)})`;
  }
}

// ── Layer 5: agentBody ──

/**
 * Layer 5: 最终 agentBody 拼合
 */
export function buildAgentBody(
  base: string,
  history: HistoryEntry[] | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
): string {
  if (!isGroup || !wasMentioned || !history || history.length === 0) {
    return base;
  }

  const historyLines = history.map(h => senderLine(h.senderId, h.senderName, h.content));

  return [
    '[Chat history begins]',
    ...historyLines,
    '',
    '[Chat history ends]',
    '[Current message]',
    base,
  ].join('\n');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
