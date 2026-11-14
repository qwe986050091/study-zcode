// 文件职责：把一次 git 调用收敛成「可判定、可超时、可截断、绝不抛未捕获异常」的单一结果。
// INV-01：run() 永远 resolve，绝不以 reject 结束；调用方只按 exitCode/signal/timedOut 判定成败。
//         （守住它的位置：settle 是唯一出口，spawn 的 error 事件也降级为结果对象）
// INV-02：settled 一旦为 true，任何迟到事件（close/error/超时回调）都不得再写终态或再次 resolve。
//         （守住它的位置：settle 与 handleTimeout 开头的 settled 早退）
// INV-03：stdout/stderr 各自累计字节数不超过 maxOutputBytes；超限只置 outputTruncated 并 kill，
//         绝不再追加，否则异常大输出（误跑 git log -p）会把主进程堆吃满。
// INV-04：定时器、data 监听、error/close 监听必须在 settle 时全部解除，句柄与监听不得跨调用泄漏。
//         （守住它的位置：settle 内 clearTimeout + off + removeAllListeners）
// 破坏后果：INV-01 破 → fire-and-forget 调用链出现 unhandled rejection，测试与进程被整体拖死。
import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS, DEFAULT_GIT_OUTPUT_BYTES } from "../config.js";
import {
  createGitEnvironmentProvider,
  type GitEnvironmentProvider,
} from "./gitEnvironmentProvider.js";

export interface GitCommandExecutionOptions {
  cwd: string;
  args: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GitCommandExecutionResult {
  binaryPath: string;
  cwd: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  timeoutMs?: number;
  timeoutElapsedMs?: number;
  timeoutCloseDelayMs?: number;
  forceKillAttempted?: boolean;
  orphaned?: boolean;
  outputTruncated: boolean;
}

export interface GitCommandProvider {
  resolveGitBinary(): Promise<string | null>;
  run(options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult>;
}

const DEFAULT_TIMEOUT_KILL_GRACE_MS = 2_000;
const DEFAULT_TIMEOUT_FORCE_KILL_GRACE_MS = 2_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;

// [资源] 超时等待自建定时器：Promise settle 后定时器自然释放，不引入可被外部中断的全局 sleep。
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// [权衡] Windows 没有可靠的单进程 SIGKILL：child.kill() 只终止直接子进程，git 派生的
// remote-https/filter helper 会继续持有管道，所以改用 taskkill /T 整树终止。
// [资源] taskkill 自身也要设超时并在 error/close 上清理定时器：杀不掉时不能反过来卡住调用方。
function forceKillChildProcess(child: ChildProcess, platform: NodeJS.Platform): void {
  if (platform === "win32" && typeof child.pid === "number") {
// [失败路径] killer 启动失败只走 cleanup 不再上抛：此时交给 orphaned 分支兜底，比让调用方永久悬挂安全。
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killer.kill();
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
    };
    killer.once("error", cleanup);
    killer.once("close", cleanup);
    return;
  }

// POSIX 下 SIGKILL 不可捕获，直接终止即可；整树清理由系统进程组语义承担，无需 taskkill 兜底。
  child.kill("SIGKILL");
}

// [权衡] environmentProvider/platform/两段 grace 全从 options 注入：生产用真实环境，
// 单测可替换平台与时长，避免为 Windows 路径另写一份实现而让两条分支行为漂移。
// 两段宽限期必须分开：先温和 kill 让 git 释放 index.lock，再强杀整树，最后才判孤儿。
export function createGitCommandProvider(options?: {
  environmentProvider?: GitEnvironmentProvider;
  platform?: NodeJS.Platform;
  timeoutKillGraceMs?: number;
  timeoutForceKillGraceMs?: number;
}): GitCommandProvider {
  const environmentProvider = options?.environmentProvider ?? createGitEnvironmentProvider();
  const platform = options?.platform ?? process.platform;
  const timeoutKillGraceMs = options?.timeoutKillGraceMs ?? DEFAULT_TIMEOUT_KILL_GRACE_MS;
// 强杀宽限期单独可配：Windows 上 taskkill 自身耗时，与 SIGTERM 宽限共用会让总延迟不可解释。
  const timeoutForceKillGraceMs =
    options?.timeoutForceKillGraceMs ?? DEFAULT_TIMEOUT_FORCE_KILL_GRACE_MS;

  return {
// [失败路径] 解析失败返回 null 而非抛错，让调用方区分「机器上没有 git」与「git 执行失败」；
// 探测与缓存策略全部下沉到 environmentProvider，这里不做二次判断。
    async resolveGitBinary(): Promise<string | null> {
      return await environmentProvider.resolveGitBinary();
    },

    async run(command: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> {
// [失败路径] 这里是本文件唯一允许 throw 的位置：缺 git 属于部署错误，与命令失败必须区分，
// 上层才能给出安装引导；其余失败一律经 settle 转成结果对象。
      const gitBinary = await environmentProvider.resolveGitBinary();
      if (!gitBinary) {
        throw new Error("Git binary is not available");
      }
      const binaryPath = gitBinary;

// [权衡] 用 ?? 而不是 ||：显式传 0 表示「立即超时」，不应回退成默认值，
// 调用方需要瞬时失败语义时不必额外加开关。
      const timeoutMs = command.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
      const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES;
// [权衡] 合并顺序是「provider 基线环境」被 command.env 覆盖：调用方要临时改
// HOME/SSH_ASKPASS 等变量，而 PATH 与 GIT_TERMINAL_PROMPT 仍由基线统一提供。
      const env = {
        ...environmentProvider.createCommandEnv(),
        ...command.env,
      };
      const startedAt = Date.now();

// [并发] 单个 Promise 收口全部异步来源（data/error/close/timer）：不把 EventEmitter 暴露出去，
// 调用方既无法漏掉监听清理，也无法在 resolve 之后读到半截结果。
      return await new Promise<GitCommandExecutionResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timedOut = false;
        let timeoutElapsedMs: number | undefined;
        let forceKillAttempted = false;
        let orphaned = false;
        let outputTruncated = false;
// settled 是唯一完成闩锁：所有出口先检它再写终态字段，保证 buildResult 读到稳定快照。
        let settled = false;

// [资源] stdio 用 pipe：既捕获输出用于错误归类，也不让子进程继承父进程终端句柄；
// stdin 设为 ignore，git 若等待凭据或编辑器输入会收到 EOF 失败，而不是永久挂起。
        const child = spawn(binaryPath, command.args, {
          cwd: command.cwd,
          env,
// windowsHide 与 taskkill 处的选项保持一致：后台调用不应弹控制台窗口打断用户。
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

// durationMs 在构造时现算：结果对象是快照，消费方之后再读时间只会得到「此刻的耗时」；
// timeoutCloseDelayMs 只在超时路径出现，用于区分「超时判定」与「进程真正退出的尾巴」。
        function buildResult(
          exitCode: number | null,
          signal: NodeJS.Signals | null,
        ): GitCommandExecutionResult {
          const durationMs = Date.now() - startedAt;
          return {
            binaryPath,
            cwd: command.cwd,
            args: command.args,
            stdout,
            stderr,
            exitCode,
            signal,
            durationMs,
            timedOut,
            timeoutMs,
            timeoutElapsedMs,
            timeoutCloseDelayMs:
// [权衡] 用 Math.max(...,0) 截平：系统时钟回拨时 durationMs 可能小于 timeoutElapsedMs，
// 负延迟会把排查方向引向错误结论，宁可饱和到 0。
              timedOut && timeoutElapsedMs !== undefined
                ? Math.max(durationMs - timeoutElapsedMs, 0)
                : undefined,
            forceKillAttempted,
            orphaned,
            outputTruncated,
          };
        }

// [并发] 先置 settled 再清监听与定时器：两步之间到达的事件会被上面的早退拦下；
// 顺序反了会让排队回调在 resolve 之后仍写 stdout，结果自相矛盾。
        function settle(result: GitCommandExecutionResult): void {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          child.stdout?.off("data", appendStdoutChunk);
          child.stderr?.off("data", appendStderrChunk);
          child.removeAllListeners("error");
          child.removeAllListeners("close");
          if (result.orphaned) {
            // Windows 上 Git helper/filter 可能拖住 stdout/stderr 句柄，
            // 如果超时后仍未 close，先断开本进程对管道和子进程句柄的引用，避免 checkpoint 继续卡住主链路。
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
          }
// [资源] orphaned 时 destroy 管道并 unref，让本进程不再被 helper 的 stdout 句柄拖住；
// 这一步必须在 resolve 之前，否则上层立刻发起下一次 git 时旧句柄仍占着。
          resolve(result);
        }

// [事务] 超时分三段推进：SIGTERM（给 git 清理 lock）→ 宽限后强杀整树 → 再宽限仍不 close 判孤儿。
// 每段之间重新检查 settled，避免对已退出的 pid 重复发信号；强杀失败也只降级为 orphaned
// 而不 assert：权限不足或 pid 复用都属于运行时可预期情况，不能让应用崩掉。
        async function handleTimeout(): Promise<void> {
          if (settled) {
            return;
          }
          timedOut = true;
          timeoutElapsedMs = Date.now() - startedAt;
          child.kill();

          await wait(timeoutKillGraceMs);
          if (settled) {
            return;
          }

          forceKillAttempted = true;
// 只有温和终止在宽限期内未 close 才升级到强杀：冲动强杀会让 git 来不及写完 index 与引用。
          forceKillChildProcess(child, platform);

          await wait(timeoutForceKillGraceMs);
          if (settled) {
            return;
          }

// [失败路径] 两段宽限后仍未 close 才标记 orphaned：exitCode/signal 置 null 表示
// 「我们放弃了等待」，调用方必须据此区别于成功退出。
          orphaned = true;
          settle(buildResult(null, null));
        }

        const timer = setTimeout(() => {
          void handleTimeout();
// [权衡] 不 unref 该定时器：unref 会让「只跑一次 git」的短命进程提前退出，
// 调用方拿到的是进程结束而不是超时结果；清理责任明确交给 settle。
        }, timeoutMs);

// [资源] 截断按字节而非字符判定：maxOutputBytes 是内存上限，多字节 UTF-8 字符占 2~4 字节，
// 按字符算会低估数倍，异常输出（误跑 git log -p）能直接吃满堆。
        const appendChunk = (chunk: Buffer, target: "stdout" | "stderr") => {
          if (outputTruncated) {
            return;
          }

// [权衡] 超限后整块丢弃而不是保留前缀：半截 UTF-8 会被 toString 替换成替换符，
// 下游按行解析错误信息会得到假内容，outputTruncated 才是可靠信号。
          const byteLength = chunk.byteLength;
          const currentBytes = target === "stdout" ? stdoutBytes : stderrBytes;
          if (currentBytes + byteLength > maxOutputBytes) {
            outputTruncated = true;
            child.kill();
            return;
          }

          const text = chunk.toString("utf-8");
          if (target === "stdout") {
            stdout += text;
            stdoutBytes += byteLength;
          } else {
            stderr += text;
            stderrBytes += byteLength;
          }
        };

        const appendStdoutChunk = (chunk: Buffer) => appendChunk(chunk, "stdout");
        const appendStderrChunk = (chunk: Buffer) => appendChunk(chunk, "stderr");

// exitCode 取 -2 这个非标准值：0 会被误判成功，1 与 git 普通失败混淆，-2 可明确归因为 spawn 失败。
        child.once("error", (error) => {
          // 当 cwd 被并发删除或运行环境瞬时缺失 git 时，spawn 会直接抛错进入 "error" 事件。
          // 之前这里 reject 会在某些 fire-and-forget 调用链里变成 unhandled rejection，
          // 进而让 Vitest 出现整批超时假红。这里统一降级为“命令失败结果”，
          // 由上层按既有 ensureGitCommandSucceeded 语义处理，避免把异常泄漏成进程级未捕获拒绝。
          stderr = error instanceof Error ? error.message : String(error);
          settle(buildResult(-2, null));
        });
        child.stdout?.on("data", appendStdoutChunk);
        child.stderr?.on("data", appendStderrChunk);
// [并发] close 是正常完成路径：exitCode 可能非 0（git 业务失败），
// 依赖方必须按 exitCode 分类，不能把「Promise resolve」当成命令成功。
        child.once("close", (exitCode, signal) => {
          settle(buildResult(exitCode, signal));
        });
      });
    },
  };
}
