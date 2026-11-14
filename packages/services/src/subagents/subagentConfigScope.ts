// Subagent 配置文件作用域：把「一个目录或一个文件」收敛成单一、可串行发布的值快照。
// 本文件不做层级合并：user / state / project 各自一个 scope，由 subagentRuntimeConfig
// 按 user → project → 内置 的顺序叠加；任何 scope failed 时整体退回内置定义。
// INV-01：同一 scope 永不并发执行两次 load——drain 以 draining 作门闩，pending 只在批次开头取走。
// INV-02：value 只在 load 成功且未被 abort 时整体替换，读者看不到半成品快照。
// INV-03：文件事件、目录重建、显式重载最终都归一到 revision/reset/pending，不另开写入路径。
// INV-04：disposed 之后不再写 value、不再调 onSettled；所有异步循环都以它为出口。
// INV-05：失败只置 failed 不清空 value，上层据此在「旧快照」与「内置定义」之间选择。
import { watch, type FSWatcher } from "chokidar";
import { stat, watch as watchDirectory } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("subagentRuntimeConfig");
// 去抖窗口只用来吸收同一次保存产生的连续事件；调大容易吞掉两次快速编辑之间的差异，
// 调小则 chokidar 的 atomic 事件与 awaitWriteFinish 会各自触发一次读取。
const EVENT_DEBOUNCE_MS = 300;
// 目录重建后的补扫没有 watcher 的 awaitWriteFinish 兜底，只能靠连续不变的 stat 判定写完；
// 这两个值与 chokidar 的 awaitWriteFinish 保持同量级，避免两套稳定口径互相打架。
const WRITE_STABILITY_MS = 1000;
const WRITE_POLL_MS = 500;
export type SubagentFileChanges = Map<string, "read" | "remove">;
export interface SubagentConfigLoadContext {
  signal: AbortSignal;
  waitForStableFile(path: string): Promise<boolean>;
}

// [权衡] 不用 watcher 判断写完，而是轮询 stat 直到五个身份字段连续 1s 不变：
// 首次扫描拿不到稳定通知，且只看 size 会把「先创建后写入」误判为已完成。
async function waitForStableFile(path: string, signal: AbortSignal): Promise<boolean> {
  let previous: Awaited<ReturnType<typeof stat>> | undefined;
// 用 performance.now()：系统时间被回拨时 Date.now() 的差值会变负，稳定判定将永不成立。
  let stableSince = performance.now();
  while (true) {
// 每轮都重新检查取消：目录被删除或显式重载会 abort，否则这里会陪着一个
// 已不存在的路径空转到进程退出。
    signal.throwIfAborted();
// ENOENT 视为「文件暂时不在」而非错误：重建窗口里文件本来就可能缺失，调用方会跳过本次补扫。
// 其余 errno（EACCES/EPERM）必须上抛，否则权限问题会被伪装成「文件一直没稳定」。
    const current = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
// 返回 false 而不是重试：文件消失通常还有 unlink 事件另走一遍，重复重试会与那一路互相覆盖。
    if (!current) return false;
    if (
// ino/dev 也参与比较：原子替换（写临时文件再 rename）可能保持 size 与 mtime 的量级，
// 只比时间戳会把「换了 inode 的新文件」当成未变化，从而读到上一份内容。
      !previous ||
      current.size !== previous.size ||
      current.mtimeMs !== previous.mtimeMs ||
      current.ctimeMs !== previous.ctimeMs ||
      current.ino !== previous.ino ||
      current.dev !== previous.dev
    )
      stableSince = performance.now();
    else if (performance.now() - stableSince >= WRITE_STABILITY_MS) return true;
    previous = current;
    await delay(WRITE_POLL_MS, undefined, { signal });
  }
}

// [并发] 一个 scope 对应一个被监听的目录/文件，所有 load 走同一条串行队列，
// 因此返回对象可被多个 RPC 读者同时读取而无需额外加锁。
/** 一个配置范围串行吸收文件变化，RPC 只消费上层已完成的 snapshot。 */
export function createSubagentConfigScope<T>(options: {
  root: string;
  file?: string;
  load(
    previous: T | undefined,
    changes: SubagentFileChanges | undefined,
    context: SubagentConfigLoadContext,
  ): Promise<T>;
  onSettled(): void;
}) {
  const root = resolve(options.root);
  const file = options.file && resolve(options.file);
// disposed 是唯一终止标志；revision 只在「输入真的变了」时自增，
// 用来识别 load 期间又来了新事件时产生的过期结果。
  let disposed = false,
    revision = 0,
    failed = false,
    reset = true;
// value 是已发布的完整快照，pending/reset 是尚未被 load 消费的输入。
// 两者分离，保证 load 期间到达的事件不会丢失。
  let value: T | undefined;
  const pending: SubagentFileChanges = new Map();
  let timer: ReturnType<typeof setTimeout> | undefined;
// draining 兼作互斥量：存在即表示有批次在跑，后到的 schedule/settle 复用同一个 Promise，
// 避免两条 load 并行写 value。
  let draining: Promise<void> | undefined;
// initialized 之前不排去抖：首份快照由构造函数里的 checkWatch→drain 显式完成，
// 否则首次 watcher 的 add 事件会和初始全量读取重复。
  let initialized = false,
    stabilize = false;
// anchor 是「实际存在的最近祖先」：root 缺失时监听父目录，靠它的结构事件重建；
// anchorStats 记录 ino/dev，用于识别目录被删除后同名重建（必须换 watcher）。
  let watcher: FSWatcher | undefined, anchor: string | undefined;
// 父目录订阅只收原生结构事件，与 chokidar 的文件索引分离，重建时必须成对取消。
  let parentWatch: AbortController | undefined;
  let anchorStats: Awaited<ReturnType<typeof stat>> | undefined;
  let releaseReady: (() => void) | undefined;
  let binding: Promise<void> | undefined;
  let checkRequested = false,
    replaceRequested = false;
// 指向当前批次的 controller：显式重载与目录重建要能立刻打断在途读取。
  let loadController: AbortController | undefined;

// [并发] 去抖器只保留最后一个定时器；漏掉 clearTimeout 会让一次保存的 add+change
// 排两次 drain，第二个在门闩释放后又跑一遍。
  function schedule() {
    if (timer) clearTimeout(timer);
    if (!disposed && initialized && (reset || pending.size))
      timer = setTimeout(() => {
        timer = undefined;
        void drain();
      }, EVENT_DEBOUNCE_MS);
  }
// drain 是唯一写入口：取走 pending、决定全量或增量、调用 load、替换 value。
// 用循环而非单次执行，是因为 load 期间到达的事件必须在本批次之后继续消化。
  async function drain() {
    if (disposed || draining) return draining;
    const changedPaths = new Set<string>();
    draining = (async () => {
// [资源] 每轮先看 disposed：dispose 会把 loadController 与 parentWatch 一起 abort，
// 循环必须在下一轮立即退出，不能等某个 Promise 自行结束。
      while (!disposed) {
// [时序] 删除必须先确认目录结构再发布：先发布空范围会让上层立刻按内置定义重建，
// 随后到达的 unlinkDir 又触发一次重建，两次发布之间的中间态会被 RPC 读到。
        // 子文件 unlink 可能早于 unlinkDir；发布空范围前确认目录，避免立即重建后
        // 原生库不再识别旧目录已删除。每个删除批次仅检查一次，不额外读取 Markdown。
        if ([...pending.values()].includes("remove")) await checkWatch();
        await binding;
// 先等 watcher 绑定完成再读目录：否则本批读到的路径可能在绑定期间已被替换，
// 新目录的事件会因 watcher 尚未就绪而丢失；随后重新检查 pending 是因为等待期间可能已被消费。
        if (disposed || (!reset && !pending.size)) break;
        const generation = revision;
// failed 强制下一次全量：上一次失败的增量无法证明其余文件有效，
// 继续增量合并会把「部分读取成功」误当成完整快照。
        const full = reset || failed;
        const changes = new Map(pending);
        for (const path of changes.keys()) changedPaths.add(path);
        if (full) changedPaths.add(root);
        pending.clear();
// [并发] 先复制再清空，是把 pending 的所有权移交给本批；此后到达的事件写入新 Map，
// 与在途 load 互不覆盖。顺序不能反：先清空后复制会漏事件；reset 也必须在这里落定。
        reset = false;
        const controller = new AbortController();
        loadController = controller;
        const needsStability = full && stabilize;
        try {
// previous 传当前 value 便于调用方复用未变化文件的结果；全量时传 undefined，
// 明确告知「这次不能复用」，避免已删除的文件残留在合并结果里。
          const next = await options.load(value, full ? undefined : changes, {
            signal: controller.signal,
            // 新 watcher 的初次扫描不经过 awaitWriteFinish；仅目录恢复补扫显式等待稳定。
            waitForStableFile: (path) =>
              needsStability ? waitForStableFile(path, controller.signal) : Promise.resolve(true),
          });
          if (disposed) return;
          if (controller.signal.aborted) continue;
// 整体替换而非合并：本文件只承诺「要么旧快照、要么新快照」，
// 合并会让读者看到一个从未在任何时刻真实存在过的混合态。
          value = next;
          failed = false;
          if (full) stabilize = false;
        } catch (error) {
          if (disposed) return;
          if (controller.signal.aborted) continue;
// [失败路径] 先判断失败属于哪一代：期间已有新事件时，这次失败多半是过期读取被 abort，
// 应把 changes 还回 pending，而不是让整个 scope 进入失败态。
          if (generation !== revision) {
            for (const [path, action] of changes) if (!pending.has(path)) pending.set(path, action);
            if (full) reset = true;
          } else {
// 本代失败：保留上一次成功的 value，只置 failed 让上层在下次发布时退回内置定义；
// 清空 value 会让启动期直接失去全部 agent。
            failed = true;
            logger.warn(undefined, "Subagent 配置读取失败，使用内置定义并等待文件变化", {
              path: root,
              error: String(error),
            });
          }
        } finally {
          // 某个候选读取失败时，同时取消该补扫中其他文件的稳定等待。
          controller.abort();
          if (loadController === controller) loadController = undefined;
        }
      }
// finally 是统一发布点：成功失败都要通知 onSettled 重算快照；
// 且必须先释放 draining，否则后续 settle 会永远挂住。
    })().finally(() => {
      draining = undefined;
      if (!disposed) {
        options.onSettled();
        if (changedPaths.size)
          logger.info(undefined, "Subagent 配置文件更新完成", {
            path: root,
            changedPaths: [...changedPaths],
            fallback: failed,
          });
      }
    });
    return draining;
  }
// 事件过滤三层：根目录结构事件走重建；必须直接位于 root 下；文件名或后缀必须匹配。
// 三层都通过才进 pending，避免无关文件被卷进一次全量读取。
  function changed(event: string, path: string) {
    const absolute = resolve(path);
    if (absolute === root && (event === "unlinkDir" || event === "add" || event === "unlink")) {
      void checkWatch(true);
      return;
    }
    if (
      dirname(absolute) !== root ||
      !(file ? absolute === file : /\.(md|markdown)$/iu.test(absolute))
    )
      return;
    if (event === "unlink") pending.set(absolute, "remove");
    else if (event === "add" || event === "change") pending.set(absolute, "read");
// 入队即换代：load 用批次开始时的 revision 做代际判断，因此无需区分事件类型，
// 任何一次待处理输入都会让在途结果失效；schedule 只负责把事件收敛成一次批次。
    else return;
    revision++;
    schedule();
  }
// 向上找最近一个存在的祖先：root 可能因为 .zcode/agents 尚未创建而不存在，
// 直接 watch 不存在的路径在 Windows 上不会产生后续 addDir，只能退到父目录。
  async function findAnchor() {
    let path = root;
    while (true) {
      try {
        const stats = await stat(path);
        if (path === root || stats.isDirectory()) return { path, stats };
      } catch (error) {
// 只吞「不存在」与「路径某段不是目录」：EACCES/EPERM 若也吞掉，
// 会把权限问题伪装成「目录还没创建」，界面永远显示空配置。
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      const parent = dirname(path);
// [失败路径] 到达文件系统根仍找不到，说明盘符或挂载点不可用；
// 继续向上会无限循环，因此直接抛出，由 checkWatch 记日志后放弃本次绑定。
      if (parent === path) throw new Error(`Subagent watch root unavailable: ${root}`);
      path = parent;
    }
  }
// checkWatch 串行化所有重建请求：chokidar 的 close 是异步的，
// 并发重建会同时存在两个 watcher，同一事件被处理两次。
  function checkWatch(replace = false): Promise<void> {
    checkRequested = true;
    replaceRequested ||= replace;
// 显式重载：先换代再置 reset，让在途候选读取 abort；releaseReady 负责叫醒
// 卡在 ready 等待里的旧绑定流程。
    if (replace) {
      revision++;
      reset = true;
      loadController?.abort();
      releaseReady?.();
    }
    if (binding) return binding;
    binding = (async () => {
// 用 checkRequested 记录「绑定期间又来了结构事件」，绑定完成后必须再检查一次，
// 否则目录在 ready 之前被替换的窗口会永久失聪。
      while (!disposed && checkRequested) {
        checkRequested = false;
        const force = replaceRequested;
        replaceRequested = false;
        const { path: nextAnchor, stats } = await findAnchor();
        if (disposed) return;
        if (
// 同一 anchor 且 ino/dev 未变时复用 watcher：每次父目录事件都重建，
// 会让正在写入的文件错过 awaitWriteFinish 的稳定通知。
          watcher &&
          anchor === nextAnchor &&
          !force &&
          anchorStats?.dev === stats.dev &&
          anchorStats.ino === stats.ino
        )
          continue;
        const previous = watcher;
        watcher = undefined;
        parentWatch?.abort();
// [资源] 旧 watcher 与父目录订阅必须成对释放：漏掉 abort 会让旧父目录事件
// 继续调用 checkWatch，形成两个绑定循环互相打架。
        if (previous) await previous.close();
        if (disposed) return;
// 只有当「root 的出现或消失」跨越本次切换才需要重载内容；
// 其它祖先变化只影响监听位置，已有 value 仍然有效。
        if (anchor !== undefined && (anchor === root || nextAnchor === root)) {
          revision++;
          reset = true;
          stabilize = nextAnchor === root;
          loadController?.abort();
        }
        anchor = nextAnchor;
        anchorStats = stats;
        const direct = anchor === root;
        const parent = dirname(anchor);
        // 祖先枚举会返回磁盘真实大小写，字符串筛选会误丢 AGENTS。直接以配置路径监听，
        // 缺失时的浅层父监听只负责发现目录，不比较目标分支名称，也不扫描其内容。
        const current = watch(anchor, {
          persistent: true,
          ignoreInitial: true,
          depth: 0,
          usePolling: false,
          followSymlinks: true,
          atomic: true,
          awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: WRITE_POLL_MS },
// 非直接锚点只放行目录与符号链接，防止父目录里的同名 Markdown 被当成配置；
// 直接锚定时严格按 file 或 .md 后缀过滤，与 changed 的判定保持同一口径。
          ignored: (path, info) => {
            const absolute = resolve(path);
            if (absolute === nextAnchor) return false;
            if (dirname(absolute) !== nextAnchor) return true;
            if (!direct) return info ? !info.isDirectory() && !info.isSymbolicLink() : false;
            return file
              ? absolute !== file
              : Boolean(info?.isDirectory()) || !/\.(md|markdown)$/iu.test(absolute);
          },
        });
        watcher = current;
// raw 捕捉 chokidar 未归一化的原生事件：非直接锚点时目录被整体替换可能只表现为 raw，
// 需要重新找 anchor。
        current.on("raw", () => {
          if (!direct && !disposed && watcher === current) void checkWatch();
        });
        // Windows 不报告空目录自身的移动；父目录只订阅原生结构事件，不枚举其内容。
        // 与 Chokidar 的文件索引分离，避免 AGENTS 被误当作逻辑 agents 的删除事件。
        if (parent !== anchor) {
          const controller = new AbortController();
          parentWatch = controller;
          void (async () => {
            for await (const _event of watchDirectory(parent, { signal: controller.signal })) {
              if (disposed || watcher !== current) return;
              await checkWatch();
            }
          })().catch((error) => {
            if (!controller.signal.aborted && !disposed)
              logger.warn(undefined, "Subagent 父目录监听异常，显式重载可重建监听", {
                path: parent,
                error: String(error),
              });
          });
        }
// watcher !== current 说明本次绑定已被替换，旧 watcher 迟到的事件必须丢弃，
// 否则会把新锚点下不存在的路径塞进 pending。
        current.on("all", (event, path) => {
          if (disposed || watcher !== current) return;
          if (direct) changed(event, path);
          else if (event === "addDir" || event === "unlinkDir") void checkWatch();
        });
// 必须等 ready 才允许上层发布：ready 之前的事件可能被 ignored 过滤掉，
// 提前发布会让「监听已建立」与「快照已完整」两个事实错位。
        await new Promise<void>((ready) => {
          releaseReady = ready;
          current.once("ready", ready);
          current.on("error", (error) => {
            if (disposed || watcher !== current) return;
            logger.warn(undefined, "Subagent 文件监听异常，显式重载可重建监听", {
              path: root,
              error: String(error),
            });
            ready();
          });
        });
        releaseReady = undefined;
// [时序] 绑定开始前的检查请求已在循环开头消费；这里补一次，
// 覆盖「findAnchor 之后、ready 之前」到达的结构事件。
        // 补上检查目录与监听就绪之间的空窗，不依赖轮询或延时猜测。
        checkRequested = true;
      }
    })()
      .catch((error) => {
        if (!disposed)
          logger.warn(undefined, "Subagent 文件监听初始化失败，显式重载可重建监听", {
            path: root,
            error: String(error),
          });
      })
      .finally(() => {
        binding = undefined;
        // 无关父目录事件只检查位置，不能反复推迟已经排队的配置更新。
        if (!timer) schedule();
        if (!disposed) options.onSettled();
      });
    return binding;
  }
// ready 的语义是「watcher 已就绪且首份快照已写入」，上层 settle 等它才算初始化完成。
  const ready = checkWatch().then(async () => {
    if (disposed) return;
    await drain();
    initialized = true;
  });
  return {
    ready,
    async settle() {
      await ready;
      await binding;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await drain();
    },
    get value() {
      return value;
    },
    get failed() {
      return failed;
    },
    get busy() {
      return (
        !disposed &&
        (!initialized || Boolean(binding) || Boolean(draining) || reset || pending.size > 0)
      );
    },
// [资源] 四个动作缺一不可：abort 让在途 load 立即返回，释放 ready 等待者
// 避免绑定循环挂死，clearTimeout 防止销毁后又排一次 drain，close 才真正停止句柄。
    dispose() {
      disposed = true;
      loadController?.abort();
      parentWatch?.abort();
      releaseReady?.();
      if (timer) clearTimeout(timer);
      pending.clear();
      const current = watcher;
      watcher = undefined;
      void current?.close().catch((error) =>
        logger.warn(undefined, "Subagent 文件监听关闭失败", {
          path: root,
          error: String(error),
        }),
      );
    },
  };
}
