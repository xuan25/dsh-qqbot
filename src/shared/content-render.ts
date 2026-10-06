/**
 * 内容渲染原语 — 消息「单独进来」形态（文本 + 附件类型标签）与 content_type 分类器。
 *
 * 纯函数 + 结构类型，不依赖 transport/middleware；
 * 合并批次逐条渲染（middleware concurrency-guard）与单条消息 userContent 渲染
 * （transport inbound）共用本模块。
 */

/** 附件归类（QQ 网关的 content_type 是 MIME 类型，如 image/png、video/mp4、audio/silk） */
export type MediaKind = 'image' | 'video' | 'voice' | 'file';

/** 是否为图片（兼容裸值 'image' 与 MIME 'image/png'） */
export function isImageContentType(contentType?: string): boolean {
  return contentType === 'image' || contentType?.startsWith('image/') === true;
}

/** 是否为视频（兼容裸值 'video' 与 MIME 'video/mp4'） */
export function isVideoContentType(contentType?: string): boolean {
  return contentType === 'video' || contentType?.startsWith('video/') === true;
}

/** 是否为语音（兼容裸值 'voice' 与 MIME 'audio/silk'） */
export function isVoiceContentType(contentType?: string): boolean {
  return contentType === 'voice' || contentType?.startsWith('audio/') === true;
}

/** 归类附件 content_type 为统一类型 */
export function classifyContentType(contentType?: string): MediaKind {
  if (isImageContentType(contentType)) return 'image';
  if (isVideoContentType(contentType)) return 'video';
  if (isVoiceContentType(contentType)) return 'voice';
  return 'file';
}

/** 消息文本的 trim 形态；无 content 时为空串。 */
export function textPart(msg: { content?: string }): string {
  return (msg.content ?? '').trim();
}

/**
 * 附件类型标签（Layer 1 用户消息主体里的轻量提示）。
 * 只标注「带了什么类型的附件」，去重；媒体本地路径在 buildDynamicCtx 提供。
 */
export function buildAttachmentTags(
  attachments?: ReadonlyArray<{ content_type: string }>,
): string {
  if (!attachments || attachments.length === 0) return '';

  const labels: Record<string, string> = {
    image: '[图片]',
    video: '[视频]',
    file: '[文件]',
  };

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const att of attachments) {
    const kind = classifyContentType(att.content_type);
    if (kind === 'voice' || seen.has(kind)) continue;
    seen.add(kind);
    const label = labels[kind];
    if (label) tags.push(label);
  }

  return tags.join(' ');
}

/**
 * Layer 1 内容骨架：文本 + 附件类型标签（语音行不含——语音依赖附件下载后的转写，
 * 合并时机不可按源渲染，由 survivor 续链补充）。
 * 用于合并批次的逐条渲染，保证每条源消息与其「单独进来」形态一致。
 * 参数取最小结构，SDK InboundMessage 与 ProcessedMessage 均可直接传入。
 */
export function buildContentSkeleton(
  msg: { content?: string; attachments?: ReadonlyArray<{ content_type: string }> },
): string {
  const parts: string[] = [];

  const text = textPart(msg);
  if (text) {
    parts.push(text);
  }

  const attachmentTags = buildAttachmentTags(msg.attachments);
  if (attachmentTags) {
    parts.push(attachmentTags);
  }

  return parts.join('\n');
}
