/**
 * 引用解析存储共享模块
 *
 * quoteRef 中间件需要一个跨调用可访问的 RefIndexStore 实例：
 * - 入站处理器（inbound.ts）按 refKey 回查原消息发送人；
 * - concurrency-guard 把合并批次中不过 quoteRef 的
 *   非 survivor 消息补写入 store。
 *
 * 插件级共享单例（与 history-store.ts 同模式）；LRU 容量 500。
 */
import { MemoryRefIndexStore } from '@tencent-connect/qqbot-nodejs';
import type { RefIndexStore } from '@tencent-connect/qqbot-nodejs';

let _store: RefIndexStore | null = null;

/** 获取共享引用解析存储（单例） */
export function getQuoteStore(): RefIndexStore {
  if (!_store) _store = new MemoryRefIndexStore(500);
  return _store;
}
