import {
  buildZCodeEndpointUrls,
  clientConfigReadOptionsSchema,
  parseClientConfigSnapshot,
  type ApiClient,
  type ClientConfigSnapshot,
} from "@zcode/shared";
import type { IClientConfigService } from "./clientConfig.js";

// 公开配置变更频率低，缓存一小时以减少启动和切换工作区时的重复请求。
const CACHE_TTL_MS = 60 * 60 * 1000;
// 单次抓取最多等待 15 秒；超时即中止，避免启动流程被弱网长时间挂起。
const REQUEST_TIMEOUT_MS = 15_000;

// 请求上下文描述公开配置的寻址维度：端点来源、应用版本与平台。
// 这些字段同时参与缓存键，任一变化都必须重新拉取，不能跨维度复用快照。
interface RequestContext {
  endpointOrigin: string;
  appVersion: string;
  platform: string;
}

// snapshot 与 expiresAt 表示已完成的缓存，pending 表示在途请求。
// 同一 key 的并发读取共享 pending，避免重复发起网络往返。
interface CacheEntry {
  snapshot?: ClientConfigSnapshot;
  expiresAt: number;
  pending?: Promise<ClientConfigSnapshot>;
}

/** 首期仅公开配置；账户灰度不得通过此实例或缓存复用。 */
export function createClientConfigService(dependencies: {
  apiClient: ApiClient;
  resolveRequestContext: () => RequestContext | Promise<RequestContext>;
}): IClientConfigService {
// 缓存按完整请求 URL（含查询参数）分桶，不同环境与版本互不干扰。
// 条目常驻内存但不主动清理：key 数量受端点与版本组合限制，规模可控。
  const entries = new Map<string, CacheEntry>();

// 发起一次公开配置抓取并与超时竞速；解析结果已通过共享 schema 校验。
// 失败一律抛出，是否降级由调用方决定，服务内部不吞掉异常。
  async function fetchSnapshot(url: URL): Promise<ClientConfigSnapshot> {
// 每次 fetchSnapshot 新建 AbortController，超时只影响本次请求。
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
// 超时 Promise 在触发时中止底层请求，并让竞速立即失败。
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Public client config request timed out"));
      }, REQUEST_TIMEOUT_MS);
// 定时器不阻止进程退出；部分运行时没有 unref，因此使用可选调用。
      timer.unref?.();
    });
// 成功、超时或解析失败都走同一收尾路径，保证定时器一定被清理。
    try {
// 请求与超时由 Promise.race 竞速，先完成者决定结果，另一方随后被丢弃。
      return await Promise.race([
        (async () => {
          const response = await dependencies.apiClient.request(url, {
            method: "GET",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Public client config HTTP ${response.status}`);
          // 设置中的 endpoint 可能在两次 await 之间变化；不能把新地址的响应缓存到旧地址。
          if (response.url && response.url !== url.toString()) {
            throw new Error("Public client config request context changed");
          }
          return parseClientConfigSnapshot(await response.json());
        })(),
        timedOut,
      ]);
// 清理未触发的定时器，避免它继续持有中止器与闭包引用。
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

// 对外只暴露 getSnapshot，缓存与请求细节保持内部可见。
  return {
// 默认读取缓存，调用方可传 forceRefresh 跳过有效期检查。
    async getSnapshot(options = {}) {
// options 先过 clientConfigReadOptionsSchema.parse，非法输入直接抛错而不是被静默忽略。
      const { forceRefresh } = clientConfigReadOptionsSchema.parse(options);
// 上下文由调用方注入，服务本身不依赖具体平台或设置存储。
      const context = await dependencies.resolveRequestContext();
// 端点由共享构造函数统一拼装，避免在此硬编码路径与来源规则。
      const url = new URL(
        "/api/v1/client/configs",
        buildZCodeEndpointUrls(context.endpointOrigin).origin,
      );
      url.searchParams.set("app_version", context.appVersion);
      url.searchParams.set("platform", context.platform);
// 以最终 URL 作为缓存键，查询参数内容与顺序共同决定是否命中。
      const key = url.toString();
// 先取出条目并立即回填，后续并发调用才能看到同一个 pending 状态。
// 未命中时用 expiresAt 为 0 的空条目占位，保证首次请求也能被共享。
      const entry = entries.get(key) ?? { expiresAt: 0 };
      entries.set(key, entry);
// 命中未过期缓存时返回深拷贝，调用方修改结果不会污染共享快照。
      if (!forceRefresh && entry.snapshot && entry.expiresAt > Date.now()) {
        return structuredClone(entry.snapshot);
      }
// 无在途请求时才发起抓取；已有 pending 则直接等待，合并同一 key 的并发读取。
      if (!entry.pending) {
        entry.pending = fetchSnapshot(url)
          .then((snapshot) => {
            entry.snapshot = snapshot;
            entry.expiresAt = Date.now() + CACHE_TTL_MS;
            return snapshot;
          })
          .finally(() => {
            entry.pending = undefined;
          });
      }
      return structuredClone(await entry.pending);
    },
  };
}
