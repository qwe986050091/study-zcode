// INV-01 三个类型别名全部由 IZCodeTaskService 的方法签名经 Parameters 推导；守住它：文件顶部的 GetTaskSnapshotParams、Result、WithEtagParams。手写参数副本后，接口新增字段不会报错，缓存键会静默漏维度。
// INV-02 [资源] 代理缓存、并发表、快照缓存三张 WeakMap 都以 service 实例为键；守住它：模块顶部的三处声明。改成按 workspacePath 索引会让本地与远程服务共用分片，快照串台且实例无法回收。
// INV-03 [失败路径] service 不是对象时原样返回，不返回空实现；守住它：useZCodeTaskService 开头的 typeof 校验。伪造成可调用对象会把失败推迟到更深层的 RPC，报错现场丢失。
// INV-04 [并发] 同一 service、同一去重键的并发请求必须合流到 inflight 中的同一个 Promise；守住它：get trap 内的 existing 分支。去掉后首屏多个 hook 会各发一次快照 RPC，relay 重复承接大 JSON。
// INV-05 [并发] inflight 的清理只在 finally 中、且必须先确认条目仍是本次 Promise；守住它：finally 里的恒等比较。无条件删除会把后发请求的条目抹掉，重复 RPC 重新出现。
// INV-06 [权衡] 去重键必须含 clientMode、resumeModelPolicy、model、thoughtLevel 四个维度；守住它：buildSnapshotDedupeKey 的四处默认值回退。删任一项都会让桌面连续链路与手机可重放链路复用同一份快照。
// INV-07 [并发] ifNoneMatch 只在本地已有 etag 时随请求发出；守住它：参数展开处的 etag 条件。恒定携带会让无缓存的首次请求也进入 notModified 分支，多付一次硬拉取。
// INV-08 [失败路径] notModified 但缓存里没有正文时必须再硬拉一次；守住它：fallbackResult 分支。直接把 notModified 上抛会让首屏拿到空快照，界面显示成无任务。
// INV-09 成功响应但正文为空时要同时删除内存与持久化条目；守住它：snapshot 为空的 else 分支。只删内存，重启后会把已删除任务的旧快照从 localStorage 复活。
// INV-10 [事务] 写路径顺序是内存、剪枝、落盘，且每次落盘写全量数组；守住它：writePersistedSnapshotEntry 尾部的调用次序。先落盘会把待淘汰条目一起序列化，放大写入量。
// INV-11 [资源] 单条序列化超过 256KB 的快照必须删除而非截断；守住它：SNAPSHOT_CACHE_MAX_ENTRY_BYTES 判断。强行写入会迅速耗尽配额，并在主线程反复做无意义的大对象序列化。
// INV-12 [权衡] 体积按 UTF-8 字节计量而非字符串长度；守住它：TextEncoder 编码后再取 byteLength 的那一步。用 length 会把中文快照低估约三倍，剪枝后仍超预算。
// INV-13 [失败路径] localStorage 的取值、解析、写入全部单独 try 包裹并降级为无缓存；守住它：getBrowserStorage 与 ensure、flush 的 catch。少一处，隐私模式或配额耗尽就会让渲染抛异常。
// INV-14 [事务] 持久化缓存只在首次访问时加载一次，用 persistedSnapshotCacheLoaded 短路；守住它：ensure 函数的开头。每次读取都解析会把命中路径变成同步解析 2MB JSON。
// INV-15 [失败路径] 反序列化的每条 entry 必须逐字段校验类型后才入库；守住它：ensure 循环里的 typeof 判断。放宽后损坏条目会以半成品进入缓存，命中时返回缺正文的对象。
// INV-16 代理只改写 getTaskSnapshot，其余属性经 Reflect.get 透传原 receiver；守住它：get trap 的 prop 判断。扩大拦截面会改变其它方法的绑定与返回身份，下游的相等判断失效。
// INV-17 代理内部的 RPC 一律打到 target 而不是代理自身；守住它：两处 getTaskSnapshotWithEtag 的目标对象。改走代理会回到 get trap，形成自调用或双重去重。
// INV-18 [失败路径] workspacePath 的有无决定走哪个服务 hook，必须在组件生命周期内保持不变；守住它：useZCodeTaskService 开头的三元。中途切换会改变 hook 调用顺序，React 直接抛错。
//
// 模块职责：为 ZCode task 服务套一层按实例隔离的代理，把 getTaskSnapshot 的并发去重、ETag 条件请求与两级快照缓存集中在一处。
// 状态所有权：快照正文与 etag 属于 host 侧事实，这里只做读缓存与合流；hook 不持有业务状态，缓存随 service 实例回收。
// 阅读顺序：类型别名 → 三张 WeakMap 与持久化上限 → buildSnapshotDedupeKey → 分片获取与存储读写 → 代理的 etag 与失败分支 → 服务解析与代理缓存。
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskSnapshot } from "@zcode/shared";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

type GetTaskSnapshotParams = Parameters<IZCodeTaskService["getTaskSnapshot"]>[0];
type GetTaskSnapshotResult = Promise<ZCodeTaskSnapshot | null>;
type GetTaskSnapshotWithEtagParams = Parameters<IZCodeTaskService["getTaskSnapshotWithEtag"]>[0];

// 模块级状态只有三类：代理缓存、按 service 分片的并发表与快照缓存，全部以 service 实例为键，随实例一起被回收。
// zcodeTaskServiceProxyCache 保证同一 raw service 永远拿到同一个代理对象，引用稳定，消费方的依赖数组才不会每次渲染都变。
// [资源] 并发表与快照缓存用 WeakMap 而不是 Map，服务重建后旧分片不会常驻，热更新时也不会泄漏。
// latestSnapshotCache 只保存最近使用的分片供诊断枚举；WeakMap 本身不可遍历，诊断需要这个额外句柄。
// 诊断注册在模块加载时执行一次，回调读取 latestSnapshotCache 的当前值，不持有全部 service。
// [权衡] 诊断只反映最近一个 service 的条目数，多实例并存时会低估；这是为了避免诊断系统反向延长服务生命周期。
// 三个上限常量集中在此：单条字节、总字节、条目数；任何新增缓存都必须先在这里定义预算。
const zcodeTaskServiceProxyCache = new WeakMap<IZCodeTaskService, IZCodeTaskService>();
const snapshotInflightRequestsByService = new WeakMap<
  IZCodeTaskService,
  Map<string, GetTaskSnapshotResult>
>();
const snapshotCacheByService = new WeakMap<
  IZCodeTaskService,
  Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }>
>();
const SNAPSHOT_CACHE_STORAGE_KEY = "zcode-task-snapshot-cache:v1";
const SNAPSHOT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
const SNAPSHOT_CACHE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_CACHE_MAX_ENTRIES = 20;
type PersistedSnapshotCacheEntry = {
  key: string;
  etag: string;
  snapshot: ZCodeTaskSnapshot;
  updatedAt: number;
  sizeBytes: number;
};
let persistedSnapshotCacheLoaded = false;
const persistedSnapshotCache = new Map<string, PersistedSnapshotCacheEntry>();
// 内存诊断计数器：WeakMap 无法枚举，记住最近一个
// service 的内存缓存（renderer 内实际只有一个 task service 实例）。
let latestSnapshotCache: Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }> | undefined;
uiMemoryDiagnosticsRegistry.register("taskSnapshotCache", () => ({
  entries: latestSnapshotCache?.size ?? 0,
  persisted: persistedSnapshotCache.size,
}));

// 纯函数，把快照请求的全部语义维度拼成去重键；键相等即代表这次请求可以复用上一次的结果。
// [并发] 三个可选数字维度只在 typeof 为 number 时写入字符串，0 与缺省因此可区分：messageLimit 为 0 是真实上限，不是未设置。
// clientMode 与 resumeModelPolicy 带默认值参与拼接；桌面连续链路与手机可重放链路的恢复语义不同，共用键会把一端快照喂给另一端。
// model 与 thoughtLevel 也进键：同一任务换了模型或思考强度，configOptions 与会话窗口都不同，旧快照会让 toolbar 与实际配置错位。
// [权衡] 维度用双冒号拼接，路径或标题恰好含双冒号时存在极小的撞键概率；换取的是可读、可在 localStorage 里直接排查的字符串。
// 新增请求参数时先加到这里再改缓存逻辑，否则去重命中会把新维度丢掉，表现得像参数没生效。
export function buildSnapshotDedupeKey(params: GetTaskSnapshotParams): string {
  return [
    params.workspacePath,
    params.workspaceIdentity ?? "",
    params.taskId,
    typeof params.messageLimit === "number" ? String(params.messageLimit) : "",
    typeof params.byteBudget === "number" ? String(params.byteBudget) : "",
    typeof params.toolLimit === "number" ? String(params.toolLimit) : "",
    // desktop continuous 和手机 remote replayable 的 snapshot 可能经过不同恢复逻辑。
    // 缓存 key 必须区分 clientMode，否则会把某一端的快照复用到另一端。
    params.clientMode ?? "desktop-continuous",
    // 手机只读恢复会刻意跳过 task-index 模型回填。
    // 策略不同代表 host 端恢复语义不同，不能共用同一份 snapshot cache。
    params.resumeModelPolicy ?? "task-index",
    // 手机首屏恢复会用历史模型 hint 激活 session。
    // 同一 task 若模型 hint 不同，context window 也可能不同，缓存必须隔离。
    params.model ?? "",
    // replayable snapshot 现在会携带 session settings 投影出的 configOptions。
    // 同一模型下 thoughtLevel 不同也会改变 toolbar 配置和后续发送 hint，不能复用旧快照。
    params.thoughtLevel ?? "",
  ].join("::");
}

// 按 service 取并发表，首次访问时惰性创建并回写 WeakMap；同一 service 的所有代理共享这一张表。
// [失败路径] 非对象入参直接返回一次性的新 Map，调用方拿到的表不共享，去重自然失效但不会抛错。
// 返回空 Map 而不是 null，是为了让代理侧不需要分支判空；代价是这种降级路径下并发的重复 RPC 不会被合流。
// 快照缓存的分片获取逻辑与并发表对称，额外把结果记到 latestSnapshotCache 供诊断读取。
// 两张表都在代理创建时一次性取出，之后由闭包持有，避免每次调用都回查 WeakMap。
// [权衡] 惰性建表让首个请求承担一次分配；若改成模块顶层的静态 Map，就会失去按 service 隔离与回收。
function getOrCreateSnapshotInflightMap(
  service: IZCodeTaskService,
): Map<string, GetTaskSnapshotResult> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotInflightRequestsByService.get(service);
  if (existing) {
    return existing;
  }
  const created = new Map<string, GetTaskSnapshotResult>();
  snapshotInflightRequestsByService.set(service, created);
  return created;
}

function getOrCreateSnapshotCacheMap(
  service: IZCodeTaskService,
): Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotCacheByService.get(service);
  if (existing) {
    latestSnapshotCache = existing;
    return existing;
  }
  const created = new Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }>();
  snapshotCacheByService.set(service, created);
  latestSnapshotCache = created;
  return created;
}

// 存储访问被收敛成一个入口：无 window 的环境与禁用 localStorage 的隐私模式都返回 null。
// [失败路径] 读取 window.localStorage 本身也可能抛异常，所以取值单独包裹 try；只在函数入口判 window 存在并不够。
// ensurePersistedSnapshotCacheLoaded 用 persistedSnapshotCacheLoaded 做一次性短路，避免每次命中都解析整份持久化 JSON。
// [事务] 先置位已加载标记再解析：解析失败也不重试，损坏数据不会在每次读取时反复打断主线程。
// 反序列化结果先断言 entries 是数组，再逐条校验 key、etag、snapshot、updatedAt、sizeBytes 的类型，任何一条不合格就跳过。
// [失败路径] 逐条校验而不是整体校验：单条脏数据只丢自己，不会让整份缓存作废。
// flushPersistedSnapshotCache 每次写入完整 entries 数组，覆盖而不是追加；localStorage 没有事务，全量覆盖是唯一可靠的原子手段。
// 写入失败（配额、隐私模式）被吞掉：缓存只是加速手段，不能因为持久化失败让快照请求失败。
function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ensurePersistedSnapshotCacheLoaded() {
  if (persistedSnapshotCacheLoaded) {
    return;
  }
  persistedSnapshotCacheLoaded = true;
  const storage = getBrowserStorage();
  const raw = storage?.getItem(SNAPSHOT_CACHE_STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as {
      entries?: PersistedSnapshotCacheEntry[];
    };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (
        typeof entry?.key !== "string" ||
        typeof entry?.etag !== "string" ||
        !entry.snapshot ||
        typeof entry.updatedAt !== "number" ||
        typeof entry.sizeBytes !== "number"
      ) {
        continue;
      }
      persistedSnapshotCache.set(entry.key, entry);
    }
  } catch {
    // ignore storage parse errors
  }
}

function flushPersistedSnapshotCache() {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      SNAPSHOT_CACHE_STORAGE_KEY,
      JSON.stringify({ entries: [...persistedSnapshotCache.values()] }),
    );
  } catch {
    // ignore storage write errors (quota/private mode)
  }
}

function prunePersistedSnapshotCache() {
  const entries = [...persistedSnapshotCache.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const nextEntries: PersistedSnapshotCacheEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (nextEntries.length >= SNAPSHOT_CACHE_MAX_ENTRIES) {
      continue;
    }
    if (totalBytes + entry.sizeBytes > SNAPSHOT_CACHE_MAX_TOTAL_BYTES) {
      continue;
    }
    nextEntries.push(entry);
    totalBytes += entry.sizeBytes;
  }
  persistedSnapshotCache.clear();
  for (const entry of nextEntries) {
    persistedSnapshotCache.set(entry.key, entry);
  }
}

function readPersistedSnapshotEntry(key: string) {
  ensurePersistedSnapshotCacheLoaded();
  const entry = persistedSnapshotCache.get(key);
  if (!entry) {
    return null;
  }
  return { etag: entry.etag, snapshot: entry.snapshot };
}

// 写入前先估算体积：序列化一次再按 UTF-8 字节计量，中文与转义字符不会被按字符数低估。
// [资源] 超过单条上限直接删除该键并回写，而不是截断或跳过；留在盘上的旧快照已过期且继续占配额。
// 合法条目带上 updatedAt 与 sizeBytes 入库，这两个字段是后续剪枝的唯一依据，不能被省略。
// [事务] 入库后先剪枝再落盘：先写盘会把下一轮要淘汰的条目也序列化一次，白白放大写入量。
// [权衡] 每条写入都全量序列化整个缓存，条目数被两个上限压得很小，换来的是实现简单与崩溃后可自愈。
function writePersistedSnapshotEntry(
  key: string,
  etag: string,
  snapshot: ZCodeTaskSnapshot,
): void {
  ensurePersistedSnapshotCacheLoaded();
  const serializedSnapshot = JSON.stringify(snapshot);
  const sizeBytes = new TextEncoder().encode(serializedSnapshot).byteLength;
  if (sizeBytes > SNAPSHOT_CACHE_MAX_ENTRY_BYTES) {
    // 大消息 task 的快照若直接写 localStorage，会很快触发配额上限并拖慢主线程。
    // 这里只持久化小体积快照，超限时删除旧缓存，避免“为了加速加载反而造成存储压力”。
    persistedSnapshotCache.delete(key);
    flushPersistedSnapshotCache();
    return;
  }

  persistedSnapshotCache.set(key, {
    key,
    etag,
    snapshot,
    updatedAt: Date.now(),
    sizeBytes,
  });
  prunePersistedSnapshotCache();
  flushPersistedSnapshotCache();
}

function deletePersistedSnapshotEntry(key: string): void {
  ensurePersistedSnapshotCacheLoaded();
  persistedSnapshotCache.delete(key);
  flushPersistedSnapshotCache();
}

// 代理是 hook 的返回值本体：只在 getTaskSnapshot 上做去重、缓存与条件请求，其余方法保持原样。
// get trap 先判 prop，非目标属性走 Reflect.get 并透传 receiver，保证调用方拿到的仍是 raw service 上的绑定。
// [并发] 命中 inflight 时返回同一个 Promise，多个 hook 共享一次 RPC；这是首屏不重复拉大快照的关键。
// 缓存先查内存分片，未命中再查持久化；从持久化取回时顺带回填内存，后续命中不再触碰 localStorage。
// [事务] 请求成功后同时更新内存与持久化，请求被判空时两处一起删；只更新一处会让内存与磁盘给出不同答案。
// 缓存写入条件要求 snapshot 与 etag 同时存在：缺 etag 无法做条件请求，缺正文则是无效命中。
// [权衡] 代理不接管 getTaskSnapshotWithEtag 这类更底层的调用，直接调用方会绕过本层；这样做避免了重入与语义歧义。
function createZCodeTaskServiceProxy(service: IZCodeTaskService): IZCodeTaskService {
  const inflight = getOrCreateSnapshotInflightMap(service);
  const snapshotCache = getOrCreateSnapshotCacheMap(service);

  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop !== "getTaskSnapshot") {
        return Reflect.get(target, prop, receiver);
      }

      return (params: GetTaskSnapshotParams) => {
        const requestKey = buildSnapshotDedupeKey(params);
        const existing = inflight.get(requestKey);
        if (existing) {
          return existing;
        }
        const cachedSnapshotEntry =
          snapshotCache.get(requestKey) ?? readPersistedSnapshotEntry(requestKey);
        if (cachedSnapshotEntry && !snapshotCache.has(requestKey)) {
          snapshotCache.set(requestKey, cachedSnapshotEntry);
        }

        // 远控首屏恢复时，多个 hook 会并发请求同一 task snapshot，
        // 导致 host 连续执行多次 getTaskSnapshot，并把超大快照重复回传到 relay。
        // 这里按“同一 service + 同一参数”做并发去重，命中时复用同一个 Promise，
        // 保证同一时刻只发起一次 RPC；同时携带 if-none-match，未变化时复用本地缓存快照，
        // 避免重复下发大 JSON。
        const request = (async () => {
          const firstResult = await target.getTaskSnapshotWithEtag({
            ...(params as GetTaskSnapshotWithEtagParams),
            ...(cachedSnapshotEntry?.etag ? { ifNoneMatch: cachedSnapshotEntry.etag } : {}),
          });
          if (firstResult.notModified) {
            if (cachedSnapshotEntry?.snapshot) {
              return cachedSnapshotEntry.snapshot;
            }
            // 仅持久化了 etag 但没有可用快照正文时，不能把 notModified 直接透传给上层，
            // 否则首屏会拿到空数据。这里回退一次“无 if-none-match”硬拉取，确保数据完整性优先。
            const fallbackResult = await target.getTaskSnapshotWithEtag(
              params as GetTaskSnapshotWithEtagParams,
            );
            if (fallbackResult.snapshot && fallbackResult.etag) {
              const nextEntry = {
                etag: fallbackResult.etag,
                snapshot: fallbackResult.snapshot,
              };
              snapshotCache.set(requestKey, nextEntry);
              writePersistedSnapshotEntry(
                requestKey,
                fallbackResult.etag,
                fallbackResult.snapshot,
              );
            }
            return fallbackResult.snapshot;
          }
          if (firstResult.snapshot && firstResult.etag) {
            const nextEntry = {
              etag: firstResult.etag,
              snapshot: firstResult.snapshot,
            };
            snapshotCache.set(requestKey, nextEntry);
            writePersistedSnapshotEntry(
              requestKey,
              firstResult.etag,
              firstResult.snapshot,
            );
          } else if (!firstResult.snapshot) {
            snapshotCache.delete(requestKey);
            deletePersistedSnapshotEntry(requestKey);
          }
          return firstResult.snapshot;
        })().finally(() => {
          if (inflight.get(requestKey) === request) {
            inflight.delete(requestKey);
          }
        });
        inflight.set(requestKey, request);
        return request;
      };
    },
  });
}

/** 获取 ZCode task wrapper 服务实例 */
export function useZCodeTaskService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
// 服务按 workspace 解析：给了 workspacePath 就走 workspace 作用域，否则退回当前窗口的服务容器。
// [失败路径] workspacePath 的有无决定调用哪个 hook，必须在组件生命周期内保持稳定；中途切换会让 hook 顺序变化，React 直接抛错。
// raw service 不是对象时原样返回，不构造空实现；调用方因此必须自行判空，这是本 hook 类型签名之外的真实契约。
// 代理按 raw service 缓存，同一实例重复调用 hook 返回同一代理；换成每次新建会让下游 effect 因引用变化反复重跑。
): IZCodeTaskService {
  // ZCode task 服务按 workspace 身份解析，保证所有 task RPC 都落到对应的 host。
  const services = workspacePath
    ? useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    : useServices();
  const rawService = services.zcodeTaskService;
  if (!rawService || typeof rawService !== "object") {
    return rawService;
  }
  const cachedProxy = zcodeTaskServiceProxyCache.get(rawService);
  if (cachedProxy) {
    return cachedProxy;
  }
  const nextProxy = createZCodeTaskServiceProxy(rawService);
  zcodeTaskServiceProxyCache.set(rawService, nextProxy);
  return nextProxy;
}
