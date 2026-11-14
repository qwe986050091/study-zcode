import { createHash } from "node:crypto";
import {
  marketingAssetSchema,
  type MarketingAsset,
  type MarketingTouchSnapshot,
  type MarketingVisual,
} from "@zcode/shared";

// 营销素材注册表：把宿主已验证的投放快照转成可下载的 data URL 白名单，供 Renderer 读图。
// INV-01：allowed 只由 allow()/visual()/accept() 写入，来源是宿主校验过的投放响应；
//         Renderer 传来的 src 未登记时，readMedia 必须在任何出网动作之前拒绝（守住：allows）。
//         破坏后果：等于把任意 URL 变成可读字节，内网探测与本地文件泄漏面对渲染进程直接开放。
// INV-02：缓存键是 kind + sha256，总量上限 48MB 且按插入序逐出；否则内存随投放量线性增长直至 OOM（守住：download 的 while）。
// INV-03：同 key 的并发读共用 pending 里的同一 Promise，finally 必须移除（守住：readMedia）。
//         破坏后果：一次失败被永久缓存成 rejected Promise，该素材之后再也读不出来。
/** 下载授权只来自宿主已验证的投放响应；Renderer 不能自行授权地址。 */
export function createMarketingAssetRegistry(
  options: { fetch?: typeof fetch; allowLoopback?: boolean } = {},
) {
// src -> 已授权 sha256 集合。用 Set 而不是单值，是为投放灰度期间新旧两张图并存，
// 避免切图瞬间正在展示的旧图被一次性判为未授权。
  const allowed = new Map<string, Set<string>>();
// size 记的是 data URL 字符长度而非原始字节：与 48MB 预算同单位，base64 的 4/3 膨胀已含在内。
  const cache = new Map<string, { data: string; size: number }>();
  const pending = new Map<string, Promise<string>>();
  let cacheBytes = 0;
// 登记入口。用 schema.parse 而非类型断言，是因为入参跨进程来自投放服务：
// 字段缺失必须在进白名单前失败，而不是等到下载时才发现 src 不是合法 URL。
  function allow(asset: MarketingAsset) {
    const parsed = marketingAssetSchema.parse(asset);
    const url = new URL(parsed.src);
    const loopback =
      options.allowLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
// [失败路径] 非 https 且未显式放行 loopback 的一律不登记，query 里的凭据型 URL 也不会进白名单；
// 调用方通过 allows() 能观察到未登记，因此静默丢弃不会掩盖投放配置错误。
    if (url.protocol !== "https:" && !loopback) return;
// [权衡] 512 个 src 用 FIFO 淘汰而不是 LRU：白名单只在启动和换投放时批量写入，
// 没有可利用的访问热点；FIFO 少维护一份访问序，代价是超长会话可能淘汰仍需要的旧素材。
    if (!allowed.has(parsed.src) && allowed.size >= 512)
      allowed.delete(allowed.keys().next().value!);
    const hashes = allowed.get(parsed.src) ?? new Set<string>();
// 同一 src 最多留 8 个历史 hash，覆盖多轮灰度换图，同时防止被反复登记撑爆内存。
    if (hashes.size >= 8) hashes.delete(hashes.values().next().value!);
    hashes.add(parsed.sha256);
    allowed.set(parsed.src, hashes);
  }
  function allows(asset: MarketingAsset) {
    return allowed.get(asset.src)?.has(asset.sha256) === true;
  }
  function visual(value?: MarketingVisual | null) {
    if (!value) return;
    if (value.type === "image") {
      allow(value.image.default);
      if (value.image.dark) allow(value.image.dark);
    }
// 视频必须同时放行正片与 fallback：否则解码失败回退时报错的是白名单，兜底等于不存在。
    if (value.type === "video") {
      allow(value.video.src);
      allow(value.video.fallback);
    }
    if (value.type === "bundle") {
      allow(value.bundle.bundle);
      if (value.bundle.fallback) allow(value.bundle.fallback);
    }
  }
// 唯一出网动作，调用前已由 readMedia 校验过白名单与 kind。
// redirect: error 阻止 30x 把请求引向未登记地址；credentials: omit 保证不带宿主 Cookie；
// 30s 超时防止慢速服务长期占住 pending，把同 key 的其他读者一起拖住。
  async function download(asset: MarketingAsset, kind: "image" | "video") {
    const response = await (options.fetch ?? fetch)(asset.src, {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(30_000),
    });
// [失败路径] 非 2xx 或无 body 统一抛固定错误码，不透传 response.status：
// 上层只按 code 分支，透传会把外部服务细节带进 UI 文案。
    if (!response.ok || !response.body) throw new Error("marketing_asset_download");
// 图片 8MB / 视频 16MB 是投放侧合同上限。按 kind 分开而不是取最大值，
// 是为了让标错类型的素材在体积阶段就失败，而不是解出整段 data URL 后才被嗅探拒绝。
    const limit = (kind === "image" ? 8 : 16) * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("marketing_asset_size");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
// 哈希比对是白名单之外的第二道闸：即便 src 曾被授权，内容也必须等于登记时的 sha256，
// 防止同一地址被 CDN 回源改写或缓存污染后替换成别的字节。
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error("marketing_asset_integrity");
    const mime =
      kind === "video"
        ? bytes.toString("ascii", 4, 8) === "ftyp"
          ? "video/mp4"
          : undefined
        : bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
          ? "image/png"
          : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
            ? "image/jpeg"
            : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
              ? "image/webp"
              : undefined;
// 只认 png/jpeg/webp/mp4 魔数，未识别一律拒绝：SVG 与 HTML 可携带脚本，不能进 data URL。
    if (!mime) throw new Error("marketing_asset_type");
    const data = `data:${mime};base64,${bytes.toString("base64")}`;
// [资源] 按插入序逐出直到装得下新条目。必须先扣 cacheBytes 再删条目，
// 保证任何时刻 cacheBytes 都等于各条 size 之和；否则预算会单调漂移，最终永远写不进新数据。
    while (cacheBytes + data.length > 48 * 1024 * 1024 && cache.size) {
      const oldest = cache.keys().next().value!;
      cacheBytes -= cache.get(oldest)!.size;
      cache.delete(oldest);
    }
    cache.set(`${kind}:${asset.sha256}`, { data, size: data.length });
    cacheBytes += data.length;
    return data;
  }
  return {
    allow,
    allows,
    allowsUrl: (url: URL) => allowed.has(url.href),
// 批量写入白名单的唯一入口。banner 与 popup 两种投放结构互斥，按 resource_position 二选一，
// 而不是两边的 visual 都读，避免把本次不生效的那份也授权出去。
    accept(snapshot: MarketingTouchSnapshot) {
      for (const delivery of snapshot.deliveries) {
        if (delivery.resource_position === "banner") {
          visual(delivery.banner.background);
          visual(delivery.banner.success_popup?.hero);
        } else visual(delivery.popup.hero);
      }
    },
// 对 Renderer 暴露的读入口。必须先 parse 再查白名单：顺序反了的话，
// 未通过 schema 的畸形 src 会先进入 allows，成为探测白名单键的手段。
    async readMedia(input: MarketingAsset, kind: "image" | "video") {
      const asset = marketingAssetSchema.parse(input);
      if (!allows(asset)) throw new Error("marketing_asset_source");
      if (kind !== "image" && kind !== "video") throw new Error("marketing_asset_type");
      const key = `${kind}:${asset.sha256}`;
      const cached = cache.get(key);
      if (cached) return cached.data;
// [并发] 同一 key 已有在途下载时直接复用，避免多个视图同时各拉一份 16MB。
      const existing = pending.get(key);
      if (existing) return existing;
      const promise = download(asset, kind);
      pending.set(key, promise);
      try {
        return await promise;
      } finally {
// [资源] 无论成功还是失败都移除在途记录：残留会让失败的 Promise 永久驻留，
// 后续同素材的读取全部立刻 reject，同时 pending 本身变成新的泄漏点。
        pending.delete(key);
      }
    },
  };
}
