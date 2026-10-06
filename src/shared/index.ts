/**
 * 共享工具层
 */
export { getProfileDir, resolveEnv, formatRelativeTime, buildUserAgent, PLUGIN_VERSION, senderTag, senderLine } from './utils.ts';
export {
  textPart,
  classifyContentType,
  isVoiceContentType,
  buildAttachmentTags,
  buildContentSkeleton,
  type MediaKind,
} from './content-render.ts';
export { getScopePeer } from './scope.ts';
export { sendMarkdownChunked } from './send-helper.ts';
