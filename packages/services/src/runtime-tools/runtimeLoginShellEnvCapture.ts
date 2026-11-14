// login shell 环境捕获：在 POSIX 上跑一次 -ilc，把用户 profile 里的 PATH 与变量同步给 GUI 进程。
// INV-01：整次捕获必须有界——4s deadline + 2MB 输出上限 + 进程组 kill，缺一条就会挂住启动。
// INV-02：输出必须同时含 START/SUFFIX 标记才可信；profile 可能打印其他内容，取最后一次出现。
// INV-03：解析只接受合法 shell 变量名，坏行跳过而不是整体失败（失败降级为 null）。
// INV-04：模块级缓存只写一次，win32/VITEST 直接缓存 null，不能反复 spawn。
// 破坏后果：去掉进程组 kill → 继承 pipe 的后代让 Promise 永不结算；去掉标记校验 → 把 profile 的
// 装饰性输出当环境变量；缓存可写 → 并发调用重复启动 shell，拖慢启动并可能互相覆盖。
// 因此所有失败路径都收敛为 null，由调用方回退到原 env。
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { prependPathEntries } from "./runtimeToolResolver.js";

const LOGIN_ENV_CAPTURE_PREFIX = "__ZCODE_LOGIN_ENV_START__";
const LOGIN_ENV_CAPTURE_SUFFIX = "__ZCODE_LOGIN_ENV_END__";
// 探测 shell 启动时 PATH 可能为空（GUI/launchd），先给一个系统目录兜底，
// 否则 profile 里的 command -v 全部失败，捕获到的 PATH 反而比原环境更少。
const DEFAULT_POSIX_BOOTSTRAP_PATH =
  process.platform === "darwin"
    ? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// undefined = 尚未探测；null = 探测过且不可用。
// 三态区分是为了避免每次走同步入口都重新 spawn 一次 shell。
let cachedLoginShellEnvSnapshot: Record<string, string> | null | undefined;

// 与 execFile 的 options 同形，便于默认 executor 直接透传；显式列出字段而非放成 Record，
// 是为了让调用方无法塞进会破坏语义的选项（例如 shell: true）。
interface LoginShellExecutionOptions {
  encoding: "utf8";
  windowsHide: boolean;
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type LoginShellExecutor = (
  shellPath: string,
  shellArgs: string[],
  options: LoginShellExecutionOptions,
) => Promise<string>;

// 用 accessSync X_OK 而不是 existsSync：PATH 上的同名普通文件不可执行，选中它会让 spawn 直接失败。
function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// 候选顺序 SHELL → zsh → bash → sh：尊重用户显式选择的 shell，同时覆盖 macOS 默认与最小化容器。
// 返回 null 表示没有任何可用 shell，调用方据此跳过捕获而不是报错。
function resolveShellPathForLoginEnv(baseEnv: NodeJS.ProcessEnv): string | null {
  const candidates = [baseEnv.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

// 只把系统目录前置，不覆盖已有 PATH 项；prependPathEntries 负责去重，
// 否则重复调用会让 PATH 无限增长（每次 resolve 都拼一遍）。
export function buildShellBootstrapPath(currentPath: string | undefined): string {
  return prependPathEntries(currentPath, DEFAULT_POSIX_BOOTSTRAP_PATH.split(":"));
}

// 用 NUL 分隔而非换行：环境变量值里允许换行，只有 NUL 在 POSIX env 中不可能出现。
// zsh/bash 用 -ilc 走交互式 profile，其他 shell 退到 -lc，避免不支持的参数直接报错。
function buildLoginShellArgs(shellPath: string): string[] {
  const command = `printf '%s\\0' '${LOGIN_ENV_CAPTURE_PREFIX}'; env -0; printf '%s\\0' '${LOGIN_ENV_CAPTURE_SUFFIX}'`;
  return shellPath.endsWith("/zsh") || shellPath.endsWith("/bash")
    ? ["-ilc", command]
    : ["-lc", command];
}

// TERM=dumb + CI=1 抑制 profile 里的交互检测与彩色/提示符输出，减少无关字节也降低超时概率。
function buildLoginShellExecutionOptions(baseEnv: NodeJS.ProcessEnv): LoginShellExecutionOptions {
  return {
    encoding: "utf8",
    windowsHide: true,
// 内层 4s 是 spawn 自身的兜底；外层 captureLoginShellEnvSnapshot 还会再加一个独立 deadline。
// [权衡] 两套超时看似冗余，但 Node 的 timeout 只对 shell 本体生效，无法覆盖继承 pipe 的后代。
    timeout: 4_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...baseEnv,
// [资源] env 只做浅合并：不能把 login shell 的全量输出直接替换 process.env，
// 否则会丢掉父进程注入的凭据类变量。
      // GUI / remote service 进程的 PATH 往往不经过 login shell 初始化。
      // 给探测 shell 一个最小系统 PATH，再由 profile 回放用户自己的命令路径。
      PATH: buildShellBootstrapPath(baseEnv.PATH),
      TERM: "dumb",
      CI: "1",
    },
  };
}

// [资源] 采集必须连同后代一起杀：login profile 常启动常驻进程，只 kill 子进程会让 pipe 保持打开。
// POSIX 下依赖 spawn 的 detached 建立进程组，负 pid 才是「整棵树」。
function killLoginShellProcessTree(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
// 负 pid 表示整个进程组；[失败路径] ESRCH 等错误只说明已经退出，
// 继续走单进程 kill 兜底，清理函数自身不能抛出。
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // 进程可能已在 close 前退出；继续尝试直接 kill，避免留下采集后代。
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 超时与自然退出可能竞争，进程已经不存在时无需额外处理。
  }
}

// executor 只负责跑完并返回 stdout；超时、大小与标记校验都在外层，
// 这样测试可以注入假 executor 而不必真的起 shell。
const executeLoginShell: LoginShellExecutor = (shellPath, shellArgs, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(shellPath, shellArgs, {
      env: options.env,
      windowsHide: options.windowsHide,
      stdio: ["ignore", "pipe", "pipe"],
      // login profile 可能启动继承 stdout/stderr 的后代进程；只 kill shell 会让
      // execFile 一直等 pipe close。POSIX 下独立进程组才能在 deadline 时完整终止采集树。
      detached: process.platform !== "win32",
    });
// settled 是唯一结算门闩：close/error/abort/超限四路可能同时发生，
// 没有它会出现 resolve 后 reject 或重复清理监听器。
    let stdout = "";
    let outputBytes = 0;
    let settled = false;

// [资源] 先杀进程树再销毁管道：反过来 destroy 只会让读取提前结束，子进程仍可能继续写。
    const killProcessTree = () => {
      killLoginShellProcessTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
    };
// abort 是外层 deadline 的唯一信号通道：这里必须同步清理并结算，不能等 close 事件，
// 否则继承 pipe 的后代会把等待拖到超时之后。
    const handleAbort = () => {
      killProcessTree();
      settle(new Error(`login shell environment capture timed out after ${options.timeout}ms`));
    };
// 结算时统一移除 abort 监听，避免已完成的请求仍被后续 abort 触发一次无效清理。
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", handleAbort);
      if (error) reject(error);
      else resolve(stdout);
    };
// stdout 与 stderr 共用字节预算：profile 可能往 stderr 大量打日志，只限 stdout 挡不住内存增长。
// [失败路径] 超限立即杀树并结算错误，而不是截断继续解析——半截输出可能缺少结束标记。
    const appendOutput = (chunk: Buffer | string, includeInStdout: boolean) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > options.maxBuffer) {
        killProcessTree();
        settle(new Error(`login shell environment capture exceeded ${options.maxBuffer} bytes`));
      } else if (includeInStdout) {
        stdout += text;
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => appendOutput(chunk, true));
    child.stderr.on("data", (chunk: Buffer | string) => appendOutput(chunk, false));
    child.once("error", (error) => settle(error));
// close 而非 exit：必须等 stdio 全部关闭，否则最后一段输出可能还没读完；
// 非 0 退出码带 signal 一起报出，便于区分超时 kill 与 profile 自身报错。
    child.once("close", (code, signal) => {
      if (code === 0) settle();
      else {
        settle(
          new Error(
            `login shell environment capture exited with code ${code ?? "null"}, signal ${signal ?? "none"}`,
          ),
        );
      }
    });
// [并发] 注册监听后立刻补一次 aborted 检查：signal 可能在启动前就已触发，
// 此时 addEventListener 不会再回调，会永久悬挂。
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) handleAbort();
  });

// 用 lastIndexOf 取最后一组标记：profile 可能 echo 出同样的字符串，
// 真正由我们 printf 的标记在输出末尾，取最后一次才是可信区间。
function extractCapturedEnvSnapshot(rawOutput: string): Record<string, string> | null {
  const startMarker = `${LOGIN_ENV_CAPTURE_PREFIX}\0`;
  const endMarker = `${LOGIN_ENV_CAPTURE_SUFFIX}\0`;
  const startIndex = rawOutput.lastIndexOf(startMarker);
  const endIndex = rawOutput.lastIndexOf(endMarker);
// [失败路径] 标记缺失或乱序说明 shell 没跑到命令（如 profile 提前 exit），返回 null 让上层退回原 env。
  if (startIndex < 0 || endIndex <= startIndex) return null;
  return parseNullSeparatedEnvSnapshot(rawOutput.slice(startIndex + startMarker.length, endIndex));
}

// 逐条容错解析：profile 混入的普通输出没有等号或含非法字符，跳过即可，
// 不能让一条坏行丢掉整份环境（能拿到多少用多少的降级策略）。
function parseNullSeparatedEnvSnapshot(rawOutput: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of rawOutput.split("\0")) {
    if (!entry) continue;
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = entry.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    result[key] = entry.slice(separatorIndex + 1);
  }
  return result;
}

// 对外入口：win32 与 VITEST 直接返回 null，避免在测试或 Windows 上启动不存在的 POSIX shell。
// shellPath 显式传 null 表示「明确不探测」，与 undefined（自动解析）区分。
export async function captureLoginShellEnvSnapshot(
  options: {
    baseEnv?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    shellPath?: string | null;
    executeShell?: LoginShellExecutor;
    timeoutMs?: number;
  } = {},
): Promise<Record<string, string> | null> {
  const baseEnv = options.baseEnv ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || baseEnv.VITEST) return null;

  const shellPath =
    options.shellPath === undefined ? resolveShellPathForLoginEnv(baseEnv) : options.shellPath;
  if (!shellPath) return null;

// [资源] 外层 deadline 与内层 spawn timeout 同时生效，先到先结算；
// 即使 executor 不响应 AbortSignal（如注入的假实现）也不会永久等待。
  const timeoutMs = options.timeoutMs ?? 4_000;
  const abortController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const executionPromise = (options.executeShell ?? executeLoginShell)(
      shellPath,
      buildLoginShellArgs(shellPath),
      {
        ...buildLoginShellExecutionOptions(baseEnv),
        timeout: timeoutMs,
        signal: abortController.signal,
      },
    );
// [并发] abortController 只传给默认 executor；注入的实现可以忽略它，
// 因此外层 Promise.race 是唯一可靠的结算保障。
    // Node execFile 的 timeout 仍会等待所有继承 pipe 的后代关闭。
    // 外层 deadline 独立结算 API；默认 executor 同时通过 AbortSignal 杀完整 POSIX 进程组。
    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        abortController.abort();
        reject(new Error(`login shell environment capture timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const output = await Promise.race([executionPromise, deadlinePromise]);
// 任何失败（超时/非 0 退出/解析异常）都统一降级为 null：
// 环境捕获是启动优化，不能因为它失败而阻止服务启动。
    return extractCapturedEnvSnapshot(output);
  } catch {
    return null;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

export function captureLoginShellEnvSnapshotSync(
  baseEnv: NodeJS.ProcessEnv,
): Record<string, string> | null {
  if (cachedLoginShellEnvSnapshot !== undefined) return cachedLoginShellEnvSnapshot;
  if (process.platform === "win32" || process.env.VITEST) {
    cachedLoginShellEnvSnapshot = null;
    return cachedLoginShellEnvSnapshot;
  }

  const shellPath = resolveShellPathForLoginEnv(baseEnv);
  if (!shellPath) {
    cachedLoginShellEnvSnapshot = null;
    return cachedLoginShellEnvSnapshot;
  }
  try {
// execFileSync 没有 deadline 以外的中断手段，依赖 options.timeout 与 maxBuffer 兜底；
// [边界] setLoginShellEnvSnapshot 是同步一次性入口：execFileSync 无 deadline 中断手段，只能靠 timeout 与 maxBuffer 兜底。
    // 兼容非 Desktop 的同步 createLocalServices 入口。这里即使走兼容 fallback 也只采集一次完整 snapshot。
    const output = execFileSync(
      shellPath,
      buildLoginShellArgs(shellPath),
      buildLoginShellExecutionOptions(baseEnv),
    );
    cachedLoginShellEnvSnapshot = extractCapturedEnvSnapshot(output);
  } catch {
    cachedLoginShellEnvSnapshot = null;
  }
  return cachedLoginShellEnvSnapshot;
}
