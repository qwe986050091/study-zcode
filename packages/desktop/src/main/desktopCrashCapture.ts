// 桌面端崩溃取证必须覆盖三件事：crashReporter 目录配置、本地 dump 归档与容量清理、进程崩溃事件监听。
// 边界：main 只做本地留档与取证元数据，不能承担远端上报协议、崩溃归因和堆栈符号化。
// 不负责：ARMS 上传策略与稳定性分类；本文件日志只描述生命周期事实，不判定是否 crash。
//
// INV-01 断言：dump 只复制不移动，live 目录始终由 Crashpad 独占 —— 守住它的位置：persistArchivedCrashDump 的 copyFileSync —— 改错故障：远端上报与本地副本互相踩踏，线上崩溃样本被提前清空。
// INV-02 断言：归档名沿用 basename，同名已存在即视为已归档并跳过 —— 守住它的位置：persistArchivedCrashDump 的 existsSync 早退 —— 改错故障：重跑归档覆盖旧 dump，元数据与实际文件时间错配。
// INV-03 断言：归档后必须把 mtime 还原成原始 dump 时间 —— 守住它的位置：紧跟 copyFileSync 的 utimesSync —— 改错故障：清理按复制时间排序，启动批量恢复时误删真正较新的崩溃。
// INV-04 断言：注解解析失败不得阻断归档 —— 守住它的位置：readCrashDumpAnnotationsFromFile 调用点 —— 改错故障：取证代码抛错吞掉整个 dump，白屏问题再也拿不到样本。
// INV-05 断言：元数据必须是与 dump 同名的 .dmp.json —— 守住它的位置：writeFileSync 的归档 json 路径 —— 改错故障：清理逻辑识别不到成对元数据，archive 堆积无法关联的 JSON。
// INV-06 断言：只有 mtime 距今满 1s 的 dump 才允许归档 —— 守住它的位置：isStableCrashDump 判定 —— 改错故障：复制 Crashpad 仍在写的半截文件，归档内容截断。
// INV-07 断言：保留策略永远至少留下 1 个 dump —— 守住它的位置：prune 循环的 keptCount > 1 下限 —— 改错故障：maxFiles 配成 0 时把本地证据全部清空。
// INV-08 断言：清理顺序必须按 mtime 降序、同时间按文件名升序 —— 守住它的位置：dumps.sort 的比较函数 —— 改错故障：两次启动删掉不同对象，问题无法复现。
// INV-09 断言：dump 必须删除成功后才删元数据，单条失败只能记账、不能中断 —— 守住它的位置：prune 删除循环 —— 改错故障：一次 unlink 失败中断整轮清理，archive 无界增长。
// INV-10 断言：孤立 .dmp.json 必须每轮重扫删除，且只匹配该后缀 —— 守住它的位置：metadataFiles 二次遍历 —— 改错故障：误删其他 JSON，或删除失败的元数据永久残留。
// INV-11 断言：归档与清理是同步临界区，必须先于 ARMS 扫描完成 —— 守住它的位置：archiveCrashDumps 的调用点 —— 改错故障：异步 IO 打乱 appCrashCaptureBootstrap 与 appARMSBootstrap 顺序，live 被先删。
// INV-12 断言：无远端上报时 crashReporter.start 只执行一次 —— 守住它的位置：hasStartedLocalCrashReporter 守卫 —— 改错故障：重复 start 覆盖 submitURL，本地 dump 被静默丢弃。
// INV-13 断言：崩溃事件监听全局只注册一次 —— 守住它的位置：registeredCrashEventMonitor 守卫 —— 改错故障：多窗口各注册一份，同一崩溃打出 N 条日志并触发 N 次归档。
// INV-14 断言：gone 事件日志等级必须只看 reason，clean-exit/killed 记 info —— 守住它的位置：resolveProcessGoneLogLevel —— 改错故障：受控退出被当成异常，ARMS 错误统计被污染。
// INV-15 断言：延迟归档定时器必须 unref —— 守住它的位置：scheduleCrashArchive 的 timer.unref —— 改错故障：残留定时器拖住退出流程，进程无法及时结束。
//
// 数据流：Crashpad 写 live/{reports|completed|pending} -> isStable 过滤 -> 复制进 archive
//        -> 写同名 .dmp.json 取证元数据 -> 按 mtime 保留最近若干且总量不超 100MB -> 汇总日志。
// 平台差异：win32 用 reports，darwin 额外有 pending，其余平台只有 completed，三者不能互相替代。
// 幂等前提：archive 内文件名是唯一键，重复归档靠 existsSync 短路，不依赖数据库或锁文件。
// 时序前提：全部函数在 main 启动路径上同步执行，异常由调用方 bootstrap 兜底，此处不做重试。
//
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { app, crashReporter, type BrowserWindow, type WebContents } from "electron";
import { getAppConfigDir } from "@zcode/services/node";
import {
  type CrashDumpV8OomSummary,
  readCrashDumpAnnotationsFromFile,
  summarizeCrashDumpAnnotations,
} from "./crashDumpAnnotations.js";

const LOCAL_ONLY_CRASH_SUBMIT_URL = "https://zcode.invalid/local-crash-only";
const CRASH_DUMP_STABLE_AFTER_MS = 1_000;
const CRASH_ARCHIVE_RETRY_DELAYS_MS = [1_500, 5_000] as const;
const CRASH_ARCHIVE_MAX_FILES = 5;
// [权衡] 5 个文件 / 100MB 是本地留档硬上限，只够留住最近几次崩溃，不能当长期崩溃仓库。
// [契约] 两个上限同时生效，任一超出即按最旧优先删；调大放大磁盘占用，调小会立刻删掉历史样本。
// [契约] 1.5s / 5s 两次延迟归档是给 Crashpad 与远端 SDK 留的处理窗口，改小会复制到写了一半的 dmp。
const CRASH_ARCHIVE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

interface CrashCaptureLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface CrashCapturePaths {
  rootDir: string;
  stagingDir: string;
  archiveDir: string;
}

interface CrashArchiveRetentionPolicy {
  maxFiles: number;
  maxTotalBytes: number;
}

interface CrashArchiveCleanupResult {
  deletedFiles: string[];
  failedFiles: string[];
}

export interface ArchivedCrashDumpRecord {
  dumpPath: string;
  archivedDumpPath: string;
  /** dump 里没有 V8 OOM 注解（例如 GPU / native 崩溃）时为 null。 */
  v8OomSummary: CrashDumpV8OomSummary | null;
}

// [契约] 根目录固定在 appConfigDir()/crash，与历史版本归档位置一致；改名会让升级前的旧 dump 变成孤儿。
// [契约] live 子目录同时交给 app.setPath("crashDumps")，因此不能改成临时目录或系统 tmpdir。
function resolveCrashCapturePaths(): CrashCapturePaths {
  const rootDir = join(getAppConfigDir(), "crash");
  return {
    rootDir,
    stagingDir: join(rootDir, "live"),
    archiveDir: join(rootDir, "archive"),
  };
}

export function resolveCrashReporterSourceDirs(
  stagingDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  // [契约] 目录名由 Crashpad 按平台决定：win32 写 reports，unix 写 completed，统一成一个就扫不到 dump。
  // [权衡] darwin 的 pending 可能是尚未完成上传的 dump，必须一并纳入以免漏样本，代价是可能归档半成品。
  // [失败路径] 目录不存在由调用方 existsSync 跳过，这里不能 mkdir，否则会凭空造出 Crashpad 不识别的目录。
  const dirs = [join(stagingDir, platform === "win32" ? "reports" : "completed")];

  if (platform === "darwin") {
    dirs.push(join(stagingDir, "pending"));
  }

  return dirs;
}

// [并发] 只按 mtime 距现在满 1s 判定稳定，用于避开 Crashpad 正在写入的文件；无法感知写锁。
// [失败路径] stat 失败一律返回 false 归入 skippedFiles，不抛错，避免一个坏条目中断整批归档。
function isStableCrashDump(path: string, nowMs: number): boolean {
  try {
    const stats = statSync(path);
    return nowMs - stats.mtimeMs >= CRASH_DUMP_STABLE_AFTER_MS;
  } catch {
    return false;
  }
}

function persistArchivedCrashDump(
  dumpPath: string,
  archiveDir: string,
  archivedAt: Date,
): ArchivedCrashDumpRecord | null {
  const fileName = basename(dumpPath);
  const archivedDumpPath = join(archiveDir, fileName);
  if (existsSync(archivedDumpPath)) {
    return null;
  }

  const sourceStats = statSync(dumpPath);
  // [资源] 用同步复制而不是 rename：live 文件归 Crashpad 管，移走会让远端上报拿不到原始 dmp。
  // [失败路径] 复制中途失败会留下不完整归档且此时还没写元数据，下一轮因同名文件存在而永久跳过；接受该风险，不做覆盖重试。
  copyFileSync(dumpPath, archivedDumpPath);
  // copyFileSync 会把归档 mtime 改成复制时间，启动批量恢复时会按遍历顺序误删较新的 crash。
  // 保留原始 dump 时间，使归档清理始终按实际 crash 先后排序。
  utimesSync(archivedDumpPath, sourceStats.atime, sourceStats.mtime);
  // 取证目的：白屏/崩溃排查只能拿到日志包，dump 本身要靠 crashpad 注解才能分辨
  // “JS 堆撞上限”还是“JIT 代码区耗尽”。解析失败只影响取证信息，绝不阻断归档。
  // [契约] 读的是归档副本而非 live 原文件，保证远端 SDK 随后删除 live 时注解依然可读。
  // [失败路径] 该调用在 persistArchivedCrashDump 内没有 try，解析抛错会让本次归档整体失败并进入 skippedFiles。
  const annotations = readCrashDumpAnnotationsFromFile(archivedDumpPath, sourceStats.size);
  const v8OomSummary = summarizeCrashDumpAnnotations(annotations);
  // [事务] 顺序固定为复制 dump -> 还原 mtime -> 写同名 json；元数据写失败会让本次归档抛错并被上游标为 skipped。
  // [契约] 后缀是 .dmp.json 而不是 .json，清理逻辑靠它识别成对元数据，改后缀会导致元数据永不被清理。
  // [契约] annotations 与 v8OomSummary 为空时用展开语法省略字段，保持 json 精简，消费方需按缺省处理。
  writeFileSync(
    join(archiveDir, `${fileName}.json`),
    JSON.stringify(
      {
        archivedAt: archivedAt.toISOString(),
        originalPath: dumpPath,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
        ...(v8OomSummary ? { v8OomSummary } : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
  // [契约] 返回 archivedDumpPath 而不是原路径，日志与排查都指向 archive 里的稳定副本。
  // [契约] v8OomSummary 允许为 null，调用方必须按“无注解”分支处理，不能当成解析失败。
  return { dumpPath, archivedDumpPath, v8OomSummary };
}

function pruneCrashDumpArchive(
  archiveDir: string,
  policy: CrashArchiveRetentionPolicy,
): CrashArchiveCleanupResult {
  // 启动时必须先完成本地留档与清理，再让 ARMS 扫描并删除 live；这里保持与既有归档一致的
  // 同步临界区，避免异步 IO 改变 appCrashCaptureBootstrap -> appARMSBootstrap 的先后顺序。
  const deletedFiles: string[] = [];
  const failedFiles: string[] = [];
  // [契约] 先整体扫描再决策删除，不在遍历中边读边删，避免 readdir 结果随目录变化而抖动。
  // [资源] size 与 mtime 一次 stat 取全，配额计算不再二次 IO，缩短与 Crashpad 的竞态窗口。
  const dumps: Array<{ entry: string; path: string; mtimeMs: number; size: number }> = [];
  const dumpEntries = new Set<string>();
  const metadataFiles: Array<{ dumpEntry: string; path: string }> = [];

  try {
    // [契约] 用 withFileTypes 直接判类型，目录与符号链接都不是 isFile，不会进入删除候选。
    // [资源] 整个扫描是同步的，与归档共用同一临界区，避免扫描期间新归档写入导致配额漏算。
    // [失败路径] 目录不存在时 readdir 抛错并被外层捕获，本轮按失败返回，不阻塞启动。
    for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      // [契约] 必须先判 .dmp.json 再判 .dmp，否则元数据会被当成 dump 统计，配额和删除对象整体错位。
      // [契约] slice(0, -5) 必须去掉 ".json" 五个字符，得到与 dump 同名的键，供孤儿判定使用。
      // [权衡] 子目录一律跳过：归档目录预期是平铺结构，嵌套目录既不参与清理也不会被误删。
      if (entry.name.endsWith(".dmp.json")) {
        metadataFiles.push({
          dumpEntry: entry.name.slice(0, -".json".length),
          path: join(archiveDir, entry.name),
        });
        continue;
      }

      // [契约] 删除候选必须只认 .dmp 后缀，其他文件（.json、.log、临时文件）永不进入删除候选。
      // [失败路径] stat 失败的文件直接进 failedFiles 而不进 dumps，避免未知大小参与配额计算。
      if (!entry.name.endsWith(".dmp")) {
        continue;
      }

      dumpEntries.add(entry.name);
      const path = join(archiveDir, entry.name);
      try {
        const stats = statSync(path);
        dumps.push({ entry: entry.name, path, mtimeMs: stats.mtimeMs, size: stats.size });
      } catch {
        failedFiles.push(path);
      }
    }
  } catch {
    // [失败路径] readdir 整体失败时把目录本身记为失败项并返回，不向上抛，启动流程继续走。
    // [契约] 返回空 deletedFiles 让日志不打印 pruned，避免把“读不到目录”误报成“已清理”。
    return { deletedFiles, failedFiles: [archiveDir] };
  }

  // [契约] 按 mtime 降序即最新在前，删除从数组尾部取，保证被删的永远是最旧的那批。
  // [契约] 同 mtime 必须用文件名做次级排序，使两次启动的删除结果一致，便于复现清理行为。
  dumps.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.entry.localeCompare(right.entry),
  );

  const maxFiles = Math.max(1, policy.maxFiles);
  const maxTotalBytes = Math.max(0, policy.maxTotalBytes);
  let keptCount = dumps.length;
  let keptBytes = dumps.reduce((total, dump) => total + dump.size, 0);
  const dumpsToDelete: typeof dumps = [];

  // [契约] keptCount > 1 是硬下限：配额再小也至少留一个 dump，避免把证据清空。
  // [契约] keptBytes 增量扣减而不是重算，循环内不再 stat，配额判断只依赖扫描快照。
  // [权衡] 单个 dump 就超过 maxTotalBytes 时仍会保留它，这是“至少留一个”优先于“不超配额”的取舍。
  while (keptCount > 1 && (keptCount > maxFiles || keptBytes > maxTotalBytes)) {
    const dump = dumps[keptCount - 1];
    if (!dump) break;
    dumpsToDelete.push(dump);
    keptCount -= 1;
    keptBytes -= dump.size;
  }

  for (const dump of dumpsToDelete) {
    // 本地 crash archive 必须有容量边界，否则历史 dump 会永久累积。
    // 清理只作用于已复制成功的 archive，绝不触碰仍由 Crashpad 管理的 live 文件。
    try {
      // [事务] 先删 dump 再删元数据：dump 删成功而 json 删失败时，下一轮靠孤儿扫描补偿。
      // [失败路径] unlink 抛错即记 failedFiles 并 continue，不让一个被占用的文件阻断后续删除。
      unlinkSync(dump.path);
      deletedFiles.push(dump.path);
    } catch {
      failedFiles.push(dump.path);
      continue;
    }

    // [契约] 元数据路径是 dump 全路径后接 .json，必须与 persistArchivedCrashDump 的写入位置始终一致。
    // [契约] 只有 dump 删除成功才走到这里；删除失败时保留配对元数据，避免出现无 dump 的孤立 json。
    const metadataPath = `${dump.path}.json`;
    if (existsSync(metadataPath)) {
      try {
        unlinkSync(metadataPath);
        deletedFiles.push(metadataPath);
      } catch {
        failedFiles.push(metadataPath);
      }
    }
  }

  for (const metadata of metadataFiles) {
    // [契约] dump 仍存在则跳过，元数据随 dump 一起由上面的删除分支处理，不能提前删。
    // [失败路径] 上一轮删了 dump 却没删掉 json 会在这里被再次触达，保证失败最终收敛而非永久残留。
    // [契约] 只处理扫描阶段收集的 .dmp.json，其他 JSON 不进入这条兜底删除路径。
    if (dumpEntries.has(metadata.dumpEntry)) {
      continue;
    }

    // 旧 dump 删除成功但元数据删除失败后，下一轮已无法从 dump 集合再次触达元数据。
    // 每轮重新扫描孤立的普通 .dmp.json，使暂时性删除失败能够继续收敛，同时不触碰其他 JSON。
    try {
      unlinkSync(metadata.path);
      deletedFiles.push(metadata.path);
    } catch {
      failedFiles.push(metadata.path);
    }
  }

  return { deletedFiles, failedFiles };
}

export function archiveCrashDumps(
  paths: CrashCapturePaths,
  options?: {
    platform?: NodeJS.Platform;
    now?: Date;
    retention?: CrashArchiveRetentionPolicy;
  },
): {
  archivedFiles: string[];
  archivedDumps: ArchivedCrashDumpRecord[];
  skippedFiles: string[];
  deletedArchiveFiles: string[];
  failedArchiveFiles: string[];
} {
  // [契约] 归档前先建目录，让首次启动或独立调用也能直接落盘，不依赖 initialize 的先行调用。
  // [权衡] recursive 建目录本身幂等，重复调用无副作用，所以这里不做 existsSync 预判。
  mkdirSync(paths.archiveDir, { recursive: true });

  // [契约] platform 可注入只为测试模拟各平台目录布局，生产必须回落到 process.platform。
  // [契约] now 同理可注入；归档时间与稳定性判断共用同一个时钟，不能一处取 Date.now 一处取参数。
  const platform = options?.platform ?? process.platform;
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const archivedFiles: string[] = [];
  const archivedDumps: ArchivedCrashDumpRecord[] = [];
  const skippedFiles: string[] = [];

  for (const dir of resolveCrashReporterSourceDirs(paths.stagingDir, platform)) {
    if (!existsSync(dir)) {
      continue;
    }

    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".dmp")) {
        continue;
      }

      const dumpPath = join(dir, entry);
      if (!isStableCrashDump(dumpPath, nowMs)) {
        skippedFiles.push(dumpPath);
        continue;
      }

      try {
        const record = persistArchivedCrashDump(dumpPath, paths.archiveDir, now);
        if (record) {
          archivedFiles.push(dumpPath);
          archivedDumps.push(record);
        }
      } catch {
        skippedFiles.push(dumpPath);
      }
    }
  }

  // [契约] 无论本轮是否归档成功都执行清理，否则长期不再崩溃时旧 dump 也永远不回收。
  // [契约] retention 由调用方传入只为测试，生产走 5 个 / 100MB 的模块常量。
  const cleanupResult = pruneCrashDumpArchive(
    paths.archiveDir,
    options?.retention ?? {
      maxFiles: CRASH_ARCHIVE_MAX_FILES,
      maxTotalBytes: CRASH_ARCHIVE_MAX_TOTAL_BYTES,
    },
  );

  return {
    archivedFiles,
    archivedDumps,
    skippedFiles,
    deletedArchiveFiles: cleanupResult.deletedFiles,
    failedArchiveFiles: cleanupResult.failedFiles,
  };
}

// [并发] 两个模块级标志是 main 进程内的一次性开关，靠单线程执行保证幂等，无锁也不需要锁。
// [契约] registeredCrashEventMonitor 置 true 后不再复位，窗口重建也只保留一份 app 级监听。
// [失败路径] 标志在 start/注册之前置位：即使后续抛错也不重试，避免重复 start 覆盖已有 reporter 配置。
let hasStartedLocalCrashReporter = false;
let registeredCrashEventMonitor = false;

function logCrashArchiveCleanup(
  logger: CrashCaptureLogger,
  result: { deletedArchiveFiles: string[]; failedArchiveFiles: string[] },
  source: string,
): void {
  // [契约] 只有真正删了文件才打 info，启动路径保持安静，避免每轮空扫描刷日志。
  // [契约] 失败项走 warn 并带文件名数组，用于定位被占用或权限不足的文件。
  if (result.deletedArchiveFiles.length > 0) {
    logger.info(
      `[crash-capture] pruned ${result.deletedArchiveFiles.length} archive file(s) source=${source}`,
    );
  }
  if (result.failedArchiveFiles.length > 0) {
    logger.warn(
      `[crash-capture] failed to prune ${result.failedArchiveFiles.length} archive file(s) source=${source}`,
      result.failedArchiveFiles,
    );
  }
}

function logArchivedCrashDumpSummaries(
  logger: CrashCaptureLogger,
  result: { archivedDumps: ArchivedCrashDumpRecord[] },
  source: string,
): void {
  for (const record of result.archivedDumps) {
    const dump = basename(record.archivedDumpPath);
    // [契约] 有注解走 warn 级一行摘要，让 OOM 在日志里一击可见；无注解按 info 处理。
    // [契约] code_space_exhausted 与 js_heap_exhausted 的区分只来自注解字段，不能靠 dump 大小猜测。
    // [资源] 摘要一次性打印后不再持有 dump 内容，原始证据以 archive 内的 .dmp 与 .dmp.json 为准。
    if (record.v8OomSummary) {
      // 一行看清是哪种 OOM：code_space_exhausted 说明 256MB JIT 代码区被占满，
      // js_heap_exhausted 才是普通的 JS 堆泄漏；具体数值同时落在 archive 的 .dmp.json 里。
      logger.warn(
        `[crash-capture] v8 oom annotations source=${source} dump=${dump}`,
        record.v8OomSummary,
      );
    } else {
      logger.info(`[crash-capture] archived dump has no v8 oom annotations dump=${dump}`);
    }
  }
}

function scheduleCrashArchive(
  logger: CrashCaptureLogger,
  paths: CrashCapturePaths,
  source: string,
) {
  // [并发] 两次延迟归档是给远端 SDK 留出消费 live dump 的窗口，太早复制可能拿到未写完的文件。
  // [资源] timer.unref 让残留定时器不阻塞进程退出；去掉后崩溃后的退出会拖到 5s 上限。
  // [失败路径] 回调内没有 try，若 mkdirSync 等前置 IO 抛错会变成 main 的未捕获异常，只能依赖内部逐文件兜底。
  for (const delayMs of CRASH_ARCHIVE_RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      const result = archiveCrashDumps(paths);
      if (result.archivedFiles.length > 0) {
        logger.info(
          `[crash-capture] archived ${result.archivedFiles.length} dump(s) source=${source} delayMs=${delayMs}`,
        );
      }
      logArchivedCrashDumpSummaries(logger, result, source);
      logCrashArchiveCleanup(logger, result, source);
    }, delayMs);
    timer.unref?.();
  }
}

export function initializeCrashCapture(
  logger: CrashCaptureLogger,
  remoteCrashReporterEnabled: boolean,
): CrashCapturePaths {
  const paths = resolveCrashCapturePaths();
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.stagingDir, { recursive: true });
  mkdirSync(paths.archiveDir, { recursive: true });
  // [契约] 必须在任何 crashReporter.start 之前设置，否则本次进程的 dump 会落到 Electron 默认目录。
  // [契约] 指向 live 而不是 archive，archive 只存副本，生命周期由本文件负责。
  app.setPath("crashDumps", paths.stagingDir);

  // [契约] 启动时先归档上一轮残留再启动 reporter，保证上一次崩溃的样本不被新会话覆盖。
  // [契约] 该调用同步完成，位于 appCrashCaptureBootstrap 与 appARMSBootstrap 之间，改成异步会打乱删除顺序。
  const startupArchiveResult = archiveCrashDumps(paths);
  logCrashArchiveCleanup(logger, startupArchiveResult, "startup");
  // [契约] 恢复数量按本轮新归档计数而非 archive 总量，避免每次启动打印同一个大数字。
  // [契约] 这里用 restored 措辞，与事件触发的 archived 区分，便于判断是启动恢复还是崩溃后归档。
  if (startupArchiveResult.archivedFiles.length > 0) {
    logger.info(
      `[crash-capture] restored ${startupArchiveResult.archivedFiles.length} local dump(s) from previous runs`,
    );
  }
  logArchivedCrashDumpSummaries(logger, startupArchiveResult, "startup");

  if (!remoteCrashReporterEnabled && !hasStartedLocalCrashReporter) {
    hasStartedLocalCrashReporter = true;
    // [契约] 无远端上报时用 .invalid 域的本地占位 URL 且 uploadToServer=false，保证 dump 只落盘不外发。
    // [契约] 只在 remoteCrashReporterEnabled 为 false 时启动；远端已启用时由远端 SDK 自己 start，重复 start 会覆盖配置。
    // [契约] companyName 留空、productName 取 app.name 兜底，仅写入 dump 元信息，不影响归档路径。
    crashReporter.start({
      companyName: "",
      productName: app.name || app.getName(),
      submitURL: LOCAL_ONLY_CRASH_SUBMIT_URL,
      uploadToServer: false,
      compress: true,
    });
    // [契约] 这行是本地模式下 reporter 已就绪的唯一确认点，用于区分“未启用远端”与“启动失败”。
    // [契约] 日志不打印 submitURL 细节，避免把内部占位地址与后续真实上报地址混为一谈。
    logger.info("[crash-capture] local crashReporter started without remote upload");
  }

  logger.info(
    `[crash-capture] configured remoteCrashReporterEnabled=${String(remoteCrashReporterEnabled)} stagingDir=${paths.stagingDir} archiveDir=${paths.archiveDir}`,
  );
  return paths;
}

export interface CrashEventMonitorHooks {
  onRenderProcessGone?: (
    webContents: WebContents,
    details: { reason: string; exitCode: number },
  ) => void;
  onChildProcessGone?: (details: {
    type: string;
    reason: string;
    exitCode: number;
    serviceName?: string;
    name?: string;
  }) => void;
  onBrowserWindowCreated?: (win: BrowserWindow) => void;
}

export function resolveProcessGoneLogLevel(reason: string): "info" | "warn" {
  // Bug 原因：Electron 也会为 clean-exit / killed 这类受控终止发送 gone 事件。
  // 原始 gone 回调只记录生命周期事实，最终是否为 crash 交给稳定性分类；旧实现无条件打
  // error，随后被 ARMS console collector 当作异常，污染错误统计。
  return reason === "clean-exit" || reason === "killed" ? "info" : "warn";
}

export function registerCrashEventMonitor(
  logger: CrashCaptureLogger,
  paths: CrashCapturePaths,
  hooks?: CrashEventMonitorHooks,
): void {
  // [并发] 模块级去重，多窗口重复调用直接返回；改成按窗口注册会让同一崩溃重复归档。
  // [契约] 早退发生在绑定 app 监听之前，所以 paths 只以第一次调用传入的为准。
  if (registeredCrashEventMonitor) {
    return;
  }
  registeredCrashEventMonitor = true;

  // [契约] 日志必须只记录 lifecycle 事实（reason/exitCode/url），是否为 crash 交给稳定性分类，不在这里下结论。
  // [契约] 先打日志再调 hook：hook 抛错时日志已落地，不会因为外部回调失败而丢现场。
  // [并发] 每次 gone 必须排两次延迟归档，可能与其他窗口事件叠加，但归档按文件名幂等。
  app.on("render-process-gone", (_event, webContents, details) => {
    logger[resolveProcessGoneLogLevel(details.reason)]("[crash-capture] render-process-gone:", {
      webContentsId: webContents.id,
      reason: details.reason,
      exitCode: details.exitCode,
      name: webContents.getType(),
      url: webContents.getURL(),
    });
    hooks?.onRenderProcessGone?.(webContents, details);
    // 远端 crash SDK 可能会在处理后清理 live 目录里的原始 dmp。
    // 这里在事件后补两次延迟归档，把原始 dump 复制到 ~/.zcode/v2/crash/archive，
    // 这样既保留线上上报，又能在本地留下一份可供排查的副本。
    scheduleCrashArchive(logger, paths, "render-process-gone");
  });

  app.on("child-process-gone", (_event, details) => {
    logger[resolveProcessGoneLogLevel(details.reason)](
      "[crash-capture] child-process-gone:",
      details,
    );
    hooks?.onChildProcessGone?.(details);
    scheduleCrashArchive(logger, paths, "child-process-gone");
  });

  app.on("browser-window-created", (_, win) => {
    hooks?.onBrowserWindowCreated?.(win);
    // [契约] 只在调用方没接管时挂 unresponsive 监听，避免与外部 hook 重复上报。
    // [契约] unresponsive 只 warn 不归档：此时进程没死、dump 尚不存在，触发归档只会空扫。
    if (!hooks?.onBrowserWindowCreated) {
      win.webContents.on("unresponsive", () => {
        logger.warn("[crash-capture] window became unresponsive:", {
          windowId: win.id,
          webContentsId: win.webContents.id,
          url: win.webContents.getURL(),
        });
      });
    }
  });
}
