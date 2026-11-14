// WebFetch 进程内正文缓存（按入参 URL 原文做 key）。
//
// 缓存的是「已抽取、可直接复用」的正文及其元数据（CachedFetchContent），不是原始响应，
// 所以命中时不会再发起网络请求，也不会重放 HTTP 状态/响应头，只有落库过的 artifact 路径
// 会随条目复用。进程级单例，生命周期与 runtime 进程一致：跨 session 共享，但每次工具调用
// 仍各自独立计费与审计。只缓成功抽取的正文；重定向与 HTTP 错误是终态结果，不进入缓存
// （见 webfetch.ts 的落缓存位置），避免把一次性的失败状态固化 15 分钟。
//
// 内存上界由 CACHE_MAX_BYTES 维护：任何写入路径都必须同时更新 cacheBytes，否则淘汰会
// 提前停手或超卖预算。淘汰顺序按 Map 插入顺序，读命中会把条目重排到末尾（近似 LRU）。
import { CACHE_MAX_BYTES, CACHE_TTL_MS } from "./webfetch-constants.js";
import type { CachedFetchContent } from "./webfetch-types.js";

interface CacheEntry extends CachedFetchContent {
  expiresAt: number;
}

const fetchCache = new Map<string, CacheEntry>();
let cacheBytes = 0;

/**
 * 清空缓存并归零字节账本，仅供测试隔离使用。
 * 生产路径没有主动失效入口：条目只靠 TTL 过期与容量淘汰退出，因此需要「同一进程内
 * 第二次请求必须重新出网」的测试只能走这里。
 */
export function clearWebFetchCacheForTests(): void {
  fetchCache.clear();
  cacheBytes = 0;
}

/**
 * 按 URL 取缓存。命中返回条目（含内部 expiresAt 字段，调用方按 CachedFetchContent 读取即可），
 * 未命中或已过期返回 undefined。
 *
 * 副作用：过期条目会被就地删除并扣减字节账本；命中条目会先删后插以重排到 Map 末尾，
 * 使其在容量淘汰时更晚被选中。因此本函数不是纯查询，调用它本身就会改变淘汰顺序。
 * 返回的是共享对象引用，调用方不得原地修改其中的 content/redirects 等字段。
 */
export function getWebFetchCache(key: string): CachedFetchContent | undefined {
  const entry = fetchCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    fetchCache.delete(key);
    cacheBytes -= entry.sizeBytes;
    return undefined;
  }
  fetchCache.delete(key);
  fetchCache.set(key, entry);
  return entry;
}

/**
 * 写入/覆盖一个缓存条目，并顺带做一次过期清理与容量淘汰。
 *
 * 覆盖时先扣掉旧条目的 sizeBytes 再累加新值，保持账本与 Map 内容一致。单条超出总预算
 * 直接放弃缓存——注意是**早退而不是删掉旧条目**，所以一次超大的重新抓取不会把原有的
 * 小条目顺手清掉，后续请求仍能命中旧内容。
 *
 * 失败语义：本函数不抛错也不校验内容；写入代表一次成功抽取已经完成，缓存只是加速，
 * 写失败（例如条目过大）对调用方是静默降级——下一次同 URL 请求重新出网。
 */
export function putWebFetchCache(key: string, value: CachedFetchContent): void {
  if (value.sizeBytes > CACHE_MAX_BYTES) return;

  const previous = fetchCache.get(key);
  if (previous) {
    cacheBytes -= previous.sizeBytes;
  }

  fetchCache.set(key, {
    ...value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  cacheBytes += value.sizeBytes;
  pruneCache();
}

/**
 * 两阶段回收：先按 TTL 清掉所有过期条目，再按插入顺序淘汰最旧条目直到总量回到预算内。
 *
 * 先清过期是必要的：过期条目虽然不再可能命中，但仍占着 cacheBytes，不先释放就会把
 * 仍有效的条目误淘汰。只在 putWebFetchCache 末尾调用，所以「长期只读不写」的缓存不会
 * 主动缩容，但也不会继续增长。
 */
function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of fetchCache) {
    if (entry.expiresAt > now) continue;
    fetchCache.delete(key);
    cacheBytes -= entry.sizeBytes;
  }

  for (const [key, entry] of fetchCache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    fetchCache.delete(key);
    cacheBytes -= entry.sizeBytes;
  }
}
