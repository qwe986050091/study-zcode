// INV-01 只登记已授权的精确路径：守住位置 注册入口；改错故障 任意脚本可读任意文件。
// INV-02 非绝对路径直接拒绝：守住位置 入口判断；改错故障 相对路径被解析到主进程目录。
// INV-03 授权前先规范化路径：守住位置 解析调用；改错故障 符号链接绕过白名单。
// INV-04 授权带有效期：守住位置 时间戳比较；改错故障 陈旧授权长期有效。
// INV-05 过期条目按需清理：守住位置 清理调用；改错故障 授权表只增不减。
// INV-06 条目数设上限：守住位置 容量常量；改错故障 长会话下内存无界增长。
// INV-07 超限按最久未用淘汰：守住位置 淘汰实现；改错故障 高频路径被误删。
// INV-08 校验时复核真实路径：守住位置 二次解析；改错故障 路径被替换后仍放行。
// INV-09 校验时要求仍是普通文件：守住位置 文件类型判断；改错故障 目录或设备被当作媒体。
// INV-10 复核失败即撤销授权：守住位置 捕获分支；改错故障 失败后保留条目继续可用。
// INV-11 命中后刷新最近使用时间：守住位置 时间赋值；改错故障 常用路径被优先淘汰。
// INV-12 协议只注册一次：守住位置 弱集合去重；改错故障 重复注册后处理器互相覆盖。
// INV-13 特权方案必须在就绪前注册：守住位置 调用时机；改错故障 本地视频元数据读不到。
// INV-14 标准与流式特权同时开启：守住位置 特权对象；改错故障 拖拽进度失效。
// INV-15 其他特权方案并入同一次注册：守住位置 展开参数；改错故障 沙箱方案被后一次覆盖。
// INV-16 请求校验主机与路径：守住位置 双条件判断；改错故障 任意协议链接都能取文件。
// INV-17 校验失败返回统一错误码：守住位置 回调分支；改错故障 媒体栈一直等待响应。
// INV-18 复用原生文件加载器：守住位置 注册方式；改错故障 自造响应丢失分段读取。
//
// 模块职责：本地媒体预览的授权表与 LOCAL_MEDIA_PREVIEW_SCHEME 自定义协议注册。
// 状态所有权：授权表归 LocalMediaPreviewPathRegistry 实例，协议实例去重归模块级 installedProtocols 弱集合。
// 阅读顺序：先看授权与校验，再看方案特权，最后看请求处理。
import { realpath as fsRealpath } from "node:fs/promises";
import { realpathSync as fsRealpathSync, statSync as fsStatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { LOCAL_MEDIA_PREVIEW_SCHEME, buildLocalMediaPreviewUrl } from "@zcode/shared";

// LocalMediaPreviewSchemeRegistrar：只暴露特权注册这一个方法。
interface LocalMediaPreviewSchemeRegistrar {
  // registerSchemesAsPrivileged：Electron 只接受一次批量注册。
  registerSchemesAsPrivileged(
    // schemes：本协议与其他特权方案合并成一个数组。
    schemes: Array<{
      // scheme：方案名，必须与协议处理器注册的名字一致。
      scheme: string;
      // privileges：standard、stream 等布尔开关。
      privileges: Record<string, boolean>;
    }>,
  ): void;
}

// LocalMediaPreviewProtocolRequest：handler 只需读 url。
interface LocalMediaPreviewProtocolRequest {
  // url：形如 local-media-preview://local/preview?path=...。
  url: string;
}

// 响应只有两种：可交给 loader 的路径，或统一错误码。
type LocalMediaPreviewProtocolResponse = string | { error: number };

// LocalMediaPreviewProtocol：只声明 registerFileProtocol 的最小接口。
interface LocalMediaPreviewProtocol {
  // registerFileProtocol：复用 Chromium 原生 file loader 保留 Range。
  registerFileProtocol(
    // scheme：注册的协议名，须与特权注册同名。
    scheme: string,
    // handler：请求回调，同步给出路径或错误。
    handler: (
      // request：含原始 url，handler 自行解析 host 与 path。
      request: LocalMediaPreviewProtocolRequest,
      // callback：必须恰好调用一次，否则媒体栈一直等待。
      callback: (response: LocalMediaPreviewProtocolResponse) => void,
    ) => void,
  ): boolean;
}

// installedProtocols：按实例去重，同一 protocol 只装一次。
const installedProtocols = new WeakSet<object>();
// NET_ERR_INVALID_URL 取 Chromium 约定值 -300。
const NET_ERR_INVALID_URL = -300;

// LocalMediaPreviewPathRegistry：授权表的对外契约。
export interface LocalMediaPreviewPathRegistry {
  // authorize：登记绝对路径，返回规范化后的真实路径。
  authorize(path: string): Promise<string>;
  // isAuthorized：校验并刷新最近使用时间。
  isAuthorized(path: string): boolean;
  // clear：窗口关闭时整表丢弃。
  clear(): void;
}

// TTL 30 分钟：够一次预览，又不让陈旧授权长期有效。
const LOCAL_MEDIA_AUTHORIZATION_TTL_MS = 30 * 60 * 1000;
// 上限 256 条：超过后按 lastUsedAt 淘汰。
const LOCAL_MEDIA_AUTHORIZATION_MAX_ENTRIES = 256;

/**
 * Main 只登记 Host 已经通过 workspace/session/message/attachment 校验的精确文件。
 * 旧协议直接信任 renderer URL 中的绝对 path，导致任何 renderer 脚本都能读取任意文件。
 */
// 授权表按规范化路径存放；非绝对路径在入口即拒绝；写入时记录 expiresAt 与 lastUsedAt；超限时 evictLeastRecentlyUsed 淘汰最久未用条目；校验时复核 canonicalPath 与文件类型。
export function createLocalMediaPreviewPathRegistry(
  // dependencies：全部可注入，便于测试固定时钟与假 realpath。
  dependencies: {
    // isAbsolutePath：入口判定，非绝对路径直接拒绝。
    isAbsolutePath?: (path: string) => boolean;
    // realpath：授权时解析符号链接，默认 fs/promises 版。
    realpath?: (path: string) => Promise<string>;
    // realpathSync：校验时二次解析，必须与授权结果一致。
    realpathSync?: (path: string) => string;
    // isRegularFileSync：拒绝目录与设备文件。
    isRegularFileSync?: (path: string) => boolean;
    // now：时钟注入点，测试用它模拟过期。
    now?: () => number;
    // ttlMs：授权有效期，缺省 30 分钟。
    ttlMs?: number;
    // maxEntries：条目上限，缺省 256。
    maxEntries?: number;
  } = {},
): LocalMediaPreviewPathRegistry {
  // authorizedPaths：key 规范化路径，value 带过期与最近使用时间。
  const authorizedPaths = new Map<
    // key 用 string：key 是规范化后的绝对路径。
    string,
    { canonicalPath: string; expiresAt: number; lastUsedAt: number }
  // Map 泛型闭合：值类型是带两个时间戳的对象。
  >();
  // 永久 Set 会无界增长，且路径被替换为 symlink 后仍继续获得 file loader 权限。
  const isAbsolutePath = dependencies.isAbsolutePath ?? isAbsolute;
  // realpath 默认 fs/promises 版，授权路径必须异步解析。
  const realpath = dependencies.realpath ?? fsRealpath;
  // realpathSync 供校验使用，避免 isAuthorized 变成异步。
  const realpathSync = dependencies.realpathSync ?? fsRealpathSync;
  // isRegularFileSync 默认 statSync().isFile()，不跟随符号链接。
  const isRegularFileSync =
    dependencies.isRegularFileSync ?? ((path: string) => fsStatSync(path).isFile());
  // now 默认 Date.now，可被测试替换成递增时钟。
  const now = dependencies.now ?? Date.now;
  // ttlMs 来自常量 LOCAL_MEDIA_AUTHORIZATION_TTL_MS。
  const ttlMs = dependencies.ttlMs ?? LOCAL_MEDIA_AUTHORIZATION_TTL_MS;
  // maxEntries 来自常量 LOCAL_MEDIA_AUTHORIZATION_MAX_ENTRIES。
  const maxEntries = dependencies.maxEntries ?? LOCAL_MEDIA_AUTHORIZATION_MAX_ENTRIES;

  // pruneExpired：按当前时刻清理过期条目，读写前都要调用。
  const pruneExpired = (observedAt: number) => {
    // 遍历中删除 Map 条目安全：删除当前项不影响迭代器。
    for (const [path, entry] of authorizedPaths) {
      // expiresAt 比较用小于等于：到期即失效，不留边界宽限。
      if (entry.expiresAt <= observedAt) authorizedPaths.delete(path);
    }
  };

  // evictLeastRecentlyUsed：容量超限时反复淘汰最久未用。
  const evictLeastRecentlyUsed = () => {
    // while 而不是 if：一次可能超出多条。
    while (authorizedPaths.size > maxEntries) {
      // oldestPath 为 undefined 表示表为空，循环随即退出。
      let oldestPath: string | undefined;
      // oldestAccess 以正无穷起步，任何 lastUsedAt 都能刷新它。
      let oldestAccess = Number.POSITIVE_INFINITY;
      // 全表线性扫描 authorizedPaths：maxEntries 上限 256，开销可忽略。
      for (const [path, entry] of authorizedPaths) {
        // lastUsedAt 严格小于：并列最旧时保留先遇到的那条。
        if (entry.lastUsedAt < oldestAccess) {
          // oldestAccess 记录当前最小值，供后续比较。
          oldestAccess = entry.lastUsedAt;
          // oldestPath 与 oldestAccess 必须同步更新，否则会删错条目。
          oldestPath = path;
        }
      }
      // 空表兜底：oldestPath 为空就退出，防止死循环。
      if (!oldestPath) return;
      // 删除后重新判断 size，直到回到上限以内。
      authorizedPaths.delete(oldestPath);
    }
  };

  // 返回字面量对象：三个方法共享闭包内的 authorizedPaths。
  return {
    // authorize：唯一写入入口，返回 canonicalPath 供协议侧使用。
    async authorize(path) {
      // isAbsolutePath 为 false 直接抛错，不做任何路径拼接。
      if (!isAbsolutePath(path)) {
        // throw 而不是返回空：调用方必须显式处理拒绝。
        throw new Error("Local media preview path must be absolute");
      }
      // realpath 先规范化再登记，符号链接指向的目标才是被授权的路径。
      const canonicalPath = await realpath(path);
      // observedAt 只取一次，保证 expiresAt 与 lastUsedAt 同源。
      const observedAt = now();
      // 先 pruneExpired 再写入，避免表里同时存在新旧两条。
      pruneExpired(observedAt);
      // set：key 用 canonicalPath，重复授权覆盖旧条目。
      authorizedPaths.set(canonicalPath, {
        // canonicalPath 冗余存一份，校验时无需再解析。
        canonicalPath,
        // expiresAt 由 observedAt 加 ttlMs 得到。
        expiresAt: observedAt + ttlMs,
        // lastUsedAt 初次等于写入时刻。
        lastUsedAt: observedAt,
      });
      // 写完立刻调用 evictLeastRecentlyUsed，上限对调用方不可见。
      evictLeastRecentlyUsed();
      // 返回规范化路径：renderer 侧据此构造预览 URL。
      return canonicalPath;
    },
    isAuthorized(path) {
      // isAuthorized：只读校验，但会刷新 lastUsedAt。
      const observedAt = now();
      // 先 pruneExpired，避免把刚过期的条目判为可用。
      pruneExpired(observedAt);
      // 以传入 path 查表：调用方必须传 canonicalPath。
      const entry = authorizedPaths.get(path);
      // 未登记直接 false，不解析文件系统。
      if (!entry) return false;
      try {
        // realpathSync 二次复核：真实路径未变且 isRegularFileSync 仍为真才放行。
        if (realpathSync(path) !== entry.canonicalPath || !isRegularFileSync(path)) {
          // 复核失败即 delete 授权，防止路径被替换后继续可用。
          authorizedPaths.delete(path);
          // 返回 false 与删除同步完成，调用方无需再清理。
          return false;
        }
      } catch {
        // realpathSync 抛错（文件已删）同样撤销授权。
        authorizedPaths.delete(path);
        // 异常路径统一 false，不向协议层抛。
        return false;
      }
      // 命中后刷新 lastUsedAt，常用路径不会被优先淘汰。
      entry.lastUsedAt = observedAt;
      // 返回 true：协议处理器据此把路径交给原生 loader。
      return true;
    },
    clear() {
      // clear：窗口销毁时整表丢弃，防止跨窗口残留授权。
      authorizedPaths.clear();
    },
  };
}

/**
 * Electron 要求 privileged scheme 在 app ready 前注册。
 * 缺少 standard 时 Chromium 不会按标准 URL 处理文件尾读取，导致 moov 位于 mdat
 * 之后的 MP4 被误判为不可解码；standard 与 stream 共同保留本地视频的元数据读取和 seek。
 */
// LOCAL_MEDIA_PREVIEW_SCHEME 必须带 standard 与 stream 特权；additionalSchemes 并入同一次注册；该调用必须早于 app ready。
export function registerLocalMediaPreviewScheme(
  // protocol：Electron protocol 模块，这里只用到批量注册。
  protocol: LocalMediaPreviewSchemeRegistrar,
  // registerSchemesAsPrivileged 只能调用一次（后一次覆盖前一次），其他 privileged scheme
  // （如插件 UI 沙箱的 zcode-sandbox）必须在这同一次调用里一起注册。
  additionalSchemes: Array<{ scheme: string; privileges: Record<string, boolean> }> = [],
): void {
  // registerSchemesAsPrivileged 一次注册完：后一次会覆盖前一次。
  protocol.registerSchemesAsPrivileged([
    {
      // scheme 走共享常量，Host 与 renderer 拼 URL 用同一个值。
      scheme: LOCAL_MEDIA_PREVIEW_SCHEME,
      // standard 保证按标准 URL 解析，stream 保证可分段读取。
      privileges: { standard: true, secure: true, stream: true },
    },
    ...additionalSchemes,
  ]);
}

// 同一协议实例只注册一次；hostname 与 pathname 都要匹配；未授权路径统一返回 NET_ERR_INVALID_URL；注册失败必须直接抛错。
export function installLocalMediaPreviewProtocol(
  // protocol：提供 registerFileProtocol 的 Electron protocol。
  protocol: LocalMediaPreviewProtocol,
  // isPathAuthorized：授权表校验入口，未授权一律回错误码。
  options: { isPathAuthorized: (path: string) => boolean },
): void {
  // installedProtocols 已含同一实例直接返回：弱集合去重，防止处理器互相覆盖。
  if (installedProtocols.has(protocol)) return;
  // protocol.handle(Response) 在 Electron 41 中无法为本地音视频提供稳定的
  // seekable range，手工返回 Range 还会被媒体栈判为不可播放。复用原生 file loader，
  // 让 Chromium 处理 Range，同时仍只把校验后的音视频绝对路径交给 loader。
  const registered = protocol.registerFileProtocol(
    LOCAL_MEDIA_PREVIEW_SCHEME,
    (request, callback) => {
      try {
        // new URL 解析：host、pathname 与 query 一次取齐。
        const url = new URL(request.url);
        // path 缺失时退化为空串，后续校验必然失败。
        const path = url.searchParams.get("path") ?? "";
        // 三重校验缺一不可：host 与 path 都能被任意协议链接伪造，必须靠 isPathAuthorized 拒绝未授权路径。
        if (
          url.hostname !== "local" ||
          url.pathname !== "/preview" ||
          !options.isPathAuthorized(path)
        ) {
          // 统一错误码：不区分 host 错、路径错还是未授权。
          callback({ error: NET_ERR_INVALID_URL });
          // return：错误分支必须终止，不能落到 callback(path)。
          return;
        }
        // 通过校验才把绝对路径交给原生 loader。
        callback(path);
      } catch {
        // 解析异常（畸形 URL）同样回错误码，不向 Electron 抛。
        callback({ error: NET_ERR_INVALID_URL });
      }
    },
  );
  // registerFileProtocol 返回 false 必须抛错：静默失败会让预览空白。
  if (!registered) throw new Error("Failed to register local media preview protocol");
  // registered 为 true 才记入弱集合，失败可重试。
  installedProtocols.add(protocol);
}

// 转出 URL 构造函数：调用方不必再依赖 shared 包路径。
export { buildLocalMediaPreviewUrl };
