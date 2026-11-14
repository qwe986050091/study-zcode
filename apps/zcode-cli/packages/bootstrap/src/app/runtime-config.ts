// INV-01 合并顺序固定为插件到内建：守住位置 展开顺序；改错故障 同名配置被低优先级覆盖。
// INV-02 内建服务保留身份：守住位置 最后合并；改错故障 用户同名配置劫持内建服务。
// INV-03 自动连接视图与全量视图分开：守住位置 两次构造；改错故障 不可信服务被自动连接。
// INV-04 项目作用域默认全信任：守住位置 空集合；改错故障 正常项目服务被排除。
// INV-05 计算机使用需显式开启：守住位置 布尔判断；改错故障 未开启也注入桥接服务。
// INV-06 桥接服务与官方图片服务分开：守住位置 独立集合；改错故障 截图链路被权限闸门拦下。
// INV-07 恢复会话不补齐失效选择：守住位置 校验分支；改错故障 失效绑定被默认值替换。
// INV-08 空会话不预先绑定模型：守住位置 条件表达式；改错故障 未配置默认即创建失败。
// INV-09 标题生成默认六十秒：守住位置 空值合并；改错故障 慢模型标题长期超时。
// INV-10 标题模型跟随会话选择：守住位置 条件展开；改错故障 切模型后标题仍用旧供应商。
// INV-11 工具面只认显式传入：守住位置 直接取值；改错故障 免审批清单被当成注册面。
// INV-12 工作目录缺失时用会话目录：守住位置 空值合并；改错故障 用户指令缺少工作目录。
// INV-13 记忆身份先修剪：守住位置 字符串修剪；改错故障 空白身份写入配置。
// INV-14 钩子来源逐条补默认：守住位置 映射函数；改错故障 插件钩子缺来源标记。
// INV-15 插件钩子为空时不改动基线：守住位置 全空判断；改错故障 空插件把钩子整体关闭。
// INV-16 钩子合并保留原有顺序：守住位置 展开追加；改错故障 用户钩子被重新排序。
// INV-17 日志上下文不含密钥与正文：守住位置 字段白名单；改错故障 日志泄漏凭据。
// INV-18 日志上下文无副作用：守住位置 纯读取；改错故障 记录日志时改变运行配置。
//
// 模块职责：把配置真相、会话覆盖与装配期注入合并为运行时配置。
// 状态所有权：无状态；全部为纯计算与纯读取。
// 阅读顺序：先看输出结构与合并优先级，再看主合并函数，最后看钩子合并与日志上下文。
import type { ConfigResult } from "@zcode/adapters/config";
import { GEN_UI_OUTPUT_ROOT_ENV } from "@zcode/shared/node";
import { resolveInitialModelSelection, type ModelSelectionOptions } from "@zcode/provider";
import { resolveBashTimeoutPolicy, type AgentProfile, type AgentRuntimeConfig } from "@zcode/core";
import { type BuiltInSubagentModelSelectionOverrides } from "@zcode/shared";
import {
  type CollaborationMode,
  type HookConfigSource,
  type HookEventName,
  type HookMatcherConfig,
  type HooksRuntimeConfig,
  type McpServerConfig,
} from "@zcode/contracts";
import { omitMcpServers, resolveTrustedOfficialCuaServerNames } from "../mcp-config.js";
import { resolveDefaultEmbeddedSearchBackend } from "./embedded-search-backend.js";
import { getProjectMemoryRoot } from "./paths.js";
import type { ZCodeAppOptions } from "./types.js";
import {
  resolveRegistryOwnedModelSelection,
  resolveRegistryModelSelection,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";

/**
 * resolveAppRuntimeConfig 的输出：三层 MCP 合并结果 + 交给 AgentRuntime 的配置 + 不可信集合。
 *
 * `configuredMcpServers` 是全量合并视图（插件 → 用户/项目 → 宿主内建，后者最后且保留
 * identity）；`runtimeConfig.mcp.servers` 是裁剪后的自动连接视图；`untrustedProjectMcpServers`
 * 记录被排除的 project server 名，供状态投影与后续连接判定使用，不是第二份配置真相。
 */
// 三个字段是同一份合并结果的不同投影：configuredMcpServers 全量；runtimeConfig 裁剪；不可信名单另存一份。
// 内建 MCP 服务放在合并链最后，同名配置以宿主内建为准。
// project 作用域默认全信任，untrustedProjectMcpServers 当前恒为空集。
// 三者由 resolveAppRuntimeConfig 一次性返回，不暴露单独的 getter。
interface ResolvedAppRuntimeConfig {
  /** 全量合并后的 MCP 配置（宿主内建最后合并，避免同名劫持）。 */
  configuredMcpServers: Record<string, McpServerConfig>;
  /** 真正交给 runtime 的配置；`mcp.servers` 已剔除不自动连接的项。 */
  runtimeConfig: AgentRuntimeConfig;
  /** 不参与自动连接的 server 名（当前产品决定 project 作用域默认全信任，故为空集）。 */
  untrustedProjectMcpServers: Set<string>;
}

/** 初始 Registry 选择 + 用户原始 options（用于把保存意图原样带到执行侧，不被归一化抹掉）。 */
interface ResolvedInitialRegistrySelection extends ResolvedRegistrySelection {
  readonly selectionOptions?: ModelSelectionOptions;
}

/**
 * 把配置真相（ConfigResult）、会话级覆盖（ZCodeAppOptions.runtimeConfig）与装配期注入
 * （插件 MCP / hooks / 子代理 profile / 内建 server）合并成一份 AgentRuntimeConfig。
 *
 * 顺序与优先级：
 *   1. MCP：插件 → 用户/项目配置 → 宿主内建（内建最后合并并保留 identity）；project 作用域
 *      全信任，`untrustedProjectMcpServers` 当前为空；
 *   2. 模型：Registry 解析出来的绑定优先于 configured default；resume 时失效选择保持“未绑定”，
 *      不借默认补齐；空会话也不强制选 Registry 首项，等本次 Submission 再绑定；
 *   3. hooks：用户/内部 hooks 在前，插件 hooks 追加在后；
 *   4. 子代理 profile / 内建模型覆盖：注入项在前，会话覆盖在后合并。
 * 副作用：纯计算，不读文件、不建连接；MCP 连接与工具目录由 runtime 侧按需建立。
 */
// 输入分三部分：ConfigResult 是配置真相；options.runtimeConfig 是会话覆盖；其余参数是装配期注入。
// 模型选择按 resume 语义取：失效绑定保持未绑定，不借默认值补齐。
// hooks 的合并顺序是用户/内部在前、插件追加在后。
// 纯计算：不读文件也不建连接，MCP 连接留给 runtime 按需建立。
export function resolveAppRuntimeConfig(input: {
  cliStorageRoot: string;
  configResult: ConfigResult;
  options: ZCodeAppOptions;
  persistedMode?: CollaborationMode;
  builtInMcpServers?: Record<string, McpServerConfig>;
  builtInSubagentModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  pluginHooks?: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  pluginMcpServers?: Record<string, McpServerConfig>;
  pluginRuntimeFeatures?: AgentRuntimeConfig["runtimeFeatures"];
  subagentOutputRootDir: string;
  subagentProfiles?: readonly AgentProfile[];
  storageRoot?: string;
  workingDirectory: string;
  workspaceIdentity?: string;
}): ResolvedAppRuntimeConfig {
  const {
    cliStorageRoot,
    configResult,
    options,
    persistedMode,
    builtInMcpServers,
    pluginMcpServers,
    pluginRuntimeFeatures,
    subagentOutputRootDir,
    subagentProfiles = [],
    workingDirectory,
    workspaceIdentity,
  } = input;
  const userInstructions = options.runtimeConfig?.userInstructions ?? { workingDirectory };
  const registrySelection = resolveInitialRegistrySelection(options);
  // 恢复历史不等于开始执行：失效/缺失选择保持未绑定，不能借 configured default 补齐。
  const initialModelSelection = options.resume
    ? registrySelection?.selection
    : (options.runtimeConfig?.modelSelection ?? registrySelection?.selection);
  // 空白会话先创建、再应用本次 Submission 的选择；强制初始默认模型会
  // 让未配置 default 的用户在 switch/send 前就创建失败。未绑定 Runtime 可以存在，
  // 真正执行仍由 admission/ModelFactory 校验完整选择，不能在这里偷偷选择 Registry 首项。
  const requestedTitleGeneration = options.runtimeConfig?.titleGeneration;
  const requestedTitleModelSelection = requestedTitleGeneration?.modelSelection;
  const titleGeneration =
    requestedTitleGeneration === undefined
      ? undefined
      : {
          ...requestedTitleGeneration,
          // 标题生成 sidecar 默认 15s 在慢模型/代理链路下容易超时，
          // 入口层统一补 60s，避免旧 core 默认值或空配置让桌面端继续回落到 15s。
          timeoutMs: requestedTitleGeneration.timeoutMs ?? 60_000,
          // 空 titleGeneration 表示启用默认标题生成，模型必须跟随会话当前模型。
          // 如果这里在草稿 session 创建时固化另一份标题模型，之后切模型只会更新主链路，
          // 首发时的 generate title sidecar 会继续使用切换前的旧 provider/model。
          ...(requestedTitleModelSelection
            ? {
                modelSelection: requestedTitleModelSelection,
              }
            : {}),
        };
  // Protocol session/create 传入的 mcp.servers 只包含 UI MCP 设置里的用户配置，
  // 不包含插件注册的 MCP。宿主内建 server 最后合并并保留其 identity，避免用户或第三方
  // 用同名配置劫持 mcp__node_repl__*；普通 plugin MCP 仍允许显式用户配置覆盖。
  const configuredMcpServers = {
    ...pluginMcpServers,
    ...(options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers),
    ...builtInMcpServers,
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginMcpServers ?? {},
  );
  const cuaBridgeServerNames = new Set(trustedOfficialCuaServerNames);
  if (pluginRuntimeFeatures?.computerUse === true && configuredMcpServers.node_repl) {
    // node_repl 需要 broker 注入，但不是 CUA MCP server。注入资格与官方 CUA 图片
    // authority 必须分开；把它塞进 trustedOfficialCuaServerNames 会让整个
    // 通用 node_repl 结果被误送进 exact-raster gate，Browser 截图和 console 日志都会失败。
    cuaBridgeServerNames.add("node_repl");
  }
  // 产品决定 workspace MCP 开箱即用：project 作用域 MCP 默认 trusted，并自动连接。
  const untrustedProjectMcpServers = new Set<string>();
  const autoConnectMcpServers = omitMcpServers(
    configuredMcpServers,
    untrustedProjectMcpServers,
    cuaBridgeServerNames,
  );
  const runtimeBuiltInModelSelectionOverrides =
    options.runtimeConfig?.subagents?.builtInModelSelectionOverrides ?? {};
  const runtimeConfig: AgentRuntimeConfig = {
    ...options.runtimeConfig,
    genUiOutputRoot: (options.env ?? process.env)[GEN_UI_OUTPUT_ROOT_ENV],
    bashTimeoutPolicy:
      options.runtimeConfig?.bashTimeoutPolicy ??
      resolveBashTimeoutPolicy(options.env ?? process.env),
    mode: options.runtimeConfig?.mode ?? persistedMode ?? configResult.config.permission.mode,
    modelSelection: initialModelSelection,
    // 仅接受显式传入的会话级工具面（ZCode Protocol session/create 或 CLI
    // --allowed-tools/--disallowed-tools）。不要从 config.permission.allowedTools
    // 回落：那个键的既有语义是“免审批清单”，把它投影到注册面会让老配置里
    // 只写了几个 allowedTools 的用户突然丢失其余全部工具。
    toolAllowlist: options.runtimeConfig?.toolAllowlist,
    toolDisallowlist: options.runtimeConfig?.toolDisallowlist,
    embeddedSearchBackend:
      options.runtimeConfig?.embeddedSearchBackend ??
      resolveDefaultEmbeddedSearchBackend({
        env: options.env,
      }),
    runtimeFeatures: pluginRuntimeFeatures,
    language: options.runtimeConfig?.language,
    titleGeneration,
    workingDirectory,
    additionalDirectories: options.additionalDirectories,
    userInstructions: {
      ...userInstructions,
      workingDirectory: userInstructions.workingDirectory ?? workingDirectory,
    },
    skillMetadataBudget:
      options.runtimeConfig?.skillMetadataBudget ?? configResult.config.skills.metadataBudget,
    toolConcurrency: {
      maxConcurrency:
        options.runtimeConfig?.toolConcurrency?.maxConcurrency ??
        configResult.config.toolConcurrency.maxConcurrency,
    },
    modelAnomalyGuard: {
      ...configResult.config.modelAnomalyGuard,
      ...options.runtimeConfig?.modelAnomalyGuard,
    },
    mcp: {
      enabled: options.runtimeConfig?.mcp?.enabled ?? configResult.config.features.mcp,
      servers: autoConnectMcpServers,
      trustedOfficialCuaServerNames: [...trustedOfficialCuaServerNames],
    },
    hooks: mergeRuntimeHooks(
      options.runtimeConfig?.hooks
        ? withHookConfigSource(options.runtimeConfig.hooks, { kind: "internal" })
        : configResult.config.hooks,
      input.pluginHooks,
    ),
    subagents: {
      ...options.runtimeConfig?.subagents,
      enabled: options.runtimeConfig?.subagents?.enabled ?? configResult.config.features.subagent,
      outputRootDir: options.runtimeConfig?.subagents?.outputRootDir ?? subagentOutputRootDir,
      builtInModelSelectionOverrides: {
        ...(input.builtInSubagentModelSelectionOverrides ?? {}),
        ...runtimeBuiltInModelSelectionOverrides,
      },
      profiles: [...(options.runtimeConfig?.subagents?.profiles ?? []), ...subagentProfiles],
    },
    memory: {
      cliStorageRoot,
      enabled: options.runtimeConfig?.memory?.enabled ?? configResult.config.features.memory,
      ...(options.runtimeConfig?.memory?.extractionEnabled === undefined
        ? {}
        : { extractionEnabled: options.runtimeConfig.memory.extractionEnabled }),
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
      use: options.runtimeConfig?.memory?.use ?? configResult.config.memory.use,
      workspaceIdentity: workspaceIdentity?.trim() || undefined,
    },
  };
  return {
    configuredMcpServers,
    runtimeConfig,
    untrustedProjectMcpServers,
  };
}

function withHookConfigSource(
  config: HooksRuntimeConfig,
  source: HookConfigSource,
): HooksRuntimeConfig {
  return {
    ...config,
    events: Object.fromEntries(
      Object.entries(config.events).map(([eventName, matchers]) => [
        eventName,
        matchers?.map((matcher) => ({
          ...matcher,
          hooks: matcher.hooks.map((hook) => ({ ...hook, source: hook.source ?? source })),
        })),
      ]),
    ) as HooksRuntimeConfig["events"],
  };
}

function resolveInitialRegistrySelection(
  options: ZCodeAppOptions,
): ResolvedInitialRegistrySelection | undefined {
  const registry = options.providerRegistry;
  if (!registry) return undefined;

  if (options.runtimeConfig?.modelSelection) {
    const selection = options.runtimeConfig.modelSelection;
    if (options.resume && !registry.validateSelection(selection).ok) return undefined;
    const resolved = resolveRegistryOwnedModelSelection(registry, selection);
    return resolved
      ? {
          ...resolved,
          ...(selection.options ? { selectionOptions: selection.options } : {}),
        }
      : undefined;
  }

  if (options.resume) return undefined;
  const initial = resolveInitialModelSelection({
    configuredDefault: options.configuredDefaultModelSelection,
    registry: registry.getView(),
  });
  if (initial.source === "none") return undefined;
  const resolved = resolveRegistryOwnedModelSelection(registry, initial.selection);
  return resolved
    ? {
        ...resolved,
        ...(initial.selection.options ? { selectionOptions: initial.selection.options } : {}),
      }
    : undefined;
}

function mergeRuntimeHooks(
  base: HooksRuntimeConfig | undefined,
  pluginHooks: Partial<Record<HookEventName, HookMatcherConfig[]>> | undefined,
): HooksRuntimeConfig | undefined {
  if (!pluginHooks || Object.values(pluginHooks).every((matchers) => !matchers?.length)) {
    return base;
  }

  const mergedEvents: HooksRuntimeConfig["events"] = {
    ...base?.events,
  };
  for (const [eventName, matchers] of Object.entries(pluginHooks) as Array<
    [HookEventName, HookMatcherConfig[]]
  >) {
    if (matchers.length === 0) continue;
    mergedEvents[eventName] = [...(mergedEvents[eventName] ?? []), ...matchers];
  }

  return {
    enabled: true,
    events: mergedEvents,
    maxOutputBytes: base?.maxOutputBytes ?? 32768,
    timeoutMs: base?.timeoutMs ?? 60000,
  };
}

/**
 * runtime 配置的结构化日志上下文：只输出布尔 / 计数 / 模式与 memory 根，不含密钥与完整内容。
 *
 * 输入是最终 AgentRuntimeConfig 与业务 cwd；memoryRoot 用 `workspaceIdentity?.trim() ||
 * workingDirectory` 的口径解析（identity 管隔离，path 管文件）。
 * 返回对象可直接作为 logger 的合并字段；无副作用。
 */
// 输出开关布尔与模式/模型标识；memoryRoot 与 cwd 只给解析后的值，不带密钥。
// model 字段由 providerId 与 modelId 用斜杠拼成，未选模型时为 undefined。
// memoryRoot 先看 workspaceIdentity，为空才回退 workingDirectory。
export function runtimeConfigLogContext(
  runtimeConfig: AgentRuntimeConfig,
  workingDirectory: string,
) {
  const memoryRoot = runtimeConfig.memory?.cliStorageRoot
    ? getProjectMemoryRoot(
        runtimeConfig.memory.cliStorageRoot,
        workingDirectory,
        runtimeConfig.memory.workspaceIdentity,
      )
    : undefined;
  return {
    mcpEnabled: runtimeConfig.mcp?.enabled !== false,
    memoryEnabled: runtimeConfig.memory?.enabled !== false,
    memoryExtractionEnabled: runtimeConfig.memory?.extractionEnabled !== false,
    memoryRoot,
    memoryUse: runtimeConfig.memory?.use !== false,
    mcsMode: runtimeConfig.midConversationSystem?.mode,
    mode: runtimeConfig.mode,
    model: runtimeConfig.modelSelection
      ? `${runtimeConfig.modelSelection.providerId}/${runtimeConfig.modelSelection.modelId}`
      : undefined,
    runtimeFeatureBrowserUse: runtimeConfig.runtimeFeatures?.browserUse === true,
    runtimeFeatureNodeRepl: runtimeConfig.runtimeFeatures?.nodeRepl === true,
    workingDirectory,
  };
}
