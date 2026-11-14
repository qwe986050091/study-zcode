// ============================================================
// 文件定位：Bash 工具「内联可见输出」预算的唯一解析点，位于输出截断策略的上游。
// 输入输出：读 BASH_MAX_OUTPUT_LENGTH 与请求侧 fallback，返回字节上限（正整数）。
// 副作用：无（纯函数，不启动进程、不读写文件）。
// 失败语义：空串/非数字/非正数一律静默回退默认值，绝不抛出；超过硬上限时削平。
// 不变量：返回值恒为有限正数且 <= 150_000；环境变量优先于请求 fallback。
// ============================================================
// 默认 30k 字节：在不撑爆上下文的前提下容纳常见命令输出。
const DEFAULT_BASH_MAX_OUTPUT_LENGTH = 30_000;
const MAX_BASH_MAX_OUTPUT_LENGTH = 150_000;

// 解析本次 Bash 可回灌模型的内联输出上限（字节）。
// 优先级：BASH_MAX_OUTPUT_LENGTH（非空且合法）> requestFallback > 30_000。
// 返回有限正数且不超过硬上限；非法配置静默回退，避免一条环境变量错误直接中断命令。
export function resolveBashMaxOutputLength(
  processEnv: NodeJS.ProcessEnv,
  requestFallback = DEFAULT_BASH_MAX_OUTPUT_LENGTH,
): number {
  const configured = processEnv.BASH_MAX_OUTPUT_LENGTH;
  if (configured === undefined) {
    return normalizeRequestFallback(requestFallback);
  }
  // 空串等价于“未配置”，不能按 0 处理，否则会把 Bash 输出全部截断。
  if (configured.trim() === "") return DEFAULT_BASH_MAX_OUTPUT_LENGTH;

  const parsed = Number.parseInt(configured, 10);
  // 解析失败或非正数不能退化成“零输出”，统一回默认值。
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BASH_MAX_OUTPUT_LENGTH;
  }
  // 硬上限防止环境变量把单次输出放大到压垮上下文窗口。
  return Math.min(parsed, MAX_BASH_MAX_OUTPUT_LENGTH);
}

// 请求侧 fallback 同样受硬上限约束；负数/NaN 视为未设置，回默认值。
function normalizeRequestFallback(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_BASH_MAX_OUTPUT_LENGTH;
  return Math.min(value, MAX_BASH_MAX_OUTPUT_LENGTH);
}
