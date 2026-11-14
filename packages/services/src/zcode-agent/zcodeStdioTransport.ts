import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { zcodeProtocolMessageSchema } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  ZCodeProtocolTransport,
  ZCodeProtocolTransportClosedEvent,
} from "./zcodeProtocolTransport.js";
import {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  terminateProcessTree,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";
import type { ProcessTreeSnapshot } from "#src/process/processTreeTerminator.js";
import { AgentStderrCollector, EXIT_STDERR_DRAIN_MS } from "./agentStderrCollector.js";

// ownedProcessGroupId/ownedProcessStartedAtMs 是进程树的身份证据：
// 只有带着它们，回收时才能区分本次 Host 拉起的进程与系统上同 PID 的无关进程。
// onStderrLine 只做旁路上报，不参与关闭判定。
interface ZCodeStdioTransportOptions {
  onStderrLine?: (line: string) => void;
  ownedProcessGroupId?: number;
  ownedProcessStartedAtMs?: number;
}

// [资源] EOF 后等待根进程自退的窗口：必须覆盖 CLI 自身的 1500ms 退出 deadline。
// 短于它会让正常收尾被误判为卡死而直接强杀，长于它则挤占 Host 的退出预算。
const STDIO_EOF_EXIT_WAIT_MS = 1_800;
// 同步 dispose 不等待进程树，但仍给 stderr 一个有限的排空窗口，
// 让最后的诊断行有机会进入日志。
const DISPOSE_STDERR_DRAIN_MS = 3_250;
const E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS = 5_000;
const PROCESS_TREE_FORCE_AFTER_MS = 2_000;
const PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS = 1_000;
// [并发] Windows 上 taskkill 成功与 Node 收到 exit 事件之间有一轮延迟，
// 这个宽限窗口用来吸收该延迟，避免把已回收的进程报成残留。
const PROCESS_TREE_WINDOWS_EXIT_OBSERVATION_GRACE_MS = 250;
const processTreeLogger = createServiceLogger("zcode-agent-process-tree");

// [状态归属] 一个 transport 绑定一个 child 的 stdio。四组状态彼此独立：
// readersDisposed 管监听器、closed 管单向关闭事件、disposed 管对外写入、
// stdoutFlushed 管尾部帧。任何一组提前置位都会造成静默丢帧或重复关闭。
export class ZCodeStdioTransport implements ZCodeProtocolTransport {
  readonly kind = "stdio" as const;

// 两条事件流分开：消息流在正常期高频触发，关闭流只触发一次，
// 合流会让订阅方在每帧都做一次关闭判断。
  private readonly messageEmitter = new Emitter<ZCodeProtocolMessage>();
  private readonly closeEmitter = new Emitter<ZCodeProtocolTransportClosedEvent>();
  private readonly stderrCollector: AgentStderrCollector;
// [事务] 必须用 StringDecoder 而不是 chunk.toString()：
// 多字节 UTF-8 字符可能跨 chunk 边界，直接 toString 会把中文切成替换符，
// 进而让 JSON.parse 在帧中间失败并关闭整条连接。
  private readonly stdoutDecoder = new StringDecoder("utf8");
  // 当前未完成行的分片；只在遇到 LF 时 join 一次，见 handleStdoutData 注释。
  private stdoutPendingChunks: string[] = [];
  private stdoutFlushed = false;
  private readersDisposed = false;
  private disposed = false;
  private closed = false;
  private disposeAndWaitPromise: Promise<void> | undefined;
  private cleanupProcessTreeSnapshot: ProcessTreeSnapshot | undefined;
// 重试次数决定这次回收是否还有 graceful 预算：
// 第二次调用说明首次已报告残留，必须直接进入强杀。
  private cleanupAttemptCount = 0;
  private childExitedAtMs: number | undefined;

// 事件成员用箭头属性固定 this，调用方可以安全解构后传入回调。
  readonly onMessage = this.messageEmitter.event;
  readonly onClose = this.closeEmitter.event;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options?: ZCodeStdioTransportOptions,
  ) {
// stderr 收集器与 stdout 解析完全解耦：
// 诊断输出没有帧协议，丢给独立收集器就不会与协议解析互相阻塞。
    this.stderrCollector = new AgentStderrCollector(child.stderr, options?.onStderrLine);

    // ZCode Protocol stdio 帧边界只认 LF。Node readline 会把 U+2028/U+2029
    // 当作换行，模型文本包含这类字符时会把合法 JSON 字符串切成半帧。
// [事务] 数据监听必须在构造期同步挂上：
// spawn 后 CLI 可能立刻写出首帧，晚挂一步就会丢 initial notification。
    child.stdout.on("data", this.handleStdoutData);
    child.stdout.once("end", this.handleStdoutEnd);
    child.stdout.once("close", this.handleStdoutEnd);
    child.stdin.on("error", (error) => this.handleStreamError("stdin", error));
    child.stdout.on("error", (error) => this.handleStreamError("stdout", error));
    child.once("exit", (code, signal) => {
      this.childExitedAtMs = Date.now();
      this.fireClose({ code, signal });
      this.disposeReaders();
      void this.waitForStderrDrain();
    });
    child.once("error", (error) => {
      this.fireClose({ reason: error.message });
      this.disposeReaders();
      void this.waitForStderrDrain();
    });
  }

// [失败路径] 写前四重检查：已释放、已关闭、已被 kill、stdin 不可写。
// [失败路径] send 写前查四项（释放/关闭/kill/stdin 可写）：任一成立即抛错，上层按错误码重连或回收。
// 写入用回调 promise 而非 drain 事件，保证单帧顺序。
  async send(message: ZCodeProtocolMessage): Promise<void> {
    if (this.disposed || this.closed || this.child.killed || !this.child.stdin.writable) {
      throw new Error("ZCode agent stdio transport is closed");
    }
    const frame = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

// [资源] 同步释放只发信号不等回收：调用方若不等待进程树，
// 必须接受可能残留后代的事实；Host 退出应改用 disposeAndWait。
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeLocalResources();
    void this.stderrCollector.waitForDrain(DISPOSE_STDERR_DRAIN_MS);
    if (!this.hasChildExited()) {
      // Windows 和 POSIX 下 agent wrapper 可能继续拉起 runtime/MCP 子进程，
      // 只 kill 父进程会留下后代进程或短时间锁住 workspace cwd。
      const ownedProcessGroupId = this.options?.ownedProcessGroupId;
      terminateProcessTree(this.child, ownedProcessGroupId ? { ownedProcessGroupId } : {});
    }
  }

// [并发] 释放 promise 缓存并把自身从缓存里摘除：
// 并发调用共享同一次回收，结束后再调用会重新走一遍（用于最终重试）。
// finally 中的身份比较防止旧 promise 把新一次回收的缓存清掉。
  disposeAndWait(): Promise<void> {
    if (!this.disposeAndWaitPromise) {
      const inFlight = this.disposeAndWaitOnce().finally(() => {
        if (this.disposeAndWaitPromise === inFlight) {
          this.disposeAndWaitPromise = undefined;
        }
      });
      this.disposeAndWaitPromise = inFlight;
    }
    return this.disposeAndWaitPromise;
  }

// 退出诊断要等 stderr 真正读完，而不是等 exit 事件。
  waitForStderrDrain(): Promise<void> {
    return this.stderrCollector.waitForDrain();
  }

// [资源] 关闭事务的完整顺序：标记释放 → 保存进程树快照 → 请求 EOF →
// 限时等待根进程退出 → 按快照回收整棵树 → 排空 stderr → 报告残留。
// 快照必须在 EOF 之前拍，根进程退出后后代会被系统接管，PPID 链就断了。
  private async disposeAndWaitOnce(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.disposeLocalResources();
    }
    // stdin EOF 可能让 CLI 根进程先退出，而 detached MCP 仍继续运行。
    // 必须在发 EOF 前保存树成员，否则根退出、后代被系统接管后无法再按 PPID 找回。
    this.cleanupAttemptCount += 1;
    const cleanupStartedAtMs = Date.now();
// 首次回收给 2s graceful，重试直接强杀：
// 重试发生在 app quit，此时已经没有更多预算可以等待。
    const forceBudgetMs = this.cleanupAttemptCount > 1 ? 0 : PROCESS_TREE_FORCE_AFTER_MS;
    // 只扣减 forceAfterMs 无法约束慢 CIM；force 触底为 0 后 waiter 还会重新
    // 获得 taskkill + exit 宽限。Windows 必须从 cleanup 起点固定同一个绝对 deadline，
    // 并贯穿快照、EOF 和 waiter，才能稳定落在 Host 3.5s service phase 内。
    const windowsCleanupDeadlineAtMs =
      process.platform === "win32"
        ? cleanupStartedAtMs +
          forceBudgetMs +
          PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS +
          PROCESS_TREE_WINDOWS_EXIT_OBSERVATION_GRACE_MS
        : undefined;
// 快照只拍一次并缓存：重试时进程表已变化，重新拍会把已回收的成员算成残留。
// 空值合并赋值保证并发/重试路径共享同一份证据。
    this.cleanupProcessTreeSnapshot ??= await this.captureCleanupSnapshot(
      windowsCleanupDeadlineAtMs,
    );
    const processTreeSnapshot = this.cleanupProcessTreeSnapshot;
    if (!this.hasChildExited()) {
      // app-server --stdio 的正常退出边界是 stdin EOF。直接 taskkill
      // 进程树，既跳过 agent 自身 shutdown，也会让 host 固定等强杀兜底窗口。
      // 这里先请求协议入口自然收尾；短时间无响应再进入进程树兜底，仍保证不残留子进程。
// 正常退出边界是 stdin EOF：先让 Agent 走自己的 shutdown，
// 而不是一上来就 taskkill 跳过它的持久化与清理逻辑。
      this.requestStdioClose();
      // coverage CLI bundle 未压缩且带完整 source map，启动/收尾明显慢于发布包。
      // coverage 下继续保留额外写盘宽限；普通窗口覆盖 CLI 的 1500ms 退出 deadline。
      const configuredEofWaitMs =
        process.env.ZCODE_E2E_COVERAGE === "1"
          ? E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS
          : STDIO_EOF_EXIT_WAIT_MS;
// Windows 上 EOF 等待也被绝对 deadline 约束，避免慢查询把总时长推过 Host 预算。
      const remainingCleanupMs =
        windowsCleanupDeadlineAtMs === undefined
          ? configuredEofWaitMs
          : Math.max(windowsCleanupDeadlineAtMs - Date.now(), 0);
      await this.waitForChildExit(Math.min(configuredEofWaitMs, remainingCleanupMs));
    }
    // app 关闭时 host 必须等进程树的 SIGTERM/SIGKILL 兜底跑完；
    // 即使根 child 已在 EOF 窗口内退出，也要用预先保存的快照回收后代。
// [并发] 回收参数三组证据：进程组、启动时间+退出时间、预拍快照。
// 带 ownedProcessStartedAtMs 时同时给出 exitedAtMs，用于排除 PID 复用；
// forceAfterMs 按剩余预算递减，确保整次 cleanup 落在固定窗口内。
    const terminationResult = await terminateProcessTreeAndWait(this.child, {
      ...(this.options?.ownedProcessGroupId
        ? { ownedProcessGroupId: this.options.ownedProcessGroupId }
        : {}),
      ...(this.options?.ownedProcessStartedAtMs
        ? {
            ownedProcessStartedAtMs: this.options.ownedProcessStartedAtMs,
            ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
          }
        : {}),
      ...(processTreeSnapshot ? { snapshot: processTreeSnapshot } : {}),
      log: processTreeLogger,
      // Windows 等待式清理的绝对 deadline 是 force 余量 + taskkill 上限 + exit 宽限。
      // 将命令上限控制在 1s，使完整 cleanup 仍落在 Host service phase 的 3.5s 内。
      windowsTaskkillTimeoutMs: PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS,
      ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
      // 前一次 cleanup 若报告残留，app quit 的最终重试不能再等待完整
      // graceful 窗口；直接进入 force，确保仍落在 main 给 Host 的退出预算内。
      forceAfterMs: Math.max(forceBudgetMs - (Date.now() - cleanupStartedAtMs), 0),
    });
    // Windows taskkill 已确认 OS 进程退出后，Node 的 ChildProcess exit 事件
    // 仍可能晚一轮投递。waiter 已同时检查 PID 存活与身份门禁，这里若再用滞后的
    // exitCode/signalCode 追加 root PID，会把成功回收误报为残留并触发无效重试。
// 残留判定只信 waiter 的结果，不再用滞后的 exitCode/signalCode 二次推断。
    const remainingPids = terminationResult.remainingPids;
    await this.stderrCollector.waitForDrain(
      windowsCleanupDeadlineAtMs === undefined
        ? undefined
        : Math.max(0, Math.min(EXIT_STDERR_DRAIN_MS, windowsCleanupDeadlineAtMs - Date.now())),
    );
// [失败路径] 有残留必须抛错：manager 收到失败才会保留 ownership 供最终重试，
// 若只记 warning 就当成功，app quit 之后这些后代将无人回收。
    if (remainingPids.length > 0) {
      // 只写 warning 后把 cleanup 当成功会让 manager 随即释放 ownership，
      // app quit 无法再次处理残留。这里把残留提升为失败并保留快照供最终重试。
      throw new Error(
        `runtime process tree cleanup incomplete; remaining pid=${[...new Set(remainingPids)].join(",")}`,
      );
    }
  }

// 关闭后不再解码：继续 write 只会把残余字节塞进已废弃的 decoder。
  private readonly handleStdoutData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }
    // Bug 原因：旧实现 `stdoutBuffer += chunk` 后对整个缓冲 indexOf("\n")，每个 64KB
    // chunk 都会让 V8 把 cons string 拍平并从头扫描，单行帧长度 n 时总开销 O(n²)。
    // task index resync 的 session/read 会回一行约 15MB 的完整快照，实测 30s 内
    // 真实 stdout 95MB 却拍平分配 9.4GB，Host CPU 100%、RSS 冲到 1.5–1.9GB。
    // 修复：只在新 chunk 内找 LF，未完成的部分存分片数组，成帧时 join 一次，线性开销。
    const text = typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    this.consumeStdoutText(text);
  };

  private readonly handleStdoutEnd = (): void => {
    if (this.stdoutFlushed) {
      return;
    }
    this.stdoutFlushed = true;
    this.stdoutPendingChunks.push(this.stdoutDecoder.end());
    const trailing = this.stdoutPendingChunks.join("");
    this.stdoutPendingChunks = [];
    if (trailing.length > 0 && !this.closed) {
      this.handleStdoutFrame(trailing);
    }
    this.fireClose({ reason: "stdout_closed" });
  };

// [事务] 只在新 chunk 内找 LF，未完成部分进分片数组，成帧时 join 一次。
// 这样单行大帧的拼接是线性的；旧实现对不断增长的整缓冲反复 indexOf，
// 是 O(n²) 且会反复拍平 cons string。
// 每帧处理后立即检查 closed：解析失败会同步关流，后续帧不应再分发。
  private consumeStdoutText(text: string): void {
    let start = 0;
    let newlineIndex = text.indexOf("\n", start);
    while (newlineIndex >= 0) {
      this.stdoutPendingChunks.push(text.slice(start, newlineIndex));
      const frame = this.stdoutPendingChunks.join("");
      this.stdoutPendingChunks = [];
      start = newlineIndex + 1;
      this.handleStdoutFrame(frame);
      if (this.closed) {
        return;
      }
      newlineIndex = text.indexOf("\n", start);
    }
    if (start < text.length) {
      this.stdoutPendingChunks.push(text.slice(start));
    }
  }

// 去掉行尾 CR 后解析；空行静默跳过，避免心跳/空写触发解析错误。
// 运行期只做 schema 校验与转发，不做任何系统进程表查询。
  private handleStdoutFrame(frame: string): void {
    const line = frame.endsWith("\r") ? frame.slice(0, -1) : frame;
    if (line.trim().length === 0) {
      return;
    }
    try {
      const parsed = zcodeProtocolMessageSchema.parse(JSON.parse(line));
      // 协议帧分发曾同步查询系统进程表，telemetry/streaming 高峰会阻塞
      // Host event loop 并让 subagent 面板无输出。运行期 data plane 只做解析和转发；
      // 完整进程树查询严格留在 dispose cleanup 边界。
      this.messageEmitter.fire(parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.fireClose({ reason: `protocol_parse_error: ${reason}` });
    }
  }

// [失败路径] EPIPE 必须在这里被吃掉：Node 的 stdin 写入回调 reject 之外，
// 底层 Socket 还会再发一次 error，没有长期监听会直接打崩 zcode-server。
// 统一转成 close 事件，让上层按连接断开处理而不是进程崩溃。
  private handleStreamError(stream: "stdin" | "stdout", error: Error): void {
    // 远端 WSL/SSH agent 秒退后，host 仍可能正在写入尚未完成的协议请求。
    // Node 的 stdin write 回调会 reject，但底层 Socket 还会额外触发 error 事件；若没有长期监听，
    // zcode-server 会因未处理的 EPIPE 直接崩溃，UI 只能看到远端连接断开而不是协议请求失败。
    // 这里把 stream error 视为 transport 已关闭，阻止后续继续向失效 agent 写入。
    this.fireClose({ reason: `${stream}_error: ${error.message}` });
  }

// 关闭只广播一次：首个原因即根因，后续 exit/error/EOF 都静默忽略。
  private fireClose(event: ZCodeProtocolTransportClosedEvent): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeEmitter.fire(event);
  }

// 解除监听后再 resume：让 stdout 继续流动到 EOF，避免管道背压把子进程卡住。
  private disposeReaders(): void {
    if (this.readersDisposed) {
      return;
    }
    this.readersDisposed = true;
    this.child.stdout.off("data", this.handleStdoutData);
    this.child.stdout.off("end", this.handleStdoutEnd);
    this.child.stdout.off("close", this.handleStdoutEnd);
// [资源] 不再消费数据但必须排空：pause 状态下子进程写满管道会永久阻塞，
// 导致回收阶段等不到 exit。
    this.child.stdout.resume();
  }

  private disposeLocalResources(): void {
    this.disposeReaders();
    this.messageEmitter.dispose();
    this.closeEmitter.dispose();
  }

// 发 EOF 前挂一个一次性 error 监听：CLI 可能正好在此刻退出，
// 半关闭的 stdin 会抛 EPIPE，这个监听只负责吞掉它。
  private requestStdioClose(): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    try {
      this.child.stdin.once("error", () => undefined);
      this.child.stdin.end();
    } catch {
      // agent 可能正好在 disposeAndWait 期间退出，stdin 已半关闭时 EOF 请求失败；
      // 失败不应打断后续进程树兜底，否则关闭路径又可能留下 runtime 残留。
    }
  }

// [并发] 退出与超时二选一，settle 幂等；定时器 unref 不阻止 Host 退出。
// 超时后仍继续走进程树回收，因此这里 resolve 不代表进程已退出。
  private waitForChildExit(timeoutMs: number): Promise<void> {
    if (this.hasChildExited()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.child.off?.("exit", settle);
        resolve();
      };
      this.child.once("exit", settle);
      timer = setTimeout(settle, timeoutMs);
      timer.unref?.();
    });
  }

// exitCode 与 signalCode 任一非 null 都算已退出：信号终止不会写 exitCode。
  private hasChildExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

// [事务] 快照优先级：存活树 → Windows 不可验证占位 → 进程组 → 已退出根的旧后代。
// 每一步都依赖上一步的失败原因，不能并行也不能跳过。
// 不可验证快照是刻意保留的：它让后续回收继续观察原 child 并明确报残留，
// 而不是向可能被复用的 PID 发信号。
  private async captureCleanupSnapshot(
    windowsCleanupDeadlineAtMs?: number,
  ): Promise<ProcessTreeSnapshot | undefined> {
    const childHadExited = this.hasChildExited();
    const liveTree = childHadExited
      ? undefined
      : await captureProcessTreeSnapshotAsync(this.child, {
          log: processTreeLogger,
          ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
          ownedProcessStartedAtMs: this.options?.ownedProcessStartedAtMs,
          // root 可能在 WMIC/CIM 查询期间退出。查询开始时还没有退出时间，
          // 必须在同轮查询完成后读取 exit 事件记录，才能安全恢复旧后代且排除 PID 复用。
          resolveOwnedProcessExitedAtMs: () => this.childExitedAtMs,
        });
// 存活树是最强证据，直接返回；其余分支只在查询失败或根已退出时使用。
    if (liveTree) {
      return liveTree;
    }
    if (process.platform === "win32" && !childHadExited && this.child.pid) {
      // 查询失败时不再串行追加第二次查询；查询期间 root 正常退出的后代已经由
      // captureProcessTreeSnapshotAsync 使用同轮进程表和 root 生命周期恢复。这里必须
      // 显式保留“身份不可验证”，否则空 identities 会被误判为进程树已经退出。
      return {
        rootPid: this.child.pid,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      };
    }
    const processGroupId = this.options?.ownedProcessGroupId;
    if (processGroupId) {
      return captureProcessGroupSnapshot(processGroupId);
    }
    const exitedTree = await captureExitedRootDescendantsSnapshotAsync(this.child.pid ?? 0, {
      log: processTreeLogger,
      ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
      ownedProcessStartedAtMs: this.options?.ownedProcessStartedAtMs,
      ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
    });
    if (exitedTree) {
      return exitedTree;
    }
    // Windows 异步 CIM 查询失败后不能在 terminateAndWait 内立刻再查一次，
    // 否则两个查询超时会串行叠加并吃满 Main 的退出预算。不可验证快照会继续观察
    // 原 ChildProcess，并在超时后明确报告残留，但绝不向未经验证的复用 PID 发信号。
    return process.platform === "win32" && this.child.pid
      ? {
          rootPid: this.child.pid,
          descendantPids: [],
          identities: [],
          identityVerification: "unavailable",
        }
      : undefined;
  }
}
