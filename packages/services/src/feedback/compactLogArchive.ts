// 反馈日志归档的编排层：决定打包什么、打到哪、要不要全量，实际压缩必须委托给 feedbackLogArchive。
// 边界：不实现压缩与进度计算，只做来源选择与体积上限策略；清理越界会误删本次产物之外的目录。
// 不变量：默认（非 full）归档必须有 2MiB 上限，防止日志无限增长把临时目录打爆。
// 失败路径：删除是尽力而为（force 且吞异常），清理失败不得影响已经成功产出的归档。
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir, getFeedbackLogArchiveDir } from "../paths.js";
import { createFeedbackDiagnosticArchive } from "./feedbackLogArchive.js";

interface ArchiveProgressEvent {
  processedBytes: number;
  totalBytes: number;
}

// 返回的 path 指向归档文件本身，size 是最终字节数，调用方据此展示与决定是否上传。
// full 与 createFullArchive 必须成对传入：只给 full 而没有实现时退回受限归档，避免产出失控的大包。
export async function prepareCompactLogArchive(options?: {
  full?: boolean;
  createFullArchive?: (
    sourceDir: string,
    options?: { onProgress?: (event: ArchiveProgressEvent) => void },
  ) => Promise<{ path: string; size: number }>;
  onProgress?: (event: ArchiveProgressEvent) => void;
}): Promise<{ path: string; size: number }> {
  const sourceDir = getAppConfigDir();
// 全量分支完全交给注入实现，本层不加限制；maxTotalBytes 只作用于默认分支，两种语义不可混用。
// 用条件展开而非先赋值再修改，是为了让 maxTotalBytes 在非 full 时「不存在」而不是 undefined。
  if (options?.full && options.createFullArchive) {
    return options.createFullArchive(sourceDir, { onProgress: options.onProgress });
  }
  return createFeedbackDiagnosticArchive({
    sources: [{ directory: join(sourceDir, "logs"), archivePrefix: "logs" }],
    outputRootDir: getFeedbackLogArchiveDir(),
    ...(!options?.full ? { maxTotalBytes: 2 * 1024 * 1024 } : {}),
    onProgress: options?.onProgress,
  });
}

// 归档写入时把内容放在 path 同级的目录结构中，所以清理要上跳一级而不是直接删文件。
// 幂等且失败静默：重复清理或不存在的路径都视为成功，避免向用户暴露无意义的清理错误。
export async function cleanupLogArchive(path: string): Promise<void> {
  await rm(join(path, ".."), { recursive: true, force: true }).catch(() => {});
}
