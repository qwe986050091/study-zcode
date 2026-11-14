// ============================================================
// memory/directory —— project Memory 根目录的幂等预创建
// ============================================================
//
// 【定位】Memory 链路最早的一步：context 初始化时确保 memoryRoot 已存在，
//   让后续 Write 工具可以“直接写、不必先探测目录”。
// 【读写边界】只经 FileSystemPort.createDirectory 建目录；不读、不写任何记忆文件，
//   也不触碰 MEMORY.md 索引内容。
// 【失效/过期口径】目录是否存在是廉价可重算事实，不做缓存；
//   建目录失败后下次 context 初始化会再次尝试。
// 【副作用】可能创建目录；失败仅记 debug 日志。
// ============================================================
import {
  traceContextToLogContext,
  type FileSystemPort,
  type Logger,
  type TraceContext,
} from "@zcode/contracts";

/**
 * 幂等预创建 project Memory 根目录。
 * 输入：FileSystemPort、rootDir（memoryRoot 绝对路径）、可选 traceContext 与 logger。
 * 输出：Promise<void>；目录已存在时不报错。
 * 副作用：可能创建目录；失败只写 debug 日志，不写索引、不读文件。
 * 失败语义：吞掉所有建目录错误，调用方按“目录可能缺失”降级；
 *   真正的用户可见错误来自后续 Write/Edit 的文件系统返回。
 * 不变量：预创建只是便利，不是 Memory 正确性前提；
 *   目录创建失败不得阻断 context 初始化。
 */
export async function ensureMemoryDirectoryExists(
  fileSystemPort: FileSystemPort,
  rootDir: string,
  traceContext?: TraceContext,
  logger?: Logger,
): Promise<void> {
  try {
    await fileSystemPort.createDirectory({ path: rootDir, trace: traceContext });
  } catch (error) {
    // 目录预创建失败不阻断执行；实际 Write/Edit 仍返回原始文件错误。
    // 因此这里只保留可观测信号（debug + 结构化 event），不重新抛出。
    logger?.debug("Memory directory creation failed", {
      ...(traceContext ? traceContextToLogContext(traceContext) : {}),
      error: error instanceof Error ? error.message : String(error),
      event: "memory.directory.create_failed",
      module: "core.memory",
      status: "failed",
    });
  }
}
