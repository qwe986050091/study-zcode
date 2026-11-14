// INV-01 顶层 schema 用 passthrough：守住位置 对象末尾；改错故障 新增顶层字段被静默丢弃。
// INV-02 MCP 三个分支都 strict：守住位置 服务 schema；改错故障 拼错字段被当成合法配置。
// INV-03 environment 归一为 env：守住位置 解析入口；改错故障 旧配置 server 全被丢弃。
// INV-04 enable 归一为 enabled：守住位置 布尔判断；改错故障 停用状态在 CLI 侧失效。
// INV-05 冲突时以停用为准：守住位置 三目表达式；改错故障 用户关掉的 server 被重新拉起。
// INV-06 remote 归一为 http：守住位置 类型改写；改错故障 外部导入的地址型服务无法加载。
// INV-07 缺 type 时按字段推断：守住位置 双分支；改错故障 历史 app 配置阻断模型加载。
// INV-08 http_headers 归一为 headers：守住位置 条件赋值；改错故障 旧字段鉴权头丢失。
// INV-09 单 server 失败只丢自己：守住位置 循环内 safeParse；改错故障 一条坏配置拖垮整份。
// INV-10 servers 非对象整体丢弃：守住位置 守卫分支；改错故障 数组输入引发致命错误。
// INV-11 诊断码只用固定三类：守住位置 联合类型；改错故障 调用方被迫解析自由文本。
// INV-12 非致命问题走 warning：守住位置 严重级字段；改错故障 局部问题被当成整份失败。
// INV-13 插件 id 统一 canonical：守住位置 映射函数；改错故障 新旧 id 同时存在产生歧义。
// INV-14 别名删除先于写入：守住位置 键迁移；改错故障 canonical 值被旧值覆盖。
// INV-15 suppressedBuiltins 去重：守住位置 reduce；改错故障 同一内置插件出现两次。
// INV-16 skills 只挑已知键：守住位置 抽取函数；改错故障 逐 skill 开关混进全局配置。
// INV-17 覆盖表空则不产出：守住位置 长度判断；改错故障 空对象覆盖下层默认值。
// INV-18 绝对路径才认覆盖：守住位置 路径判定；改错故障 相对键被误当成开关。
//
// 模块职责：定义配置文件的唯一校验形状，并把历史字段归一成运行态补丁。
// 状态所有权：纯解析无状态；诊断数组由调用方传入并就地追加。
// 阅读顺序：先看 schema 定义，再看归一化入口，最后看扁平映射与辅助判定。
/* eslint-disable max-lines -- zcode-cli 配置 schema 需要集中维护文件解析和 provider 继承，拆散会让配置语义更难对齐。 */
/*
 * ============================================================
 * config / schema.ts —— 配置文件 schema、legacy 归一化与诊断
 *
 * 定位：定义 config.json 的唯一校验形状，并在进入 RuntimeConfigPatch 之前把历史
 * 字段（environment/enable/http_headers/remote/旧 CUA 插件 id）归一成运行态字段。
 *
 * 输入输出：parseConfigFileToRuntimePatchWithDiagnostics 输入任意 JSON 值，输出
 * {config, diagnostics}；非致命问题（单个 MCP server 非法、servers 不是对象）降级为
 * warning 并继续，schema 级错误由调用方捕获成 config_file_invalid。
 *
 * 副作用：无（纯解析/校验，不读写文件）。
 *
 * 失败语义：顶层结构不符 Zod 校验时抛 ZodError；MCP server 级别失败只丢该 server。
 *
 * 不变量：plugin id 统一 canonical 化；同一 MCP server 只保留 env/enabled/headers
 * 等运行态字段，legacy 字段解析后必须被删除。
 * ============================================================
 */
import { z } from "zod";
import type { RuntimeConfigPatch } from "@zcode/contracts";

const stringRecordSchema = z.record(z.string(), z.string());
const unknownRecordSchema = z.record(z.string(), z.unknown());
const positiveNumberSchema = z.number().finite().positive();
const positiveIntegerSchema = z.number().int().positive();
const modelStreamSchema = z.object({
  idleTimeoutMs: positiveNumberSchema.optional(),
});

const permissionSchema = z.object({
  mode: z.enum(["plan", "build", "edit", "yolo", "guarded", "auto"]).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  autoApproveHighRisk: z.boolean().optional(),
  allowMediumRiskInAuto: z.boolean().optional(),
});

const storageSchema = z.object({
  dir: z.string().min(1).optional(),
  sessionDbPath: z.string().min(1).optional(),
});

const networkSchema = z.object({
  httpProxy: z.string().min(1).optional(),
  noProxy: z.string().min(1).optional(),
  caCertFile: z.string().min(1).optional(),
  timeout: positiveNumberSchema.optional(),
});

const featuresSchema = z.object({
  compact: z.boolean().optional(),
  rewind: z.boolean().optional(),
  subagent: z.boolean().optional(),
  memory: z.boolean().optional(),
  skill: z.boolean().optional(),
  mcp: z.boolean().optional(),
});

const memorySchema = z.object({
  use: z.boolean().optional(),
});

// mcpServerBaseSchema 只放 stdio/http/sse 三个分支共用的字段，分支独有的键留在各自 schema。
// 协议版本字段与 enabled 开关平级，都可选，缺省时由下游按 transport 兜底。
// timeout 一律过 z.number().finite().positive()，避免 NaN 与 Infinity 穿过校验。
// 缺字段会让 strict 丢整条。
// 因此新增字段先加到这里。
const mcpServerBaseSchema = {
  alwaysLoad: z.boolean().optional(),
  // 设置页和 MCP adapter 已支持协议选择；配置入口漏掉该字段会因 strict 校验丢弃整个 server。
  protocolVersion: z.enum(["auto", "legacy", "2026-07-28"]).optional(),
  enabled: z.boolean().optional(),
  timeoutMs: positiveNumberSchema.optional(),
};

const mcpOAuthSchema = z.union([
  z
    .object({
      type: z.literal("client_credentials"),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      clientName: z.string().min(1).optional(),
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authorization_code"),
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      clientName: z.string().min(1).optional(),
      redirectPath: z.string().min(1).optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

const mcpStdioServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: stringRecordSchema.optional(),
  })
  .strict();

const mcpHttpServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("http"),
    url: z.string().min(1),
    headers: stringRecordSchema.optional(),
    oauth: mcpOAuthSchema.optional(),
  })
  .strict();

const mcpSseServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("sse"),
    url: z.string().min(1),
    headers: stringRecordSchema.optional(),
    oauth: mcpOAuthSchema.optional(),
  })
  .strict();

// z.preprocess 在 discriminatedUnion 之前跑，先把旧形状归一化再按 type 分流。
// normalizeMcpServerConfigInput 只改键名与形状而保留值语义；下游无需感知旧格式，因为配置内容其实没变。
// discriminatedUnion("type") 用 type 选分支，缺失时预处理器已按 command/url 推断过。
// type 不在 stdio/http/sse 之内时，校验阶段直接报错，不会落进默认分支。
// 单条 server 校验失败由外层 try/catch 捕获并降级，不阻断其它条目。
const mcpServerSchema = z.preprocess(
  normalizeMcpServerConfigInput,
  z.discriminatedUnion("type", [mcpStdioServerSchema, mcpHttpServerSchema, mcpSseServerSchema]),
);

const mcpSchema = z.object({
  servers: z.record(z.string(), mcpServerSchema).optional(),
});

const pluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const pluginMarketplaceSourceSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("url"),
      url: z.string().min(1),
      headers: stringRecordSchema.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("github"),
      repo: z.string().min(1),
      ref: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      sparsePaths: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("git"),
      url: z.string().min(1),
      ref: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      sparsePaths: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("npm"),
      package: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("file"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("directory"),
      path: z.string().min(1),
    })
    .strict(),
]);

const pluginsSchema = z.object({
  enabled: z.boolean().optional(),
  dirs: z.array(z.string().min(1)).optional(),
  enabledPlugins: z.record(z.string(), z.boolean()).optional(),
  extraKnownMarketplaces: z
    .record(z.string().min(1), z.object({ source: pluginMarketplaceSourceSchema }).strict())
    .optional(),
  options: z.record(z.string(), z.record(z.string(), pluginOptionValueSchema)).optional(),
  suppressedBuiltins: z.array(z.string().min(1)).optional(),
});

export const LEGACY_CUA_PLUGIN_ID = "zcode-cua@zcode-plugins-official";
export const CANONICAL_CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";

/** 把旧 CUA 插件 id 映射为 canonical id；其他 id 原样返回。 */
export function canonicalizePluginId(pluginId: string): string {
  return pluginId === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : pluginId;
}

/**
 * 返回某个插件 id 的全部等价键（canonical 在前，legacy 在后）。
 * 写配置前据此删除所有别名，避免新旧 id 同时存在导致解析歧义。
 */
export function pluginIdAliases(pluginId: string): readonly string[] {
  return canonicalizePluginId(pluginId) === CANONICAL_CUA_PLUGIN_ID
    ? [CANONICAL_CUA_PLUGIN_ID, LEGACY_CUA_PLUGIN_ID]
    : [pluginId];
}

const skillToggleSchema = z.object({
  enable: z.boolean().optional(),
});

// skill / command 可用性覆盖：key 为对应 .md 的绝对路径，enable:false 表示禁用
const skillCommandOverrideSchema = z
  .object({
    enable: z.boolean().optional(),
  })
  .passthrough();
const skillCommandOverridesSchema = z.record(z.string(), skillCommandOverrideSchema);
const skillsSchema = z
  .object({
    enabled: z.boolean().optional(),
    includeInstructions: z.boolean().optional(),
    metadataBudget: positiveNumberSchema.optional(),
    roots: z.array(z.string()).optional(),
  })
  .catchall(skillToggleSchema);

const loggingSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  format: z.enum(["text", "json"]).optional(),
});

const conversationRecordingSchema = z.object({
  enabled: z.boolean().optional(),
  dir: z.string().min(1).optional(),
});

const recordingSchema = z.object({
  conversation: conversationRecordingSchema.optional(),
});

const uiSchema = z.object({
  locale: z.enum(["auto", "en-US", "zh-CN"]).optional(),
  theme: z.enum(["auto", "dark", "light"]).optional(),
});

const toolConcurrencySchema = z.object({
  maxConcurrency: positiveNumberSchema.optional(),
});

const modelAnomalyGuardSchema = z.object({
  toolCallWarningThreshold: positiveIntegerSchema.optional(),
  repeatedToolCallWarningThreshold: positiveIntegerSchema.optional(),
  maxBudgetWarningsPerTurn: z.number().int().nonnegative().optional(),
});

// Hooks schema：
// 理想态是 re-export shared/workspace-hook-config，但两个 pnpm workspace 解析出物理
// 不同的 zod 实例（adapters 4.4.3 / shared 4.3.6）：shared schema 嵌入本包组合 schema
// 会让 dts 引用 foreign zod 内部类型（TS2742），typeof/ZodType 注解都会落入类型循环。
// 因此本副本按原样保留（本包 zod 构造），并保持与 shared 的校验语义等价；
// 运行时校验语义仍以 shared 为准（discovery/trust 装配入口都走 shared schema——
// 本 schema 只负责配置文件装载诊断）。若未来统一 zod 实例，应删除本副本改 re-export。
export const hookProcessSchema = z
  .object({
    type: z.literal("process"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    args: z.array(z.string()).optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
  })

  .passthrough();

export const hookCommandSchema = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string().min(1)]).optional(),
    timeout: positiveNumberSchema.optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
  })
  .passthrough();

export const hookMatcherSchema = z
  .object({
    matcher: z.string().min(1).optional(),
    hooks: z.array(z.discriminatedUnion("type", [hookProcessSchema, hookCommandSchema])).min(1),
  })
  .strict();

export const hooksSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: positiveNumberSchema.optional(),
    maxOutputBytes: positiveNumberSchema.optional(),
    events: z
      .object({
        SessionStart: z.array(hookMatcherSchema).optional(),
        UserPromptSubmit: z.array(hookMatcherSchema).optional(),
        PreToolUse: z.array(hookMatcherSchema).optional(),
        PermissionRequest: z.array(hookMatcherSchema).optional(),
        PostToolUse: z.array(hookMatcherSchema).optional(),
        PostToolUseFailure: z.array(hookMatcherSchema).optional(),
        Stop: z.array(hookMatcherSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// 顶层字段全部可选。
// 未知键被保留而非拒绝。
// 每个子域独立 schema。
// hook 与权限各有边界。
// ZCodeConfigFileSchema 的 TS 类型用 z.infer 推出，不另外手写一份 interface。
export const ZCodeConfigFileSchema = z
  .object({
    $schema: z.string().optional(),
    modelStream: modelStreamSchema.optional(),
    permission: permissionSchema.optional(),
    storage: storageSchema.optional(),
    network: networkSchema.optional(),
    features: featuresSchema.optional(),
    memory: memorySchema.optional(),
    mcp: mcpSchema.optional(),
    plugins: pluginsSchema.optional(),
    skills: skillsSchema.optional(),
    skill: skillCommandOverridesSchema.optional(),
    command: skillCommandOverridesSchema.optional(),
    logging: loggingSchema.optional(),
    recording: recordingSchema.optional(),
    ui: uiSchema.optional(),
    toolConcurrency: toolConcurrencySchema.optional(),
    modelAnomalyGuard: modelAnomalyGuardSchema.optional(),
    hooks: hooksSchema.optional(),
  })
  .passthrough();

export type ZCodeConfigFile = z.infer<typeof ZCodeConfigFileSchema>;

type SkillCommandOverrideMap = Record<string, { enable?: boolean }>;

export type ConfigDiagnosticSeverity = "warning" | "error";
/** 稳定诊断码：仅这三类，调用方据此做展示/告警映射，禁止自由文本判断。 */
export type ConfigDiagnosticCode =
  | "config_file_invalid"
  | "config_mcp_server_invalid"
  | "config_project_hooks_pending_trust";

export interface ConfigDiagnostic {
  /** 稳定诊断码。 */
  code: ConfigDiagnosticCode;
  /** 出问题的文件绝对路径；部分诊断由上层补齐。 */
  filePath?: string;
  /** 面向用户的消息（Zod 错误已格式化）。 */
  message: string;
  /** 文件内 JSON 路径，如 mcp.servers.foo。 */
  path?: string;
  /** warning=已降级继续；error=该文件整体未装载。 */
  severity: ConfigDiagnosticSeverity;
}

export interface ParseConfigFileResult {
  /** 已归一化的运行态补丁；顶层校验失败时不会返回（会抛错）。 */
  config: RuntimeConfigPatch;
  /** 解析过程中产生的降级诊断（不含致命 schema 错误，那会抛异常）。 */
  diagnostics: ConfigDiagnostic[];
}

/**
 * 在进入 Zod 校验前做 MCP server 归一化，兼容历史字段与外部 Agent 配置。
 *
 * 归一化顺序：environment→env、enable→enabled（冲突以停用为准）、清理超时旧字段、
 * remote→http、缺 type 时按 command/url 推断、http_headers→headers。纯函数，不写盘。
 */
// 非对象入参（含 null 与数组）原样返回，交给后面的 z 校验报错。
// 用展开复制出 next，避免直接改调用方传进来的对象。
// environment 与 enable 读完立即 delete，防止新旧键同时留在 next 里。
// type 只在原本缺失时才按 command/url 推断，已有值一律不覆盖。
// 返回 next 这个新对象，原入参保持不变。
function normalizeMcpServerConfigInput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const server = { ...(value as Record<string, unknown>) };
  if (!("env" in server) && "environment" in server) {
    // 旧配置和部分外部导入使用 environment；运行态只消费 env。
    // 在解析入口归一化，避免一个 legacy MCP server 拖垮整份 config。
    server.env = server.environment;
  }
  delete server.environment;

  if (typeof server.enable === "boolean" || typeof server.enabled === "boolean") {
    // 历史遗留兜底：桌面端早期把停用状态写成 enable，而契约字段一直是 enabled。
    // 桌面端与 mcp-sync 现在只写 enabled，并在加载配置时把存量 enable 就地迁移落盘；
    // CLI 是只读解析、不能写盘，这里只覆盖「用户先跑 CLI、还没开过桌面端」的窗口。
    // 冲突时以「停用」为准：桌面端写 enable:false 时不会清理外部导入残留的 enabled:true，
    // 按 enabled 取值会把用户关掉的 server 重新拉起（停用了还在被调用）。
    // 存量配置迁移完毕后，这段连同下面的 delete 可以整块删除。
    server.enabled = server.enable === false ? false : (server.enabled ?? true);
  }
  delete server.enable;

  // External MCP configs may carry provider-specific timeout fields. ZCode does not migrate
  // those values, but the strict runtime schema should still accept old imported entries.
  delete server.timeout;
  delete server.startup_timeout_sec;

  if (server.type === "remote") {
    // 外部 Agent 配置常把 HTTP MCP 标记为 remote；ZCode 运行态协议类型是 http。
    server.type = "http";
  } else if (typeof server.type !== "string") {
    // app 管理层把 command 形态视为默认 stdio；CLI 也需要同样推断，
    // 否则历史 app 配置缺少 type 时会阻断模型配置加载。
    if (typeof server.command === "string" && server.command.trim().length > 0) {
      server.type = "stdio";
    } else if (typeof server.url === "string" && server.url.trim().length > 0) {
      server.type = "http";
    }
  }

  if (
    (server.type === "http" || server.type === "sse") &&
    server.headers === undefined &&
    server.http_headers !== undefined
  ) {
    // 兼容历史 BigModel MCP 配置：旧字段名是 http_headers，agent runtime 只消费 headers。
    server.headers = server.http_headers;
  }
  delete server.http_headers;

  return server;
}

/**
 * 配置装载主入口：归一化 → Zod 校验 → 转 RuntimeConfigPatch，并收集降级诊断。
 *
 * 副作用无；失败语义：schema 顶层校验失败抛 ZodError（由 file-config 转成
 * config_file_invalid），MCP server 级问题只产生 warning 并继续。
 */
export function parseConfigFileToRuntimePatchWithDiagnostics(
  value: unknown,
): ParseConfigFileResult {
  const diagnostics: ConfigDiagnostic[] = [];
  const normalized = normalizeConfigFileInput(value, diagnostics);
  const parsed = ZCodeConfigFileSchema.parse(normalized);
  return {
    config: parsedConfigFileToRuntimePatch(parsed),
    diagnostics,
  };
}

/**
 * schema 校验后的扁平映射：只拷贝已识别的顶层字段，丢弃 $schema 等无关键。
 *
 * 纯数据转换；skills/skill/command 需要额外合并成 skillOverrides 与 commandOverrides，
 * 其余字段基本一一对应。
 */
function parsedConfigFileToRuntimePatch(parsed: ZCodeConfigFile): RuntimeConfigPatch {
  const config: RuntimeConfigPatch = {};
  if (parsed.modelStream) config.modelStream = parsed.modelStream;

  if (parsed.permission) config.permission = parsed.permission;
  if (parsed.storage) config.storage = parsed.storage;
  if (parsed.network) config.network = parsed.network;
  if (parsed.features) config.features = parsed.features;
  if (parsed.memory) config.memory = parsed.memory;
  if (parsed.mcp) config.mcp = parsed.mcp;
  if (parsed.plugins) config.plugins = normalizePluginConfig(parsed.plugins);
  const skillsConfig = parseSkillsRuntimeConfig(parsed.skills);
  if (skillsConfig) config.skills = skillsConfig;
  const skillOverrides = mergeSkillCommandOverrides(
    parsed.skill,
    parseSkillOverridesFromPluralSkills(parsed.skills),
  );
  if (skillOverrides) config.skillOverrides = skillOverrides;
  if (parsed.command) config.commandOverrides = parsed.command;
  if (parsed.logging) config.logging = parsed.logging;
  if (parsed.recording?.conversation) {
    config.recording = { conversation: parsed.recording.conversation };
  }
  if (parsed.ui) config.ui = parsed.ui;
  if (parsed.toolConcurrency) config.toolConcurrency = parsed.toolConcurrency;
  if (parsed.modelAnomalyGuard) config.modelAnomalyGuard = parsed.modelAnomalyGuard;
  if (parsed.hooks) config.hooks = parsed.hooks;

  return config;
}

/**
 * 运行态 plugin 配置归一化：enabledPlugins/options 的 legacy CUA id 迁移到 canonical，
 * suppressedBuiltins 去重并 canonical 化。
 *
 * canonical 已存在时保留新值、删除旧键，避免覆盖用户显式写入；返回新对象，不改入参。
 */
function normalizePluginConfig(
  plugins: ZCodeConfigFile["plugins"],
): NonNullable<RuntimeConfigPatch["plugins"]> {
  if (!plugins) return {};
  const enabledPlugins = plugins.enabledPlugins ? { ...plugins.enabledPlugins } : undefined;
  if (enabledPlugins?.[LEGACY_CUA_PLUGIN_ID] !== undefined) {
    if (enabledPlugins[CANONICAL_CUA_PLUGIN_ID] === undefined) {
      enabledPlugins[CANONICAL_CUA_PLUGIN_ID] = enabledPlugins[LEGACY_CUA_PLUGIN_ID];
    }
    delete enabledPlugins[LEGACY_CUA_PLUGIN_ID];
  }
  const suppressedBuiltins = plugins.suppressedBuiltins
    ? plugins.suppressedBuiltins.reduce<string[]>((ids, id) => {
        const canonicalId = id === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : id;
        if (canonicalId === CANONICAL_CUA_PLUGIN_ID && ids.includes(CANONICAL_CUA_PLUGIN_ID)) {
          return ids;
        }
        ids.push(canonicalId);
        return ids;
      }, [])
    : undefined;
  const options = plugins.options ? { ...plugins.options } : undefined;
  if (options?.[LEGACY_CUA_PLUGIN_ID] !== undefined) {
    if (options[CANONICAL_CUA_PLUGIN_ID] === undefined) {
      options[CANONICAL_CUA_PLUGIN_ID] = options[LEGACY_CUA_PLUGIN_ID];
    }
    delete options[LEGACY_CUA_PLUGIN_ID];
  }
  return {
    ...plugins,
    ...(enabledPlugins ? { enabledPlugins } : {}),
    ...(suppressedBuiltins ? { suppressedBuiltins } : {}),
    ...(options ? { options } : {}),
  };
}

/**
 * 在整份文件校验前，逐个安全校验 MCP server 并剔除非法项。
 *
 * 非对象 servers 整体丢弃（warning）；单 server 失败只丢该 server（warning），
 * 保证 provider/plugin 等其余配置不因一个坏 MCP 条目而全部失效。
 */
// 逐层确认对象形状。
// 缺 servers 直接放行。
// 非法 servers 换成空表。
// servers 逐项交给 mcpServerSchema 校验，失败写入 diagnostics 而不抛错。
// 通过校验的项按原索引写回 servers，保持配置里的顺序。
function normalizeConfigFileInput(value: unknown, diagnostics: ConfigDiagnostic[]): unknown {
  if (!isPlainRecord(value)) return value;

  const root = { ...value };
  const mcp = root.mcp;
  if (!isPlainRecord(mcp)) return root;

  const servers = mcp.servers;
  if (servers === undefined) return root;

  if (!isPlainRecord(servers)) {
    diagnostics.push({
      code: "config_mcp_server_invalid",
      message: "mcp.servers must be a JSON object; ignoring all MCP servers.",
      path: "mcp.servers",
      severity: "warning",
    });
    root.mcp = {
      ...mcp,
      servers: {},
    };
    return root;
  }

  const parsedServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const parsed = mcpServerSchema.safeParse(server);
    if (parsed.success) {
      parsedServers[name] = parsed.data;
      continue;
    }

    // MCP server 是可选工具配置，单个 server 错误不应导致 provider/plugin 等配置丢失。
    diagnostics.push({
      code: "config_mcp_server_invalid",
      message: formatMcpServerError(parsed.error),
      path: `mcp.servers.${name}`,
      severity: "warning",
    });
  }

  root.mcp = {
    ...mcp,
    servers: parsedServers,
  };
  return root;
}

/** 把 MCP server 的 ZodError 压成 `path: message` 列表；空 path 用 <server>。 */
function formatMcpServerError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<server>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** 类型守卫：非数组普通对象（用于跳过非对象/JSON 数组输入）。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读取有限正数；其他值返回 undefined（仅用于兼容旧配置的宽松读取）。 */
function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 抽取 skills 的“全局开关”子字段（enabled/includeInstructions/metadataBudget/roots）。
 *
 * skills schema 使用 catchall 承载逐 skill 开关，因此不能整体透传；这里只挑出已知键，
 * 没有任何键时返回 undefined，避免空对象进入合并结果。
 */
function parseSkillsRuntimeConfig(
  skills: ZCodeConfigFile["skills"],
): RuntimeConfigPatch["skills"] | undefined {
  if (!skills) return undefined;
  const next: NonNullable<RuntimeConfigPatch["skills"]> = {};
  if (skills.enabled !== undefined) next.enabled = skills.enabled;
  if (skills.includeInstructions !== undefined) {
    next.includeInstructions = skills.includeInstructions;
  }
  if (skills.metadataBudget !== undefined) next.metadataBudget = skills.metadataBudget;
  if (skills.roots !== undefined) next.roots = skills.roots;
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * 把 `skills[<绝对路径>] = {enable}` 映射成 skillOverrides。
 *
 * 设置页把单 skill 开关写到这个位置，而 agent 运行态只消费 skillOverrides；在此统一
 * 转换，避免 UI 状态与 agent 实际加载分叉。非绝对路径/非开关形状的键直接跳过。
 */
function parseSkillOverridesFromPluralSkills(
  skills: ZCodeConfigFile["skills"],
): SkillCommandOverrideMap | undefined {
  if (!skills) return undefined;
  const overrides: SkillCommandOverrideMap = {};
  for (const [path, value] of Object.entries(skills)) {
    if (!isAbsoluteConfigPath(path) || !isSkillCommandOverrideValue(value)) {
      continue;
    }
    // 设置页当前把单个 skill 开关写到 skills[SKILL.md 绝对路径]。
    // agent 运行态只消费 skillOverrides，所以这里在配置解析阶段统一映射，避免 UI 状态和 agent 实际加载分叉。
    overrides[path] = { enable: value.enable };
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * 合并多份 skill/command 覆盖表，后者覆盖前者（Object.assign 顺序）。
 * 全部为空时返回 undefined，避免产生空覆盖对象。
 */
function mergeSkillCommandOverrides(
  ...overridesList: Array<SkillCommandOverrideMap | undefined>
): SkillCommandOverrideMap | undefined {
  const merged: SkillCommandOverrideMap = {};
  for (const overrides of overridesList) {
    if (!overrides) continue;
    Object.assign(merged, overrides);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** 校验覆盖值形状：对象且 enable（若存在）为 boolean；缺失 enable 也接受。 */
function isSkillCommandOverrideValue(value: unknown): value is { enable?: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("enable" in value ? typeof (value as { enable?: unknown }).enable === "boolean" : true)
  );
}

/** 判断路径是否为绝对路径：POSIX `/`、Windows `\` 或盘符 `C:/`、`C:\`。 */
function isAbsoluteConfigPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}
