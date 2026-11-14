// 云内容服务：把已发布内容包按「sha256 内容寻址 + 租约(lease)」落盘，再经 127.0.0.1 临时 HTTP 回放给页面，
// 既避开 file:// 绕过 CSP，也不把任意本地路径暴露给渲染进程。
// INV-01：磁盘 entry 只由 sha256 决定，同内容重复 prepare 命中同一 entry（守住：prepare → cache.acquire）。
// INV-02：仅当 leaseId 在 leases 集合内才回 200；release/dispose 必须先删集合再删目录（守住：请求处理/release/dispose）。
// INV-03：disposed 单向置位，dispose 返回前 pending 必须清空且所有租约已释放（守住：prepare/disposeAllAndWait）。
// 破坏 INV-02/03：已释放内容仍可执行，或 rm 与在途写盘竞争，留下残留目录。
import { createServer } from "node:http";
import { extname } from "node:path";
import { rm } from "node:fs/promises";
import { contentBundleSchema } from "@zcode/shared";
import type { ICloudContentService } from "#src/cloud-content/cloudContent.js";
import { createContentBundleCache } from "#src/cloud-content/contentBundleCache.js";
import type { createMarketingAssetRegistry } from "#src/marketing-touch/marketingAssetRegistry.js";

// [权衡] 用响应头 CSP 而不是页面 meta：头先于任何字节生效，内容包即使被篡改也无法内联提权；
// sandbox 只给 allow-scripts，同时禁掉导航、fetch 与同源存储读取。
const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
// 扩展名白名单而非 mime 库：不在表内直接 404，避免把 .map/.txt 当作可执行内容回放；
// 未知类型若回退 octet-stream，浏览器的内容嗅探会绕过这里的类型判断。
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

export function createCloudContentService(options: {
  cacheRoot: string;
  publishedAssets?: ReturnType<typeof createMarketingAssetRegistry>;
}): ICloudContentService & { disposeAllAndWait(): Promise<void> } {
// [并发] disposed 只由 dispose 单向写 true，读侧遍布请求处理与 prepare；
// 它不保护共享数据，只作为「拒绝新工作」的门闩，故单布尔量足够，无需原子结构。
  let disposed = false;
// 只有真正 acquire 过才允许删除 cacheRoot：多个窗口可能共享同一目录，
// 未使用缓存的实例若也 rm，会清掉别人正在服务的租约。
  let usedCache = false;
// lifetime 是缓存层 fetch/写盘的唯一取消源；dispose 先 abort 再等 pending，阻塞在网络上的 prepare 才能尽快退出。
  const lifetime = new AbortController();
// [资源] pending 记录尚未结算的 prepare；disposeAllAndWait 必须等全部落定，
// 否则 rm 会删掉某个操作正在写入的目录，或释放它刚登记的租约。
  const pending = new Set<Promise<unknown>>();
// leases 既是 HTTP 准入集合，也是 dispose 的兜底清单：
// 正常 release 先删集合再删磁盘，异常路径留下的租约由 dispose 统一补释放。
  const leases = new Set<string>();
// [失败路径] 缺少 publishedAssets 时 trusted 恒为 false，缓存层因此拒绝一切远程抓取，而不是退化成开放代理。
  const trusted = (url: URL) => options.publishedAssets?.allowsUrl(url) === true;
  const cache = createContentBundleCache({
    cacheRoot: options.cacheRoot,
    isTrustedUrl: trusted,
    signal: lifetime.signal,
  });
// 请求体用 async IIFE 包裹：createServer 不等待返回的 Promise，
// 必须显式 void 并在末尾 catch，否则一次 cache.read 失败就是未处理的 rejection。
  const server = createServer((request, response) => {
    void (async () => {
// [失败路径] 非 GET 与已销毁都回 404 而非 405：不向内容包泄露服务端状态，
// 也避免 HEAD/OPTIONS 触发缓存读或绕过后面的租约校验。
      if (disposed || request.method !== "GET") {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const [, leaseId, ...segments] = url.pathname.split("/");
// 约定路径为 /<leaseId>/<entry 相对路径>；先分段再 join，
// 保证 segment 内的编码斜杠不会被提前当成目录分隔符。
      if (!leaseId || !leases.has(leaseId)) {
        response.writeHead(404).end();
        return;
      }
      const path = decodeURIComponent(segments.join("/"));
// 扩展名先转小写再查表：缓存目录在 Windows 上可能产出 .HTML，按原样查表会 404，导致跨平台行为不一致。
      const mime = MIME[extname(path).toLowerCase()];
      if (!mime) {
        response.writeHead(404).end();
        return;
      }
// read 内部按租约解析真实路径并确认仍在租约目录内；
// HTTP 层不自行拼接文件系统路径，path traversal 检查只保留在一处。
      const content = await cache.read(leaseId, path);
      response
// no-store：URL 里的 leaseId 是短期凭证，不能被磁盘缓存复用；
// cross-origin 资源策略允许 sandbox iframe 取用，其余头收紧默认权限。
        .writeHead(200, {
          "Content-Type": mime,
          "Content-Length": content.length,
          "Content-Security-Policy": CSP,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
          "Cross-Origin-Resource-Policy": "cross-origin",
        })
        .end(content);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    });
  });
// [资源] 服务懒启动，端口交给内核分配（listen(0)）；缓存 Promise 而非 URL，
// 保证并发 prepare 只监听一次，不会出现端口泄漏或两次 bind 冲突。
  let listening: Promise<string> | undefined;
  function resourceOrigin() {
    listening ??= new Promise<string>((resolve, reject) => {
      server.once("error", reject);
// [权衡] 只绑 127.0.0.1：内容包与宿主同机，绑 0.0.0.0 会让局域网读到短期租约；
// 随机端口避免与用户其它服务冲突，也无法被外部预知。
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("cloud_content_address"));
          return;
        }
// [资源] unref 让服务不阻止进程退出；真正的关闭仍由 disposeAllAndWait 负责，漏掉这行会让测试挂住事件循环。
        server.unref();
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return listening;
  }
  return {
    async readPublishedMedia({ asset, kind }) {
      if (disposed || !options.publishedAssets) throw new Error("cloud_content_disabled");
      return options.publishedAssets.readMedia(asset, kind);
    },
// prepare 契约：成功返回的 leaseId 必须能被 release 恰好抵消一次；
// 任何抛错路径都要自行回滚已登记的租约，否则 dispose 会重复释放。
    async prepare({ bundle }) {
      const parsed = contentBundleSchema.parse(bundle);
      if (disposed) throw new Error("cloud_content_disposed");
      if (!options.publishedAssets?.allows({ src: parsed.url, sha256: parsed.sha256 }))
        throw new Error("cloud_content_source");
// 先建 Promise 再登记 pending：若先 await 后登记，dispose 的 allSettled 会漏掉这段窗口。
// 操作体内部的回滚顺序固定为「删集合 → release」，保证集合里的 leaseId 一定对应存在的目录。
      const operation = (async () => {
        usedCache = true;
// acquire 返回内容寻址后的 entry 与 cacheHit；同 sha256 的并发请求由缓存层去重，这里不假设互斥。
        const result = await cache.acquire(parsed);
// [并发] 先登记租约再返回 URL：登记晚于 URL 暴露会让首个请求命中未知 leaseId 而 404，表现为随机白屏。
        leases.add(result.leaseId);
// acquire 期间可能已经销毁：此刻必须释放刚拿到的租约并让 prepare 失败，
// 否则 URL 虽未返回，磁盘目录与计数会永久泄漏；
// 这里先删集合再 release，与 release() 的顺序一致，避免 HTTP 层接受一个正在被删的租约。
        if (disposed) {
          await cache.release(result.leaseId);
          leases.delete(result.leaseId);
          throw new Error("cloud_content_disposed");
        }
        try {
          const base = await resourceOrigin();
          return {
            leaseId: result.leaseId,
            cacheHit: result.cacheHit,
            url: `${base}/${result.leaseId}/${result.entry.split("/").map(encodeURIComponent).join("/")}`,
          };
        } catch (error) {
          leases.delete(result.leaseId);
          await cache.release(result.leaseId);
          throw error;
        }
      })();
      pending.add(operation);
      try {
        return await operation;
      } finally {
        pending.delete(operation);
      }
    },
    async release({ leaseId }) {
      leases.delete(leaseId);
      await cache.release(leaseId);
    },
// 关闭顺序不可交换：置门闩 → abort → 等操作 → 关服务 → 释放剩余租约 → 删根目录。
// 每一步都依赖前一步已静止；先删目录会让仍在读的请求拿到半截响应。
    async disposeAllAndWait() {
      disposed = true;
      lifetime.abort();
      await Promise.allSettled(pending);
      if (listening) {
        await listening.catch(() => undefined);
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      await Promise.all([...leases].map((leaseId) => cache.release(leaseId)));
      leases.clear();
      if (usedCache) await rm(options.cacheRoot, { recursive: true, force: true });
    },
  };
}
