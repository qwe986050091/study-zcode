// INV-01 平台差异收敛在单文件：守住位置 类职责边界；改错故障 Windows 与 POSIX 逻辑互相污染。
// INV-02 资源遥测只在 Bash 开启：守住位置 双重判断；改错故障 普通命令上报空遥测。
// INV-03 终止原因按优先级归类：守住位置 三元链；改错故障 超时被记成主动终止。
// INV-04 准备阶段不启动进程：守住位置 纯准备注释与实现；改错故障 探测阶段泄漏子进程。
// INV-05 快照环境含提供方覆盖：守住位置 合并表达式；改错故障 探测到的别名与实际执行不符。
// INV-06 快照仅限直接执行形态：守住位置 四条件；改错故障 系统 shell 被注入启动脚本。
// INV-07 有快照即关闭登录模式：守住位置 布尔推导；改错故障 登录重读配置抵消可复现性。
// INV-08 启动脚本作为可选前置：守住位置 可选标记；改错故障 快照被清理后命令直接失败。
// INV-09 cwd 包装后按新命令重解析：守住位置 命令行比较；改错故障 方言与包装文本不匹配。
// INV-10 POSIX 必须独立进程组：守住位置 detached 表达式；改错故障 无法整体清理后代。
// INV-11 标准输入按需接入：守住位置 三元选择；改错故障 无输入时也占用管道。
// INV-12 无进程号退回根进程信号：守住位置 早退分支；改错故障 无法终止时静默卡住。
// INV-13 Windows 用整树强制终止：守住位置 参数列表；改错故障 只杀根进程留下孤儿。
// INV-14 终止器失败仍有兜底：守住位置 错误监听；改错故障 等待永不结算。
// INV-15 Bash 清理纳入关机等待：守住位置 登记表写入；改错故障 关机提前释放资源。
// INV-16 通用进程组保持既有边界：守住位置 分支选择；改错故障 修复能力扩散到其他调用方。
// INV-17 输出接入同时喂收集器与事件：守住位置 双写顺序；改错故障 事件与落盘内容不一致。
// INV-18 排空超时先杀树再销毁：守住位置 三步顺序；改错故障 孙进程持管道导致永久挂起。
//
// 模块职责：把执行请求编译成子进程调用，并负责终止、输出接入与排空。
// 状态所有权：子进程句柄与待清理表由基类持有，本类不缓存跨请求状态。
// 阅读顺序：先看遥测与准备，再看两条终止路径，最后看输出接入与排空。
// ============================================================
// 文件定位：把 ExecutionRequest 编译成 spawn 调用，并负责进程树终止、pipe 输出接入与 IO 排空。
// 输入输出：prepareChildSpawn 产出 file/args/shell/env/cwd/stdio；其余方法只操作已 spawn 的 child。
// 副作用：spawn 子进程、taskkill（Windows）、向进程组发信号、挂 data/error 监听、写 stdin、destroy 流。
// 失败语义：spawn 失败向上抛由 run 层转 spawn_error；kill 失败按“进程已退出”处理；stdin EPIPE 只记录不抛出。
// 不变量：POSIX 一律 detached 建独立进程组；Bash 才允许跨 PGID 杀树；stdio 恒为 [ignore|pipe, pipe, pipe]。
// ============================================================
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { applyBashSourcesToExecutionRequest } from "./bash-startup-script.js";
import { createBashResourceTelemetry } from "./bash-resource-telemetry.js";
import { createCwdCapturePlan } from "./cwd-capture.js";
import {
  applyResolvedShellCommand,
  buildExecutionEnv,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "./execution-command.js";
import { NodeExecutionAdapterResults } from "./node-execution-adapter-results.js";
import { createExecutionOutputStreamDecoder } from "./outputEncoding.js";
import type { OutputCollector } from "./output-collector.js";
import {
  BASH_SIGTERM_TO_SIGKILL_MS,
  signalPosixProcessTree,
  terminateGenericPosixProcessGroup,
} from "./process-tree.js";
import {
  revalidateShellInitSnapshotForExecution,
  supportsShellInitSnapshot,
} from "./shell-init-snapshot.js";
import {
  IO_DRAIN_TIMEOUT_MS,
  resolveDefaultOutputRootDir,
  sanitizePathSegment,
  waitForPromise,
} from "./execution-utils.js";
import type {
  ExitState,
  InternalExecutionRunOptions,
  PreparedChildSpawn,
} from "./execution-adapter-types.js";
import type { ExecutionRequest, ExecutionRunOptions } from "@zcode/contracts";

// 进程层：向下继承 run/results，向上被 lifecycle 复用。
// 所有平台差异（Windows taskkill、POSIX 进程组、Git Bash 路径）都收敛在本文件。
// 进程层只处理平台相关的执行细节。
// 该封装被 lifecycle 层复用，入参不感知业务类型。
// 所有 Windows 与 POSIX 差异收在此处。
// 类本身不保存跨请求状态。
export class NodeExecutionAdapterProcess extends NodeExecutionAdapterResults {
  // 为 Bash 开启资源遥测：非 Bash 或未配置回调时返回 no-op。
  // 返回的 finish 闭包在退出时按 timeout/killed/error/completed 归类并上报一次。
  protected trackBashResources(
    child: ChildProcess,
    isBash: boolean,
    stopState: () => { timedOut: boolean; killed: boolean },
  ): (state: ExitState) => void {
    if (!isBash || !this.options.onToolExecResource) return () => {};
    const telemetry = createBashResourceTelemetry({
      platform: this.platform,
      processGroupId: child.pid,
      onComplete: this.options.onToolExecResource,
    });
    return (state) => {
      const stop = stopState();
      // 终止原因优先级：先看是否已判定超时，再看是否主动 kill/收到信号，最后才看 spawn 错误。
      telemetry.finish(
        stop.timedOut
          ? "timeout"
          : stop.killed || state.signal
            ? "killed"
            : state.error
              ? "error"
              : "completed",
      );
    };
  }

  // 组装一次 spawn：环境 → 命令解析 → 可选 shell 快照 → 启动脚本 → cwd 捕获 → 最终 argv/spawnOptions。
  // 只有 Git Bash / POSIX bash 且 direct-exec 时才尝试初始化快照；拿到快照就改为非登录 shell。
  // 本方法只做纯准备（除快照生成外无进程启动）；真正 spawn 在 run 层完成。
  // 先建 env 再 resolveCommand，顺序反了会丢 PATH。
  // 快照探测用最终环境，避免别名错位。
  // 只有直接执行的 posix 配置才做快照。
  // wrapped 命中时对 innerCommand 重新 resolve。
  protected async prepareChildSpawn(request: ExecutionRequest): Promise<PreparedChildSpawn> {
    const env = buildExecutionEnv(request.env, {
      network: this.options.network,
      platform: this.platform,
      processEnv: this.processEnv,
    });
    const resolvedCommand = resolveExecutionCommand(request.command, {
      cwd: request.cwd,
      env,
      platform: this.platform,
    });
    const rootDir =
      this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv);
    const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
    // 快照生成要用“最终会传给 shell 的环境”，因此先合并 provider 的 envOverlay 再探测。
    const snapshotEnv = resolvedCommand.envOverlay
      ? { ...env, ...resolvedCommand.envOverlay }
      : env;
    // 只有 shell 模式 + posix-bash + direct exec（shell===false）才值得做快照；
    // 系统 shell 的启动行为由 shell 自己负责，注入 source 反而不可控。
    const shellInitSnapshot =
      request.command.mode === "shell" &&
      request.command.shellProfile === "posix-bash" &&
      resolvedCommand.shell === false &&
      supportsShellInitSnapshot(resolvedCommand.cwdDialect)
        ? await revalidateShellInitSnapshotForExecution(
            await this.shellInitSnapshots.getOrCreate({
              env: snapshotEnv,
              rootDir,
              shellDialect: resolvedCommand.cwdDialect,
              shellPath: resolvedCommand.file,
            }),
          )
        : undefined;
    // 已有快照就不再走登录 shell：登录模式会重新读 .bashrc，抵消快照带来的可复现性。
    const useLoginShell = shellInitSnapshot ? false : true;
    const resolvedShell = setResolvedShellLoginMode(resolvedCommand, useLoginShell);
    // 快照作为 optional 前置 source：文件若在运行前被清理，命令仍能执行（只是丢 alias）。
    const requestWithSources = applyBashSourcesToExecutionRequest(request, {
      leadingSources: shellInitSnapshot
        ? [
            {
              optional: true,
              path: shellInitSnapshot.path,
              shellPath: shellInitSnapshot.shellPath,
            },
          ]
        : [],
      rootDir,
      sessionId,
      shellDialect: resolvedCommand.cwdDialect,
    });
    const capturePlan = createCwdCapturePlan(requestWithSources, {
      dialect: resolvedCommand.cwdDialect,
      platform: this.platform,
    });
    // 命令被 cwd 捕获包装过（外层 shell 文本变化）时需要按新命令重新解析，
    // 否则直接套用已解析 shell，避免重复探测 Git Bash。
    const command =
      capturePlan.command === requestWithSources.command
        ? requestWithSources.command.mode === "shell"
          ? applyResolvedShellCommand(resolvedShell, requestWithSources.command.command)
          : resolvedShell
        : resolveExecutionCommand(capturePlan.command, {
            cwd: request.cwd,
            env,
            platform: this.platform,
            resolvedShell,
          });
    const spawnEnv = command.envOverlay ? { ...env, ...command.envOverlay } : env;
    // POSIX 必须 detached 才能形成独立进程组并被整体清理；Windows 由 taskkill /T 负责。
    const baseOptions = {
      cwd: request.cwd,
      detached: this.platform !== "win32",
      env: spawnEnv,
      shell: command.shell,
      stdio: [
        request.stdin === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
      ] satisfies StdioOptions,
      windowsHide: true,
    };

    return {
      command,
      cwdDialect: command.cwdDialect,
      cwdFilePath: capturePlan.cwdFilePath,
      spawnOptions: baseOptions,
    };
  }

  // 终止进程树：Windows 用 taskkill /T /F；POSIX 分通用进程组与 Bash 全树两套策略。
  // 无 pid 时退回 child.kill(SIGTERM)；Bash 的清理会话注册到 pendingBashProcessTreeKills 供 shutdown 等待。
  // 没有进程号时只对根进程发信号。
  // Windows 用系统命令整树强杀。
  // POSIX 分通用组与 Bash 全树两套。
  protected terminateProcessTree(child: ChildProcess, useBashProcessTreeStop: boolean): void {
    if (!child.pid) {
      child.kill("SIGTERM");
      return;
    }

    if (this.platform === "win32") {
      // taskkill 自身也可能失败；失败时对根进程补 SIGKILL，且 completion 必然 settle。
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const completion = new Promise<void>((resolve) => {
        killer.once("error", () => {
          child.kill("SIGKILL");
          resolve();
        });
        killer.once("close", () => resolve());
      });
      if (useBashProcessTreeStop) {
        // 直写后不再等待 pipe EOF，shutdown 必须显式等待 taskkill 收尾，避免提前释放资源。
        this.pendingBashProcessTreeKills.set(completion, killer);
        void completion.finally(() => this.pendingBashProcessTreeKills.delete(completion));
      }
      return;
    }

    if (!useBashProcessTreeStop) {
      // PPID 后代枚举只修复 Bash job-control 的跨 PGID 清理；通用 hook、
      // shell 和 argv execution 必须保留既有进程组边界，避免修复能力扩散到其它调用方。
      terminateGenericPosixProcessGroup(child);
      return;
    }

    const rootPid = child.pid;
    // Bash job control、pipeline、xargs 和 PTY 可以把 worker 放入不同 PGID。
    // 两阶段清理各自快照当时的 PPID 后代，不跨阶段记忆进程身份。
    void signalPosixProcessTree(rootPid, "SIGTERM");
    let timer!: NodeJS.Timeout;
    const escalation = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        try {
          process.kill(-rootPid, "SIGKILL");
        } catch {
          // 直接的 force group kill 只做 best effort，随后仍会执行完整杀树。
        }
        // shutdown 等待实际查表与信号发送，不能在异步杀树刚启动时就释放清理所有权。
        void signalPosixProcessTree(rootPid, "SIGKILL").then(resolve);
      }, BASH_SIGTERM_TO_SIGKILL_MS);
      timer.unref?.();
    });
    this.pendingBashProcessTreeKills.set(escalation, timer);
    void escalation.finally(() => {
      this.pendingBashProcessTreeKills.delete(escalation);
    });
  }

  // 直接销毁 stdout/stderr 流：仅在 IO 排空超时后调用，用于释放仍被孙进程持有的 pipe。
  protected destroyChildOutputStreams(child: ChildProcess): void {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  // 接入 pipe 输出：stdout/stderr 各一个流式解码器，data 同时进 collector 与事件流。
  // 事件里的 text 是解码结果，chunk 保留原始 Buffer，供上层按需再解码。
  protected attachPipedOutput(
    child: ChildProcess,
    stdout: OutputCollector,
    stderr: OutputCollector,
    encoding: string | null,
    options: ExecutionRunOptions,
  ): void {
    for (const [name, collector] of [
      ["stdout", stdout],
      ["stderr", stderr],
    ] as const) {
      const stream = child[name];
      const decoder = createExecutionOutputStreamDecoder(encoding);
      stream?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        collector.append(buffer, stream);
        this.emit(options, {
          type: name,
          chunk: buffer,
          text: decoder.write(buffer),
          timestamp: new Date(),
        });
      });
    }
  }

  // 写入 stdin 并立即 end；返回读取“首个错误”的闭包，供结果层判定是否需要提示。
  // 必须挂 error 监听：hook 可能提前关闭 stdin，异步 EPIPE 否则会以未捕获异常崩掉 Agent。
  protected writeChildInput(
    child: ChildProcess,
    input: ExecutionRequest["stdin"],
  ): () => Error | undefined {
    let failure: Error | undefined;
    if (input !== undefined && child.stdin) {
      const capture = (error: Error) => {
        failure ??= error;
      };
      // Hook 可以提前关闭 stdin，异步 EPIPE 必须有监听，不能让 Agent 崩溃。
      child.stdin.on("error", capture);
      try {
        child.stdin.end(input);
      } catch (error) {
        capture(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return () => failure;
  }

  // 等待 pipe 关闭：先给 1s；保留型执行（后台任务）无限等，其余按需杀树后再给 1s，仍不关就 destroy。
  // 这样既能让正常命令把尾部输出写完，又不会因孙进程持有 pipe 而永久挂住。
  // 先等 pipe 自然关闭的 graceMs 窗口。
  // keepAlive 为 true 时 timeout 传 Infinity。
  // 超时后先 killProcessTree 再 destroy stream。
  protected async drainChildOutput(
    child: ChildProcess,
    closed: Promise<void>,
    options: InternalExecutionRunOptions,
    terminationRequested: boolean,
  ): Promise<void> {
    if (await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS)) return;
    // 通用 argv/Hook 保留 pipe EOF 所有权；Bash 直写文件不会进入此路径。
    if (options.shouldRetainExecutionAfterRootExit?.() === true) {
      await closed;
      return;
    }
    if (!terminationRequested) this.terminateProcessTree(child, false);
    if (!(await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS))) this.destroyChildOutputStreams(child);
  }
}
