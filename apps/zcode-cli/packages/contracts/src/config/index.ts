// Config Port - Scoped configuration with change notification
//
// 横向能力：配置的层级、优先级、来源可追踪性与热更新通知。
// 生产者：adapters 的 config-factory 把 system/user/project/session/env/cli 六层合并成
// RuntimeConfig，再由 ConfigPortImpl 按 ConfigKey 索引；消费方覆盖 core 运行时、
// hooks/permission 判定、MCP 与插件发现、TUI/协议投影。
// 不变量：合并只在 adapters 层完成，业务模块只能通过 ConfigPort 读取；
// RuntimeConfig 一旦产出即为该次装配的只读快照，跨进程只传递普通 JSON 结构。
// 回写口径：运行期 set 只作用于当前进程（Session 作用域），不落盘；
// 持久化只发生在 user 配置文件（plugins.* 与 ui.locale 等 update* 接口），
// project/env/cli 层是只读输入，任何一侧都不能把合并结果整体写回磁盘。

import type { CollaborationMode } from "../interfaces/session.port.js";
import type { McpServerConfig } from "../interfaces/mcp.port.js";
import type { HooksRuntimeConfig, HooksRuntimeConfigPatch } from "../hooks/index.js";
import type { PluginConfig, PluginOptionValues } from "../plugins/index.js";

// ============================================================
// Config Key Types
// ============================================================

// 配置键的唯一注册表：点号分段（域.字段）既是对外契约也是配置文件/环境变量/CLI 的映射键。
// 键字符串一旦发布即为持久化格式，重命名会造成旧配置文件静默失效，因此只允许新增。
// 每新增一个键，必须同步 ConfigValue 的条件类型、ConfigPortImpl.merge 的写入分支、
// getDefaultValue 的兜底，以及 adapters 的 file/env/cli 解析，否则读取端会退化为 unknown。
// 分组顺序即文档顺序：模型流、权限、存储、网络、特性开关、记忆、MCP、插件、技能、日志、录制、并发、hook、UI。
export const ConfigKey = {
  ModelStreamIdleTimeout: "modelStream.idleTimeoutMs",

  // Permission
  PermissionMode: "permission.mode",
  PermissionAllowedTools: "permission.allowedTools",
  PermissionDisallowedTools: "permission.disallowedTools",
  PermissionAutoApproveHighRisk: "permission.autoApproveHighRisk",
  PermissionAllowMediumRiskInAuto: "permission.allowMediumRiskInAuto",

  // Storage
  StorageDir: "storage.dir",
  StorageSessionDbPath: "storage.sessionDbPath",

  // Network
  HttpProxy: "network.httpProxy",
  NoProxy: "network.noProxy",
  CaCertFile: "network.caCertFile",
  HttpTimeout: "network.timeout",

  // Features
  FeatureCompact: "features.compact",
  FeatureRewind: "features.rewind",
  FeatureSubagent: "features.subagent",
  FeatureMemory: "features.memory",
  FeatureSkill: "features.skill",
  FeatureMcp: "features.mcp",

  // Memory
  MemoryUse: "memory.use",

  // MCP
  McpServers: "mcp.servers",

  // Plugins
  PluginsEnabled: "plugins.enabled",
  PluginsDirs: "plugins.dirs",
  PluginsEnabledPlugins: "plugins.enabledPlugins",
  PluginsExtraKnownMarketplaces: "plugins.extraKnownMarketplaces",
  PluginsOptions: "plugins.options",
  PluginsSuppressedBuiltins: "plugins.suppressedBuiltins",

  // Skills
  SkillsEnabled: "skills.enabled",
  SkillsIncludeInstructions: "skills.includeInstructions",
  SkillsMetadataBudget: "skills.metadataBudget",
  SkillsRoots: "skills.roots",

  // Skill / Command 可用性覆盖（按 SKILL.md / 命令 .md 的绝对路径过滤）
  SkillOverrides: "skill",
  CommandOverrides: "command",

  // Logging
  LogLevel: "logging.level",
  LogFormat: "logging.format",

  // Conversation Recording
  RecordingConversationEnabled: "recording.conversation.enabled",
  RecordingConversationDir: "recording.conversation.dir",

  // Tool Concurrency
  ToolConcurrencyMax: "toolConcurrency.maxConcurrency",

  // Model anomaly guards
  ModelAnomalyGuard: "modelAnomalyGuard",

  // Hooks
  Hooks: "hooks",

  // UI
  UiLocale: "ui.locale",
  UiTheme: "ui.theme",
} as const;

// 上列常量对象的取值联合，是 get/set/observe 的类型入口。
export type ConfigKey = (typeof ConfigKey)[keyof typeof ConfigKey];

// ============================================================
// Config Value Types
// ============================================================

// 键 → 值类型的编译期映射，用条件类型代替一张运行期表。
// 映射未覆盖的键会退化为 unknown，说明新增 ConfigKey 时漏改了这里；
// 值类型必须与 DefaultRuntimeConfig 中同名字段的类型保持一致，否则 set 会写入错误形状。
// 字符串类配置里 storage/network 的路径与代理允许 undefined（表示“未设置”而非空串），
// 其余布尔/数字字段必须有确定默认值，不允许 undefined 穿透到消费端。
export type ConfigValue<K extends ConfigKey> = K extends "modelStream.idleTimeoutMs"
  ? number
  : K extends "permission.mode"
    ? CollaborationMode
    : K extends "permission.allowedTools" | "permission.disallowedTools"
      ? string[]
      : K extends "permission.autoApproveHighRisk" | "permission.allowMediumRiskInAuto"
        ? boolean
        : K extends
              | "storage.dir"
              | "storage.sessionDbPath"
              | "network.httpProxy"
              | "network.noProxy"
              | "network.caCertFile"
          ? string | undefined
          : K extends "network.timeout"
            ? number
            : K extends
                  | "features.compact"
                  | "features.rewind"
                  | "features.subagent"
                  | "features.memory"
                  | "features.skill"
                  | "features.mcp"
                  | "skills.enabled"
                  | "skills.includeInstructions"
              ? boolean
              : K extends "memory.use"
                ? boolean
                : K extends "skills.metadataBudget"
                  ? number
                  : K extends "skills.roots"
                    ? string[]
                    : K extends "skill" | "command"
                      ? Record<string, SkillCommandOverride>
                      : K extends "mcp.servers"
                        ? Record<string, McpServerConfig>
                        : K extends "plugins.enabled"
                          ? boolean
                          : K extends "plugins.dirs"
                            ? string[]
                            : K extends "plugins.enabledPlugins"
                              ? Record<string, boolean>
                              : K extends "plugins.extraKnownMarketplaces"
                                ? PluginConfig["extraKnownMarketplaces"]
                                : K extends "plugins.options"
                                  ? Record<string, PluginOptionValues>
                                  : K extends "plugins.suppressedBuiltins"
                                    ? string[]
                                    : K extends "logging.level"
                                      ? "debug" | "info" | "warn" | "error"
                                      : K extends "logging.format"
                                        ? "text" | "json"
                                        : K extends "recording.conversation.enabled"
                                          ? boolean
                                          : K extends "recording.conversation.dir"
                                            ? string | undefined
                                            : K extends "toolConcurrency.maxConcurrency"
                                              ? number
                                              : K extends "modelAnomalyGuard"
                                                ? ModelAnomalyGuardConfig
                                                : K extends "hooks"
                                                  ? HooksRuntimeConfig
                                                  : K extends "ui.locale"
                                                    ? UiLocale
                                                    : K extends "ui.theme"
                                                      ? UiThemePreference
                                                      : unknown;

// ============================================================
// Config Scope
// ============================================================

// 配置来源层级。顺序即优先级语义（低→高）：system < user < project < session < env < cli。
// session 只存在于进程内（运行期 set），不来自文件；env 指 ZCODE_* 环境变量；
// cli 指命令行参数覆盖。安全相关配置（权限、网络代理/证书、hook）必须能回答“来自哪一层”。
export const ConfigScope = {
  System: "system",
  User: "user",
  Project: "project",
  Session: "session",
  Env: "env",
  Cli: "cli",
} as const;

// ConfigScope 的取值联合。
export type ConfigScope = (typeof ConfigScope)[keyof typeof ConfigScope];

// 各层数值优先级：合并时按升序折叠，大的覆盖小的。留出 10 的步长便于将来插入新层。
// 该表是合并顺序的唯一权威来源，调用方不得自行写死分层顺序；
// 注意 MCP server 发现有一条刻意不同的规则（user 遮蔽 project），见 adapters 的 mcp 解析。
export const ConfigScopePriority: Record<ConfigScope, number> = {
  [ConfigScope.System]: 0,
  [ConfigScope.User]: 10,
  [ConfigScope.Project]: 20,
  [ConfigScope.Session]: 30,
  [ConfigScope.Env]: 40,
  [ConfigScope.Cli]: 50,
};

// ============================================================
// Config Source
// ============================================================

// 单个键的来源记录，用于安全配置审计与排障（ConfigPort.getSources 返回其数组）。
// 契约上允许一个键有多条来源；当前实现每次 set 都会整体替换 sources，
// 因此数组实际只保留“最后写入的一层”，跨层完整视图需要由 adapters 的 ConfigResult.sources 提供。
// scope 是来源层级；key 是目标键；value 是该层原始取值；path 仅文件层填写；
// env/cli/session 层没有路径。
// 该结构只读且不进协议投影；不要把 value 里的敏感项（代理凭据、证书路径）写进日志。
export interface ConfigSource {
  scope: ConfigScope;
  key: ConfigKey;
  value: unknown;
  path?: string; // For file-based configs, the file path
}

// ============================================================
// Skill / Command 可用性覆盖
// ============================================================

// 按绝对路径覆盖单个 skill / 命令是否可用。未列出的条目默认可用，
// 只有显式 enable:false 才会在发现阶段被过滤掉。
// 该覆盖只影响发现阶段暴露的可用集合，不参与执行期权限判定：enable:true 不会授予额外权限。
// 键是 SKILL.md / 命令 .md 的绝对路径，因此同一份配置不能跨机器无条件复用；
// 路径在比较前由 adapters 规范化，配置里应写解析后的绝对路径。
export interface SkillCommandOverride {
  enable?: boolean;
}

// ============================================================
// Runtime Config
// ============================================================

// 六层合并后的最终配置视图，是 core/runtime 与 adapter 的只读输入。
// 字段与 ConfigKey 一一对应但按域嵌套；被消费方高频读取的是 permission、features、
// plugins、skills、hooks、ui。plugins/skills 的索引签名用于承载按路径的覆盖项，
// 该形状只为兼容存量读取，新代码应使用 skillOverrides / commandOverrides。
// 该对象不持久化整体：落盘只发生在 user 配置文件的局部字段，避免把 project/env 值写回。
export interface RuntimeConfig {
  modelStream: ModelStreamConfig;
  permission: {
    mode: CollaborationMode;
    allowedTools: string[];
    disallowedTools: string[];
    autoApproveHighRisk: boolean;
    allowMediumRiskInAuto: boolean;
  };
  storage: {
    dir: string;
    sessionDbPath: string;
  };
  network: {
    httpProxy?: string;
    noProxy?: string;
    caCertFile?: string;
    timeout: number;
  };
  features: {
    compact: boolean;
    rewind: boolean;
    subagent: boolean;
    memory: boolean;
    skill: boolean;
    mcp: boolean;
  };
  memory: {
    use: boolean;
  };
  mcp: {
    servers: Record<string, McpServerConfig>;
  };
  plugins: PluginConfig;
  skills: {
    enabled: boolean;
    includeInstructions: boolean;
    metadataBudget: number;
    roots: string[];
    [skillPath: string]: boolean | number | string[] | { enable?: boolean };
  };
  // key 为 SKILL.md 绝对路径，value.enable=false 表示禁用该 skill
  skillOverrides: Record<string, SkillCommandOverride>;
  // key 为命令 .md 绝对路径，value.enable=false 表示禁用该命令
  commandOverrides: Record<string, SkillCommandOverride>;
  logging: {
    level: "debug" | "info" | "warn" | "error";
    format: "text" | "json";
  };
  recording: {
    conversation: ConversationRecordingConfig;
  };
  toolConcurrency: ToolConcurrencyConfig;
  modelAnomalyGuard: ModelAnomalyGuardConfig;
  hooks: HooksRuntimeConfig;
  ui: {
    locale: UiLocale;
    theme: UiThemePreference;
  };
}

// 单层配置的补丁形状：所有字段可选，用于逐层注入与合并（文件、env、CLI 覆盖都产出它）。
// 合并按 ConfigScopePriority 升序进行，嵌套域做深合并；plugins/skills/hooks 有专门的合并规则，
// 不能退化成整体对象覆盖（否则 project 只写一个字段会丢掉 user 层的其余配置）。
// 该类型也用于运行期热更新补丁，不得包含不可序列化的值。
export interface RuntimeConfigPatch {
  modelStream?: Partial<ModelStreamConfig>;
  permission?: Partial<RuntimeConfig["permission"]>;
  storage?: Partial<RuntimeConfig["storage"]>;
  network?: Partial<RuntimeConfig["network"]>;
  features?: Partial<RuntimeConfig["features"]>;
  memory?: Partial<RuntimeConfig["memory"]>;
  mcp?: Partial<RuntimeConfig["mcp"]>;
  plugins?: Partial<RuntimeConfig["plugins"]>;
  skills?: Partial<RuntimeConfig["skills"]>;
  skillOverrides?: RuntimeConfig["skillOverrides"];
  commandOverrides?: RuntimeConfig["commandOverrides"];
  logging?: Partial<RuntimeConfig["logging"]>;
  recording?: {
    conversation?: Partial<ConversationRecordingConfig>;
  };
  toolConcurrency?: Partial<RuntimeConfig["toolConcurrency"]>;
  modelAnomalyGuard?: Partial<RuntimeConfig["modelAnomalyGuard"]>;
  hooks?: HooksRuntimeConfigPatch;
  ui?: Partial<RuntimeConfig["ui"]>;
}

// UI 支持的确定语言集合；新增语言必须同步 i18n 资源与 TUI/协议端映射表。
export type SupportedLocale = "en-US" | "zh-CN";
// UI 语言偏好：auto 表示跟随系统/宿主，解析成 SupportedLocale 由上层完成，契约层不做探测。
export type UiLocale = SupportedLocale | "auto";
// 具体主题模式；auto 不在其中，避免“暗色偏好”与“跟随系统”被混为一谈。
export type UiThemeMode = "dark" | "light";
// 主题偏好：auto 由前端按系统外观解析；该值会跨进程传递，保持纯字符串。
export type UiThemePreference = UiThemeMode | "auto";

// 模型流空闲超时默认值（10 分钟）：超过该时长没有任何 chunk 视为流已死，交由重试/错误链处理。
export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 600_000;

// 模型流控制参数，目前只有空闲超时；该值按毫秒持久化在 user 配置中。
export interface ModelStreamConfig {
  idleTimeoutMs: number;
}

// System 层默认配置：所有键的兜底值，必须与 ConfigValue 的类型一一对应。
// 它是合并链的最低优先级来源，也会被 ConfigPortImpl 作为缺失键的默认值；
// 修改默认值等于改变所有新会话的行为，需要同步 spec 与测试，不能只在合并层改。
// 这里的 permission.mode="build" 是协作模式默认值，不是权限等级描述。
export const DefaultRuntimeConfig: RuntimeConfig = {
  modelStream: {
    idleTimeoutMs: DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  },
  permission: {
    mode: "build",
    allowedTools: [],
    disallowedTools: [],
    autoApproveHighRisk: false,
    allowMediumRiskInAuto: false,
  },
  storage: {
    dir: "~/.zcode",
    sessionDbPath: "~/.zcode/cli/db/db.sqlite",
  },
  network: {
    timeout: 180000,
  },
  features: {
    compact: true,
    rewind: true,
    subagent: true,
    memory: true,
    skill: true,
    mcp: true,
  },
  memory: {
    use: true,
  },
  mcp: {
    servers: {},
  },
  plugins: {
    dirs: [],
    enabled: true,
    enabledPlugins: {},
    extraKnownMarketplaces: {},
    options: {},
    suppressedBuiltins: [],
  },
  skills: {
    enabled: true,
    includeInstructions: true,
    metadataBudget: 20_000,
    roots: [],
  },
  skillOverrides: {},
  commandOverrides: {},
  logging: {
    level: "info",
    format: "text",
  },
  recording: {
    conversation: {
      enabled: false,
    },
  },
  toolConcurrency: {
    maxConcurrency: 10,
  },
  modelAnomalyGuard: {
    maxBudgetWarningsPerTurn: 3,
    repeatedToolCallWarningThreshold: 3,
  },
  hooks: {
    enabled: false,
    events: {},
    maxOutputBytes: 32768,
    timeoutMs: 60000,
  },
  ui: {
    locale: "en-US",
    theme: "auto",
  },
};

// ============================================================
// Tool Concurrency Config
// ============================================================

// 会话录制开关与输出目录；默认关闭，开启后 provider 原始请求/响应与 SessionEvent 会按 session
// 写成 JSONL。dir 缺席时由适配层解析为 <storage.dir>/cli/conversation，契约层不做路径拼接。
export interface ConversationRecordingConfig {
  /** 显式开启后，provider 原始请求/响应与 SessionEvent 会按 session 写入 JSONL。 */
  enabled: boolean;
  /** 输出根目录；缺席时使用 `<storage.dir>/cli/conversation`。 */
  dir?: string;
}

// 工具并发上限：只约束可并发安全的工具调用批，不是 agent loop 的停止条件。
export interface ToolConcurrencyConfig {
  maxConcurrency: number;
}

// 模型异常行为的告警阈值：重复工具调用与预算告警按 turn 计数，仅用于提示，不阻断执行。
export interface ModelAnomalyGuardConfig {
  toolCallWarningThreshold?: number;
  repeatedToolCallWarningThreshold: number;
  maxBudgetWarningsPerTurn: number;
}

// ============================================================
// Config Port Interface
// ============================================================

// 取消订阅句柄；调用方必须在销毁时执行，否则观察者会随 session 泄漏。
export interface Unsubscribe {
  (): void;
}

// 配置变更通知：subscribe 只监听单键（适合权限/UI 等精确刷新），
// subscribeAll 监听全部键（适合需要重算派生状态的消费方）。
// 回调在写入线程同步触发，回调内不得长时间阻塞；prev 是旧值，便于做差异刷新。
export interface ConfigObserver {
  subscribe<K extends ConfigKey>(
    key: K,
    handler: (value: ConfigValue<K>, prev: ConfigValue<K>) => void,
  ): Unsubscribe;
  subscribeAll(handler: (key: ConfigKey, value: unknown, prev: unknown) => void): Unsubscribe;
}

// 配置读取端口：业务模块唯一的配置入口，不直接读文件/环境变量。
// get 在键缺失时回落到默认值，仍无值才抛错；getAll 返回合并后的完整 RuntimeConfig 快照。
// set 只影响当前进程（Session 作用域），不持久化；merge 供装配层按来源注入补丁。
// getSources 是安全配置的可追踪出口；注意它返回的是该键当前保留的来源记录（实现上只留最后一次
// 写入的一层），需要完整分层视图时使用 adapters config-factory 输出的 ConfigResult.sources。
// 该端口不提供写文件能力，持久化由 adapters 的文件配置适配器负责。
export interface ConfigPort {
  // Get configuration value
  get<K extends ConfigKey>(key: K): ConfigValue<K>;
  getAll(): RuntimeConfig;

  // Check if key exists
  has(key: ConfigKey): boolean;

  // Set configuration value (runtime only, not persisted by default)
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>): void;

  // Get observer for scoped subscriptions
  observe(): ConfigObserver;

  // Get all sources for a key (for debugging/audit)
  getSources(key: ConfigKey): ConfigSource[];

  // Merge additional config (e.g., from file/env)
  merge(config: RuntimeConfigPatch, scope: ConfigScope): void;
}
