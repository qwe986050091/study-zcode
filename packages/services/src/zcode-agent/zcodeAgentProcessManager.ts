import { localRuntimeNetworkCapture } from "#src/zcode-agent/localRuntimeNetworkCapture.js";
import { resolveZCodeAgentSpawnCwd } from "#src/zcode-agent/zcodeAgentSpawnCwd.js";
import type { ZCodeAgentStorageStartupSnapshot } from "#src/zcode-agent/zcodeAgent.js";
/* eslint-disable max-lines -- zcodeAgentProcessManager 集中维护 agent 子进程启动、复用、超时回收和 runtime identity，拆分会扩大进程生命周期状态同步面 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Emitter } from "@zcode/rpc";
import { GEN_UI_OUTPUT_DIRECTORY, GEN_UI_OUTPUT_ROOT_ENV } from "@zcode/shared/node";
import { getAppConfigDir } from "../paths.js";
import {
  parseZCodeProcessDiagnostic,
  ZCODE_AGENT_LIFECYCLE_LOG_MARKER,
  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
} from "@zcode/shared/process-diagnostic";
import {
  ZCODE_AGENT_RUNTIME,
  ZCODE_AGENT_PROVIDER,
  ZCODE_RUNTIME_ENV_KEY,
  resolveWorkspaceKey,
  resolveZCodeRuntimeEnv,
  sanitizeZCodeRuntimeEnv,
} from "@zcode/shared";
import {
  findZCodeAgentRuntimeBinary,
  findZCodeAgentRuntimeNodeBundle,
} from "../runtime-tools/providerRuntimeResolver.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "./zcodeStdioTransport.js";
import { readZCodeStdioTapDevState } from "./zcodeStdioTapDevConfig.js";
import type { ZCodeAgentPresentationSurface } from "./zcodeAgentPresentationSurface.js";
import { shouldSpawnInDetachedProcessGroup } from "../process/processTreeTerminator.js";
import type { RuntimeProcessLifecycleReporter } from "../process/runtimeProcessLifecycle.js";
import { buildAgentWorkspaceIdentityEnv } from "../runtime-tools/agentProxyEnv.js";

// 一条可启动的 Agent 命令描述。args/env 是部署形态的产物，
// supportsStorageStartup/storagePreparationEntry 只由本地配套 bundle 设置，
// 自定义命令不做能力推断，避免把不支持的协议能力当成已支持。
export interface ZCodeAgentCommand {
  /** 本地配套 CLI bundle 的存储专用 Worker 入口；远端/自定义命令不推断能力。 */
  storagePreparationEntry?: string;
  /** 本次部署的 Agent 支持迁移前的启动通知；旧自定义命令保持原协议。 */
  supportsStorageStartup?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ZCodeAgentCommandResolverContext {
  presentationSurface?: ZCodeAgentPresentationSurface;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
}

export type ZCodeAgentCommandResolver = (
  context: ZCodeAgentCommandResolverContext,
) => Promise<ZCodeAgentCommand | null> | ZCodeAgentCommand | null;

// manager 的可注入点全部可选：生产由装配层给出 resolver 与 lifecycle reporter，
// 测试只需替换 commandResolver 即可跑起真实 stdio 客户端。
// 每个 manager 实例对应一条进程泳道（lane），同 workspace 的不同泳道互不复用进程。
export interface ZCodeAgentProcessManagerOptions {
  commandResolver?: ZCodeAgentCommandResolver;
  presentationSurface?: ZCodeAgentPresentationSurface;
  requestTimeoutMs?: number;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  /**
   * 进程泳道标识。同一 workspace 的不同泳道各走独立 manager 实例；lane 会写入
   * runtimeIdentity 与 spawn/exit 日志，便于排障区分。
   * 缺省为 chat 主泳道，不追加任何标记。
   */
  lane?: string;
  /**
   * 空闲回收阈值：连接上没有请求在飞持续超过该时长，就主动回收整棵进程树，
   * 下次 getClient 透明重新拉起。只给 mcp-status 这类“按需探测、进程内挂着 MCP 子进程”
   * 的控制面 lane 使用；chat / plugin 缺省不回收。
   */
  idleTimeoutMs?: number;
  /**
   * 仅当默认进程 cwd 等于目标 workspace 且该目录不可用时使用。
   * 业务 workspacePath/workspaceKey 不随 cwd 兜底改变。
   */
  spawnFallbackCwd?: string;
  /**
   * 每次 spawn agent 子进程前解析的额外环境变量（在 process.env 之后、workspace 变量之前合入）。
   * 用于把设置页的代理等配置注入子进程；按 spawn 时读取，天然「下次启动生效」。
   *
   * context 携带本次 spawn 的 workspace 标识三元组（workspacePath/workspaceIdentity/workspaceKey）。
   * Helper lifecycle 不再回收或重启已有 Agent。
   */
  resolveSpawnEnv?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
  }) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * 可选的外部 spawn admission hook。CUA 默认装配不再注入 Helper recovery gate，
   * 避免 Helper lifecycle 阻塞或间接重启 Agent；保留该通用 hook 供其他产品策略使用。
   */
  waitForSpawnAdmission?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
    signal?: AbortSignal;
  }) => Promise<void> | void;
}

// [状态归属] 一个受管进程的全部事实：client、child、退出诊断 promise、
// 首次回收原因、空闲计时器与 runtime 身份。任何一处状态都不放到外部 Map，
// 这样进程被替换时旧实例仍能独立完成自己的退出诊断。
interface ManagedZCodeAgentProcess {
  client: ZCodeProtocolClient;
  child: ChildProcessWithoutNullStreams;
  cleanupPromise?: Promise<void>;
  exitDiagnosticsCompleted: Promise<void>;
// exited 与 child.killed 语义不同：killed 表示发过信号，
// exited 才表示 exit 事件已到；判断可复用性必须看两者。
  exited: boolean;
// 首次清理原因即根因事实，后续幂等回收不得覆盖。
  firstCleanupReason?: AgentProcessCleanupReason;
  idleTimer?: ReturnType<typeof setTimeout>;
  readyAt?: number;
  readyReported: boolean;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  runtimeInstanceId: string;
  spawned: boolean;
  startedAt: number;
  terminationIntent?: AgentProcessTerminationIntent;
  workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
}

// 清理原因枚举同时是日志字段与监控归因：expected 类不应被当成崩溃，
// retry 变体只用于第二次回收，便于区分一次失败与真实残留。
type AgentProcessCleanupReason =
  | "idle-timeout"
  | "idle-timeout-retry"
  | "manager-dispose"
  | "manager-dispose-retry"
  | "protocol-close"
  | "request-timeout"
  | "workspace-dispose"
  | "workspace-dispose-retry";

interface AgentProcessTerminationIntent {
  kind: "expected" | "watchdog_recycle";
  reason: Exclude<AgentProcessCleanupReason, "protocol-close">;
  requestedAt: number;
}

// [资源] E2E 覆盖率 preload 源码：在 bundle 解析前就注册信号处理，
// 否则冷启动解析耗时超过早退窗口时，普通 shutdown handler 还没注册就收到 SIGTERM，
// 覆盖率数据会整段丢失。
const E2E_COVERAGE_PRELOAD_SOURCE = `
const { takeCoverage } = require("node:v8");
const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const coverageDirectory = process.env.NODE_V8_COVERAGE;
let coverageFlushStarted = false;
for (const signal of process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const flushCoverage = () => {
    if (coverageFlushStarted) return;
    coverageFlushStarted = true;
    if (coverageDirectory) {
      writeFileSync(
        resolve(coverageDirectory, \`coverage-signal-\${process.pid}.marker\`),
        signal,
      );
    }
    try {
      takeCoverage();
    } catch (error) {
      if (coverageDirectory) {
        writeFileSync(
          resolve(coverageDirectory, \`coverage-signal-error-\${process.pid}.txt\`),
          error instanceof Error ? error.stack || error.message : String(error),
        );
      }
    }
    if (process.listenerCount(signal) !== 1) return;
    setTimeout(() => {
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
    }, 1000);
  };
  process.prependListener(signal, flushCoverage);
}
if (coverageDirectory) {
  writeFileSync(resolve(coverageDirectory, \`coverage-ready-\${process.pid}.marker\`), "");
}
`;

// [权衡] 覆盖率开关必须同时满足两个环境变量才生效：
// 只设 ZCODE_E2E_COVERAGE 而没有 artifact 目录时无法决定落盘位置，
// 这时静默返回空 env，比在任意目录写文件更安全。
export function buildE2EAgentCoverageEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const artifactDir = env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (env.ZCODE_E2E_COVERAGE !== "1" || !artifactDir) {
    return {};
  }
// preload 文件每次启动重写：内容随版本变化，残留旧 preload 会让覆盖率格式与工具不匹配。
  const directory = resolve(artifactDir, "coverage", "raw", "cli");
  mkdirSync(directory, { recursive: true });
  const preloadPath = resolve(directory, "zcode-e2e-coverage-preload.cjs");
  // CLI bundle 未压缩时解析耗时可能超过 E2E 的早退窗口，普通 shutdown
  // handler 尚未注册就收到 SIGTERM。用 NODE_OPTIONS preload 在解析 bundle 前接管落盘。
  writeFileSync(preloadPath, E2E_COVERAGE_PRELOAD_SOURCE, "utf8");
  const requireOption = `--require=${JSON.stringify(preloadPath)}`;
  return {
    NODE_OPTIONS: [env.NODE_OPTIONS?.trim(), requireOption].filter(Boolean).join(" "),
    NODE_V8_COVERAGE: directory,
  };
}

/**
 * （CLI 重连重订边界）：同一 workspace 的 agent 进程被重建（超时回收/崩溃后
 * 首个 getClient 重新拉起）。v4 订阅（sessions-index/workspace-config/conversation）
 * 都活在 CLI 进程内存里，进程换代即失效——订阅方收到本事件后必须重发 subscribe。
 */
// [并发] 只在真正 spawn 成功后触发（generation>1），
// 失败的启动不能伪造重启，否则订阅方重连会再次触发启动，形成自激风暴。
export interface ZCodeAgentRuntimeRestartedEvent {
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
}

// available/unavailable 是 host 侧唯一权威的 runtime 存在性信号：
// 订阅方据此决定是发起订阅还是挂起，不要用 client 是否存在来自行推断。
export interface ZCodeAgentRuntimeLifecycleEvent {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  state: "available" | "unavailable";
}

// runtime 身份三元组（generation/identity/processId）用于跨进程关联日志与订阅代际；
// identity 含 workspaceKey 与 lane，可在多 workspace 混合日志里唯一定位一个进程。
export interface ZCodeAgentRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
  /** 进程泳道标识；chat 主泳道缺省为空。 */
  lane?: string;
}

// spawn 前置探测结果只用于诊断：Node 的 ENOENT 无法区分命令缺失与 cwd 缺失，
// 这里把两者可见性都记下来，生产日志才能定位到底是哪一侧丢了。
interface ZCodeAgentSpawnPreflight {
  command: string;
  args: string[];
  requestedCwd: string;
  cwd: string;
  cwdSource: "command" | "workspace" | "workspace-fallback";
  commandPathKind: "absolute" | "path-search";
  commandExists: boolean | null;
  cwdExists: boolean;
}

const serviceLog = createServiceLogger("zcode-agent");

// 三档日志包装固定带 service 名，调用点只写消息与结构化字段；
// 这样进程生命周期日志可以用统一前缀过滤。
const log = (...args: unknown[]) => serviceLog.info(undefined, ...args);
const warnLog = (...args: unknown[]) => serviceLog.warn(undefined, ...args);
const errorLog = (...args: unknown[]) => serviceLog.error(undefined, ...args);

// [资源] stderr 只保留最后 20 行、每行最多 1000 字符：
// 保留全部会在长期运行的 Agent 上无限增长，只留尾部已足够还原退出前的异常。
const AGENT_STDERR_TAIL_MAX_LINES = 20;
const AGENT_STDERR_LINE_MAX_CHARS = 1_000;
// [失败路径] 三类脱敏模式覆盖赋值式、认证头式与裸 key 式泄漏：
// 诊断会跨进程上报并写生产日志，任何一类漏掉都等于把凭据落盘。
const AGENT_STDERR_SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const AGENT_STDERR_AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const AGENT_STDERR_API_KEY_PATTERN = /\b(sk-)[A-Za-z0-9_-]{16,}\b/gi;

// 脱敏是幂等的：重复替换不会二次破坏已替换的占位符，
// 因此调用方可以在拼接前后各做一次而不必担心结果漂移。
function redactAgentDiagnostic(value: string): string {
  return (
    value
      .replace(AGENT_STDERR_SENSITIVE_ASSIGNMENT_PATTERN, "$1<redacted>")
      .replace(AGENT_STDERR_AUTH_SCHEME_PATTERN, "$1 <redacted>")
      // 裸 key 也必须在跨进程诊断和生产日志之前遮盖。
      .replace(AGENT_STDERR_API_KEY_PATTERN, "$1<redacted>")
  );
}

// 开发态才落 debug：stderr 原始行可能与消息流同量级，
// 生产环境写入会显著放大日志体积。
const debugLog = (...args: unknown[]) => {
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  serviceLog.debug(undefined, ...args);
};

// 环形尾部缓冲：lineCount 统计真实行数（不受截断影响），
// tail 只保留最后若干行；snapshot 返回副本，避免调用方持有可变数组。
function createAgentStderrTail(): {
  append(line: string): void;
  snapshot(): { lineCount: number; tail: string[] };
} {
  const tail: string[] = [];
  let lineCount = 0;

  return {
    append(line) {
      lineCount += 1;
      const redacted = redactAgentDiagnostic(line);
      const bounded =
        redacted.length > AGENT_STDERR_LINE_MAX_CHARS
          ? `${redacted.slice(0, AGENT_STDERR_LINE_MAX_CHARS)}…[truncated]`
          : redacted;
      tail.push(bounded);
// `tail` 超限即 `shift()` 丢最旧一行：诊断只关心退出前上下文，不需要完整历史。
      if (tail.length > AGENT_STDERR_TAIL_MAX_LINES) {
        tail.shift();
      }
    },
    snapshot() {
      return { lineCount, tail: [...tail] };
    },
  };
}

// env 里的参数必须显式校验成字符串数组：JSON 解析成功但类型不对时
// 继续向下传会让 spawn 收到非字符串参数并抛出难以定位的错误。
function parseArgsJson(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("ZCODE_AGENT_SERVER_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

// 从 cwd 逐级向上找仓库内文件：开发态 cwd 可能是子包目录，
// 固定相对路径找不到，向上探测才能同时覆盖 monorepo 与打包布局。
function findUpward(relativePath: string): string | null {
  let current = process.cwd();
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

// [失败路径] spawn 前把 cwd 解析、命令存在性、cwd 存在性一次性算清：
// cwd 解析是异步的（可能要做路径兜底），必须在最终 admission 检查之前完成。
// 这里不改业务 workspacePath/workspaceKey，兜底只影响子进程 cwd。
async function buildZCodeAgentSpawnPreflight(
  command: ZCodeAgentCommand,
  workspacePath: string,
  spawnFallbackCwd?: string,
): Promise<ZCodeAgentSpawnPreflight> {
  const commandPathKind = isAbsolute(command.command) ? "absolute" : "path-search";
// cwd 优先级：命令自带 > workspace 路径；spawnFallbackCwd 只在两者都不可用时兜底。
  const requestedCwd = command.cwd ?? workspacePath;
  const {
    cwd,
    usedFallback: shouldUseWorkspaceFallback,
    cwdExists,
  } = await resolveZCodeAgentSpawnCwd({ requestedCwd, workspacePath, spawnFallbackCwd });
  return {
    command: command.command,
    args: command.args ?? [],
    requestedCwd,
    cwd,
    cwdSource: shouldUseWorkspaceFallback
      ? "workspace-fallback"
      : command.cwd === undefined
        ? "workspace"
        : "command",
    commandPathKind,
    // Node spawn 的 ENOENT 既可能来自 command 缺失，也可能来自 cwd 缺失。
    // 生产日志在 spawn 前同时记录两者可见性，避免把工作区路径丢失误判成自动更新丢 binary。
// 走 PATH 搜索的命令无法在 spawn 前判定存在性，返回 null 表示未知而不是不存在。
    commandExists: commandPathKind === "absolute" ? existsSync(command.command) : null,
    cwdExists,
  };
}

// 开发态优先命中仓库内的 dist 或源码入口：改源码立刻生效，
// 不会被远端历史安装的 native binary 抢先匹配。
// 桌面端 process.execPath 指向 Electron Helper，必须显式 ELECTRON_RUN_AS_NODE，
// 否则子进程会按 Chromium 子进程启动并卡在 GPU 初始化。
function resolveBundledWorkspaceZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  const distEntrypoint = findUpward("apps/zcode-cli/packages/cli/dist/zcode.cjs");
  if (distEntrypoint) {
// 字节码入口是显式实验开关：开启但文件缺失时直接抛错，
// 静默回退成 JS 会让打包验证失去意义。
    const useBytecode =
      process.versions.electron && process.env.ZCODE_DESKTOP_AGENT_BYTECODE === "1";
    const entrypoint = useBytecode
      ? join(dirname(distEntrypoint), "zcode.bytecode.cjs")
      : distEntrypoint;
    // 此同步 command resolver 沿用既有 existsSync 契约；显式试验不能静默回退成 JS。
    if (useBytecode && !existsSync(entrypoint)) {
      throw new Error("桌面 Agent 字节码入口缺失，请运行 pnpm build:desktop-agent:bytecode");
    }
    return {
      command: process.execPath,
      args: [entrypoint, "app-server", "--stdio"],
      // Worker 与 Electron Node 子进程的 V8 snapshot 可不同；临时存储准备继续用 JS。
      storagePreparationEntry: distEntrypoint,
      cwd: context.workspacePath,
      // 桌面端 host 运行在 Electron utility process 中，process.execPath 指向 Electron Helper。
      // 这里显式启用 Node 运行模式，避免内置 zcode-agent 被当成 Electron/Chromium 子进程启动并卡在 GPU 初始化。
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  const sourceEntrypoint = findUpward("apps/zcode-cli/packages/cli/src/main.ts");
  const tsxEntrypoint = findUpward("node_modules/.bin/tsx");
  if (!sourceEntrypoint || !tsxEntrypoint) {
    return null;
  }
  return {
    command: tsxEntrypoint,
    args: [sourceEntrypoint, "app-server", "--stdio"],
    cwd: context.workspacePath,
  };
}

// 远端 SSH 场景的兜底：宿主进程 cwd 不在仓库内，env 也不会被 ssh exec 继承，
// 只能复用 runtime binary 候选链去找已部署到 ~/.zcode/server/agents 的原生二进制。
function resolveDeployedZCodeAgentBinaryCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  // 旧 resolver 只识别 ZCODE_AGENT_SERVER_COMMAND env 和 monorepo 源码树。
  // SSH 远端把 zcode-server.cjs 单文件部署到 ~/.zcode/server/，宿主进程的 cwd 不在仓库内、
  // env 也不会被 ssh exec 继承，即使 zcode-agent 已经部署到 ~/.zcode/server/agents/glm/，
  // resolver 也找不到，第一次 getClient 就抛 "ZCode agent server command is not configured"。
  // 这里复用 findZCodeAgentRuntimeBinary 的候选链（含 GLM_BINARY_PATH env、
  // packagedResourcesPath、~/.zcode/server/agents/glm、bundled-agents 等），
  // 把已部署的原生 binary 当成最终兜底，远端/桌面打包形态都能命中。
// 找不到即返回 null，由调用方决定报错文案，resolver 本身不做兜底猜测。
  const binaryPath = findZCodeAgentRuntimeBinary();
  if (!binaryPath) {
    return null;
  }
  return {
    command: binaryPath,
    args: ZCODE_AGENT_RUNTIME.spawnArgs,
    cwd: context.workspacePath,
  };
}

// 桌面打包态用 app 自带的 Electron Node 执行 resources 下的 zcode.cjs：
// 不再随包内置独立 Node 二进制，体积显著下降且跨平台同一份 JS。
// process.versions.electron 作为闸门，远端 host 由系统 Node 运行会自然跳过。
function resolveElectronRuntimeZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  // 桌面打包态：host 跑在 Electron utility process 里，process.execPath 指向 Electron Helper，
  // 它内置的 Node runtime 与 zcode-cli 目标版本一致（Electron 41 = Node 24.x）。
  // 这里直接用 app 自带的 Electron Node 执行打进 resources/glm 的 zcode.cjs，
  // 不再随包内置一份独立 Node 二进制（体积从 ~180MB 降到 ~16MB，且跨平台同一份 JS）。
  // 用 process.versions.electron 作为闸门：远端 SSH/WSL host 由系统 Node 运行、没有 electron，
  // 会跳过这里继续走原生二进制兜底，桌面/远端两条链路互不影响。
// 非 Electron 环境直接放弃这条链路，交回原生二进制兜底。
  if (!process.versions.electron) {
    return null;
  }
  const bundlePath = findZCodeAgentRuntimeNodeBundle();
  if (!bundlePath) {
    return null;
  }
  return {
    command: process.execPath,
    args: [bundlePath, ...ZCODE_AGENT_RUNTIME.spawnArgs],
    storagePreparationEntry: bundlePath,
    cwd: context.workspacePath,
    // 关键：必须以纯 Node 模式启动，否则子进程会被当成 Electron/Chromium 子进程卡在 GPU 初始化。
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

// 解析顺序即优先级：env 显式覆盖 → monorepo dev（dist/源码）→
// 桌面打包 Electron Node → 已部署 native binary。顺序不能随意调整，
// 否则开发态会被本机历史安装的二进制劫持。
export function resolveDefaultZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  const command = process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();
  if (command) {
    return applyPresentationSurfaceToCommand(
      {
        command,
        args: parseArgsJson(process.env.ZCODE_AGENT_SERVER_ARGS_JSON) ?? ["app-server", "--stdio"],
        cwd: process.env.ZCODE_AGENT_SERVER_CWD?.trim() || context.workspacePath,
      },
      context.presentationSurface,
    );
  }

  // 顺序：env 显式覆盖 → monorepo dev 源码/dist（dev 改源码立刻生效，不会被远端历史装的 native binary
  // 抢先匹配）→ 桌面打包态 Electron Node runtime 跑 zcode.cjs → 已部署 native binary（远端 SSH 兜底）。
// 本地配套 bundle 支持 storage startup 协议，标记后客户端才等待迁移通知；
// `resolveBundledWorkspaceZCodeAgentCommand` 返回空时保持旧启动协议，不等待迁移通知。
  const bundled =
    resolveBundledWorkspaceZCodeAgentCommand(context) ??
    resolveElectronRuntimeZCodeAgentCommand(context);
  return applyPresentationSurfaceToCommand(
    bundled
      ? { ...bundled, supportsStorageStartup: true }
      : resolveDeployedZCodeAgentBinaryCommand(context),
    context.presentationSurface,
  );
}

// 桌面态给命令补 --surface desktop：先剔除调用方已写的同类参数再追加，
// 避免同一参数出现两份而让 Agent 侧解析到歧义值。
function applyPresentationSurfaceToCommand(
  command: ZCodeAgentCommand | null,
  presentationSurface: ZCodeAgentCommandResolverContext["presentationSurface"],
): ZCodeAgentCommand | null {
  if (!command || presentationSurface !== "desktop") {
    return command;
  }

  const commandArgs = command.args ?? [];
  const args: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index]!;
// [失败路径] 只有非 option 的下一 token 才属于 --surface：
// 旧实现无条件消费下一个 token，孤立的 --surface 会吞掉 --stdio，
// 自定义 Agent 命令因此丢失协议启动参数。
    if (arg === "--surface") {
      const nextArg = commandArgs[index + 1];
      // Bug 原因：旧逻辑无条件消费下一个 token，孤立的 --surface 会把后续
      // --stdio 等 option 一并吞掉，导致自定义 Agent 命令失去协议启动参数。
      // 只有明确的非 option value 才属于 --surface；其他 option 继续走原参数链路。
      if (nextArg !== undefined && !nextArg.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--surface=")) {
      continue;
    }
    args.push(arg);
  }

  return {
    ...command,
    args: [...args, "--surface", "desktop"],
  };
}

// 开发态 stdio 抓包代理：只在显式开关打开且脚本存在时包装，
// 原始帧数据量与消息流同级，生产与默认开发路径都不走这里。
export function wrapZCodeAgentCommandWithStdioTapDevProxy(
  command: ZCodeAgentCommand,
  workspaceKey: string,
): ZCodeAgentCommand {
// 开关与日志目录都由 dev 配置文件决定，不在代码里硬编码路径。
  const tapState = readZCodeStdioTapDevState();
  if (!tapState.enabled) {
    return command;
  }

  const tapScript = findUpward("scripts/dev/zcode-stdio-tap.mjs");
  if (!tapScript) {
    debugLog("ZCode stdio tap proxy enabled but script not found");
    return command;
  }

  // 开发态 raw stdio 帧数据量和消息流同级，不能打进普通 info 日志。
  // 这里只在显式开关打开时用旁路 proxy 写盘，生产构建和默认开发路径都不受影响。
  return {
    supportsStorageStartup: command.supportsStorageStartup,
    command: process.execPath,
    args: [
      tapScript,
      "--workspace-key",
      workspaceKey,
      "--log-dir",
      tapState.logDir,
      "--",
      command.command,
      ...(command.args ?? []),
    ],
    cwd: command.cwd,
    env: {
      ...command.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

// [并发] 一个 manager 实例 = 一条进程泳道。所有 Map 都以 workspaceKey 为键，
// 但同一 workspace 的不同泳道由不同实例持有，因此不会互相复用进程。
// 三张表分工：processes=当前活跃、owned=仍需回收所有权、starting=启动中 promise。
export class ZCodeAgentProcessManager {
// 当前活跃进程表：判活与复用只看这里；
// 被替换下来的旧进程仍留在 ownedProcesses 里直到回收完成。
  private readonly processesByWorkspaceKey = new Map<string, ManagedZCodeAgentProcess>();
// [资源] 所有权集合：只有回收真正完成后才移除。
// Host 退出时必须据此逐个等待进程树清理，否则会留下孤儿 CLI。
  private readonly ownedProcesses = new Set<ManagedZCodeAgentProcess>();
// 启动去重表：warmup 与首次 sendPrompt 可能同时进入 getClient，
// 这里把并发调用收敛到同一个 promise，避免同一 workspace 重复 spawn。
  private readonly startingByWorkspaceKey = new Map<string, Promise<ZCodeProtocolClient>>();
// [并发] 重启代际：切模型/销毁 workspace 时递增，
// 旧的启动请求在真正 spawn 前会因代际不匹配失败，不会把旧配置写回进程池。
  private readonly restartGenerationByWorkspaceKey = new Map<string, number>();
// runtime 代际只增不减，作为订阅代际与日志关联的稳定标识。
  private readonly runtimeGenerationByWorkspaceKey = new Map<string, number>();
// [并发] 已宣告 available 的 runtime 身份：unavailable 事件只在身份仍匹配时发出，
// 防止旧进程的迟到关闭把新进程的可用状态误报为不可用。
  private readonly availableRuntimeIdentityByWorkspaceKey = new Map<string, string>();
  private readonly startAdmissionAbortControllersByWorkspaceKey = new Map<
    string,
    Set<AbortController>
  >();
  private readonly storageStartupEmitter = new Emitter<{
    workspaceKey: string;
    snapshot: ZCodeAgentStorageStartupSnapshot;
  }>();
  readonly onStorageStartupChanged = this.storageStartupEmitter.event;

// 只读查询，不触发 spawn：迁移状态是 UI 展示用信息，
// 被动读取不能成为启动 Agent 的理由。
  getStorageStartupState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeAgentStorageStartupSnapshot | null {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    return managed
      ? {
          generation: managed.runtimeIdentity.generation,
          state: managed.client.storageStartup.snapshot ?? null,
        }
      : null;
  }

  private readonly commandResolver: ZCodeAgentCommandResolver;
  private readonly presentationSurface: ZCodeAgentProcessManagerOptions["presentationSurface"];
  private readonly requestTimeoutMs: number | undefined;
  private readonly processLifecycleReporter: RuntimeProcessLifecycleReporter | undefined;
  private readonly resolveSpawnEnv: ZCodeAgentProcessManagerOptions["resolveSpawnEnv"];
  private readonly waitForSpawnAdmission: ZCodeAgentProcessManagerOptions["waitForSpawnAdmission"];
  private readonly spawnFallbackCwd: string | undefined;
  private readonly lane: string | undefined;
  private readonly idleTimeoutMs: number | undefined;
  private readonly runtimeRestartedEmitter = new Emitter<ZCodeAgentRuntimeRestartedEvent>();
  private readonly runtimeLifecycleEmitter = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  private disposeAllInFlight: Promise<void> | undefined;
  private disposed = false;

  /** 进程换代通知（generation>1 时触发）；v4 订阅方据此重订，见 ZCodeAgentRuntimeRestartedEvent。 */
  readonly onRuntimeRestarted = this.runtimeRestartedEmitter.event;
  /** 进程真实 spawn 后 available，当前 protocol client 关闭后 unavailable。 */
  readonly onRuntimeLifecycle = this.runtimeLifecycleEmitter.event;

  constructor(options?: ZCodeAgentProcessManagerOptions) {
    this.commandResolver = options?.commandResolver ?? resolveDefaultZCodeAgentCommand;
    this.presentationSurface = options?.presentationSurface;
    this.requestTimeoutMs = options?.requestTimeoutMs;
    this.processLifecycleReporter = options?.processLifecycleReporter;
    this.resolveSpawnEnv = options?.resolveSpawnEnv;
    this.waitForSpawnAdmission = options?.waitForSpawnAdmission;
    this.spawnFallbackCwd = options?.spawnFallbackCwd;
    this.lane = options?.lane?.trim() || undefined;
    this.idleTimeoutMs =
      options?.idleTimeoutMs && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : undefined;
  }

// [失败路径] 生命周期上报是旁路观测，任何异常都只记 warn：
// 监控链路故障不允许阻断 Agent 的启动、回收或退出流程。
  private reportProcessLifecycle(
    callback: (reporter: RuntimeProcessLifecycleReporter) => void,
  ): void {
    const reporter = this.processLifecycleReporter;
    if (!reporter) {
      return;
    }

    try {
      callback(reporter);
    } catch (error) {
      // 进程生命周期上报是旁路观测，临时失败不得阻断 agent 启动或回收。
      warnLog("ZCode agent process lifecycle reporter failed", error);
    }
  }

// 用 delete 而不是置 undefined，保证 managed 上不存在多余的键。
  private clearIdleTimer(managed: ManagedZCodeAgentProcess): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      delete managed.idleTimer;
    }
  }

  /**
   * 空闲回收：每次在飞请求归零就重置计时；到点时若仍无请求在飞且该进程仍是当前活跃实例，
   * 主动回收整棵进程树（含挂在其下的 MCP 子进程）。归因为 expected/idle-timeout，
   * 不会被监控当作崩溃。到点时有新请求在飞则什么都不做，等下一次归零重新计时。
   */
// [资源] 空闲回收：请求归零即重置计时，到点时四项条件全部满足才回收——
// 未销毁、进程未退出、仍是当前活跃实例、确实无在飞请求与迁移等待。
// 只给 mcp-status 这类按需探测的控制面 lane 配置，chat/plugin 不回收。
  private scheduleIdleReclaim(workspaceKey: string, managed: ManagedZCodeAgentProcess): void {
    if (!this.idleTimeoutMs || this.disposed || managed.exited) {
      return;
    }
    this.clearIdleTimer(managed);
    const timer = setTimeout(() => {
      delete managed.idleTimer;
      if (this.disposed || managed.exited) {
        return;
      }
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      // 自定义 Agent 的旧启动请求可能先结清，再继续数据库准备；无在飞 RPC 不代表迁移空闲。
      if (
// 无在飞 RPC 不等于空闲：自定义 Agent 可能正在等待数据库迁移，
// storageStartup.isWaiting 期间回收会打断一次进行中的启动。
        managed.client.pendingOperationRequestCount > 0 ||
        managed.client.storageStartup.isWaiting
      ) {
        return;
      }
      log("ZCode agent process idle timeout; reclaiming", {
        workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        idleTimeoutMs: this.idleTimeoutMs,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      void this.cleanupManagedProcessWithRetry(
        managed,
        "idle-timeout",
        "idle-timeout-retry",
        "idle timeout",
      ).catch(() => undefined);
    }, this.idleTimeoutMs);
    // 空闲计时器不能把 host 进程钉在事件循环里。
    timer.unref?.();
    managed.idleTimer = timer;
  }

// [并发] 只记录首次清理原因：后续 app quit 等幂等回收不能把
// 已经发生的异常 protocol close 改写成 expected，否则监控会漏报崩溃。
// protocol-close 本身可能是崩溃结果，因此不建立主动终止意图。
  private recordTerminationIntent(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
  ): void {
// 已有原因直接返回：先到者即根因。
    if (managed.firstCleanupReason) {
      return;
    }
    managed.firstCleanupReason = reason;
    if (reason === "protocol-close") {
      return;
    }
    // protocol close 可能是 Agent 崩溃的结果，只有 Host 主动发起的回收
    // 才能建立退出意图。首次 cleanup 原因是根因事实，后续 app quit 等幂等回收不能
    // 把已经发生的异常 protocol close 改写成 expected。
    managed.terminationIntent = {
      kind: reason === "request-timeout" ? "watchdog_recycle" : "expected",
      reason,
      requestedAt: Date.now(),
    };
  }

// [并发] 先比较身份再从可用表移除：只有当前进程才能发出 unavailable，
// 已被替换的旧进程重复上报会让订阅方误以为新 runtime 掉线。
  private reportRuntimeUnavailable(managed: ManagedZCodeAgentProcess): void {
    const workspaceKey = managed.runtimeIdentity.workspaceKey;
    if (
      this.availableRuntimeIdentityByWorkspaceKey.get(workspaceKey) !==
      managed.runtimeIdentity.identity
    ) {
      return;
    }
    this.availableRuntimeIdentityByWorkspaceKey.delete(workspaceKey);
    this.runtimeLifecycleEmitter.fire({
      workspacePath: managed.workspace.workspacePath,
      ...(managed.workspace.workspaceIdentity
        ? { workspaceIdentity: managed.workspace.workspaceIdentity }
        : {}),
      workspaceKey,
      runtimeIdentity: managed.runtimeIdentity,
      state: "unavailable",
    });
  }

// ready 需要同时满足：已收到 spawn 事件、未退出、未上报过、有 readyAt 与 pid。
// getClient 可能早于异步 spawn 返回，所以 ready 由 spawn 回调驱动而不是由调用方驱动。
  private reportRuntimeReady(managed: ManagedZCodeAgentProcess): void {
    if (
      !managed.spawned ||
      managed.exited ||
      managed.readyReported ||
      managed.readyAt == null ||
      typeof managed.child.pid !== "number"
    ) {
      return;
    }
    managed.readyReported = true;
    this.reportProcessLifecycle((reporter) =>
      reporter.onReady?.({
        pid: managed.child.pid!,
        provider: ZCODE_AGENT_PROVIDER,
        ...(this.lane ? { lane: this.lane } : {}),
        workspacePath: managed.workspace.workspacePath,
        readyAt: managed.readyAt!,
        startupDurationMs: Math.max(0, managed.readyAt! - managed.startedAt),
        runtimeGeneration: managed.runtimeIdentity.generation,
        runtimeInstanceId: managed.runtimeInstanceId,
      }),
    );
  }

// [事务] 回收是幂等的：cleanupPromise 绑在 managed 上，
// 超时、重启、app quit 三条路径共用同一次回收，不会重复发信号。
  private cleanupManagedProcess(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    options: { reportError?: boolean } = {},
  ): Promise<void> {
    this.recordTerminationIntent(managed, reason);
    this.clearIdleTimer(managed);
// 复用已有回收 promise，并把 reportError 语义留给创建方决定。
    if (managed.cleanupPromise) {
      return managed.cleanupPromise;
    }

    // protocol close 只会使 client 不再可复用，不代表它对应的
    // OS 进程已退出。将回收 Promise 绑在 managed process 上，timeout、restart 和
    // app quit 可以共用同一次幂等回收，Host 也不会丢失已退休进程的所有权。
    let cleanupCompleted = false;
// [资源] protocol close 只说明 client 不可复用，不代表 OS 进程已退出；
// 必须等 exit 诊断完成，Host 才能释放所有权，否则关闭方看不到最后的 stderr。
    const cleanupPromise = managed.client
      .disposeAndWait()
      .then(async () => {
        // 进程树回收可能先于异步 exit 监听器返回；必须等 stderr/退出事件完成，
        // 否则 Host 会提前释放所有权，关闭调用方看不到最后一条诊断。
// 进程树回收可能先于异步 exit 监听器返回，这里等待诊断收尾。
        await managed.exitDiagnosticsCompleted;
        cleanupCompleted = true;
        log("ZCode agent process cleanup completed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason,
        });
      })
      .finally(() => {
        if (managed.cleanupPromise === cleanupPromise) {
          delete managed.cleanupPromise;
        }
        if (cleanupCompleted) {
          this.ownedProcesses.delete(managed);
        }
      });
    managed.cleanupPromise = cleanupPromise;
    // Bug 原因：dispose 与重试编排竞态时，rejection 可能先于调用方 await 挂靠被判为
    // unhandledRejection（vitest 计为运行级失败，生产等价于未处理拒绝）。catch 必须在
    // 创建点无条件挂靠：reportError:false（重试路径）时静默吞掉，统一上报由
    // cleanupManagedProcessWithRetry 的 await/catch 完成，告警语义不变。
    void cleanupPromise.catch((error) => {
      if (options.reportError === false) {
        return;
      }
      errorLog("ZCode agent process cleanup failed", {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        reason,
        error,
      });
    });
    return cleanupPromise;
  }

// 关闭路径单独包一层，只为固定 manager-dispose 的原因与重试作用域。
  private async cleanupManagedProcessForShutdown(managed: ManagedZCodeAgentProcess): Promise<void> {
    await this.cleanupManagedProcessWithRetry(
      managed,
      "manager-dispose",
      "manager-dispose-retry",
      "manager dispose",
    );
  }

// [失败路径] Windows 进程表与 exit 事件可能短暂落后，首次回收会误报残留；
// 这里统一重试一次并复用 transport 快照，真实残留会在第二次继续抛出。
// 首次失败不升级为 error，最终失败只上报一条，避免日志重复。
  private async cleanupManagedProcessWithRetry(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    retryReason: AgentProcessCleanupReason,
    retryScope: string,
  ): Promise<void> {
    try {
      // 首次 cleanup 的进程树/exit 观察可能只是中间态；在 retry 成功时，
      // 首次 rejection 不应提前升级为生产 error 告警。最终失败仍由本方法统一上报一次。
      await this.cleanupManagedProcess(managed, reason, { reportError: false });
    } catch (firstError) {
      // Windows 进程表查询/exit 事件可能短暂落后，首次 cleanup 会误报 root
      // 残留。restart/app quit 都不能把这种中间态暴露给调用方，需重试一次并复用
      // transport 内部快照；真实残留会在第二次 cleanup 继续抛出。
// 只读取错误码用于归因，不修改原错误对象。
      const cleanupError = firstError as NodeJS.ErrnoException;
      warnLog(`ZCode agent process cleanup retrying during ${retryScope}`, {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        cleanupStage: reason,
        errorName: firstError instanceof Error ? firstError.name || "Error" : "UnknownError",
        ...(typeof cleanupError.code === "string" ? { errorCode: cleanupError.code } : {}),
        error: firstError,
      });
      try {
        await this.cleanupManagedProcess(managed, retryReason, { reportError: false });
      } catch (finalError) {
        errorLog("ZCode agent process cleanup failed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason: retryReason,
          retryScope,
          error: finalError,
        });
        throw finalError;
      }
    }
  }

// [并发] 启动型入口，三条路径按顺序短路：已销毁报错、活跃进程复用、
// 启动中则等待同一个 promise。
// 只有走到最后才真正发起 spawn，并把 promise 登记到去重表。
  async getClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeProtocolClient> {
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    const workspaceKey = resolveWorkspaceKey(params);
// 复用条件必须同时满足未 killed：发过信号但尚未退出的事件也不能再交出 client。
    const existing = this.processesByWorkspaceKey.get(workspaceKey);
    if (existing && !existing.child.killed) {
      return existing.client;
    }

// 等待已有启动并记录等待时长，便于排查首次请求被 warmup 拖慢的情况。
    const starting = this.startingByWorkspaceKey.get(workspaceKey);
    if (starting) {
      const waitStartedAt = Date.now();
      log("ZCode agent process start already in progress", {
        workspaceKey,
      });
      const client = await starting;
      log("ZCode agent process start wait completed", {
        workspaceKey,
        durationMs: Date.now() - waitStartedAt,
      });
      return client;
    }

    // agent 启动前置后，host warmup 和 UI 首次 readWorkspacePresentation/sendPrompt
    // 可能同时进入 getClient。这里按 workspaceKey 收敛启动中的 promise，避免同一工作区重复 spawn。
// 启动开始时快照代际，后续在 spawn 前多处复核。
    const startGeneration = this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0;
    const admissionAbortController = new AbortController();
    let controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      controllers = new Set<AbortController>();
      this.startAdmissionAbortControllersByWorkspaceKey.set(workspaceKey, controllers);
    }
    controllers.add(admissionAbortController);
    const startPromise = this.startClient(
      params,
      workspaceKey,
      startGeneration,
      admissionAbortController.signal,
    );
    this.startingByWorkspaceKey.set(workspaceKey, startPromise);
    try {
      return await startPromise;
    } finally {
      controllers.delete(admissionAbortController);
      if (controllers.size === 0) {
        this.startAdmissionAbortControllersByWorkspaceKey.delete(workspaceKey);
      }
      if (this.startingByWorkspaceKey.get(workspaceKey) === startPromise) {
        this.startingByWorkspaceKey.delete(workspaceKey);
      }
    }
  }

  /**
   * 只读取已经登记的 runtime client；被动 observer 使用本入口避免 getClient 的隐式 spawn。
   */
// 只读入口：被动 observer 用它避免 getClient 的隐式 spawn，
// 保证观察行为不会改变 runtime 是否存在。
  getExistingClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeProtocolClient | undefined {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    return managed && !managed.child.killed ? managed.client : undefined;
  }

  /** 资源管理器：当前仍存活的受管 runtime（pid + workspace + client） */
// 资源管理器视图：只列出仍存活且有 pid 的进程，
// 已退出/已 killed 的实例不对外暴露，避免上层对僵尸进程发请求。
  listManagedProcesses(): Array<{
    pid: number;
    workspacePath: string;
    workspaceIdentity?: string;
    lane?: string;
    client: ZCodeProtocolClient;
  }> {
    const result: Array<{
      pid: number;
      workspacePath: string;
      workspaceIdentity?: string;
      lane?: string;
      client: ZCodeProtocolClient;
    }> = [];
    for (const managed of this.processesByWorkspaceKey.values()) {
      if (managed.exited || managed.child.killed || typeof managed.child.pid !== "number") continue;
      result.push({
        pid: managed.child.pid,
        workspacePath: managed.workspace.workspacePath,
        ...(managed.workspace.workspaceIdentity
          ? { workspaceIdentity: managed.workspace.workspaceIdentity }
          : {}),
        ...(this.lane ? { lane: this.lane } : {}),
        client: managed.client,
      });
    }
    return result;
  }

  /** Agent service 首次通过 provider/model 门禁后调用；同一 runtime 只上报一次。 */
// [并发] 只有当传入 client 仍是该 workspace 当前登记的 client 时才标 ready，
// await 期间进程可能已被替换；给旧 entry 标 ready 会让新进程永远不 ready。
  markReady(
    params: { workspacePath: string; workspaceIdentity?: string },
    client: ZCodeProtocolClient,
  ): void {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    if (!managed || managed.client !== client || managed.readyAt != null || managed.exited) {
      return;
    }
    managed.readyAt = Date.now();
    // getClient 可能早于 ChildProcess 的异步 spawn 事件返回，也可能在 await 期间
    // 被新 runtime 替换。只给返回该 entry 的进程标 ready，并由 spawn 回调保证 start → ready 顺序。
    this.reportRuntimeReady(managed);
  }

// [事务] 一次完整的启动事务：解析命令 → 等待准入 → 解析 env →
// 探测 cwd → 二次准入 → spawn → 组装 client → 登记进程表。
// 每个 await 之后都必须复核销毁状态与重启代际，因为任何一步都可能耗时数百毫秒。
  private async startClient(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
    },
    workspaceKey: string,
    startGeneration: number,
    admissionSignal: AbortSignal,
  ): Promise<ZCodeProtocolClient> {
    const startStartedAt = Date.now();
// resolver 允许抛错：配置错误应直接冒泡成启动失败，而不是静默换一种启动方式。
    const resolveCommandStartedAt = Date.now();
    const command = await this.commandResolver({
      ...params,
      ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
      workspaceKey,
    });
    const resolveCommandDurationMs = Date.now() - resolveCommandStartedAt;
// 无命令即明确报配置缺失，文案里带上环境变量名，便于用户自查。
    if (!command) {
      throw new Error(
        "ZCode agent server command is not configured. Set ZCODE_AGENT_SERVER_COMMAND before integration.",
      );
    }
// 准入被取消（workspace 销毁或 manager 关闭）后不再继续，
// 这里用 signal.reason 保留调用方给出的具体取消原因。
    if (admissionSignal.aborted) {
      throw admissionSignal.reason ?? new Error("ZCode agent process start was cancelled.");
    }
// 抓包包装只影响实际 spawn 的命令，日志同时记录原始与生效命令，
// 才能看出是否被 dev proxy 接管。
    const effectiveCommand = wrapZCodeAgentCommandWithStdioTapDevProxy(command, workspaceKey);
    log("ZCode agent command resolved", {
      workspaceKey,
      command: command.command,
      effectiveCommand: effectiveCommand.command,
      resolveCommandDurationMs,
    });

    // Helper recovery 可能在 command resolve 期间开始；先等待一次，确保 env 解析使用
    // recovery 后的 broker 凭据，而不是把旧状态带到 spawn 边界。
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });

    // 设置页代理等运行时 env 在 process.env 之后合入（覆盖继承的同名 shell 变量），
    // 但仍让 command.env（部署特定）保持最高优先级。
// [权衡] 运行时 env 在 process.env 之后、command.env 之前合入：
// 覆盖继承的 shell 变量，但部署特定配置仍保持最高优先级。
    const spawnEnv = (await this.resolveSpawnEnv?.({ ...params, workspaceKey })) ?? {};
    if (this.disposed) {
      // app 正在关闭时，启动中的 warmup 可能刚完成 command/env resolve。
      // 这时继续 spawn 会绕过 disposeAllAndWait 的快照，重新制造一个无人托管的 agent 进程。
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      // 切模型会重启单个 workspace。旧启动请求如果在重启后才恢复，
      // 不能继续 spawn 并写回进程池，否则新配置会被旧 agent 覆盖。
      throw new Error("ZCode agent process start was cancelled.");
    }
    // cwd 探测也让出事件循环，必须放在最终 admission 与销毁/代际检查之前。
// cwd 探测会让出事件循环，因此必须在最终准入与代际检查之前完成，
// 之后再做一次 admission，才能保证 spawn 时看到的是最新状态。
    const spawnPreflight = await buildZCodeAgentSpawnPreflight(
      effectiveCommand,
      params.workspacePath,
      this.spawnFallbackCwd,
    );
    admissionSignal.throwIfAborted();
    // env resolve 本身是异步的，恢复屏障可能在这段时间重新关闭；必须在 spawn 前
    // 再等待并复查代际，不能只依赖第一次 admission。
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      throw new Error("ZCode agent process start was cancelled.");
    }
    // app 以本地开发方式启动时，让 agent 子进程也带上 ZCODE_RUNTIME_ENV=development；
    // 不再传 NODE_ENV，避免用户 shell/runtime 变量影响 ZCode 运行模式或泄漏到 Bash 工具。
// 只下发 ZCODE_RUNTIME_ENV，不再传 NODE_ENV：
// 避免用户 shell 的 NODE_ENV 影响 ZCode 运行模式或泄漏给 Bash 工具。
    const runtimeEnv = resolveZCodeRuntimeEnv(process.env);
    log("ZCode agent spawn preflight", {
      workspaceKey,
      spawnPreflight,
    });
// [资源] 这里的时间戳是进程树的归属起点：transport 用它给进程打启动时间，
// 回收时据此区分本次 Host 启动的进程与系统上更早的遗留进程。
// 必须在 spawn 调用前取值，spawn 之后再取会落在子进程创建之后，
// 导致归属判定漏掉真正属于本次启动的进程。
// 它与 startedAt 不是同一个概念：后者用于统计启动耗时。
    const spawnRequestedAt = Date.now();
// [资源] spawn 是唯一真正创建 OS 进程的位置，参数与 stdin/stdout 都固定为 pipe：
// 协议走 stdio，任何继承之外的 fd 都需要在这里显式声明。
    const child = spawn(effectiveCommand.command, spawnPreflight.args, {
      cwd: spawnPreflight.cwd,
      // agent 可能再派生实际 runtime/MCP 子进程。POSIX 下让 wrapper 进入独立进程组，
      // 关闭时才能按进程树整体回收；Windows 保持非 detached，交给 taskkill /T 处理。
// POSIX 下让 wrapper 进入独立进程组，关闭时可按组回收整棵树；
// Windows 保持非 detached，由 taskkill /T 处理。
      detached: shouldSpawnInDetachedProcessGroup(),
      env: {
// 先清洗宿主 env 再叠加本次 spawn 的覆盖项：
// 清洗会剔除 Host 专属变量，避免子进程误以为自己运行在 Host 上下文。
        ...sanitizeZCodeRuntimeEnv(process.env),
        [ZCODE_RUNTIME_ENV_KEY]: runtimeEnv,
        ...spawnEnv,
        ...effectiveCommand.env,
        // 生成文件根目录由执行端 Host 唯一决定，保证 Agent 写入与 Host 读取授权一致。
        [GEN_UI_OUTPUT_ROOT_ENV]: join(getAppConfigDir(), GEN_UI_OUTPUT_DIRECTORY),
        // 身份/隔离语义使用 workspaceIdentity；cwd 继续使用 workspacePath。
        ...buildAgentWorkspaceIdentityEnv(params.workspaceIdentity),
        ...buildE2EAgentCoverageEnv(),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const startedAt = Date.now();
// 每个进程独立一份尾部缓冲，退出诊断只属于本次 runtime。
    const stderrTail = createAgentStderrTail();
// transport 拿走 child 的 stdio 并负责帧切分；
// ownedProcessStartedAtMs 与 ownedProcessGroupId 把进程所有权登记进 transport，
// 后续进程树回收据此判断哪些后代属于本 Host。
    const transport = new ZCodeStdioTransport(child, {
      onStderrLine: (line) => {
// 结构化诊断行优先于普通 stderr：它是存活 runtime 异常的唯一旁路，
// 上报时按创建时的 child 绑定身份，不能用当前 workspace 反查，
// 否则重启后的迟到事件会串到新进程上。
        const diagnostic = parseZCodeProcessDiagnostic(line);
        if (diagnostic && typeof child.pid === "number") {
          // 根因：只保存 exit tail 会漏掉存活 runtime 的异常；此旁路不依赖 debug 开关。
          // 身份绑定创建时的 child，不能查当前 workspace，避免重启后的迟到事件串进程。
          this.reportProcessLifecycle((reporter) =>
            reporter.onException?.({
              pid: child.pid!,
              provider: ZCODE_AGENT_PROVIDER,
              ...(this.lane ? { lane: this.lane } : {}),
              workspacePath: params.workspacePath,
              runtimeGeneration,
              runtimeInstanceId,
              diagnostic: {
                ...diagnostic,
                // 脱敏占位符可能比原文长，必须再次限长，避免 IPC schema 拒绝合法异常。
                name: redactAgentDiagnostic(diagnostic.name).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
                ),
                message: redactAgentDiagnostic(diagnostic.message).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
                ),
                ...(diagnostic.stack !== undefined
                  ? {
                      stack: redactAgentDiagnostic(diagnostic.stack).slice(
                        0,
                        ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
                      ),
                    }
                  : {}),
              },
            }),
          );
          return;
        }
        stderrTail.append(line);
        debugLog(line);
      },
      ownedProcessStartedAtMs: spawnRequestedAt,
      // POSIX 下 child 由本 manager 以 detached=true 启动，pid 同时就是 Host
      // 拥有的独立 PGID；异常 root exit 后 cleanup 仍可按组回收同组后代。
      ...(process.platform !== "win32" && child.pid ? { ownedProcessGroupId: child.pid } : {}),
    });
// requireStorageStartup 只在命令声明支持时开启：
// 旧自定义命令不等待迁移通知，否则会永久卡在启动门禁上。
    const client = new ZCodeProtocolClient(transport, {
      requireStorageStartup: effectiveCommand.supportsStorageStartup,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    if (child.pid) {
// 网络抓包按 pid 注册并在进程 close 时自动注销，避免残留映射。
      const unregisterNetworkCapture = localRuntimeNetworkCapture.register(client, child.pid);
      child.once("close", unregisterNetworkCapture);
    }
    // Agent 进程重启后，Host 仍需要 runtime identity 区分新旧订阅和运行命令。
    // Provider Registry 由新 Worker 从所属 Environment 的 Config 重建，不再由 UI 重新下发。
// 每次成功组装 client 才递增 runtime 代际：订阅方用它区分新旧进程，
// Provider Registry 由新 Worker 自己从 Environment 配置重建，不需要 UI 重发。
    const runtimeGeneration = (this.runtimeGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
    this.runtimeGenerationByWorkspaceKey.set(workspaceKey, runtimeGeneration);
    // 生命周期事件关联只需要本次 runtime 的不透明身份，不能复用包含 workspaceKey 的协议 identity。
// 不透明实例 id 只用于生命周期事件关联，不含 workspaceKey；
// 含路径标识的 identity 留给协议层日志使用。
    const runtimeInstanceId = `agent-${randomUUID()}`;
    const runtimeIdentity: ZCodeAgentRuntimeIdentity = {
      generation: runtimeGeneration,
      identity: this.lane
        ? `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}:${this.lane}`
        : `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}`,
      ...(typeof child.pid === "number" ? { processId: child.pid } : {}),
      ...(this.lane ? { lane: this.lane } : {}),
      workspaceKey,
    };
// [并发] 先建 promise 再注册 exit 监听：回收路径可能早于 exit 事件到达，
// 没有这个 promise 就只能靠轮询等待诊断收尾。
    const exitDiagnostics = Promise.withResolvers<void>();
    const managed: ManagedZCodeAgentProcess = {
      child,
      client,
      exited: false,
      exitDiagnosticsCompleted: exitDiagnostics.promise,
      readyReported: false,
      runtimeIdentity,
      runtimeInstanceId,
      spawned: false,
      startedAt,
      workspace: {
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      },
    };
// [并发] 登记活跃表与所有权表必须同时完成：
// 只登活跃表会在替换时丢掉旧进程的回收责任。
    this.processesByWorkspaceKey.set(workspaceKey, managed);
    this.ownedProcesses.add(managed);
// 迁移状态广播兼计时器调度：等待迁移时停表，就绪且无在飞请求时重新计时，
// 这样空闲回收不会打断一次正在进行的数据迁移。
// 只在该 managed 仍是当前活跃实例时广播，防止旧进程状态覆盖新进程。
    const publishStorage = () => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) return;
      if (client.storageStartup.isWaiting) this.clearIdleTimer(managed);
      else if (
        client.storageStartup.snapshot?.phase === "ready" &&
        client.pendingOperationRequestCount === 0
      ) {
        this.scheduleIdleReclaim(workspaceKey, managed);
      }
      this.storageStartupEmitter.fire({
        workspaceKey,
        snapshot: { generation: runtimeGeneration, state: client.storageStartup.snapshot ?? null },
      });
    };
// 订阅后立即手动调用一次，把订阅前已发生的状态变化补上。
    client.storageStartup.onDidChange(publishStorage);
    publishStorage();
    if (this.idleTimeoutMs) {
      client.onPendingRequestsDrained(() => this.scheduleIdleReclaim(workspaceKey, managed));
    }
// [并发] 只有 spawn 事件才证明新 CLI 真实存在：Node 会先返回 ChildProcess，
// 再异步报告 cwd/command 的 ENOENT。旧实现在此之前就广播重启，
// 订阅方重连又触发启动，最终形成失败启动 → 假重启 → 重连的自激风暴。
    child.once("spawn", () => {
      managed.spawned = true;
      // Node spawn() 会先返回 ChildProcess，再异步报告 cwd/command ENOENT。
      // 旧代码在确认 spawn 成功前就发布 runtimeRestarted，订阅方随即重连并再次触发
      // 启动，最终形成失败启动 -> 假重启 -> 重连的自激风暴。只有 spawn 事件才表示
      // 新 CLI 运行时真实存在，可以安全通知 v4 订阅方重订。
// 首代进程不需要重启通知；已被替换的进程也不通知，
// 否则订阅方会对一个已经不存在的 runtime 重发订阅。
      if (runtimeGeneration > 1 && this.processesByWorkspaceKey.get(workspaceKey) === managed) {
        this.runtimeRestartedEmitter.fire({ workspaceKey, runtimeIdentity });
      }
      if (this.processesByWorkspaceKey.get(workspaceKey) === managed) {
        this.availableRuntimeIdentityByWorkspaceKey.set(workspaceKey, runtimeIdentity.identity);
        this.runtimeLifecycleEmitter.fire({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          workspaceKey,
          runtimeIdentity,
          state: "available",
        });
      }
      if (typeof child.pid === "number") {
        this.reportProcessLifecycle((reporter) =>
          reporter.onSpawn({
            pid: child.pid!,
            provider: ZCODE_AGENT_PROVIDER,
            ...(this.lane ? { lane: this.lane } : {}),
            workspacePath: params.workspacePath,
            command: effectiveCommand.command,
            args: effectiveCommand.args ?? [],
            startedAt,
            runtimeGeneration,
            runtimeInstanceId,
          }),
        );
      }
      this.reportRuntimeReady(managed);
      log("ZCode agent process started", {
        workspaceKey,
        command: effectiveCommand.command,
        cwd: spawnPreflight.cwd,
        pid: child.pid,
        durationMs: Date.now() - startStartedAt,
      });
    });
// [失败路径] spawn 失败（ENOENT/EACCES 等）不会触发 exit，只能从 error 事件收口；
// 日志里同时带 spawnPreflight，才能判断是命令缺失还是 cwd 缺失。
    child.once("error", (error) => {
      errorLog(
        `ZCode agent process error${this.processLifecycleReporter?.onError ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
        {
          workspaceKey,
          pid: child.pid,
          runtimeIdentity: runtimeIdentity.identity,
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
          spawnPreflight,
        },
      );
      const errno = error as NodeJS.ErrnoException;
      this.reportProcessLifecycle((reporter) =>
        reporter.onError?.({
          pid: typeof child.pid === "number" ? child.pid : null,
          provider: ZCODE_AGENT_PROVIDER,
          ...(this.lane ? { lane: this.lane } : {}),
          workspacePath: params.workspacePath,
          command: effectiveCommand.command,
          args: effectiveCommand.args ?? [],
          errorName: error.name || "Error",
          ...(typeof errno.code === "string" ? { errorCode: errno.code } : {}),
          errorMessage: error.message,
          ...(error.stack ? { errorStack: error.stack } : {}),
          runtimeGeneration,
          runtimeInstanceId,
          occurredAt: Date.now(),
        }),
      );
// 没有 pid 说明进程从未真正创建：直接结算诊断并释放所有权，
// 否则 ownedProcesses 会永久保留一个不存在的进程，让关闭流程等待超时。
      if (child.pid == null) {
        exitDiagnostics.resolve();
        this.ownedProcesses.delete(managed);
      }
    });
// [资源] exit 是进程终结的唯一权威事件：先标 exited、停空闲计时器，
// 等待 stderr 排空后再上报诊断，最后无条件 resolve 诊断 promise。
// finally 保证即使上报抛错，回收路径也不会永远卡在诊断等待上。
    child.once("exit", async (code, signal) => {
      try {
        managed.exited = true;
        this.clearIdleTimer(managed);
        const endedAt = Date.now();
// 没有主动终止意图即非预期退出：signal crash 与自行 exit 0 都算，
// 不能只按非零 code 判断，否则长期运行后自行退出的 Agent 会被当成正常结束。
        const terminationKind = managed.terminationIntent?.kind ?? "unexpected";
        // 协议解析/stream 故障会先触发 protocol-close，再由 Host 用 SIGTERM
        // 回收仍存活的进程。若只透传主动 termination intent，desktop 只能看到最终信号，
        // 无法区分协议故障与受控退出；保留首次 cleanup 原因作为结构化根因。
// [失败路径] 协议故障会先触发 protocol-close 再用 SIGTERM 回收，
// 只透传主动意图会让 desktop 只看到信号，分不清协议故障与受控退出；
// `firstCleanupReason` 保留首次清理原因，作为 `terminationReason` 的结构化根因。
        const terminationReason = managed.terminationIntent?.reason ?? managed.firstCleanupReason;
        // 协议已立即失效，但 exit 先于 stderr EOF；保留旧 runtime 闭包身份收齐最后诊断。
// 协议已立即失效，但 exit 可能先于 stderr EOF；
// 用创建时的闭包身份收齐最后诊断，不能查当前 workspace。
        await transport.waitForStderrDrain();
        const stderr = stderrTail.snapshot();
        const exitContext = {
          workspaceKey,
          pid: child.pid,
          runtimeIdentity: runtimeIdentity.identity,
          code,
          signal,
          terminationKind,
          terminationReason,
        };
        // 之前日志只有新的 "process started"，缺少旧 pid 的退出轨迹。
        // agent native crash 后 UI 只会看到 protocol close/Session is not active，无法判断是崩溃还是主动重启。
        log("ZCode agent process exited", exitContext);
// 非预期退出单独打一条 error 级日志并附 stderr 尾部：
// 生产日志过去只有 code=1，无法还原顶层异常；
// 带 lifecycle 标记是为了避免 Electron 把它再计为一次 JS 异常。
        if (terminationKind === "unexpected") {
          // Agent 顶层异常只写 stderr 并以非零 code 退出；stderr 过去仅走开发态
          // debug，生产日志只剩 code=1，无法还原异常。不能只按非零 code 判断：signal crash
          // 和长期运行的 Agent 自行 exit 0 同样是非预期退出。
          // 已有独立生命周期事件，显式标记包装日志，避免 Electron 将其再计为 JS 异常。
          errorLog(
            `ZCode agent process exited unexpectedly${this.processLifecycleReporter ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
            {
              ...exitContext,
              stderr,
            },
          );
        }
        if (typeof child.pid === "number") {
          this.reportProcessLifecycle((reporter) =>
            reporter.onExit({
              pid: child.pid!,
              provider: ZCODE_AGENT_PROVIDER,
              ...(this.lane ? { lane: this.lane } : {}),
              workspacePath: params.workspacePath,
              exitCode: code,
              signal,
              endedAt,
              terminationKind,
              runtimeReady: managed.readyAt != null,
              ...(terminationReason ? { terminationReason } : {}),
              runtimeGeneration,
              runtimeInstanceId,
              uptimeMs: Math.max(0, endedAt - startedAt),
              stderrLineCount: stderr.lineCount,
              ...(terminationKind === "unexpected" && stderr.tail.length > 0
                ? { stderrTail: stderr.tail }
                : {}),
            }),
          );
        }
      } finally {
        exitDiagnostics.resolve();
      }
    });
// [事务] 请求超时说明协议链路已不可信：旧实现只 reject 当前请求，
// child 仍存活，后续同 workspace 会继续复用坏 client 并反复超时。
// 这里主动回收整棵进程树，让下一次 getClient 重新拉起干净的 app-server。
    client.onRequestTimeout((event) => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
// 取消通知是尽力而为的控制面调用，超时不应升级成回收：
// 取消失败最多让生成多跑一会儿，重启进程的代价远高于收益。
      if (event.method === "workspace/cancelGenerateText") {
        warnLog(
          "ZCode agent cancel notification timed out; keeping client (best-effort control plane)",
          {
            workspaceKey,
            method: event.method,
            requestId: event.requestId,
            timeoutMs: event.timeoutMs,
            pid: child.pid,
          },
        );
        return;
      }
      warnLog("ZCode agent request timed out; disposing stale protocol client", {
        workspaceKey,
        method: event.method,
        requestId: event.requestId,
        timeoutMs: event.timeoutMs,
        pid: child.pid,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      // timeout 说明协议请求/响应链路已经不可信。旧实现只 reject 当前请求，
      // 但 child 仍未 exit，后续同 workspace 会继续复用坏 client 并反复超时。
      // 这里主动回收进程树，让下一次 getClient 重新拉起干净的 app-server。
      void this.cleanupManagedProcessWithRetry(
        managed,
        "request-timeout",
        "request-timeout",
        "request timeout",
      ).catch(() => undefined);
    });
// [资源] 协议关闭不等于进程退出：这里只摘除活跃表并上报 unavailable，
// 只要仍持有所有权就必须按原进程组完成幂等回收，
// 否则根进程退出后同组 MCP 后代仍会残留。
    client.onClose(() => {
      const wasActiveClient = this.processesByWorkspaceKey.get(workspaceKey) === managed;
      log("ZCode agent protocol client closed", {
        workspaceKey,
        pid: child.pid,
        runtimeIdentity: runtimeIdentity.identity,
        wasActiveClient,
      });
      if (wasActiveClient) {
        this.processesByWorkspaceKey.delete(workspaceKey);
      }
      this.reportRuntimeUnavailable(managed);
// 已释放的进程不再重复回收；仍持有的必须按组清理。
      if (this.ownedProcesses.has(managed)) {
        // 根 child 的 exit 不等于同组 MCP 后代已退出。即使 protocol close
        // 来自根进程退出，也必须按原进程组完成幂等回收后才能释放 Host 所有权。
        void this.cleanupManagedProcessWithRetry(
          managed,
          "protocol-close",
          "protocol-close",
          "protocol close",
        ).catch(() => undefined);
      }
    });
    return client;
  }

// [权衡] 查询接口复用启动型 getClient 会让 provider 保存等被动探测
// 按 workspace 数量隐式 spawn Agent；这里只读已登记实例，缺失即抛错。
  async getRuntimeIdentity(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAgentRuntimeIdentity> {
    const workspaceKey = resolveWorkspaceKey(params);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    // runtime identity 是查询接口，旧实现却复用了启动型 getClient，
    // 导致 provider 保存等被动探测按 workspace 数量隐式 spawn Agent CLI。
    if (!managed || managed.exited || managed.child.killed) {
      throw new Error("ZCode agent runtime identity is unavailable.");
    }
    return managed.runtimeIdentity;
  }

// 能力探测只跑 resolver，不 spawn：用于 UI 在真正启动前提示配置缺失。
// resolver 抛错也归为不可用，并把原始 message 带出去。
  async canStart(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ available: boolean; workspaceKey: string; reason?: string }> {
    const workspaceKey = resolveWorkspaceKey(params);
    try {
      const command = await this.commandResolver({
        ...params,
        ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
        workspaceKey,
      });
      return command
        ? { available: true, workspaceKey }
        : {
            available: false,
            workspaceKey,
            reason: "ZCODE_AGENT_SERVER_COMMAND is not configured",
          };
    } catch (error) {
      return {
        available: false,
        workspaceKey,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

// [并发] 单 workspace 回收：先递增重启代际并取消准入，再从活跃表摘除，
// 最后才回收进程。顺序保证在飞的启动请求不会在摘除后写回进程池。
// 不能复用 disposeAll，否则整个 manager 会被标记关闭，后续无法重新拉起。
  async disposeWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(params);
    this.restartGenerationByWorkspaceKey.set(
      workspaceKey,
      (this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1,
    );
// 取消准入让所有卡在 await 的启动立即失败，而不是继续走到 spawn。
    this.abortPendingStarts(workspaceKey);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    this.processesByWorkspaceKey.delete(workspaceKey);
    // dispose 不能把尚未完成的 start promise 从追踪表中删掉。删除会让
    // recovery/UI 的下一次 getClient 再开一条 spawn，旧 promise 随后又可能越过异步
    // resolve 回写进程池，形成同一 workspace 的 spawn/dispose 风暴。代际检查会让旧
    // promise 在真正 spawn 前失败，finally 再按 promise identity 清理 map。
    if (managed) {
      // restartWorkspaceProcess 只应回收当前 workspace 的 agent。
      // 不能复用 disposeAll，否则会把整个 manager 标记为已关闭，后续首发/预热无法重新拉起。
      this.reportRuntimeUnavailable(managed);
      await this.cleanupManagedProcessWithRetry(
        managed,
        "workspace-dispose",
        "workspace-dispose-retry",
        "workspace dispose",
      );
    }
  }

// 每个启动请求登记一个 AbortController，这里统一 abort；
// 未登记的 workspace 直接返回，不做空集合分配。
  private abortPendingStarts(
    workspaceKey: string,
    reason = new Error("ZCode agent process start was cancelled."),
  ): void {
    const controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      return;
    }
    for (const controller of controllers) {
      controller.abort(reason);
    }
  }

// 全量取消用于 manager 关闭，理由与单 workspace 相同。
  private abortAllPendingStarts(
    reason = new Error("ZCode agent process manager is disposed."),
  ): void {
    for (const workspaceKey of this.startAdmissionAbortControllersByWorkspaceKey.keys()) {
      this.abortPendingStarts(workspaceKey, reason);
    }
  }

// [资源] 同步版关闭：只发 dispose 不等待进程树回收，
// 适用于不关心退出时机的调用方；需要等待的必须用 disposeAllAndWait。
  disposeAll(): void {
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();
    for (const managed of this.ownedProcesses) {
      this.recordTerminationIntent(managed, "manager-dispose");
      this.reportRuntimeUnavailable(managed);
      managed.client.dispose();
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();
  }

// [资源] app/host 退出时必须等待每棵进程树完成 graceful + force 清理：
// 只同步 dispose 时 SIGKILL 兜底依赖 unref timer，host 先退出后 timer 不再执行，
// zcode-cli 会残留为孤儿进程。
// disposeAllInFlight 让重复调用共享同一次等待。
  async disposeAllAndWait(): Promise<void> {
    if (this.disposeAllInFlight) {
      return this.disposeAllInFlight;
    }
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();

// 先快照再清表：清表后仍要按快照逐个回收，
// 否则并发回收过程中的新增只会被统计一次。
    const managedProcesses = [...this.ownedProcesses];
    for (const managed of managedProcesses) {
      this.reportRuntimeUnavailable(managed);
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();

    // app/host 退出时旧逻辑只同步 dispose client，底层进程树的 SIGKILL 兜底
    // 依赖 unref timer，host 自己退出后 timer 不会再执行，zcode-cli 会残留为孤儿进程。
    // 这里让 host 可以等待每个 workspace 的 agent 进程树完成 graceful + force 清理。
    this.disposeAllInFlight = Promise.all(
      managedProcesses.map((managed) => this.cleanupManagedProcessForShutdown(managed)),
    ).then(() => undefined);
    try {
      await this.disposeAllInFlight;
    } finally {
      this.disposeAllInFlight = undefined;
    }
  }
}
