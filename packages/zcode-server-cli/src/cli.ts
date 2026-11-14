/* eslint-disable max-lines -- Server lifecycle、首装、迁移与卸载命令共享同一 CLI 解析和安全边界。 */
// ============ 职责边界 ============
// 做：解析 zcode-server 命令行参数，分派 version、serve、status、stop、restart、running-tasks、
// update、uninstall、proxy-stdio、migrate retry，并把结果按 human 或 json 输出。
// 不做：不实现 Supervisor 与 Core 的运行逻辑，不管理 release 内容，不做服务注册的平台实现。
// 依赖：@zcode/services 的 workspace alias repo；contracts 的 schema 与超时常量；runtime 下的
// paths、lock、releaseManager、updateHandoff、serviceInstallation；server-core 的 proxyStdio。
// 边界：CLI 是一次性进程，所有可变状态必须落在文件或锁上；不持有跨命令的内存状态。
//
// ============ INV 不变量表 ============
// INV-01 断言：update 与 uninstall 必须共用同一把 DataRootLock —— 守住它的位置：acquireLifecycleCommandLock 的锁文件来源 —— 改错故障：两个命令并发，删除正在写入的 release。
// INV-02 断言：生命周期命令必须在任何 IO 前把 serverRoot 收敛为 canonical 路径 —— 守住它的位置：runServerCli 的 layout 计算 —— 改错故障：符号链接别名派生不同 endpoint，重复注册。
// INV-03 断言：version 必须在 layout 解析与锁获取之前返回 —— 守住它的位置：runServerCli 的首个分支 —— 改错故障：半装环境也会访问文件，版本探测不稳定。
// INV-04 断言：json 标志必须在解析前读取且只读一次 —— 守住它的位置：runServerCli 开头的局部常量 —— 改错故障：参数解析失败时无法输出结构化错误。
// INV-05 断言：proxy-stdio 必须在 switch 之前处理 —— 守住它的位置：runServerCli 的早返回分支 —— 改错故障：落入 legacy delegate，stdio 被错误进程占用。
// INV-06 断言：migrate retry 的 --path 必须是绝对路径 —— 守住它的位置：migrateRetryRequested 分支的两次校验 —— 改错故障：按 CWD 解析，迁移到错误目录。
// INV-07 断言：只有公开错误码才能写入 code，retryable 依赖 code 合法 —— 守住它的位置：顶层 catch 的序列化 —— 改错故障：泄漏内部标识或让客户端按错误语义重试。
// INV-08 断言：--server-root 最多出现一次且必须从 argv 移除 —— 守住它的位置：parseServerCliArguments —— 改错故障：子命令看到未知参数，或重复参数被静默择一。
// INV-09 断言：daemon 注册必须排除 supervisor 子进程 —— 守住它的位置：shouldRegisterService 的布尔组合 —— 改错故障：子进程再注册服务，形成注册风暴。
// INV-10 断言：启动前必须用短超时读取一次 control status —— 守住它的位置：readControlStatus 的 500ms —— 改错故障：首装或停机路径被拉长，用户看到无响应。
// INV-11 断言：fallback 模式下即使实例 ready 也必须继续替换 —— 守住它的位置：existing 的复用分支 —— 改错故障：fallback 实例永远不会被服务管理器接管。
// INV-12 断言：有 runningTaskCount 时绝不替换实例 —— 守住它的位置：stopExistingSupervisor 之前的判断 —— 改错故障：运行中的任务被强停，结果丢失。
// INV-13 断言：fallback 入口必须用 process.argv[1] —— 守住它的位置：supervisorEntry 的取值 —— 改错故障：archive 更新后指向已清理的临时解压目录，子进程立即崩溃。
// INV-14 断言：后台子进程必须 detached、stdio ignore、unref、disconnect —— 守住它的位置：fork 之后的四步 —— 改错故障：CLI 的事件循环被 IPC 通道拖住，daemon 命令不退出。
// INV-15 断言：ready 判定必须比较 updatedAt 与启动基线 —— 守住它的位置：waitForPersistedStatus 的条件 —— 改错故障：把上一次运行的 ready 当成本次成功。
// INV-16 断言：crash-loop-stopped 必须立即抛错，且抛错前先 stop Supervisor —— 守住它的位置：waitForSupervisorReady 与 catch —— 改错故障：socket 与锁残留，后续 serve 永久 already running。
// INV-17 断言：APPLY_UPDATE_TIMEOUT_MS 必须覆盖完整回滚路径且常量取自 contracts —— 守住它的位置：该导出的表达式 —— 改错故障：回滚仍在执行时 CLI 误报超时。
// INV-18 断言：状态 invalid 或 unreadable 时必须拒绝 stop —— 守住它的位置：stopExistingSupervisor 的入口校验 —— 改错故障：重复注册，旧 owner 仍持有锁。
// INV-19 断言：卸载必须先校验安装归属、再注销服务、再取卸载锁 —— 守住它的位置：runUninstall 与 finishUninstall 的先后 —— 改错故障：任意绝对目录可被递归删除，或服务被重新拉起。
// INV-20 断言：uninstallEntries 是唯一删除白名单，install.json 绝不在其中 —— 守住它的位置：该常量数组 —— 改错故障：删除身份文件，App 把同一设备拆成新设备。
//
// ============ 阅读提示 ============
// 本文件同时承载生命周期、首装、迁移与卸载，改动前先确认命令归属与锁的获取顺序。
// 所有 await 点都可能被并发 CLI 插入，不能把「检查」与「执行」拆成两个无锁阶段。
// 输出格式是脚本与 Desktop probe 的契约，改文案前先确认调用方。
// 注意：注释中的行号以插入时文件为准，后续改动会漂移，请按符号名检索。
import { fork } from "node:child_process";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isPublicZCodeErrorCode, ZCODE_VERSION } from "@zcode/shared";
import { SourceServerWorkspaceAliasRepo } from "@zcode/services/node";
import {
  CORE_KILL_TIMEOUT_MS,
  CORE_READY_TIMEOUT_MS,
  CORE_STOP_GRACE_TIMEOUT_MS,
  controlRequestSchema,
  createStoppedServerStatus,
  serverStatusSchema,
  type ServerStatus,
} from "./contracts.js";
import { requestControl } from "./ipc/controlClient.js";
import {
  resolveCanonicalServerLayout,
  resolveServerLayout,
  validateUninstallTarget,
} from "./runtime/paths.js";
import { validateServerInstallOwnership } from "./runtime/installationOwnership.js";
import { createReleaseAgentWiring, type BundledAgentWiring } from "./runtime/agentWiring.js";
import { writeStableLauncher } from "./runtime/stableLauncher.js";
import {
  runLocalArchiveUpdateCommand,
  runUpdateCommand,
  type UpdateDaemonHandoff,
} from "./runtime/updateCommand.js";
import { DataRootLock } from "./runtime/lock.js";
import { ReleaseManager } from "./runtime/releaseManager.js";
import { createUpdateDaemonHandoff } from "./runtime/updateHandoff.js";
import {
  acquireUninstallLock,
  describeLockInspection,
  removeRunContentsExceptLock,
} from "./runtime/uninstallGuard.js";
import { readPersistedStatus, readPersistedStatusDetailed } from "./runtime/statusSnapshot.js";
import { waitForServerStopped } from "./runtime/shutdownWait.js";
export { readPersistedStatus } from "./runtime/statusSnapshot.js";
import {
  hasLegacyServiceRegistration,
  unregisterInstalledService,
  unregisterLegacyServiceForRoot,
} from "./runtime/serviceInstallation.js";
import { ProxyStdioError, runProxyStdio } from "./server-core/proxyStdio.js";

export interface CliIO {
  stdout?: { write(value: string): void };
  stderr?: { write(value: string): void };
  confirm?: (prompt: string) => Promise<string>;
  legacyDelegate?: (argv: readonly string[]) => Promise<number>;
}

export interface ServerCliRuntimeOptions {
  bundledAgentWiring?: BundledAgentWiring | null;
  proxyStdioStreams?: { input: Readable; output: Writable };
  workspaceAliasRepo?: Pick<SourceServerWorkspaceAliasRepo, "retryFailedWorkspace">;
  /** process/service manager 是更新协调器的外部边界；测试可注入受控实现。 */
  updateDaemonHandoff?: UpdateDaemonHandoff;
}

const stdout = (io: CliIO, value: unknown): void =>
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
const stderr = (io: CliIO, value: unknown): void =>
  io.stderr?.write(`${value instanceof Error ? value.message : String(value)}\n`);

// [契约] update 与 uninstall 必须共用同一把 DataRootLock，锁文件取自 canonical layout。
// [失败路径] 用两个不同锁文件会让 update 与 uninstall 并发，删除正在写入的 release。
// [并发] 锁冲突时把原始错误挂到 cause 上，保留可诊断性，不要吞掉。
// [权衡] 只在消息包含 already running 时转换文案，其他 IO 错误原样上抛。
// [边界] 本函数不设置等待与重试，拿不到锁必须立即失败让用户重试。
async function acquireLifecycleCommandLock(
  layout: ReturnType<typeof resolveServerLayout>,
  conflictMessage: string,
): Promise<DataRootLock> {
  const lock = new DataRootLock(layout.updateLockFile);
  try {
    await lock.acquire();
    return lock;
  } catch (error) {
    if (error instanceof Error && error.message.includes("already running")) {
      throw new Error(conflictMessage, { cause: error });
    }
    throw error;
  }
}

export function serviceRegistrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZCODE_SERVER_SKIP_SERVICE_REGISTRATION !== "1";
}

export function daemonStartupMode(env: NodeJS.ProcessEnv = process.env): "service" | "fallback" {
  return serviceRegistrationEnabled(env) ? "service" : "fallback";
}

export function isRegisteredServiceEntry(args: readonly string[]): boolean {
  return args.includes("--service-entry");
}

export const SERVER_SERVICE_ARGS = ["serve", "--supervisor"] as const;

export function shouldRegisterService(
  daemonRequested: boolean,
  supervisorProcess: boolean,
): boolean {
  return daemonRequested && !supervisorProcess;
}

// [契约] `runServerCli` 是唯一对外入口；命令分派与错误收敛都在函数内完成，退出码由函数返回供测试断言。
// [失败路径] 顶层 catch 必须把非 json 错误写到 stderr 并返回 1，不能吞掉后返回 0。
// [契约] json 标志在解析前读取，保证参数解析失败时仍能输出结构化错误。
// [权衡] 用返回值而非 process.exit，便于单测与 legacy delegate 复用。
// [边界] 本函数不持有任何跨命令状态，每次调用都是独立生命周期。
export async function runServerCli(
  argv: readonly string[],
  io: CliIO = {},
  runtimeOptions: ServerCliRuntimeOptions = {},
): Promise<number> {
  // [契约] 只认 --json 精确匹配，不支持等号形式，避免解析歧义。
  // [失败路径] 把它做成全局变量会让并发调用互相污染，这里必须是局部常量。
  // [契约] 该值决定后续所有输出的序列化形态，中途不得再读 argv 重新判断。
  // [权衡] 在 try 之外读取，保证解析抛错时错误输出仍能带上结构化格式。
  // [边界] 不校验 JSON 输出是否存在循环引用，序列化失败属于调用方错误。
  const json = argv.includes("--json");
  try {
    const parsed = parseServerCliArguments(argv);
    const command = parsed.argv[0];
    // [契约] version 必须在任何 layout 解析与锁获取之前返回，避免无意义的文件访问。
    // [失败路径] 让它落入 legacy delegate 会把兼容性交给旁边的 Agent，Desktop probe 无法判定。
    // [契约] json 输出固定为 product 与 version 两个字段，字段名是探针契约。
    // [权衡] 非 json 只输出裸版本号，便于脚本直接比较。
    // [边界] 不检查安装是否完整，版本命令必须在半装状态下也能用。
    if (command === "version" || command === "--version") {
      // Bug 原因：Server --version 过去落入 legacy delegate，实际输出取决于旁边的 Agent
      // zcode.cjs，Desktop probe 无法稳定判断 Server compatibility。
      stdout(io, json ? { product: "zcode-server", version: ZCODE_VERSION } : ZCODE_VERSION);
      return 0;
    }
    const proxyStdioRequested =
      command === "proxy-stdio" || (command === "server" && parsed.argv[1] === "proxy-stdio");
    const migrateRetryRequested = command === "migrate" && parsed.argv[1] === "retry";
    if (!command) {
      return await (io.legacyDelegate?.(parsed.argv) ?? delegateLegacyCli(parsed.argv, io));
    }
    // 同一物理 data-root 的符号链接别名会派生不同 control endpoint 和 OS service
    // identity。生命周期命令统一在 IO 前收敛 root，避免第二个 Supervisor 绕过探测重复注册。
    // [契约] 生命周期命令必须在任何 IO 前把 serverRoot 收敛成 canonical 路径。
    // [失败路径] 用符号链接别名分别解析会派生不同 control endpoint 与 OS service identity。
    // [并发] 收敛前不能读锁或探测状态，否则第二个 Supervisor 会绕过检测重复注册。
    // [契约] canonical 化只对生命周期命令生效，其他命令保留用户传入的 layout。
    // [边界] 本步不校验目录是否存在，缺失由下游 lock 与 release 逻辑报错。
    const layout =
      ["serve", "status", "stop", "restart", "update", "uninstall"].includes(command) ||
      proxyStdioRequested ||
      migrateRetryRequested
        ? await resolveCanonicalServerLayout(parsed.layout.serverRoot)
        : parsed.layout;
    // [契约] proxy-stdio 必须在 switch 之前处理，因为它不返回 ServerStatus。
    // [失败路径] 放进 switch 会让 default 分支落到 legacy delegate，stdio 被错误进程占用。
    // [契约] 错误必须序列化成 ok=false 加 code 的单行 JSON，Desktop 依赖该形状。
    // [权衡] 捕获范围只覆盖 runProxyStdio，不包括参数解析，避免掩盖 CLI 用法错误。
    // [边界] 不关闭传入的流，生命周期归调用方。
    if (proxyStdioRequested) {
      try {
        await runProxyStdio({
          layout,
          input: runtimeOptions.proxyStdioStreams?.input ?? process.stdin,
          output: runtimeOptions.proxyStdioStreams?.output ?? process.stdout,
        });
        return 0;
      } catch (error) {
        const code = error instanceof ProxyStdioError ? error.code : "proxy-stdio-failed";
        io.stderr?.write(
          `${JSON.stringify({ ok: false, code, error: error instanceof Error ? error.message : String(error) })}\n`,
        );
        return 1;
      }
    }
    // [契约] migrate retry 要求 --path 是绝对路径，缺参或相对路径都必须立即失败。
    // [失败路径] 允许相对路径会按 CLI 的 CWD 解析，workspace alias 迁移到错误目录。
    // [契约] pathIndex 取第一个 --path，重复参数不做优先级合并。
    // [权衡] 直接 new SourceServerWorkspaceAliasRepo 作为兜底，测试通过 runtimeOptions 注入。
    // [边界] 不校验目标 workspace 是否真实存在，由 repo 的 retry 逻辑判定。
    if (migrateRetryRequested) {
      const pathIndex = parsed.argv.indexOf("--path");
      const workspacePath = pathIndex >= 0 ? parsed.argv[pathIndex + 1] : undefined;
      if (!workspacePath) throw new Error("migrate retry requires --path");
      if (!isAbsolute(workspacePath)) throw new Error("migrate retry --path must be absolute");
      const result = await (
        runtimeOptions.workspaceAliasRepo ?? new SourceServerWorkspaceAliasRepo()
      ).retryFailedWorkspace(workspacePath);
      stdout(io, json ? { ok: true, ...result } : `Migration recovered: ${result.canonicalKey}`);
      return 0;
    }
    switch (command) {
      case "serve":
        return await runServe(parsed.argv.slice(1), io, json, layout, runtimeOptions);
      case "status":
      case "running-tasks":
      case "stop":
      case "restart":
        return await runControl(command, io, json, {}, layout);
      case "update": {
        const updateLock = await acquireLifecycleCommandLock(
          layout,
          "Another ZCode Server update is already running",
        );
        const updateDaemonHandoff =
          runtimeOptions.updateDaemonHandoff ?? createUpdateDaemonHandoff();
        try {
          if (parsed.argv.includes("--from-archive")) {
            return await runLocalArchiveUpdateCommand(
              parsed.argv,
              io,
              json,
              layout,
              () => requestApplyUpdate(layout, parsed.argv.includes("--force")),
              updateDaemonHandoff,
            );
          }
          return await runUpdateCommand(
            parsed.argv,
            io,
            json,
            layout,
            () => requestApplyUpdate(layout, parsed.argv.includes("--force")),
            updateDaemonHandoff,
          );
        } finally {
          await updateLock.release();
        }
      }
      case "uninstall": {
        const uninstallLock = await acquireLifecycleCommandLock(
          layout,
          "A ZCode Server update is already running",
        );
        try {
          return await runUninstall(io, json, layout);
        } finally {
          await uninstallLock.release();
        }
      }
      default:
        return await (io.legacyDelegate?.(parsed.argv) ?? delegateLegacyCli(parsed.argv, io));
    }
  // [契约] 只有公开错误码才写入 code 字段，未知 code 必须丢弃，避免泄漏内部标识。
  // [失败路径] retryable 只在 code 合法时才附带，否则客户端会按不存在的语义重试。
  // [契约] 人类可读模式只输出 error.message，不打印堆栈，避免泄漏路径。
  // [权衡] 所有异常统一返回 1，不区分退出码，脚本只依赖成功与非成功。
  // [边界] 本 catch 不负责回滚已获取的锁，锁由各命令的 finally 释放。
  } catch (error: unknown) {
    if (json) {
      const structured =
        error && typeof error === "object"
          ? (error as { code?: unknown; retryable?: unknown })
          : null;
      const publicCode = isPublicZCodeErrorCode(structured?.code) ? structured.code : undefined;
      stdout(io, {
        ok: false,
        ...(publicCode ? { code: publicCode } : {}),
        ...(publicCode && typeof structured?.retryable === "boolean"
          ? { retryable: structured.retryable }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    } else stderr(io, error);
    return 1;
  }
}

// [契约] --server-root 最多出现一次，重复必须抛错而不是取最后一个。
// [失败路径] 允许多次出现会让调用方以为后面的生效，实际取决于实现顺序。
// [契约] 解析后必须把该选项及其值从 argv 移除，否则子命令会看到未知参数。
// [权衡] 只支持前置值形式，不支持等号形式，保持与现有脚本兼容。
// [边界] 不校验 serverRoot 是否可写，只校验绝对路径。
function parseServerCliArguments(argv: readonly string[]): {
  argv: readonly string[];
  layout: ReturnType<typeof resolveServerLayout>;
} {
  const rootOptionIndexes = argv.flatMap((value, index) =>
    value === "--server-root" ? [index] : [],
  );
  if (rootOptionIndexes.length > 1) throw new Error("--server-root may only be specified once");
  const rootOptionIndex = rootOptionIndexes[0];
  if (rootOptionIndex === undefined) return { argv, layout: resolveServerLayout() };
  const serverRoot = argv[rootOptionIndex + 1];
  if (!serverRoot) throw new Error("--server-root requires an absolute path");
  if (!isAbsolute(serverRoot)) throw new Error("--server-root must be an absolute path");
  return {
    argv: argv.filter(
      (_value, index) => index !== rootOptionIndex && index !== rootOptionIndex + 1,
    ),
    layout: resolveServerLayout(serverRoot),
  };
}

// [契约] serve 是唯一同时支持 service 与 fallback 两种启动模式的命令。
// [失败路径] 两条路径的 ready 判定都必须基于持久化状态，不能只看子进程是否存活。
// [契约] daemonRequested 与 supervisorProcess 共同决定是否注册，二者不能合并成一个布尔。
// [权衡] 前台模式阻塞在信号 promise 上，daemon 模式返回后必须主动断开 stdin。
// [边界] 本函数不实现 Supervisor 内部逻辑，只做编排与等待。
async function runServe(
  args: readonly string[],
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  runtimeOptions: ServerCliRuntimeOptions,
): Promise<number> {
  const daemonRequested = args.includes("--daemon");
  const supervisorProcess = args.includes("--supervisor");
  // [契约] 只有 daemon 且不是 supervisor 子进程时才注册，防止子进程重复注册自己。
  // [失败路径] 去掉 supervisor 判断会让 supervisor 再拉一个 service，形成注册风暴。
  // [契约] 该判断必须在任何平台探测之前，非 Windows 也要先确定是否走 service。
  // [权衡] 用参数而非读 env，便于测试覆盖四种组合。
  // [边界] 返回 true 不代表服务管理器可用，可用性在下面单独探测。
  if (shouldRegisterService(daemonRequested, supervisorProcess)) {
    let startupMode = daemonStartupMode();
    const platform =
      process.platform === "darwin" || process.platform === "linux" ? process.platform : "win32";
    if (startupMode === "service") {
      const { isServiceManagerAvailable } = await import("./platform/serviceManager.js");
      if (!(await isServiceManagerAvailable(platform))) {
        // Bug 原因：SSH 过去把 transport 类型等同于“必有 systemd --user/launchd”。
        // 容器、最小系统和无 user bus 的非交互会话因此在安装完成后必然连接失败。
        startupMode = "fallback";
      }
    }
    const legacyIdentityMigration =
      startupMode === "service" && (await hasLegacyServiceRegistration(layout));
    // [契约] 启动前必须读一次 control status，且超时固定为 500ms，避免拖慢首装。
    // [失败路径] 超时设太长会让无 Server 的机器在每次 serve 时都等满，体验退化。
    // [契约] 读不到状态返回 null，等价于没有可复用的实例，不是错误。
    // [权衡] 用短超时而非直接探测 socket 文件，兼顾残留文件与半启动状态。
    // [边界] 该结果只用于决策，不能作为最终 ready 证据。
    const existing = await readControlStatus(layout, 500);
    if (existing && (existing.state === "ready" || existing.state === "starting")) {
      // [契约] 已有实例且服务已注册时可直接复用，但要排除需要做 legacy 身份迁移的情况。
      // [失败路径] 迁移期间直接复用会让新旧 service identity 并存，后续卸载删不干净。
      // [契约] fallback 模式下即使实例 ready 也要继续走到替换逻辑，因为 fallback 无法被接管。
      // [权衡] 复用前先判断 runningTaskCount，有任务时绝不替换，宁可报错。
      // [边界] 本分支不停止实例，替换动作统一交给 stopExistingSupervisor。
      if ((existing.serviceRegistered && !legacyIdentityMigration) || startupMode === "fallback") {
        if (json) stdout(io, existing);
        else
          stdout(
            io,
            `ZCode Server ${existing.state} at ${existing.host ?? ""}:${existing.port ?? ""}`,
          );
        return 0;
      }
      if (existing.runningTaskCount > 0) {
        throw new Error(
          `Cannot replace fallback daemon while ${existing.runningTaskCount} task(s) are running; stop the server first`,
        );
      }
      // 旧 fallback 会持有 data-root lock，直接注册并启动 OS service 只能
      // 拉起一个立即锁冲突的 Supervisor。空闲时先收口 fallback，再重试真实注册。
      await stopExistingSupervisor(layout, "Cannot verify fallback Server status before migration");
    } else if (existing?.state === "stop-failed" && existing.pid === null) {
      // Bug 原因：stop-failed 的 Supervisor 观察到迟到的 Core 终态后仍持有锁和 control socket，
      // 直接启动只会让新 Supervisor 锁冲突，设备在手工 stop 前无法恢复。已无存活 Core 时由
      // 原 owner 按 stop 契约收口；pid 仍存在则不发 stop，继续由锁 fail-closed。
      await stopExistingSupervisor(
        layout,
        "Cannot verify stop-failed Server status before restart",
      );
    }
    const baselineUpdatedAt = (await readPersistedStatus(layout))?.updatedAt ?? 0;
    let serviceStarted = false;
    let childEarlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    if (startupMode === "service") {
      const { createDaemonServiceDescriptor, registerService, serviceDescriptorPath } =
        await import("./platform/serviceManager.js");
      await writeStableLauncher(layout, platform, {
        command: process.execPath,
        entry: process.argv[1] ?? fileURLToPath(import.meta.url),
      });
      const descriptor = createDaemonServiceDescriptor({ platform, layout });
      await mkdir(layout.serviceDir, { recursive: true, mode: 0o700 });
      const descriptorPath = serviceDescriptorPath(layout, descriptor);
      await writeFile(descriptorPath, descriptor.content, "utf8");
      await unregisterLegacyServiceForRoot(layout);
      // 服务管理器已通过能力探测后，注册失败表示权限、descriptor 或真实系统异常。
      // 此时必须向调用方返回根因，不能再用 detached fallback 掩盖。
      await registerService(descriptor, descriptorPath);
      serviceStarted = true;
    }
    // [契约] fallback 必须用 process.argv[1] 作为入口，不能依赖 import.meta.url。
    // [失败路径] archive 更新时 import.meta.url 指向临时解压目录，handoff 后目录被清理，子进程崩溃。
    // [契约] 子进程必须以 detached 加 stdio ignore 启动，并 unref 后 disconnect。
    // [失败路径] 不 disconnect 会让 CLI 的事件循环被 IPC 通道拖住，daemon 命令无法返回。
    // [边界] 早退事件只记录不抛出，由等待循环统一报告。
    if (!serviceStarted) {
      // Bug 原因：archive bootstrap 协调更新时 import.meta.url 指向临时解压目录；handoff
      // 后该目录会被清理。fallback 必须复用本次目标 release 的真实 argv 入口。
      const supervisorEntry = process.argv[1] ?? fileURLToPath(import.meta.url);
      const child = fork(
        supervisorEntry,
        [...SERVER_SERVICE_ARGS, "--server-root", layout.serverRoot],
        {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
            ZCODE_SERVER_ROOT: layout.serverRoot,
          },
        },
      );
      child.unref();
      // Supervisor 是独立 daemon，不需要保留 CLI↔Supervisor 的 IPC 通道；关闭该通道
      // 才能让一次性的 `serve --daemon` CLI 在返回 ready 后真正退出。
      child.disconnect();
      // 子 Supervisor 以 detached + stdio ignore 启动，锁冲突等启动失败时静默退出；
      // 记录早退信息让等待循环立即报告真实原因。
      child.once("exit", (code, signal) => {
        childEarlyExit = { code, signal };
      });
    }
    // [契约] 等待条件必须同时满足状态、updatedAt 大于基线、以及 serviceRegistered 预期值。
    // [失败路径] 去掉 updatedAt 比较会把上一次运行的 ready 当成本次启动成功。
    // [契约] 每 100ms 轮询一次持久化文件，不使用文件监听，避免平台差异。
    // [权衡] 固定 10s 上限，超时抛错而不是无限等待，让上层能给出明确失败。
    // [边界] assertStillWaiting 只用于失败前增强诊断，不能改变等待条件。
    const started = await waitForPersistedStatus(
      layout,
      "ready",
      baselineUpdatedAt,
      () => {
        if (childEarlyExit) {
          throw new Error(
            `ZCode Server daemon exited before ready (code=${childEarlyExit.code ?? "null"} signal=${childEarlyExit.signal ?? "none"}); check ${layout.statusFile} for details`,
          );
        }
      },
      serviceStarted,
    );
    if (json) stdout(io, started);
    else stdout(io, `ZCode Server ${started.state} at ${started.host ?? ""}:${started.port ?? ""}`);
    process.stdin.pause();
    process.stdin.destroy();
    return 0;
  }
  const daemon = supervisorProcess;
  const { Supervisor } = await import("./supervisor/supervisor.js");
  const serviceRegistered = supervisorProcess && isRegisteredServiceEntry(args);
  const executingRelease = await new ReleaseManager(layout).readCurrent();
  const executingEntry = process.argv[1] ?? fileURLToPath(import.meta.url);
  const executingReleaseDir = dirname(dirname(resolve(executingEntry)));
  const supervisorReleaseId =
    executingRelease?.releaseId &&
    resolve(executingRelease.releaseDir) === resolve(executingReleaseDir)
      ? executingRelease.releaseId
      : undefined;
  let foregroundStopped: (() => void) | undefined;
  // [契约] launcher 必须按 release 目录解析 core 与 node，缺失才回落到当前进程。
  // [失败路径] 混用 release 内的 core 与进程外 node 会造成版本不匹配，崩溃信息难以归因。
  // [契约] env 必须合并 inheritedEnv、releaseWiring 与 release 标识，三者缺一不可。
  // [权衡] stdio 使用 ignore 加 ipc，既隔离输出又保留控制通道。
  // [边界] 本构造不启动 Supervisor，start 由调用方显式调用。
  const supervisor = new Supervisor({
    layout,
    launcher: {
      launch: (generation, release) => {
        const runtimeRoot = release?.releaseDir ? join(release.releaseDir, "runtime") : null;
        const corePath = runtimeRoot
          ? join(runtimeRoot, "server-core.js")
          : fileURLToPath(new URL("./server-core.js", import.meta.url));
        const runtimeNode = runtimeRoot
          ? join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node")
          : process.execPath;
        const inheritedEnv = {
          ...process.env,
          ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
          ZCODE_SERVER_ROOT: layout.serverRoot,
        };
        const releaseWiring = runtimeRoot
          ? createReleaseAgentWiring(runtimeRoot, runtimeNode, inheritedEnv)
          : runtimeOptions.bundledAgentWiring;
        return fork(corePath, [String(generation)], {
          execPath: runtimeNode,
          env: {
            ...inheritedEnv,
            ...releaseWiring,
            ...(runtimeRoot ? { ZCODE_SERVER_RUNTIME_ROOT: runtimeRoot } : {}),
            ...(release?.releaseId ? { ZCODE_SERVER_RELEASE_ID: release.releaseId } : {}),
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
      },
    },
    version: ZCODE_VERSION,
    ...(supervisorReleaseId ? { supervisorReleaseId } : {}),
    serviceRegistered,
    onStopped: () => {
      process.stdin.pause();
      foregroundStopped?.();
      if (supervisorProcess) process.disconnect?.();
    },
  });
  await supervisor.start();
  let status: ServerStatus;
  try {
    // [契约] crash-loop-stopped 必须立即抛错，不能继续等到超时。
    // [失败路径] 只等 ready 会让 Core 崩溃循环拖满 15s，用户看到的是超时而非根因。
    // [契约] 启动失败后必须先 stop Supervisor 再上抛，否则 control socket 与锁残留。
    // [失败路径] 不 stop 会让下次 serve 永久报 already running，只能手工清理。
    // [边界] 本等待只读内存状态，不读取持久化文件。
    status = await waitForSupervisorReady(supervisor);
  } catch (error) {
    // Core 进入 crash-loop 时不能把错误直接抛给 CLI 顶层返回：control
    // socket 仍持有事件循环导致前台进程假死；用户 Ctrl+C（此时信号 handler 尚未注册，
    // 走默认强杀）后锁文件与 socket 残留，后续 serve 永远报 "already running"。
    // 启动失败必须先停 Supervisor 收口锁与 socket，再上抛错误。
    await supervisor.stop("startup-failed").catch(() => undefined);
    throw error;
  }
  if (json) stdout(io, status);
  else stdout(io, `ZCode Server ${status.state} at ${status.host ?? ""}:${status.port ?? ""}`);
  await new Promise<void>((resolve) => {
    foregroundStopped = resolve;
    if (!daemon) {
      const finish = () => {
        void supervisor.stop("signal").then(() => resolve());
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    }
  });
  return 0;
}

// apply-update 服务端最坏路径包含旧 Core 停止、新 Core ready 等待、新 Core 回滚停止、
// 旧 Core ready 等待以及旧 Core ready 超时后的再次停止，即三次停止预算加两次 ready 预算，
// 另需为 current/pending 文件操作和 IPC 调度留出余量。客户端超时必须覆盖完整回滚路径，
// 否则 CLI 会在 update 仍在后台执行时误报超时（R2-CLI-08）。
// [契约] 超时必须覆盖三次停止预算、两次 ready 预算与 30s 文件与 IPC 余量。
// [失败路径] 只覆盖正常路径会让回滚时的 CLI 误报超时，而服务端仍在执行。
// [契约] 三个常量必须来自 contracts，不能在这里写死数字。
// [权衡] `APPLY_UPDATE_TIMEOUT_MS` 按最坏回滚路径取上界：超时误报会让 CLI 提前判失败，偏长只增加用户等待。
// [边界] 该值只用于 apply-update，其他命令使用默认超时。
export const APPLY_UPDATE_TIMEOUT_MS =
  3 * (CORE_STOP_GRACE_TIMEOUT_MS + CORE_KILL_TIMEOUT_MS) + 2 * CORE_READY_TIMEOUT_MS + 30_000;

// [契约] 停止前必须先读详细持久化状态，invalid 或 unreadable 必须拒绝继续。
// [失败路径] 在状态不可读时发 stop 会让 CLI 误判服务端已收口，随后重复注册。
// [契约] 基线 updatedAt 必须取自停止前的快照，用于过滤掉旧的 stopped 状态。
// [权衡] 统一走 requestControl 而不是直接 kill，保证锁与 socket 由 owner 释放。
// [边界] 本函数不重试，stop 失败直接上抛。
async function stopExistingSupervisor(
  layout: ReturnType<typeof resolveServerLayout>,
  unverifiedStatusMessage: string,
): Promise<void> {
  const persistedBeforeStop = await readPersistedStatusDetailed(layout);
  if (persistedBeforeStop.state === "invalid" || persistedBeforeStop.state === "unreadable") {
    throw new Error(unverifiedStatusMessage);
  }
  const stopBaselineUpdatedAt = persistedBeforeStop.status?.updatedAt ?? 0;
  await requestControl(layout.controlEndpoint, { command: "stop" });
  await waitForServerStopped(layout, stopBaselineUpdatedAt, true);
}

async function requestApplyUpdate(
  layout: ReturnType<typeof resolveServerLayout>,
  force: boolean,
): Promise<unknown> {
  return await requestControl(
    layout.controlEndpoint,
    { command: "apply-update", ...(force ? { force: true } : {}) },
    APPLY_UPDATE_TIMEOUT_MS,
  );
}

// [契约] 请求必须先过 controlRequestSchema，命令名与扩展字段一起校验。
// [失败路径] 绕过 schema 会把非法命令发到 Supervisor，服务端只能返回不透明错误。
// [契约] status 失败时回落持久化状态或 stopped 快照，保证查询永远有结果。
// [失败路径] stop 的回落只在端点不可达且状态确为 stopped 或 uninstalled 时才成立。
// [边界] 本函数不获取生命周期锁，读操作允许与写操作并发。
async function runControl(
  command: string,
  io: CliIO,
  json: boolean,
  extra: Record<string, unknown> = {},
  layout = resolveServerLayout(),
): Promise<number> {
  const request = controlRequestSchema.parse({ id: "cli", command, ...extra });
  let result: unknown;
  try {
    result = await requestControl(
      layout.controlEndpoint,
      request,
      command === "apply-update" ? APPLY_UPDATE_TIMEOUT_MS : undefined,
    );
  } catch (error: unknown) {
    if (command === "status") {
      const persisted = await readPersistedStatusDetailed(layout);
      result = persisted.status ?? createStoppedServerStatus(ZCODE_VERSION);
    } else if (command === "stop" && isControlEndpointUnavailable(error)) {
      const persisted = await readPersistedStatusDetailed(layout);
      if (persisted.state === "invalid" || persisted.state === "unreadable") {
        throw error;
      }
      if (
        persisted.status &&
        persisted.status.state !== "stopped" &&
        persisted.status.state !== "uninstalled"
      ) {
        throw error;
      }
      // Supervisor 停止时会先关闭 control socket，再由 CLI 落盘 stopped 状态。
      // 重复 stop 发生在这个窗口后不应因为 socket 不存在而变成失败。
      result = persisted.status ?? createStoppedServerStatus(ZCODE_VERSION);
    } else {
      throw error;
    }
  }
  if (json) stdout(io, result);
  else stdout(io, result ?? "ok");
  return 0;
}

function isControlEndpointUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EINVAL";
}

// [契约] 必须两次输入 DELETE，两次都精确匹配，任一不符即取消。
// [失败路径] 只校验一次会让误触直接进入不可逆删除流程。
// [契约] 停止服务前必须先 validateServerInstallOwnership，顺序不可反。
// [失败路径] 先停服务再校验会留下已停但无法安全删除的中间态。
// [边界] 本函数不做实际删除，删除在 finishUninstall。
async function runUninstall(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
): Promise<number> {
  const first = await (io.confirm?.("Type DELETE to uninstall ZCode Server: ") ??
    Promise.resolve(""));
  if (first !== "DELETE") throw new Error("Uninstall cancelled");
  const second = await (io.confirm?.("Type DELETE again to confirm: ") ?? Promise.resolve(""));
  if (second !== "DELETE") throw new Error("Uninstall cancelled");
  // 不能把同一个 --server-root 同时作为 allowlist 根和删除目标：包含关系
  // 恒成立，任何绝对目录都能被卸载流程递归删除。停止服务前必须先验证安装归属。
  // [契约] 不能把同一个 server-root 同时当作 allowlist 根与删除目标，包含关系恒成立。
  // [失败路径] 少了归属校验，任意绝对目录都可能被卸载流程递归删除。
  // [契约] ownership 必须一路传到 finishUninstall，不能中途重新计算。
  // [权衡] 校验失败时保留原始错误作为 cause，便于定位是配置还是权限问题。
  // [边界] 本步只读元数据，不修改任何文件。
  const ownership = await validateServerInstallOwnership(layout);
  try {
    await runControl("confirm-uninstall", io, json, { confirmation: "DELETE" }, layout);
  } catch (error: unknown) {
    const persisted = await readPersistedStatusDetailed(layout);
    if (persisted.status?.state === "stopped" || persisted.status?.state === "uninstalled")
      return await finishUninstall(io, json, layout, ownership);
    const lockInspection = await new DataRootLock(layout.lockFile).inspect();
    if (lockInspection.state === "active") {
      throw new Error(`Cannot uninstall while Server lock is held by pid ${lockInspection.pid}`, {
        cause: error,
      });
    }
    if (lockInspection.state === "invalid" || lockInspection.state === "unreadable") {
      throw new Error(
        `Cannot verify Server shutdown before uninstall (${describeLockInspection(lockInspection)})`,
        { cause: error },
      );
    }
  }
  await waitForServerStopped(layout);
  return await finishUninstall(io, json, layout, ownership);
}

// [契约] 必须先注销服务再获取卸载锁，反序会让服务在删除过程中被重新拉起。
// [失败路径] 先删文件再注销服务，服务管理器可能按旧 descriptor 重启一个残缺实例。
// [契约] 任何删除失败都必须在 finally 释放锁，避免永久锁死后续卸载。
// [权衡] 释放锁失败被忽略，因为此时主错误更重要，且锁有 stale 检测。
// [边界] 本函数不校验 ownership，信任调用方传入的已校验结果。
async function finishUninstall(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  ownership: Awaited<ReturnType<typeof validateServerInstallOwnership>>,
): Promise<number> {
  await unregisterInstalledService(layout);
  const uninstallLock = await acquireUninstallLock(layout);
  // 根因：删除 install.json 会在数据仍保留时生成新设备身份，App 因此归档原连接并拆出新设备。
  // 正式卸载只移除运行资产；身份随用户数据保留，卸载状态仍由 uninstalled.json 保护。
  // [契约] 这是唯一的删除白名单，新增目录必须同时确认它不承载用户身份数据。
  // [失败路径] 把 install.json 放进列表会在数据仍保留时生成新设备身份，App 拆出新设备。
  // [契约] run 目录必须走 removeRunContentsExceptLock，不能整目录 rm。
  // [失败路径] 整目录 rm 会删掉持有中的锁文件，让并发 Supervisor 失去 fail-closed 依据。
  // [边界] 列表之外的未知内容一律保留，并写入 preservedPaths 供审计。
  const uninstallEntries = [
    "releases",
    "run",
    "cache",
    "bin",
    "service",
    "current.json",
    "pending.json",
    "uninstalled.json",
    "update-transaction.json",
    "node",
    "zcode-server.cjs",
    "agents",
    "build",
    "tools",
  ] as const;
  try {
    for (const entry of uninstallEntries) {
      const target = validateUninstallTarget(
        ownership.canonicalServerRoot,
        join(ownership.canonicalServerRoot, entry),
      );
      if (!target.ok || !target.canonicalPath) {
        throw new Error(`Unsafe uninstall target: ${target.reason ?? "unknown"}`);
      }
      if (entry === "run") {
        await removeRunContentsExceptLock(layout);
      } else {
        await rm(target.canonicalPath, { recursive: true, force: true });
      }
    }
    const preservedPaths = (await readdir(ownership.canonicalServerRoot))
      .filter((entry) => entry !== "run")
      .sort();
    // server root 允许用户显式指定，不能递归删除未知内容。卸载只清理上面的
    // ZCode allowlist，并把保留项写入结果供用户审计。先落盘 marker，再释放 lock，
    // 让并发 Supervisor 在删除 run 目录的最后窗口也会 fail-closed。
    await writeFile(
      layout.uninstalledFile,
      `${JSON.stringify({ uninstalled: true, uninstalledAt: Date.now(), version: ZCODE_VERSION, preservedPaths }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await uninstallLock.release();
    await rm(layout.runDir, { recursive: true, force: true });
    if (json) stdout(io, { uninstalled: true, preservedPaths });
    else stdout(io, "uninstalled");
    return 0;
  } catch (error: unknown) {
    await uninstallLock.release().catch(() => undefined);
    throw error;
  }
}

async function waitForPersistedStatus(
  layout: ReturnType<typeof resolveServerLayout>,
  expectedState: "ready" | "stopped",
  minUpdatedAt = 0,
  assertStillWaiting?: () => void,
  expectedServiceRegistered?: boolean,
): Promise<ServerStatus> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await readPersistedStatus(layout);
    if (
      status?.state === expectedState &&
      status.updatedAt > minUpdatedAt &&
      (expectedServiceRegistered === undefined ||
        status.serviceRegistered === expectedServiceRegistered)
    )
      return status;
    assertStillWaiting?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Server ${expectedState}`);
}

async function waitForSupervisorReady(supervisor: {
  status: () => ServerStatus;
}): Promise<ServerStatus> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = supervisor.status();
    if (status.state === "ready") return status;
    if (status.state === "crash-loop-stopped")
      throw new Error("Server Core entered crash-loop-stopped");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Server Core ready");
}

async function readControlStatus(
  layout: ReturnType<typeof resolveServerLayout>,
  timeoutMs: number,
): Promise<ServerStatus | null> {
  try {
    const result = await requestControl(layout.controlEndpoint, { command: "status" }, timeoutMs);
    return serverStatusSchema.parse(result);
  } catch {
    return null;
  }
}

// [契约] 兼容入口必须优先读 ZCODE_LEGACY_CLI_ENTRY，其次才是同目录的 zcode.cjs。
// [失败路径] 顺序反了会让显式配置被忽略，测试与自定义安装都无法指向替代实现。
// [契约] 候选不存在时按是否有子命令区分退出码，未知命令返回 1，无参数返回 0。
// [权衡] 子进程用 stdio inherit，让 TUI 直接接管终端，不做任何输出包装。
// [边界] 退出码透传子进程结果，signal 终止统一折算成 1。
async function delegateLegacyCli(argv: readonly string[], io: CliIO): Promise<number> {
  const candidate =
    process.env.ZCODE_LEGACY_CLI_ENTRY?.trim() ||
    join(dirname(fileURLToPath(import.meta.url)), "zcode.cjs");
  try {
    await access(candidate);
  } catch {
    stdout(io, argv.length ? `Unknown command: ${argv[0]}` : "ZCode TUI");
    return argv.length ? 1 : 0;
  }
  const child = fork(candidate, [...argv], { stdio: "inherit" });
  return await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}
