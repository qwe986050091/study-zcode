// 工作区 Git 分支解析：供 TUI 启动与切换工作区时展示当前分支名。
// 外部命令调用收敛在本文件，调用方只拿到 string | undefined，不感知进程细节与错误形态。
// 失败口径（目录不是仓库、未安装 git、超时、输出超限）统一降级为 undefined，由 UI 自行隐藏分支标识。
// 该查询是纯只读操作：不修改工作区、不写持久化、不产生事件与日志；超时与输出上限保证不阻塞 TUI 首屏。

import { spawn } from "node:child_process";

// 直接按 PATH 解析 git，跨平台差异（.exe/.cmd）交由 spawn 处理，不经过 shell 拼接。
const GIT_COMMAND = "git";
// symbolic-ref 只解析 HEAD 的符号引用；游离 HEAD 或非仓库会以非 0 退出，天然作为失败信号。
const GIT_BRANCH_ARGS = ["symbolic-ref", "--quiet", "--short", "HEAD"];
// 子进程预算 750ms：分支名属装饰性信息，超时即放弃，避免拖慢 TUI 首屏渲染。
const DEFAULT_GIT_TIMEOUT_MS = 750;
// 正常分支名远小于 512 字节；超限说明输出异常（如被包装脚本污染），按失败处理并 kill。
const DEFAULT_GIT_OUTPUT_LIMIT_BYTES = 512;
// 个别 git 实现或包装脚本会把游离 HEAD 输出为 "HEAD"，这里作为防御性失败标记保留。
const DETACHED_HEAD_LABEL = "HEAD";

// 子进程结果的最小契约：调用方只关心退出码与 stdout，stderr 与 stdin 均被丢弃。
type GitCommandResult = {
  // 进程退出码；null 表示被信号终止，-1 表示本模块自行判定的失败（spawn 异常、超时、输出超限）。
  exitCode: number | null;
  // 已收集的标准输出；超时或超限场景下可能是部分内容，所以非 0 退出码时禁止再解析它。
  stdout: string;
};

// 命令执行器的注入点：默认实现为 runGitCommand，测试可替换为纯函数以避免真实子进程。
type GitCommandRunner = (
  file: string,
  args: string[],
  options: {
    // 允许累积的 stdout 字节上限，超出即 kill 子进程并返回失败；单位：字节。
    maxOutputBytes: number;
    // 从 spawn 到强制 kill 的墙钟上限；单位：毫秒。
    timeoutMs: number;
  },
) => Promise<GitCommandResult>;

// 解析工作区当前 git 分支名。
// 输入：workspaceDirectory 必填并原样作为 git -C 的实参（不做归一化）；timeoutMs / maxOutputBytes 可覆盖默认预算；
// runCommand 仅供测试注入，缺省使用真实子进程实现。
// 输出：成功时为去掉首尾空白与换行后的首行分支名；非仓库、游离 HEAD、超时、输出超限、执行器抛错一律返回 undefined。
// 副作用：启动一个只读子进程，stdin/stderr 忽略；不写文件、不发事件、不打印日志。
// 不变量：返回值要么是 undefined，要么是非空且不等于 "HEAD" 的单行字符串。
export async function resolveWorkspaceGitBranch(options: {
  // stdout 字节上限，缺省 DEFAULT_GIT_OUTPUT_LIMIT_BYTES；仅影响异常输出的判定。
  maxOutputBytes?: number;
  // 命令执行器注入点，缺省为真实的 spawn 实现。
  runCommand?: GitCommandRunner;
  // 子进程墙钟上限，缺省 DEFAULT_GIT_TIMEOUT_MS；单位：毫秒。
  timeoutMs?: number;
  // 待查询的工作区目录绝对路径（调用方负责给出，本函数不校验其存在性）。
  workspaceDirectory: string;
}): Promise<string | undefined> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_LIMIT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  // 缺省值统一用 ?? 解析：仅 undefined 时回落默认，显式 0 等合法值不会被误当成"未传"。
  const runCommand = options.runCommand ?? runGitCommand;
  // 注入的执行器（尤其自定义/异步实现）可能 reject；统一折算为失败结果，防止异常穿透到 TUI 渲染路径。
  const result = await runCommand(
    GIT_COMMAND,
    ["-C", options.workspaceDirectory, ...GIT_BRANCH_ARGS],
    {
      maxOutputBytes,
      timeoutMs,
    },
  ).catch(() => ({ exitCode: -1, stdout: "" }));

  // 非 0 退出码覆盖了"非 git 目录 / 游离 HEAD / spawn 失败 / 超时 / 输出超限"等全部失败场景，统一按无分支展示。
  if (result.exitCode !== 0) return undefined;

  // 只取首行并 trim：输出上限可能截断尾部，多行内容只认第一条，避免把警告文本带进 UI。
  const branch = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
  // 空输出与字面 "HEAD" 都不是可用分支名，返回 undefined 而不是空串，调用方只需判空一次。
  if (!branch || branch === DETACHED_HEAD_LABEL) return undefined;
  return branch;
}

// 默认命令执行器：spawn 一个子进程并收集 stdout，保证 Promise 只结算一次且永不 reject。
// 输入/输出：与 GitCommandRunner 契约一致；stderr 与 stdin 均忽略，只看 stdout 与退出码。
// 失败降级：spawn 同步抛错、超时、输出超限、进程 error 事件都折算为 exitCode = -1，调用方无需 try/catch。
// 不变量：resolve 前一定已清理定时器；可多次触发的事件（close/error/超时/超限）由 settled 去重只取首个。
async function runGitCommand(
  file: string,
  args: string[],
  options: {
    maxOutputBytes: number;
    timeoutMs: number;
  },
): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    // spawn 在 ENOENT/EACCES 等场景会同步抛出；此处必须捕获并立即 resolve，否则 Promise 永远悬空。
    try {
      child = spawn(file, args, {
        // 不接 stdin，stderr 丢弃（git 的失败信息通过退出码表达即可），仅 stdout 建管道。
        stdio: ["ignore", "pipe", "ignore"],
        // Windows 下避免弹出控制台窗口，保证 TUI 界面不被干扰。
        windowsHide: true,
      });
    } catch {
      resolve({ exitCode: -1, stdout: "" });
      return;
    }

    let stdout = "";
    // settled 是唯一的结算闸门：超时、超限、error、close 可能先后触发，靠它保证 resolve 只执行一次。
    let settled = false;
    // 超时到点先 kill 再结算，避免子进程在 TUI 里继续存活；返回 -1 使上层按"无分支"处理。
    const timeout = setTimeout(() => {
      child.kill();
      finish({ exitCode: -1, stdout });
    }, options.timeoutMs);

    // 幂等结算：重复调用直接返回；成功结算时务必清掉定时器，否则进程会被悬空定时器拖住。
    const finish = (result: GitCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    // 按字节而非字符累计：多字节 UTF-8 下用字符串长度会低估体积，可能导致输出上限失效。
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > options.maxOutputBytes) {
        // 超限即 kill 并标记失败；已读内容保留在 stdout 中，但 exitCode = -1 表示其不完整、不可信。
        child.kill();
        finish({ exitCode: -1, stdout });
      }
    });
    // spawn 失败（如找不到可执行文件）会走 error 事件；此时 close 可能不再触发，需单独结算。
    child.on("error", () => finish({ exitCode: -1, stdout }));
    // 正常路径：close 携带真实退出码，是唯一会把非 -1 退出码透给调用方的入口。
    child.on("close", (exitCode) => finish({ exitCode, stdout }));
  });
}
