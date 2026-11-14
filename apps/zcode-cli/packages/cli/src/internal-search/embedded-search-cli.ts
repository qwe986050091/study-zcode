// 内嵌搜索 CLI：把 `find` / `grep` 请求转发给随包分发的原生搜索二进制，并负责参数兜底、
// 取消传播、下游关流（EPIPE）收敛与退出码归一化。仅在 __internal-search 包装层内使用，不直接面向用户。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// 支持的子命令；与原生二进制的可执行名一一对应，其余值一律拒绝。
export type EmbeddedSearchCommand = "find" | "grep";

// 输出目标的鸭子类型：只声明嵌入方真正依赖的能力，便于测试用内存流替换。
type EmbeddedSearchWritable = {
  // 目标流是否已被销毁；为真时跳过写入，避免向已关闭的流写数据。
  destroyed?: boolean;
  // 解绑/绑定 error 监听；可选，简化实现（如内存流）可以不提供。
  off?(event: "error", listener: (error: NodeJS.ErrnoException) => void): void;
  on?(event: "error", listener: (error: NodeJS.ErrnoException) => void): void;
  // 写入一个 chunk；返回 false 表示背压，本模块忽略该信号（搜索输出不做节流）。
  write(chunk: string | Uint8Array): boolean | void;
};

// grep 的缺省注入开关：-G 用基础正则、-I 跳过二进制文件，并排除常见版本库目录，避免结果被仓库元数据污染。
const GREP_DEFAULT_ARGS = [
  "-G",
  "-I",
  "--exclude-dir=.git",
  "--exclude-dir=.svn",
  "--exclude-dir=.hg",
  "--exclude-dir=.bzr",
  "--exclude-dir=.jj",
  "--exclude-dir=.sl",
] as const;

// 与缺省注入参数冲突、或会改变 ugrep/GNU grep 语义的参数；命中任一即完全放弃缺省值，按用户原样转发。
const GREP_BYPASS_PATTERNS = [
  /^-.*-filter.*$/u,
  /^-.*-pager.*$/u,
  /^-.*-view.*$/u,
  /^-.*-format-open.*$/u,
  /^-.*-config.*$/u,
  /^---.*$/u,
  /^-@.*$/u,
  /^-.*-save-config.*$/u,
  // ugrep 的 -z/-Z 与 GNU grep 的 null-data 语义不同；这些参数必须绕回系统 grep。
  /^-[Zz].*$/u,
  /^-[^-].*[Zz].*$/u,
  /^--null$/u,
  /^--null-data$/u,
] as const;

// 下游提前关流（如 `grep ... | head`）时 Node 抛出的错误码集合：属于正常早停，不是失败。
const OUTPUT_CLOSED_ERROR_CODES = new Set(["EPIPE", "EIO", "ENXIO", "EBADF"]);
// SIGTERM 之后等待多久升级为 SIGKILL，避免取消时残留原生搜索进程。
const SIGTERM_TO_SIGKILL_MS = 750;
// 没有具体信号可归因的取消，统一用 130（等价于 SIGINT 的 shell 约定）。
const DEFAULT_ABORT_EXIT_CODE = 130;
// 信号 → shell 约定的退出码；未列出的信号回落到 DEFAULT_ABORT_EXIT_CODE 或 1。
const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
// 取消原因的判别标记，确保只认本模块自己构造的 reason，不误读外部 AbortSignal 的任意值。
const EMBEDDED_SEARCH_ABORT_REASON = "embedded-search-abort";

// 取消原因的结构化载荷：让退出码计算不依赖错误字符串。
interface EmbeddedSearchAbortReason {
  // 要返回给包装层的退出码（如 130/129/143）。
  exitCode: number;
  // 类型判别标记，恒等于 EMBEDDED_SEARCH_ABORT_REASON。
  kind: typeof EMBEDDED_SEARCH_ABORT_REASON;
  // 触发取消的信号名；由父 signal 外部传入的取消可为 undefined。
  signal?: NodeJS.Signals;
}

// 一次内嵌搜索所需的运行时依赖。
export interface EmbeddedSearchIo {
  // 子进程工作目录，决定相对搜索路径的解析基准。
  cwd: string;
  // 外部取消信号；aborted 后立即终止子进程并按对应信号返回退出码。
  signal?: AbortSignal;
  // 错误输出目标；子进程 stderr 原样转发到此。
  stderr: EmbeddedSearchWritable;
  // 标准输入；省略时立即关闭子进程 stdin（find 与仅按文件的 grep 都不需要输入）。
  stdin?: NodeJS.ReadableStream;
  // 正常输出目标；写入抛 EPIPE 等关流错误即视为下游已读完并提前结束。
  stdout: EmbeddedSearchWritable;
}

// 内嵌搜索命令入口。
// 输入：argv[0] 为子命令，其余为原样转发的参数；io 提供 cwd、取消信号与三条流。
// 输出：进程式退出码 —— 0 成功、2 不支持的命令、127 二进制缺失、130/143 等信号码、其它为原生退出码。
// 副作用：spawn 原生子进程并转发其 stdout/stderr；不写文件、不持久化状态。
// 生命周期：无论正常结束、抛错还是取消，都会在 finally 中解绑本模块注册的信号监听。
export async function runEmbeddedSearchCli(
  argv: readonly string[],
  io: EmbeddedSearchIo,
): Promise<number> {
  const command = argv[0];
  // 仅接受白名单子命令，防止把任意可执行名透传到 spawn。
  if (command !== "find" && command !== "grep") {
    io.stderr.write(`unsupported embedded search command: ${command ?? ""}\n`);
    return 2;
  }

  const abortScope = createEmbeddedSearchAbortScope(io.signal);
  try {
    return await runNativeSearchCommand(command, argv.slice(1), io, abortScope.signal);
  } finally {
    abortScope.dispose();
  }
}

// 计算真正传给原生二进制的参数数组。
// 输入：命令与用户参数（不会被修改）。
// 输出：新数组。find 原样返回；grep 在无冲突参数时前置缺省开关，否则原样转发。
// 副作用：无，纯函数，可直接用于断言。
export function resolveNativeSearchArgs(
  command: EmbeddedSearchCommand,
  args: readonly string[],
): string[] {
  if (command !== "grep") return [...args];
  // 一旦用户显式给出会改变语义的参数，注入缺省值可能引发报错或行为不一致，因此整体让位。
  if (args.some(isGrepBypassArgument)) return [...args];
  return [...GREP_DEFAULT_ARGS, ...args];
}

// 启动并跟踪一个原生搜索子进程，返回归一化后的退出码。
// 输入：已校验的命令、原始参数、io 流与有效 signal（此后不再变化）。
// 输出：Promise 恒 resolve（不 reject），退出码含义与 runEmbeddedSearchCli 一致。
// 副作用：spawn 子进程、转发输出、必要时 taskkill/SIGKILL；注册流与信号监听，结算时统一清理。
// 不变量：settle 只生效一次；无论走哪条路径都不会留下未清理的监听或挂起的 Promise。
function runNativeSearchCommand(
  command: EmbeddedSearchCommand,
  args: readonly string[],
  io: EmbeddedSearchIo,
  signal: AbortSignal,
): Promise<number> {
  // 用显式 Promise 而非事件回调聚合，便于把 close/error/abort/EPIPE 四条路径统一到 settle。
  return new Promise((resolve) => {
    // spawn 前就已被取消时直接返回信号码，不产生任何子进程。
    if (signal.aborted) {
      resolve(exitCodeForAbortSignal(signal));
      return;
    }

    const child = spawn(command, resolveNativeSearchArgs(command, args), {
      cwd: io.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let childExited = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let terminationRequested = false;
    let stdoutClosed = false;
    let stderrClosed = false;

    const cleanupRuntimeListeners = () => {
      io.stdout.off?.("error", onStdoutError);
      io.stderr.off?.("error", onStderrError);
      signal.removeEventListener("abort", onAbort);
    };

    // 关闭、错误、取消、EPIPE 四条路径都可能触发结算；先到者胜出，其余直接忽略。
    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      cleanupRuntimeListeners();
      resolve(exitCode);
    };

    // 终止请求是幂等的：重复的 abort/EPIPE 不应重复发信号，也不应给已退出的进程补刀。
    const requestChildTermination = () => {
      if (terminationRequested || childExited) return;
      terminationRequested = true;
      forceKillTimer = terminateNativeSearchChild(child, () => childExited);
    };

    const onAbort = () => {
      // embedded search 的真实搜索进程由 __internal-search 再 spawn；
      // 不能只依赖外层 Bash 的进程树清理，否则 remote/大仓库搜索取消时 native find/grep 可能残留。
      requestChildTermination();
    };

    // internal grep 常被模型放进 `grep ... | head` 管道里；下游读够后会关闭 stdout。
    // 原生 grep/ugrep 会安静处理这种 SIGPIPE，Node 转发层也必须吞掉 EPIPE 并停止子进程，避免栈污染工具结果。
    const stopAfterStdoutClosed = () => {
      stdoutClosed = true;
      requestChildTermination();
      settle(0);
    };

    const onStdoutError = (error: NodeJS.ErrnoException) => {
      if (isOutputClosedError(error)) {
        stopAfterStdoutClosed();
      }
    };
    const onStderrError = (error: NodeJS.ErrnoException) => {
      if (isOutputClosedError(error)) {
        stderrClosed = true;
      }
    };

    io.stdout.on?.("error", onStdoutError);
    io.stderr.on?.("error", onStderrError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }

    child.stdout.on("data", (chunk: Uint8Array) => {
      if (stdoutClosed || io.stdout.destroyed) return;
      try {
        io.stdout.write(chunk);
      } catch (error) {
        if (isOutputClosedError(error)) {
          stopAfterStdoutClosed();
          return;
        }
        throw error;
      }
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      if (stderrClosed || io.stderr.destroyed) return;
      try {
        io.stderr.write(chunk);
      } catch (error) {
        if (isOutputClosedError(error)) {
          stderrClosed = true;
          return;
        }
        throw error;
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      if (!stderrClosed && !io.stderr.destroyed) {
        try {
          io.stderr.write(`failed to run embedded ${command}: ${error.message}\n`);
        } catch (writeError) {
          if (!isOutputClosedError(writeError)) {
            throw writeError;
          }
        }
      }
      // ENOENT 表示原生二进制缺失，映射为 127（shell 的 "command not found"）；其它启动错误统一为 1。
      settle(signal.aborted ? exitCodeForAbortSignal(signal) : error.code === "ENOENT" ? 127 : 1);
    });
    child.on("close", (code, childSignal) => {
      childExited = true;
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      // 被信号杀死时没有 code，用 128 表示异常终止；这与 shell 的 128+n 约定同向。
      settle(signal.aborted ? exitCodeForAbortSignal(signal) : code ?? (childSignal ? 128 : 1));
    });

    if (io.stdin) {
      io.stdin.pipe(child.stdin);
      child.stdin.on("error", () => {
        // Native grep/find may exit before consuming stdin, which is normal for file-only commands.
      });
    } else {
      child.stdin.end();
    }
  });
}

// 为单次搜索创建取消作用域：合并父 signal 与进程信号，并保证监听可被释放。
// 输入：可选的父 AbortSignal（已 aborted 时立即继承）。
// 输出：内部 signal 与 dispose；dispose 幂等，负责解绑父 signal 与所有进程信号监听。
// 副作用：临时注册 process.once(SIGINT/SIGTERM[/SIGHUP])，结束前必须 dispose，否则会阻塞进程退出。
function createEmbeddedSearchAbortScope(parentSignal?: AbortSignal): {
  dispose: () => void;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  const processListeners: Array<[NodeJS.Signals, () => void]> = [];
  let disposed = false;

  const abortFromParent = () => {
    if (controller.signal.aborted) return;
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  if (!controller.signal.aborted) {
    for (const signal of embeddedSearchShutdownSignals()) {
      const listener = () => {
        if (!controller.signal.aborted) {
          controller.abort(createSignalAbortReason(signal));
        }
      };
      process.once(signal, listener);
      processListeners.push([signal, listener]);
    }
  }

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      parentSignal?.removeEventListener("abort", abortFromParent);
      for (const [signal, listener] of processListeners) {
        process.off(signal, listener);
      }
    },
    signal: controller.signal,
  };
}

function terminateNativeSearchChild(
  child: ChildProcessWithoutNullStreams,
  hasExited: () => boolean,
): NodeJS.Timeout | undefined {
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGTERM");
    return undefined;
  }

  // Windows 无 POSIX 信号语义，改用 taskkill 树杀：搜索进程可能带着子进程，单发信号停不干净。
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill("SIGKILL"));
    return undefined;
  }

  // native find/grep 是 __internal-search 的直接子进程；
  // 保持它在外层 Bash 进程组内，让 Bash runner 的二段清理仍能兜住，同时 wrapper 自己定点终止直接 child。
  child.kill("SIGTERM");

  const timer = setTimeout(() => {
    if (hasExited()) return;
    child.kill("SIGKILL");
  }, SIGTERM_TO_SIGKILL_MS);
  timer.unref();
  return timer;
}

function createSignalAbortReason(signal: NodeJS.Signals): EmbeddedSearchAbortReason {
  return {
    exitCode: SIGNAL_EXIT_CODES[signal] ?? DEFAULT_ABORT_EXIT_CODE,
    kind: EMBEDDED_SEARCH_ABORT_REASON,
    signal,
  };
}

// 把取消信号折算成退出码：只认本模块构造的 reason，其它原因一律按默认的 130。
function exitCodeForAbortSignal(signal: AbortSignal): number {
  return isEmbeddedSearchAbortReason(signal.reason)
    ? signal.reason.exitCode
    : DEFAULT_ABORT_EXIT_CODE;
}

function isEmbeddedSearchAbortReason(reason: unknown): reason is EmbeddedSearchAbortReason {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "kind" in reason &&
    reason.kind === EMBEDDED_SEARCH_ABORT_REASON &&
    "exitCode" in reason &&
    typeof reason.exitCode === "number"
  );
}

// 需要监听的终止信号；Windows 无法投递 SIGHUP，监听它只会多一个永不触发的句柄。
function embeddedSearchShutdownSignals(): NodeJS.Signals[] {
  return process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

// 判断某个参数是否要求跳过缺省注入（逐条模式匹配，命中即整体让位）。
function isGrepBypassArgument(argument: string): boolean {
  return GREP_BYPASS_PATTERNS.some((pattern) => pattern.test(argument));
}

// 判断错误是否只是"下游已关流"，此类错误需要吞掉而不是升级为工具失败。
function isOutputClosedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    OUTPUT_CLOSED_ERROR_CODES.has(error.code)
  );
}
