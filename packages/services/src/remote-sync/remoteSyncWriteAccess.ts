// 远端同步写入前必须先探测目录：只验证能否创建并删除文件，不校验配额策略与权限模型。
// 边界：单目录探测不清理已存在的目录，探测失败也不改变目录状态；上层按首个失败短路。
// 不变量(INV)：成功返回前必须删除 marker，不能把探针文件留在用户的同步目录里。
// 改错会怎样：探针残留会触发同步冲突或上传脏数据；吞掉异常会把不可写目录误报为可用。
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RemoteSyncWriteAccessResult } from "@zcode/shared";

// 单目录探测：任何异常都归一化为 ok:false，调用方无需区分 errno 细节。
export async function checkRemoteSyncDirectoryWriteAccess(
  directoryPath: string,
): Promise<RemoteSyncWriteAccessResult> {
// 探针必须放在目标目录内部而非系统临时目录，才能覆盖该目录本身的写权限与配额。
  const markerPath = join(directoryPath, `.zcode-sync-preflight-${process.pid}-${randomUUID()}`);
  try {
// recursive 允许目录尚不存在；若创建失败则不会写出 marker，后续无需额外清理。
    await mkdir(directoryPath, { recursive: true });
// flag: "wx" 保证不覆盖同名文件；文件名带 pid+uuid，避免多进程并发探测互相踩踏。
    await writeFile(markerPath, "ok", { encoding: "utf-8", flag: "wx" });
    // 成功路径必须立即删除探针，否则 marker 会留在用户同步目录里被当成待同步文件上传。
    await rm(markerPath, { force: true });
    return { ok: true, path: directoryPath };
  } catch (error) {
    // 失败清理不能覆盖原始错误：force 让文件不存在时静默，catch 吞掉清理自身的异常。
    await rm(markerPath, { force: true }).catch(() => undefined);
    return {
      ok: false,
      path: directoryPath,
      // 只保留 message 文本，调用方不依赖 errno；非 Error 抛出物也转成字符串，保证结果类型稳定。
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// 批量探测按顺序短路：首个不可写目录即返回，保留其 path 与 error 作为唯一根因。
// 选择顺序而非并行：避免一次在多个目录留下探针，也让失败归因确定、可复现。
export async function checkRemoteSyncDirectoriesWriteAccess(
  directoryPaths: readonly string[],
): Promise<RemoteSyncWriteAccessResult> {
  for (const directoryPath of directoryPaths) {
    // 逐个目录串行探测：首个失败立即返回其 path 与 error，后续目录不再留下探针。
    const result = await checkRemoteSyncDirectoryWriteAccess(directoryPath);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true, path: directoryPaths.join(", ") };
}
