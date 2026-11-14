// CLI 工作目录解析边界：把 `--cwd` 参数折叠成经过校验的绝对路径。
// 各子命令入口只应通过本模块决定进程工作目录，避免同一参数在不同命令下语义漂移。
import { statSync } from "node:fs";
import { resolve } from "node:path";

// 解析 `--cwd` 所需的依赖全部由调用方注入，便于在测试里替换 cwd 与文件系统状态。
interface ResolveCliCwdOptions {
  // 进程基准目录的取值函数；返回值应为绝对路径，相对 `--cwd` 以它为基准拼接。
  cwd: () => string;
  // 用户通过 `--cwd` 显式给出的路径；`undefined` 表示未指定，此时直接沿用 cwd()。
  // 注意空字符串是有意传入的空值，不等同于未指定。
  requestedCwd?: string;
}

const CWD_OPTION_LABEL = "--cwd";

// 解析并校验 CLI 的工作目录。
// 输入：`options.cwd()` 作为基准目录；`requestedCwd` 为 `undefined` 表示不覆盖，空字符串属于非法参数。
// 输出：总是绝对路径（经 resolve 归一化），调用方可直接用于文件、Git 与子进程 cwd。
// 副作用：只读文件系统（statSync），不创建、不切换、不持久化任何目录。
// 失败语义：路径不可访问或指向非目录时抛错，不做猜测性回退；错误 cause 保留系统原始错误。
export function resolveCliCwd(options: ResolveCliCwdOptions): string {
  const baseDirectory = options.cwd();
  // 未传 --cwd 与传了空值必须区分：后者是用户输入错误，静默沿用基准目录会掩盖拼写问题。
  if (options.requestedCwd === undefined) return baseDirectory;

  if (options.requestedCwd.length === 0) {
    throw new Error(`${CWD_OPTION_LABEL} requires a non-empty path.`);
  }

  const workingDirectory = resolve(baseDirectory, options.requestedCwd);
  // resolve 只做字符串归一化，不能证明目标存在；必须再 stat 一次才能排除不存在与文件路径。
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(workingDirectory);
  } catch (error) {
    throw new Error(`${CWD_OPTION_LABEL} path is not accessible: ${workingDirectory}`, {
      cause: error,
    });
  }

  if (!stats.isDirectory()) {
    throw new Error(`${CWD_OPTION_LABEL} must point to a directory: ${workingDirectory}`);
  }

  return workingDirectory;
}
