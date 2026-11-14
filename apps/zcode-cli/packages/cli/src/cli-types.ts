import type { TuiReadClipboardImage, TuiWriteClipboardText } from "@zcode/tui";
import type { UiLocale } from "@zcode/i18n";
import type { Logger } from "@zcode/contracts";
import type {
  createManagedCdpBrowserRuntime,
  ManagedCdpBrowserRuntimeOptions,
} from "@zcode/adapters/browser";
import type {
  createDefaultProviderEndpointRoutingPort,
  createModelAdapter,
  createZCodeApp,
  CreateDefaultProviderEndpointRoutingPortOptions,
  CreateModelAdapterOptions,
  configureCodingPlanApiKey,
  ConfigureCodingPlanApiKeyOptions,
  inspectZCodeSkill,
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
  inspectZCodeCustomCommand,
  InspectZCodeCustomCommandOptions,
  InspectZCodeSkillOptions,
  loginZCodeCli,
  loginBigmodelCodingPlan,
  LoginBigmodelCodingPlanOptions,
  LoginZCodeCliOptions,
  listZCodeCustomCommands,
  ListZCodeCustomCommandsOptions,
  loadZCodeCustomCommand,
  listZCodeSessions,
  listZCodeSkills,
  ListZCodeSessionsOptions,
  ListZCodeSkillsOptions,
  logoutZCodeCli,
  LogoutZCodeCliOptions,
  resolveLatestSession,
  ResolveLatestSessionOptions,
  RunZCodeProtocolAgentOptions,
  prepareZCodeTelemetryEnv,
  startProcessProviderRegistryRuntime,
  shutdownZCodeTelemetry,
  ZCodeAppOptions,
} from "@zcode/bootstrap";
import type { CliEnv, DotenvLoadResult, LoadCliDotenvOptions } from "./env.js";
import type { PluginsCommandOverrides } from "./plugins-command.js";
import type { CliShutdownProcess } from "./shutdown.js";
import type { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";

// 已加载的 @zcode/bootstrap 模块命名空间类型；只在需要类型引用时使用，不触发运行时加载。
export type BootstrapModule = typeof import("@zcode/bootstrap");

// CLI 运行期依赖注入集合：所有字段可选，缺省时回退到 bootstrap/全局实现的默认值。
// 设计目的是让单测与嵌入方无需拉起真实网络/文件/子进程即可跑命令路由；
// 字段值一律为函数，表示「调用时才取」，避免在构造阶段产生 I/O 副作用。
export interface RunDependencies extends PluginsCommandOverrides {
  // 存储迁移入口；缺省表示不执行迁移（由 bootstrap 默认流程负责）。
  migrateStorage?: () => Promise<import("@zcode/shared/sqlite-migrations").MigrationResult>;
  // 协议模式下 agent 的生命周期声明；缺省使用 bootstrap 默认（单次运行）。
  protocolLifecycle?: RunZCodeProtocolAgentOptions["lifecycle"];
  // --stdio 等协议模式的输入流；缺省由入口层接入 process.stdin。
  protocolInput?: NodeJS.ReadableStream;
  createManagedCdpBrowserRuntime?: (
    options?: ManagedCdpBrowserRuntimeOptions,
  ) => ReturnType<typeof createManagedCdpBrowserRuntime>;
  createModelAdapter?: (
    options?: CreateModelAdapterOptions,
  ) => ReturnType<typeof createModelAdapter>;
  createProviderEndpointRoutingPort?: (
    options: CreateDefaultProviderEndpointRoutingPortOptions,
  ) => ReturnType<typeof createDefaultProviderEndpointRoutingPort>;
  createZCodeApp?: (
    options?: ZCodeAppOptions,
  ) => Awaited<ReturnType<typeof createZCodeApp>> | ReturnType<typeof createZCodeApp>;
  /**
   * Session-event shaper for --output-format stream-json. Defaults to the
   * bootstrap module's, which is also what the protocol server uses; injectable
   * so a caller that supplies its own `createZCodeApp` (tests, embedders) can
   * still stream, since the bootstrap module is not loaded on that path.
   */
  mapSessionEvent?: BootstrapModule["mapSessionEvent"];
  // 工作目录来源（函数形式延迟求值）；缺省回退 process.cwd，调用时取当前值。
  cwd?: () => string;
  // 环境变量快照；缺省回退 process.env，用于解析存储目录、telemetry 等配置。
  env?: CliEnv;
  inspectSkill?: (options: InspectZCodeSkillOptions) => ReturnType<typeof inspectZCodeSkill>;
  inspectWorkspaceHookTrust?: typeof inspectWorkspaceHookTrust;
  grantWorkspaceHookTrust?: typeof grantWorkspaceHookTrust;
  revokeWorkspaceHookTrustCli?: typeof revokeWorkspaceHookTrustCli;
  inspectCustomCommand?: (
    options: InspectZCodeCustomCommandOptions,
  ) => ReturnType<typeof inspectZCodeCustomCommand>;
  loginZCodeCli?: (options?: LoginZCodeCliOptions) => ReturnType<typeof loginZCodeCli>;
  loginBigmodelCodingPlan?: (
    options?: LoginBigmodelCodingPlanOptions,
  ) => ReturnType<typeof loginBigmodelCodingPlan>;
  configureCodingPlanApiKey?: (
    options: ConfigureCodingPlanApiKeyOptions,
  ) => ReturnType<typeof configureCodingPlanApiKey>;
  loadDotenv?: (options?: LoadCliDotenvOptions) => DotenvLoadResult;
  prepareZCodeTelemetryEnv?: typeof prepareZCodeTelemetryEnv;
  projectConfigPath?: string;
  listSessions?: (options: ListZCodeSessionsOptions) => ReturnType<typeof listZCodeSessions>;
  listCustomCommands?: (
    options: ListZCodeCustomCommandsOptions,
  ) => ReturnType<typeof listZCodeCustomCommands>;
  loadCustomCommand?: (
    options: InspectZCodeCustomCommandOptions,
  ) => ReturnType<typeof loadZCodeCustomCommand>;
  // headless slash 路由要和 app facade 的保留名 gate 用同一个判据；默认取 bootstrap 的，
  // 注入点只为让单测不必拉起整个 bootstrap 模块。见 prompt-command.ts。
  isReservedSlashCommandName?: BootstrapModule["isReservedZCodeSlashCommandName"];
  listSkills?: (options: ListZCodeSkillsOptions) => ReturnType<typeof listZCodeSkills>;
  // 进程级日志器；缺省由入口层创建，传入后所有 CLI 模块共享同一 scope 体系。
  logger?: Logger;
  readClipboardImage?: TuiReadClipboardImage;
  writeClipboardText?: TuiWriteClipboardText;
  resolveLatestSession?: (
    options: ResolveLatestSessionOptions,
  ) => ReturnType<typeof resolveLatestSession>;
  resolveWorkspaceGitBranch?: typeof resolveWorkspaceGitBranch;
  logoutZCodeCli?: (options?: LogoutZCodeCliOptions) => ReturnType<typeof logoutZCodeCli>;
  runZCodeProtocolAgent?: (options?: RunZCodeProtocolAgentOptions) => Promise<void>;
  // TUI 主循环入口；缺省动态引用 @zcode/tui，注入便于无终端测试。
  runTui?: typeof import("@zcode/tui").runTui;
  // 为 true 时跳过用户级配置合并，只保留项目/系统层配置。
  skipUserConfig?: boolean;
  // 用户配置路径覆盖；缺省由 bootstrap 按平台解析，null/undefined 均表示走默认。
  userConfigPath?: string;
  // 进程退出入口；缺省 process.exit，注入后便于单测观察退出码而不真正退出。
  exitProcess?: (code: number) => void;
  // 关闭清理的兜底超时（毫秒）；超时后强制继续退出，避免挂起的 I/O 卡住 CLI。
  shutdownCleanupTimeoutMs?: number;
  // 关闭流程使用的外部进程句柄；缺省由入口层注入真实实现。
  shutdownProcess?: CliShutdownProcess;
  startProcessProviderRegistryRuntime?: typeof startProcessProviderRegistryRuntime;
  shutdownZCodeTelemetry?: typeof shutdownZCodeTelemetry;
}

// 权限模式：build 可改代码并可执行命令；plan 只规划不落盘；edit 仅编辑文件；
// yolo 跳过人工审批；guarded 对高风险操作强制审批。
export type CliPermissionMode = "build" | "plan" | "edit" | "yolo" | "guarded";
// 运行模式 = 权限模式 + auto（由运行时自动选择权限模式）。
export type CliRuntimeMode = CliPermissionMode | "auto";

// CLI 模式状态：current 为当前生效模式（可能为空，表示尚未确定）；
// override 为用户显式覆盖的权限模式，优先级高于 current。
export interface CliModeState {
  current?: CliRuntimeMode;
  override?: CliPermissionMode;
}

// /goal 的目标请求：objective 为自然语言目标（非空）；
// replaceExisting 为 true 表示用户已确认覆盖已有目标。
export interface CliTargetRequest {
  objective: string;
  replaceExisting: boolean;
}

// 具备模式/语言能力的 app facade：基础能力来自 createZCodeApp，
// 可选方法仅在支持该能力的客户端实现上存在，调用前需判空。
export type ModeCapableApp = Awaited<ReturnType<typeof createZCodeApp>> & {
  getMode?: () => CliRuntimeMode;
  setLocale?: (locale: UiLocale) => Promise<{ locale: "en-US" | "zh-CN" }>;
  setMode?: (mode: CliRuntimeMode) => Promise<{ mode: CliRuntimeMode }>;
};

// 会话恢复请求：continueSession 表示「继续最近会话」；
// resumeSessionId 存在时恢复指定会话，否则按 continueSession 语义处理。
export interface CliResumeRequest {
  continueSession: boolean;
  resumeSessionId?: string;
}
