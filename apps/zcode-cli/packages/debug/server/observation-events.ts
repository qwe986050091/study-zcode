// INV-01 首帧先发重试指令：守住位置 流启动；改错故障 断线后浏览器按默认间隔重连。
// INV-02 问候事件携带当前指纹：守住位置 启动流程；改错故障 前端首屏没有基线。
// INV-03 轮询间隔归一化：守住位置 入参处理；改错故障 非法值让定时器空转。
// INV-04 最小间隔防高频扫描：守住位置 下限夹取；改错故障 调试台自身拖慢被观测进程。
// INV-05 定时器不阻止进程退出：守住位置 释放调用；改错故障 仅剩定时器时进程无法退出。
// INV-06 取消时停止定时器：守住位置 取消回调；改错故障 流关闭后仍在扫描磁盘。
// INV-07 单飞检查避免任务堆积：守住位置 提前返回；改错故障 慢盘下扫描并发增长。
// INV-08 关闭后不再写入：守住位置 入队判断；改错故障 向失效控制器写数据抛错。
// INV-09 写入失败即标记关闭：守住位置 捕获分支；改错故障 后续轮次反复失败。
// INV-10 仅在指纹变化时推进版本：守住位置 长度判断；改错故障 前端被无变化事件刷屏。
// INV-11 扫描异常只发错误事件：守住位置 捕获分支；改错故障 一次读失败终止整条订阅。
// INV-12 目录签名按名称排序：守住位置 排序调用；改错故障 目录项顺序变化误报变更。
// INV-13 目录子项含类型与大小：守住位置 拼接表达式；改错故障 同名文件替换不被发现。
// INV-14 子项读取失败记缺失：守住位置 内层捕获；改错故障 单个坏条目中断整轮扫描。
// INV-15 文件签名含截断秒级时间：守住位置 时间处理；改错故障 毫秒抖动造成持续刷新。
// INV-16 共享内存只取大小：守住位置 忽略时间分支；改错故障 读取方自身触发无限刷新。
// INV-17 不存在路径记为缺失：守住位置 错误判断；改错故障 首次启动就把订阅打挂。
// INV-18 变更按种类标签路径比对：守住位置 键构造；改错故障 同级新源被误报为变化。
//
// 模块职责：观测数据源指纹计算与 SSE 变更推送。
// 状态所有权：版本与上一轮指纹归单条流，扫描互斥标记同样在闭包内。
// 阅读顺序：先看流生命周期，再指纹聚合，最后看单目标与差异比对。
/**
 * 观测数据源的变更订阅（SSE）。
 *
 * 职责：周期性对日志目录、事件 JSONL 与 SQLite 主库/WAL/SHM 计算指纹，指纹变化时向前端推送
 * change 事件，让调试台无需轮询即可自动刷新。
 * 指纹口径：文件以大小 + mtime 生成签名（SHM 只取大小，见 `fingerprintTarget` 说明）；
 * 目录则聚合条目名/类型/大小/mtime，按名称排序保证签名稳定。
 * 副作用：占用文件 stat/readdir（只读）；每 50ms 以上的定时器，流取消时清理。
 * 失败语义：单次扫描失败只推送 `source-error` 事件，订阅继续，不终止流。
 * 不变量：同一 (kind,label,path) 的签名变化才视为变更，避免新增同级源被误报。
 */
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ObservationChangeEvent,
  ObservationHelloEvent,
  ObservationSourceErrorEvent,
  ObservationSourceFingerprint,
  ObservationSourceKind,
} from "../src/shared.js";
import { defaultDbPath, defaultLogDir } from "./sources.js";
import type { ObservationOptions } from "./types.js";

interface ObservationEventStreamOptions {
  intervalMs?: number;
  now?: () => Date;
}

interface ObservationWatchTarget {
  kind: ObservationSourceKind;
  label: string;
  path: string;
  jsonlOnly?: boolean;
  ignoreMtime?: boolean;
}

const DEFAULT_OBSERVATION_EVENT_INTERVAL_MS = 750;
const MIN_OBSERVATION_EVENT_INTERVAL_MS = 50;
const OBSERVATION_EVENT_RETRY_MS = 1500;

/**
 * 创建观测变更 SSE 流。
 * 输入：`options` 复用观测查询参数（日志目录/事件文件/数据库路径）；`streamOptions` 可注入
 * 轮询间隔与时钟，便于单测确定性。
 * 输出：SSE `ReadableStream`；首帧先发 `retry` 指令，再发 `hello`（含当前指纹与间隔）。
 * 行为：定时器每轮差异比对，仅在指纹变化时推进 `revision` 并推送 `change`。
 * 副作用：定时器仅用于计算指纹，不写任何文件；流 cancel 时停止定时器。
 * 失败语义：单轮扫描异常转为 `source-error` 事件，订阅本身保持存活。
 */
// encoder 与 intervalMs 在 createObservationEventStream 入口一次固定，循环内不再重算。
// 首帧先写 retry 指令再写 hello：顺序反了客户端会按默认退避重连。
// 每轮只比对指纹；仅 revision 变化时才推 change，未变化不产生事件。
// 流 cancel 时停止定时器并标记关闭，取消后不再推送任何帧。
export function createObservationEventStream(
  options: ObservationOptions,
  streamOptions: ObservationEventStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const intervalMs = normalizeInterval(streamOptions.intervalMs);
  const now = streamOptions.now ?? (() => new Date());
  let revision = 0;
  let previousSources: ObservationSourceFingerprint[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let checking = false;

  const encodeEvent = (type: string, data: unknown): Uint8Array =>
    encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  const enqueueEvent = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    type: string,
    data: unknown,
  ): void => {
    if (closed) return;
    // 前端断开后 enqueue 会抛错：一旦发生即置 closed，后续轮次不再写入失效的控制器。
    try {
      controller.enqueue(encodeEvent(type, data));
    } catch {
      closed = true;
    }
  };

  const checkSources = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> => {
    if (checking || closed) return;
    // 单飞检查：上一轮扫描未结束就跳过本轮，避免慢盘/大目录下任务堆积。
    checking = true;
    try {
      const nextSources = await fingerprintObservationSources(options);
      const changedSources = diffSources(previousSources, nextSources);
      if (changedSources.length > 0) {
        previousSources = nextSources;
        revision += 1;
        const event: ObservationChangeEvent = {
          revision,
          changedAt: now().toISOString(),
          changedSources,
          sources: nextSources,
        };
        enqueueEvent(controller, "change", event);
      }
    } catch (error) {
      const event: ObservationSourceErrorEvent = {
        checkedAt: now().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      };
      enqueueEvent(controller, "source-error", event);
    } finally {
      checking = false;
    }
  };

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`retry: ${OBSERVATION_EVENT_RETRY_MS}\n\n`));
      previousSources = await fingerprintObservationSources(options);
      const hello: ObservationHelloEvent = {
        generatedAt: now().toISOString(),
        intervalMs,
        sources: previousSources,
      };
      enqueueEvent(controller, "hello", hello);
      timer = setInterval(() => {
        void checkSources(controller);
      }, intervalMs);
      // 不把该定时器作为进程存活的强引用，仅剩它时允许进程正常退出。
      timer.unref?.();
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });
}

/**
 * 计算全部观测目标的指纹，顺序与 `observationWatchTargets` 一致。
 * 输出：每项含 `exists` 与 `signature`；不存在的源以 `missing`/`error:...` 表示，不抛错。
 * 副作用：只读 stat/readdir；目标数量固定，不会递归扫描仓库。
 */
// 输出顺序严格跟随 observationWatchTargets，供上游按位置逐项比对指纹。
// 逐项 await fingerprintTarget；单项异常降级为 error 签名而不中断整轮扫描。
// 目标不存在时签名记 missing，而不是把 ENOENT 抛给调用方。
// 只读目标自身与一级目录项，不递归扫描整棵仓库。
export async function fingerprintObservationSources(
  options: ObservationOptions,
): Promise<ObservationSourceFingerprint[]> {
  const fingerprints: ObservationSourceFingerprint[] = [];
  for (const target of observationWatchTargets(options)) {
    fingerprints.push(await fingerprintTarget(target));
  }
  return fingerprints;
}

function observationWatchTargets(options: ObservationOptions): ObservationWatchTarget[] {
  const dbPath = resolve(options.dbPath ?? defaultDbPath());
  const targets: ObservationWatchTarget[] = [
    {
      kind: "log",
      label: "结构化日志",
      path: resolve(options.logDir ?? defaultLogDir()),
      jsonlOnly: true,
    },
  ];

  if (options.eventPath) {
    targets.push({
      kind: "eventlog",
      label: "Session 事件 JSONL",
      path: resolve(options.eventPath),
      jsonlOnly: true,
    });
  }

  // SQLite 三件套：主库、WAL、SHM；任一变化都可能意味着会话数据被写入。
  targets.push(
    {
      kind: "sqlite",
      label: "SQLite Session 数据库",
      path: dbPath,
    },
    {
      kind: "sqlite",
      label: "SQLite WAL",
      path: `${dbPath}-wal`,
    },
    {
      kind: "sqlite",
      label: "SQLite SHM",
      path: `${dbPath}-shm`,
      ignoreMtime: true,
    },
  );

  return targets;
}

/**
 * 计算单个目标的指纹。
 * 目录：列出直接子项（jsonlOnly 时仅 .jsonl/.log），按名称排序后拼成签名，任一子项增删改都会变化。
 * 文件：签名由大小 + 截断到秒的 mtime 组成；`ignoreMtime` 目标只取大小。
 * 失败语义：路径不存在记 `missing`，其他读取错误记 `error:<message>`，均不向上抛出。
 */
// 目录分支只列直接子项；jsonlOnly 时过滤掉非 .jsonl/.log 文件。
// 子项名排序后拼成签名：顺序稳定，增删改才能被比对出来。
// 单个子项 stat 失败按缺失计入签名；其余错误记 error:<message>。
// 文件分支比较 size 与截断到秒的 mtime；ignoreMtime 目标只比 size。
async function fingerprintTarget(
  target: ObservationWatchTarget,
): Promise<ObservationSourceFingerprint> {
  try {
    const inputStat = await stat(target.path);
    if (inputStat.isDirectory()) {
      const entries = (await readdir(target.path))
        .filter((entry) => !target.jsonlOnly || entry.endsWith(".jsonl") || entry.endsWith(".log"))
        .sort();
      const parts: string[] = [];
      for (const entry of entries) {
        const entryPath = join(target.path, entry);
        try {
          const entryStat = await stat(entryPath);
          const kind = entryStat.isDirectory() ? "dir" : "file";
          parts.push(`${entry}:${kind}:${entryStat.size}:${mtimeSignature(entryStat.mtimeMs)}`);
        } catch {
          parts.push(`${entry}:missing`);
        }
      }
      return {
        kind: target.kind,
        label: target.label,
        path: target.path,
        exists: true,
        signature: `dir:${mtimeSignature(inputStat.mtimeMs)}:${parts.join("|")}`,
      };
    }

    // SQLite readers, including this debug app's own read-only analyzer pass, can update
    // the WAL shared-memory file mtime. Treating that mtime as data change makes the UI
    // refresh itself forever, so SHM fingerprints only track existence and size.
    const signature = target.ignoreMtime
      ? `file:${inputStat.size}`
      : `file:${inputStat.size}:${mtimeSignature(inputStat.mtimeMs)}`;

    return {
      kind: target.kind,
      label: target.label,
      path: target.path,
      exists: true,
      signature,
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        kind: target.kind,
        label: target.label,
        path: target.path,
        exists: false,
        signature: "missing",
      };
    }
    return {
      kind: target.kind,
      label: target.label,
      path: target.path,
      exists: false,
      signature: `error:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 找出签名相比上一轮发生变化（含新增/删除）的源；未变化的源不推送，避免无效刷新。 */
function diffSources(
  previousSources: ObservationSourceFingerprint[],
  nextSources: ObservationSourceFingerprint[],
): ObservationSourceFingerprint[] {
  const previousByKey = new Map(
    previousSources.map((source) => [sourceFingerprintKey(source), source.signature]),
  );
  return nextSources.filter(
    (source) => previousByKey.get(sourceFingerprintKey(source)) !== source.signature,
  );
}

function sourceFingerprintKey(source: ObservationSourceFingerprint): string {
  return `${source.kind}:${source.label}:${source.path}`;
}

/** 归一化轮询间隔：非法/非有限值回落到默认值，并夹到最小 50ms，防止高频扫描拖慢调试台。 */
function normalizeInterval(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_OBSERVATION_EVENT_INTERVAL_MS;
  }
  return Math.max(Math.trunc(value), MIN_OBSERVATION_EVENT_INTERVAL_MS);
}

function mtimeSignature(value: number): string {
  return Math.floor(value).toString(36);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
