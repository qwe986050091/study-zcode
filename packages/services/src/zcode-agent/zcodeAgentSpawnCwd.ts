import { stat } from "node:fs/promises";

/** 只选择执行目录，不捕获数据库错误；无可用备用目录时保留原路径供正常启动报错。 */
// 只决定子进程工作目录，不捕获数据库错误；probe 可注入，测试无需真实文件系统。
// 返回值里的 cwdExists 供调用方区分「目录可用」与「回退到兜底」。
export async function resolveZCodeAgentSpawnCwd(
  options: { requestedCwd: string; workspacePath: string; spawnFallbackCwd?: string },
  probe: (path: string) => Promise<{ isDirectory(): boolean }> = stat,
): Promise<{ cwd: string; usedFallback: boolean; cwdExists: boolean }> {
// 任何探测异常都按不可用处理，保持与旧 Agent 一致的备用 cwd 语义。
  const usable = async (path: string | undefined) => {
    if (!path) return false;
    try {
      return (await probe(path)).isDirectory();
    } catch {
      // 旧 Agent 对失效历史目录统一使用备用 cwd；ENOTDIR/EACCES 也必须保持这一语义。
      return false;
    }
  };
  const cwdExists = await usable(options.requestedCwd);
  if (
// [失败路径] 只有「请求目录就是 workspace 且确实不存在」时才允许回退；
// 调用方显式指定的其他目录即使不可用也原样返回，交由正常启动报错。
    options.requestedCwd === options.workspacePath &&
    !cwdExists &&
    (await usable(options.spawnFallbackCwd))
  )
    return { cwd: options.spawnFallbackCwd!, usedFallback: true, cwdExists: true };
  return { cwd: options.requestedCwd, usedFallback: false, cwdExists };
}
