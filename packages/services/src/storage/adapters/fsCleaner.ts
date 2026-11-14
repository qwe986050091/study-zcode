/**
 * 清理执行器：枚举候选（递归 / 非递归两种范围）与有界并发删除。
 * 删除后自底向上移除变空的目录，但保留 keepDirectories（类别顶层目录），写入方不必重新 mkdir。
 */
// 边界：枚举阶段只读元数据（lstat 不跟随符号链接），删除阶段使用 rm 且 force:false，确保目标真存在才计成功。
// 错误按候选粒度收集进 failures，不让单个文件失败中断整批清理。
import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { FsCleanerPort, StorageDeleteResult } from "../app/ports.js";
import type { StorageCleanCandidate } from "../domain/cleanPlan.js";
import type { StorageCleanScope } from "../domain/storageCatalog.js";
import { normalizeStorageRelativePath } from "../domain/storageCatalog.js";
import { walkStorageRoot } from "./fsWalker.js";

// 并发上限固定为 8：既能摊薄单次 rm 的延迟，又避免大量并行 unlink 触发 Windows 上的句柄/杀毒扫描抖动。
// 这里用固定 worker 数而不是 Promise.all 全量并发，使内存与句柄占用不随候选数量增长。
const DELETE_CONCURRENCY = 8;

// errorCode 的返回值直接进 StorageDeleteResult：只能是 ENOENT/EACCES/UNKNOWN 这类稳定枚举，不能把 message 透给上层。
function errorCode(error: unknown): string {
  // 只白名单字符串 code：message 可能含完整路径，透出即把本机目录结构泄漏到上层展示。
  // fs 错误用字符串 code（ENOENT/EACCES）；非对象或自定义错误统一归为 UNKNOWN，让上层只处理有限几种。
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

// 非递归范围：只列出 prefix 目录下一层文件，子目录整体保留（由上层决定是否对子目录单独建 scope）。
// 目录不存在视为「无候选」而不是错误，因为该目录可能从未创建，清理应当幂等。
// 逐项 lstat 而不是用 readdir 的 withFileTypes，是为了同时拿到 size 与 mtime。
async function listShallow(rootPath: string, prefix: string): Promise<StorageCleanCandidate[]> {
  // prefix 直接交给 join：这里不做规范化与越界判断，非法前缀由 deleteFiles 的最后一道校验统一兜住。
  const directoryPath = join(rootPath, prefix);
  let names: string[];
  try {
    // readdir 只取名字，随后逐项 lstat：把「目录不存在」的错误集中在这一处被吞掉，幂等清理才有保证。
    names = await readdir(directoryPath);
  } catch {
    return [];
  }
  const candidates: StorageCleanCandidate[] = [];
  for (const name of names) {
    try {
      // lstat 不跟随符号链接：若跟随，链接指向的仓库外文件会被计入清理候选并被 rm，越界删除无法回滚。
      // 只收 isFile 的条目，目录交由 pruneEmptyParents 在删除后统一处理。
      const stats = await lstat(join(directoryPath, name));
      // 目录、符号链接与 socket 都跳过：删除阶段只 rm 普通文件，空目录留给 pruneEmptyParents 统一判断。
      if (!stats.isFile()) continue;
      candidates.push({
        // 相对路径统一用正斜杠拼 prefix/name：下游 normalizeStorageRelativePath 与 join 都按这个口径解读。
        relativePath: `${prefix}/${name}`,
        bytes: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      // 枚举期间被删除的文件跳过即可
    }
  }
  return candidates;
}

// 递归范围：复用 walkStorageRoot 的遍历口径，保证与用量统计看到的是同一批文件。
// listRecursive 不捕获 walkStorageRoot 的遍历错误，必须由调用方决定降级；prefix 只做字符串拼接，越界校验统一留给下游。
// 返回的是「写入时已确定的相对路径」，期间文件增减由删除阶段的失败项体现。
async function listRecursive(rootPath: string, prefix: string): Promise<StorageCleanCandidate[]> {
  // 前置条件：prefix 来自 StorageCleanScope 常量表，不是用户输入；若将来放开，必须先在这里校验越界。
  const candidates: StorageCleanCandidate[] = [];
  await walkStorageRoot({
    // 遍历根先拼上 prefix，因此 onEntry 给出的 relativePath 是相对 prefix 的，回填时还要补回前缀。
    rootPath: join(rootPath, prefix),
    // onEntry 逐项回调即收集，不做二次遍历；prefix 必须交给 deleteFiles 统一归一化，否则两处规则会漂移。
    onEntry: (entry) =>
      candidates.push({ ...entry, relativePath: `${prefix}/${entry.relativePath}` }),
  });
  return candidates;
}

// 删除完成后自底向上尝试 rmdir，恢复正常目录结构；失败一律忽略。
// 忽略失败的原因：目录非空（仍有保留文件）、目录被其他写入方删除、权限不足都属于正常竞态。
// keepDirectories 内的目录（类别顶层）永不进入候选，保证写入方后续无需重新 mkdir。
async function pruneEmptyParents(
  rootPath: string,
  deletedRelativePaths: string[],
  keepDirectories: Set<string>,
): Promise<void> {
  // 先处理最深的目录，父目录才有机会变空。
  const directories = new Set<string>();
  for (const path of deletedRelativePaths) {
    // 从被删文件的父目录起步：文件本身已删除，再对它 rmdir 只会得到 ENOTDIR 噪声失败。
    let current = dirname(path);
    // current === '.' 必须终止：dirname('.') 仍然是 '.'，少了这个条件循环会永远停不下来。
    while (current && current !== "." && !keepDirectories.has(current)) {
      directories.add(current);
      current = dirname(current);
    }
  }
  // 按层级深度降序执行，子目录先删，父目录才可能变空；同深度顺序无关。
  // 按 / 的段数衡量深度：同一深度先后无所谓，跨深度必须深的在前，父目录才有机会变空。
  const ordered = [...directories].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const directory of ordered) {
    // rm 失败必须忽略：目录可能因用户新增文件而非空，或已被并发删除，清理不能因此整体中断。
    await rmdir(join(rootPath, directory)).catch(() => {});
  }
}

// 工厂不持有状态：每次调用都基于传入 rootPath 与 scopes 重新枚举，避免缓存导致「列出后已删除」的陈旧结果。
// 返回对象同时暴露枚举与删除两个能力，便于上层先展示候选、用户确认后再执行删除。
export function createFsStorageCleaner(): FsCleanerPort {
  return {
    async listCandidates(rootPath: string, scopes: StorageCleanScope[]) {
      // 前置条件：scopes 是清理边界的唯一来源；允许外部传入任意 prefix 等于放开删除范围。
      // 各范围互不依赖，并行枚举降低总延迟；浅层枚举内部已吞掉「目录不存在」的错误。
      // 任一递归范围抛错都会让整次枚举失败，这是有意的：列表不完整时不应引导用户执行清理。
      const lists = await Promise.all(
        scopes.map((scope) =>
          scope.recursive
            ? listRecursive(rootPath, scope.prefix)
            : listShallow(rootPath, scope.prefix),
        ),
      );
      // 递归范围与非递归范围可能重叠（cli/db/backup 与 cli/db），按路径去重。
      // 去重以规范化后的相对路径为键，重复出现时后写入的候选覆盖前者（大小可能来自不同 scope 的同一文件）。
      const byPath = new Map<string, StorageCleanCandidate>();
      for (const candidate of lists.flat()) {
        byPath.set(normalizeStorageRelativePath(candidate.relativePath), candidate);
      }
      return [...byPath.values()];
    },

    // 删除阶段永不抛错：所有失败都记录为 { path, code }，成功项才累加计数与释放字节。
    // freedBytes 按枚举时记录的大小累加，而不是删除后重新 stat（文件已不存在），因此只是估算值。
    // deleted 列表只含真正删除成功的路径，供后续 pruneEmptyParents 收敛目录。
    async deleteFiles(rootPath, targets, options): Promise<StorageDeleteResult> {
      // 前置条件：targets 必须来自 listCandidates 的枚举结果；即使如此，下面仍按 relative 反查兜底越界。
      // 结果对象在所有分支共用：失败项不中断循环，因此 deletedCount 与 failures 可能同时非零，汇总时不能二选一。
      const result: StorageDeleteResult = { deletedCount: 0, freedBytes: 0, failures: [] };
      // deleted 只收成功项供 pruneEmptyParents 使用；把失败路径也放进去会让未清空的目录被误判为空。
      const deleted: string[] = [];
      // 复制到 queue 再 shift：直接消费调用方数组会让上层重试时拿到空列表，删除静默失效。
      const queue = [...targets];
      const worker = async () => {
        for (let target = queue.shift(); target; target = queue.shift()) {
          const relativePath = normalizeStorageRelativePath(target.relativePath);
          // join 会消化 .. 段，所以越界判断必须在 join 之后用 relative 反查真实落点，而不是只校验入参字符串。
          const absolutePath = join(rootPath, relativePath);
          const back = relative(rootPath, absolutePath);
          // 越界防护：join 后若相对路径回溯到 rootPath 之外（含 .. 段），直接记为 EOUTSIDE 并跳过删除。
          // 这是删除链路的最后一道校验，不能依赖上层传入的路径已规范化。
          if (back.startsWith("..") || back.split(sep).includes("..")) {
            result.failures.push({ path: relativePath, code: "EOUTSIDE" });
            continue;
          }
          try {
            // force:false 让「文件已被并发删除」变成 ENOENT 失败项而不是静默成功，deleted 列表才可信。
            await rm(absolutePath, { force: false });
            result.deletedCount += 1;
            result.freedBytes += target.bytes;
            deleted.push(relativePath);
          } catch (error) {
            result.failures.push({ path: relativePath, code: errorCode(error) });
          }
        }
      };
      // 固定起 8 个 worker 消费同一队列：候选少于 8 个时多出的 worker 立即结束，不会空转等待。
      await Promise.all(Array.from({ length: DELETE_CONCURRENCY }, worker));
      // keepDirectories 每次转成 Set：调用方可能传数组，逐项 includes 在深目录上会退化成二次方复杂度。
      await pruneEmptyParents(rootPath, deleted, new Set(options.keepDirectories));
      return result;
    },
  };
}
