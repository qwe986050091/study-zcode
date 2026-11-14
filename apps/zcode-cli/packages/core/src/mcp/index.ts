// MCP tool bridge - projects MCP descriptors into core tool entries

// 本文件是 MCP 工具桥接层：把 McpPort 上报的 McpToolDescriptor 投影为 core 可注册的 ToolEntry。
// 负责名称投影、权限/风险/副作用声明、超时与结果预算、结果格式化为模型内容。
// 不负责：MCP 连接与握手、工具发现、审批 UI、图片落盘（由 mcpPort、registry、image-normalization 承担）。
//
// INV-01 断言：官方 CUA 的规范名只在不可伪造 authority 门成立后投影 —— 守住它的位置：toRegisteredMcpToolName 的官方分支 —— 改错故障：第三方同名 server 冒充官方，权限组被错误放宽。
// INV-02 断言：规则校验同时看新名与 descriptor 原名 —— 守住它的位置：registerMcpTools 的 allow/deny 判断 —— 改错故障：升级前保存的 namespaced denylist 静默失效并放行。
// INV-03 断言：providerVisible 由 resolveMcpToolVisibility 的 model 通道决定 —— 守住它的位置：createMcpToolEntry 的 providerVisible —— 改错故障：app-only 工具进入 provider contracts，模型可直接调用。
// INV-04 断言：宿主 node_repl 的 js 恒为 high/system —— 守住它的位置：isHostNodeReplExecution 与其下游 riskLevel —— 改错故障：文件与进程能力被描述成普通网络调用。
// INV-05 断言：MCP 的 needsApproval 恒为 true，且 timeout.allowCallOverride 恒 false —— 守住它的位置：permission 与 timeout 字段 —— 改错故障：调用方可自行延长超时或绕过审批。
// INV-06 断言：官方 CUA 的 resultBudget 为 256 KiB 文本且策略 truncate —— 守住它的位置：resultBudget 三元分支 —— 改错故障：结构化 image/image_ref 被压成字符串或顺序被打乱。
// INV-07 断言：官方 CUA 结果必须带 modelContentProtection —— 守住它的位置：permissionCapabilityGroup 同段的展开对象 —— 改错故障：帧与 image_ref 被通用截断剥离，模型坐标系失真。
// INV-08 断言：provider 拼写别名只在规范前缀命中时挂载且单向 —— 守住它的位置：officialCuaProviderSpellingAliases —— 改错故障：精确查找返回 Tool not found，或别名反向污染规范名。
// INV-09 断言：title 只加在模型可见 schema，dispatch 前必须剥离 —— 守住它的位置：createModelFacingMcpInputSchema 与 toMcpRuntimeArguments —— 改错故障：上游 zcode-cua 严格 schema 校验失败。
// INV-10 断言：title 仅在 get_app_state 且 server 名匹配 CUA 特征时注入 —— 守住它的位置：isZCodeCuaGetAppState —— 改错故障：无关 MCP 工具被强加必填字段，调用全线报错。
// INV-11 断言：空 structuredContent 不得追加伪造文本块 —— 守住它的位置：hasInformativeStructuredContent 门 —— 改错故障：模型收到空 Structured content 噪声，错误详情被掩盖。
// INV-12 断言：isError 的包装与否只由 _meta 显式声明决定 —— 守住它的位置：formatMcpToolResult 尾部 —— 改错故障：message-only 错误被二次包裹，堆栈猜测式解析回归。
// INV-13 断言：非文本块存在时不折叠为字符串 —— 守住它的位置：collapseModelBlocks 的全文本判断 —— 改错故障：图片 dataUrl 被 join 成乱码文本。
// INV-14 断言：base64 大小估算在去掉 padding 后按 3/4 计算 —— 守住它的位置：estimateBase64Bytes —— 改错故障：体积判断偏移，占位与预算失衡。
// INV-15 断言：block 顺序即模型看到的分块顺序 —— 守住它的位置：formatContentBlock 的 flatMap —— 改错故障：CUA 帧与 image_ref 错位。
// INV-16 断言：workspaceIdentity 存在时同时作为 workspaceKey —— 守住它的位置：handler 内的 mcpPort.callTool 参数 —— 改错故障：远程会话按路径串味，跨 workspace 命中缓存。
// INV-17 断言：进度事件必须携带 traceId 与 turnId —— 守住它的位置：createMcpProgressEvent —— 改错故障：进度无法归位到会话时间线。
// INV-18 断言：stringify 失败时降级为字符串而非抛出 —— 守住它的位置：stringify 的 catch —— 改错故障：循环引用导致整条工具结果丢失。
//
// 阅读顺序：registerMcpTools（准入） → createMcpToolEntry（契约） → handler（执行） → formatMcpToolResult（回灌）。
// 变更提示：调整名称、预算或权限字段前，先对照 docs/design/v2/tool 的链路文档。
// 变更提示：官方 CUA 分支依赖不可伪造 authority，禁止用名称 wildcard 替代。
// 变更提示：新增 block 类型时同步 formatContentBlock 与 resultBudget 的字节口径。
// 变更提示：任何截断策略调整都要同时验证 CUA 帧保护与 node_repl artifact 落地。
// 版本口径：MCP_TOOL_TIMEOUT_MS 只是缺省值，descriptor.timeoutMs 优先级更高。
// 命名口径：模型可见名与 runtime 路由名分离，任何一处漂移都会导致查找失败。
import {
  modelMessageContentToText,
  resolveMcpToolVisibility,
  SessionEventType,
  ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
  ZCODE_MCP_ERROR_PRESENTATION_META_KEY,
  type JsonSchema,
  type McpPort,
  type McpToolCallResult,
  type McpToolDescriptor,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type ModelToolSideEffectScope,
  type PermissionCapabilityGroup,
  type RiskLevel,
  type SessionEvent,
  type ToolCallProgressPayload,
} from "@zcode/contracts";
import { ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME as ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME } from "@zcode/shared";
import { OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION } from "@zcode/zcode-cua/frame-contract";
import { randomUUID } from "node:crypto";
import type { ToolRegistry } from "../tool/registry.js";
import { createToolRuleNameSet } from "../tool/tool-visibility.js";
import type { ToolEntry } from "../tool/types.js";
import {
  asDataUrl,
  base64PayloadFromMcpImageData,
  normalizeMcpToolResultForModel,
} from "./image-normalization.js";
import { toMcpToolName, toModelVisibleMcpNamePart } from "./name.js";

export {
  createMcpAppProvidedToolEntry,
  MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS,
  type McpAppProvidedToolDefinition,
  type McpAppProvidedToolExecutor,
} from "./app-tools.js";
export { toMcpToolName } from "./name.js";

export {
  HOST_NODE_REPL_IMAGE_MAX_DIMENSION,
  MCP_IMAGE_INLINE_BASE64_BYTES,
  MCP_IMAGE_INLINE_RAW_BYTES,
} from "./image-normalization.js";

// 30 秒是 MCP 调用的兜底上限，descriptor 自带 timeoutMs 时以 descriptor 为准。
// 取值偏小时慢 server（浏览器抓取、CUA 截图链）会被误判超时，UI 表现为工具中途终止。
// 取值偏大时取消与超时两条路径都变慢，用户长时间看不到失败反馈。
// 该常量只做默认值，不在 handler 内按结果大小动态放宽。
const MCP_TOOL_TIMEOUT_MS = 30_000;
const OFFICIAL_CUA_PERMISSION_CAPABILITY_GROUP = "official_cua" satisfies PermissionCapabilityGroup;
const CUA_USER_TITLE_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  description:
    "Required short user-facing title in the user's language that describes why the app interface is being read without implementation terms such as CUA, MCP, or get_app_state",
} satisfies JsonSchema;
const ZCODE_CUA_CANONICAL_MODEL_PREFIX = "mcp__computer-use__";
const ZCODE_CUA_PROVIDER_SPELLING_ALIAS_PREFIX = "mcp__computer_use__";

// 注册选项全部来自 session 冻结配置，注册阶段只读，不回写任何字段。
// officialCuaServerNames 只能由 runtime 用不可伪造凭据验明后传入。
// 该字段缺失即 fail-closed，所有 MCP 一律按普通工具处理。
// pluginIdByServerName 仅用于 display.ui 归属投影，不参与权限判定。
export interface RegisterMcpToolsOptions {
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /**
   * 由 runtime 使用不可伪造的 product authority 凭据验明的官方 CUA server。
   * 名称本身不构成信任；省略时 fail-closed，所有 MCP 都按普通工具处理，
   * 不投影官方 CUA 规范名，也不挂载 provider 拼写别名。
   */
  officialCuaServerNames?: ReadonlySet<string>;
  /**
   * namespaced server 名 → 插件稳定 id，来自 session 冻结的 PluginReferenceCatalog。
   * 只用于 display.ui 的归属投影；缺失时该 server 的工具不投影 UI。
   */
  pluginIdByServerName?: ReadonlyMap<string, string>;
}

// [契约] 返回值是实际注册成功的名称列表，调用方据此判断工具是否可用。
// 被 allow/deny 过滤掉的 descriptor 不注册也不报错，静默跳过是既定契约。
// registry.register 在循环内逐条执行，中途抛错会让已注册条目残留。
export function registerMcpTools(
  registry: ToolRegistry,
  mcpPort: McpPort,
  descriptors: readonly McpToolDescriptor[],
  options: RegisterMcpToolsOptions = {},
): string[] {
  const allowed = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowed = createToolRuleNameSet(options.disallowedTools);
  const registered: string[] = [];

  // 循环按 descriptor 原始顺序注册，顺序影响模型侧工具清单的稳定排序。
  // 同一 server 内重名工具会覆盖前一条，这里不做去重保护。
  // descriptors 为只读入参，禁止在循环内原地排序或改写。
  for (const descriptor of descriptors) {
    const officialCuaAuthorityVerified =
      options.officialCuaServerNames?.has(descriptor.serverName) === true;
    const descriptorName = toMcpToolName(descriptor);
    const name = toRegisteredMcpToolName(descriptor, officialCuaAuthorityVerified);
    // [权衡] 双名检查是为了兼容升级前落盘的 namespaced 规则记录。
    // allow 语义是「任一名称命中即接受」，与 deny 的「任一命中即拒绝」并不对称。
    // 若简化成先算一个规范名再比较，历史 deny 记录会整体落到别名之外而失效。
    // 后续修改规则存储格式时，必须同步这里的双名查询口径。
    // 官方 CUA 投影模型主名后，如果只按新名检查规则，升级前保存的 namespaced
    // denylist 会静默失效并放行。新旧名称任一命中 deny 即拒绝，任一命中 allow 即接受。
    if (allowed && !allowed.has(name) && !allowed.has(descriptorName)) continue;
    if (disallowed?.has(name) || disallowed?.has(descriptorName)) continue;
    registry.register(
      createMcpToolEntry(name, descriptor, mcpPort, officialCuaAuthorityVerified, {
        pluginId: options.pluginIdByServerName?.get(descriptor.serverName),
      }),
    );
    registered.push(name);
  }

  return registered;
}

// 命名分成两条路：可信官方 CUA 投影 provider 约定的规范名，其余走 adapter 原名。
// 规范名固定 mcp__computer-use__ 前缀，工具段再经 toModelVisibleMcpNamePart 归一。
// 返回值只影响模型可见名称，handler 仍用 descriptor 的原 server/tool 路由。
// 一旦对未验明 authority 的 server 走这条分支，等于把官方权限组白送出去。
function toRegisteredMcpToolName(
  descriptor: McpToolDescriptor,
  officialCuaAuthorityVerified: boolean,
): string {
  if (
    officialCuaAuthorityVerified &&
    descriptor.serverName === ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME
  ) {
    // adapter 会把官方插件 serverName 命名空间化，descriptor.name 因而是
    // mcp__plugin_zcode-cua_computer-use__*；直接沿用它会让 provider 约定的 computer-use
    // 工具永远不存在。可信门成立后仅投影模型可见名称，handler 仍用 descriptor 的原路由。
    return `${ZCODE_CUA_CANONICAL_MODEL_PREFIX}${toModelVisibleMcpNamePart(descriptor.toolName)}`;
  }
  return toMcpToolName(descriptor);
}

export function createMcpToolEntry(
  name: string,
  descriptor: McpToolDescriptor,
  mcpPort: McpPort,
  officialCuaAuthorityVerified: boolean,
  presentation: { pluginId?: string } = {},
): ToolEntry {
  // readOnlyHint 决定并发安全与风险等级，缺失时按可写处理，不能当成只读。
  // destructiveHint 优先级高于 readOnly，两个都缺时落到 medium。
  // 这两个 hint 由外部 server 自报，只能用于风险展示，不能当作安全边界。
  const readOnly = descriptor.annotations?.readOnlyHint === true;
  const destructive = descriptor.annotations?.destructiveHint === true;
  // 插件 UI：visibility 不含 "model" 的工具只供 UI 回调（mcp/uiCallTool），
  // 仍进 registry 以复用元数据，但不进 provider contracts（registry.toContracts 已过滤 providerVisible=false）。
  // 修复：之前只看 ui.visibility，没有 resourceUri 的 app-only 数据工具会被当成模型可见。
  // [契约] visibility 含 model 才进 provider contracts，仅 ui 的工具只供 UI 回调。
  // app-only 且无 resourceUri 的数据工具历次回归都出在这里，判断必须走统一函数。
  // 不可见时仍要注册，registry 需要元数据支撑 mcp/uiCallTool 的回调路由。
  // 这里写成 false 已足够，下游依据 providerVisible=false 统一过滤。
  const providerVisible = resolveMcpToolVisibility(descriptor).includes("model");
  const isHostNodeReplExecution =
    descriptor.serverName === "node_repl" && descriptor.toolName === "js";
  const isCuaAppObservation = isZCodeCuaGetAppState(descriptor);
  // 宿主 node_repl 的 js 能执行本机 Node 代码，不能沿用普通未知 MCP 的 medium/network
  // 默认值；否则权限 UI 会把文件/进程级能力错误描述成普通网络调用。
  // [契约] 宿主 node_repl 的 js 直接跑本机 Node，副作用范围必须是 system。
  // 其余 MCP 一律按 network，即便实际能写文件也不在这里升级。
  // 与 riskLevel 必须成对修改，两处不一致会让权限 UI 与审批文案互相矛盾。
  // 该判断只认 serverName 与 toolName 的精确组合，不做前缀匹配。
  const sideEffectScope: ModelToolSideEffectScope = isHostNodeReplExecution ? "system" : "network";
  const riskLevel: RiskLevel = isHostNodeReplExecution
    ? "high"
    : destructive
      ? "high"
      : readOnly
        ? "low"
        : "medium";
  const needsApproval = true;
  const timeoutMs = descriptor.timeoutMs ?? MCP_TOOL_TIMEOUT_MS;
  // [权衡] 官方 CUA 给 256 KiB 文本空间，是为了容纳整棵界面树而不被通用截断。
  // truncate 而非 artifact：CUA 结果必须留在上下文里，落盘会破坏帧与 image_ref 的邻接。
  // 普通 MCP 保持 100 KiB 内联、50 KiB 模型字节，超额按头部截断。
  // node_repl 走 artifact 加尾部预览，只把 64 KiB 摘要回灌，完整输出留在 session。
  const resultBudget = officialCuaAuthorityVerified
    ? {
        // 图片 block 的 base64 不计入模型文本预算，但树文本仍可能超过普通 MCP 的
        // 50 KiB。这里给官方 CUA 足够的有界文本空间，避免通用截断把结构化
        // image/image_ref 退化成纯字符串或改变相邻顺序。
        maxInlineBytes: 256 * 1024,
        maxModelBytes: 256 * 1024,
        strategy: "truncate" as const,
        preview: { direction: "head" as const },
      }
    : isHostNodeReplExecution
      ? {
          maxInlineBytes: 1_000_000,
          maxModelBytes: 64 * 1024,
          strategy: "artifact" as const,
          preview: { direction: "tail" as const, maxBytes: 64 * 1024 },
          artifact: { enabled: true, retention: "session" as const },
        }
      : {
          maxInlineBytes: 100_000,
          maxModelBytes: 50_000,
          strategy: "truncate" as const,
          preview: { direction: "head" as const },
        };

  // 下面这个对象是 ToolEntry 的唯一契约出口，字段分别被权限、取消、trace 与 UI 消费。
  // aliases 只在官方 CUA 门成立时出现，未成立时保持 undefined 而不是空数组。
  // permissionCapabilityGroup 与 modelContentProtection 必须同生同灭，不能只展开其一。
  // metadata.mcpPresentation 是 UI 展示口径，缺 description 时下游会退回工具名。
  return {
    // 因精确查找直接返回 Tool not found。只在不可伪造的官方 authority 门成立且内部
    // serverName 仍是官方 namespaced 名时挂单向别名；provider 继续只看规范名称。
    aliases: officialCuaProviderSpellingAliases(name, descriptor, officialCuaAuthorityVerified),
    capability: `MCP tool exposed by ${descriptor.serverName}: ${descriptor.toolName}`,
    // 项目级 CUA 授权只能复用不可伪造的 official authority gate。
    // server/tool 名可以被第三方仿冒，因此绝不能用名称 wildcard 表达这一权限。
    ...(officialCuaAuthorityVerified
      ? {
          permissionCapabilityGroup: OFFICIAL_CUA_PERMISSION_CAPABILITY_GROUP,
          // 最终栅格和紧随其后的 image_ref 共同定义模型唯一可用的像素坐标系。
          // modelContentProtection 是唯一 Host authority；通用 resultBudget / hook
          // 投影据此不能截断、丢弃或重排这组块，避免并行 boolean 漂移。
          modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
        }
      : {}),
    inputSchema: createModelFacingMcpInputSchema(descriptor, isCuaAppObservation),
    outputSchema: McpToolOutputJsonSchema,
    metadata: {
      shouldDefer: true,
      alwaysLoad: descriptor.alwaysLoad,
      searchHint: descriptor.searchHint,
      concurrentSafe: readOnly || descriptor.annotations?.idempotentHint === true,
      destructive,
      // 必须把 MCP tool 的 description 透传到 metadata，让 registry 把它带进模型输入，
      // 否则模型侧只看到 name + inputSchema，调用 MCP 工具时缺乏判断依据。
      description: descriptor.description,
      name,
      mcpPresentation: {
        serverName: descriptor.serverName,
        toolName: descriptor.toolName,
        ...(descriptor.description ? { description: descriptor.description } : {}),
        // 只有官方 MCP 的结果才允许携带被客户端信任的结构化标识（额度耗尽 / 无套餐）。
        ...(descriptor.official ? { official: true } : {}),
        ...(presentation.pluginId ? { pluginId: presentation.pluginId } : {}),
        ...(descriptor.ui ? { ui: descriptor.ui } : {}),
      },
      needsApproval,
      ...(providerVisible ? {} : { providerVisible: false }),
      readOnly,
      riskLevel,
      sideEffectScope,
      timeoutMs,
    },
    permission: {
      permission: "mcp",
      reason: `MCP tool ${descriptor.serverName}/${descriptor.toolName} executes through an external server`,
      riskLevel,
      sideEffectScope,
      needsApproval,
      patternSources: ["toolName", "input", "network"],
      denyPriority: "beforeAsk",
    },
    resultBudget,
    timeout: {
      defaultMs: timeoutMs,
      allowCallOverride: false,
    },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: `MCP tool ${name} was cancelled`,
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
    // [资源] handler 内不做重试，重试由上层 runtime 与 provider 侧策略承担。
    // 每次调用现算 startedAt，进度事件的 elapsedMs 以此为基准。
    // input 是模型给的原始参数，尚未经过 title 等追加字段的剥离。
    // 抛出的错误原样上抛，由调用层统一转成用户可见提示。
    handler: async (input, context) => {
      const startedAt = Date.now();
      // [并发] 单次调用只透传 context 的 abortSignal，不额外建超时计时器。
      // timeoutMs 同时写进 ToolEntry.timeout 与本次调用参数，两处必须一致。
      // workspaceIdentity 存在时同时作为 workspaceKey，避免远程会话按路径串味。
      const result = await mcpPort.callTool(
        {
          serverName: descriptor.serverName,
          toolName: descriptor.toolName,
          arguments: toMcpRuntimeArguments(input, isCuaAppObservation),
          trace: {
            traceId: context.traceId,
            spanId: context.spanId,
            parentSpanId: context.parentSpanId,
            sessionId: context.sessionId,
            turnId: context.turnId,
          },
          runtimeScope: context.runtimeScope ?? "main",
          workspacePath: context.workingDirectory,
          ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
          ...(context.workspaceIdentity?.trim()
            ? {
                workspaceIdentity: context.workspaceIdentity.trim(),
                workspaceKey: context.workspaceIdentity.trim(),
              }
            : { workspaceKey: context.workingDirectory }),
          ...(context.turnId ? { turnId: context.turnId } : {}),
          clientMode: context.clientMode ?? "desktop-continuous",
          deliveryKind: context.deliveryKind ?? "desktop-continuous",
        },
        {
          signal: context.abortSignal,
          timeoutMs,
          // [并发] 进度回调经 emitEvent 走 session 事件通道，与工具行进度共用同一 UI 路径。
          // 回调内不 await、不阻塞 mcpPort 的响应流，避免慢 UI 反压 server。
          // context.emitEvent 缺失（非流式或测试场景）时整段不挂 onProgress。
          // MCP 进度通知（A8）→ ToolCallProgress：与 Bash 输出进度同一事件，UI 走已有工具行进度路径。
          ...(context.emitEvent
            ? {
                onProgress: (progress: { progress: number; total?: number; message?: string }) => {
                  void context.emitEvent?.(
                    createMcpProgressEvent(context, name, startedAt, progress),
                  );
                },
              }
            : {}),
        },
      );
      // [失败路径] 超大图片只能在这里拦截，resultBudget 看到的只是占位文本而非真实体积。
      // 官方 CUA 结果必须 preserveOfficialCuaFrames，先保住帧再谈压缩。
      // node_repl 允许压缩超大图片，其余场景保留原始 base64 以免破坏可复现性。
      // 归一化失败不能吞掉，否则模型会收到裸 base64 文本。
      // MCP server 会返回大 base64 图片；resultBudget 只看到图片占位文本，
      // 必须在 handler 阶段保存副本并替换模型可见内容，避免 provider 请求体被打爆。
      return normalizeMcpToolResultForModel({
        compressOversizedImages: isHostNodeReplExecution,
        context,
        descriptor,
        preserveOfficialCuaFrames: officialCuaAuthorityVerified,
        result,
        toolName: name,
      });
    },
    formatModelContent: (output) => formatMcpToolResult(output),
  };
}

function createMcpProgressEvent(
  context: Parameters<ToolEntry["handler"]>[1],
  toolName: string,
  startedAt: number,
  progress: { progress: number; total?: number; message?: string },
): SessionEvent {
  const payload: ToolCallProgressPayload = {
    toolCallId: context.toolCallId as ToolCallProgressPayload["toolCallId"],
    toolName,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    progress: progress.progress,
    ...(progress.total !== undefined ? { total: progress.total } : {}),
    ...(progress.message !== undefined ? { message: progress.message } : {}),
  };
  return {
    id: randomUUID() as SessionEvent["id"],
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: new Date(),
    traceId: context.traceId,
    sequenceNumber: 0,
    payload,
  };
}

// 别名是单向的：注册 mcp__computer_use__ 拼写，规范名仍是 mcp__computer-use__。
// 只在规范前缀命中时生成，避免对普通 mcp 名称误挂别名。
// 返回 undefined 而非空数组，registry 对 undefined 不建别名索引。
function officialCuaProviderSpellingAliases(
  name: string,
  descriptor: McpToolDescriptor,
  officialCuaAuthorityVerified: boolean,
): readonly string[] | undefined {
  if (
    !officialCuaAuthorityVerified ||
    descriptor.serverName !== ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME ||
    !name.startsWith(ZCODE_CUA_CANONICAL_MODEL_PREFIX)
  ) {
    return undefined;
  }
  const toolName = name.slice(ZCODE_CUA_CANONICAL_MODEL_PREFIX.length);
  return toolName.length > 0
    ? [`${ZCODE_CUA_PROVIDER_SPELLING_ALIAS_PREFIX}${toolName}`]
    : undefined;
}

export const McpToolOutputJsonSchema = {
  type: "object",
  required: ["content"],
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
      },
    },
    structuredContent: {},
    isError: {
      type: "boolean",
    },
    _meta: {
      type: "object",
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} satisfies JsonSchema;

// 外部 server 可能上报空 schema 或非对象 properties，这里统一兜成可写对象。
// additionalProperties 默认放开，避免把上游合法参数判成非法。
// 只做形状归一，不补 required，也不裁剪未知字段。
function normalizeInputSchema(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  return {
    ...schema,
    type: "object",
    properties:
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? schema.properties
        : {},
  };
}

function createModelFacingMcpInputSchema(
  descriptor: McpToolDescriptor,
  isCuaAppObservation: boolean,
): JsonSchema {
  // 先归一再判断是否需要追加 title，避免在脏 schema 上做属性展开。
  // 非 CUA 观察工具原样返回，不改动上游 schema 的任何字段。
  const schema = normalizeInputSchema(descriptor.inputSchema);
  if (!isCuaAppObservation) return schema;

  const properties = schema.properties as Record<string, unknown>;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];

  // 原因：title 是 ZCode 给用户看的意图摘要，不属于上游 zcode-cua 参数。只在模型 contract
  // 叠加必填字段，runtime dispatch 再剥离，既让模型稳定生成可读标题，也保持上游严格 schema 兼容。
  return {
    ...schema,
    properties: {
      ...properties,
      title: CUA_USER_TITLE_SCHEMA,
    },
    required: [...new Set([...required, "title"])],
  };
}

// 识别 get_app_state 时先做小写与横线、下划线归一，容忍 provider 拼写差异。
// server 侧只接受官方名、zcode-cua、computer-use 及两者组合的 namespaced 形态。
// 该判断决定是否追加 title 必填字段，误判会让无关工具调用直接校验失败。
// 这里只看名称特征，不代表 authority 验明，权限提升仍走 officialCuaAuthorityVerified。
function isZCodeCuaGetAppState(
  descriptor: Pick<McpToolDescriptor, "serverName" | "toolName">,
): boolean {
  if (descriptor.toolName.trim().toLowerCase().replace(/-/g, "_") !== "get_app_state") {
    return false;
  }

  const serverName = descriptor.serverName.trim().toLowerCase().replace(/_/g, "-");
  return (
    descriptor.serverName === ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME ||
    serverName === "zcode-cua" ||
    serverName === "computer-use" ||
    (serverName.includes("zcode-cua") && serverName.includes("computer-use"))
  );
}

function hasInformativeStructuredContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// [契约] 输出统一为模型内容：全文本块折叠成字符串，含图片时保留块数组。
// 非 MCP 结果直接 stringify，保证旧调用路径与自由格式输出不报错。
// 错误包装只看 _meta 显式声明，不解析错误文本，避免 server 文案变动引发回归。
export function formatMcpToolResult(output: unknown): ModelMessageContent {
  if (!isMcpToolCallResult(output)) {
    return stringify(output);
  }

  const blocks = output.content.flatMap(formatContentBlock);
  // 生产 adapter 会保留 structuredContent 的空键；undefined、null、空对象和
  // 空数组都没有模型信息，不能追加伪造的 "Structured content" 块。有内容的错误详情
  // 仍需保留，权限引导依赖这条结构化通道。
  if (hasInformativeStructuredContent(output.structuredContent)) {
    blocks.push({
      type: "text",
      text: `Structured content:\n${stringify(output.structuredContent)}`,
    });
  }

  // [失败路径] 没有任何可用 block 时退回整体 stringify，保证模型至少看到原文。
  // 只要存在一个非文本块就保持数组，直接 joining 会把 dataUrl 拼成乱码。
  const content = blocks.length > 0 ? collapseModelBlocks(blocks) : stringify(output);
  if (!output.isError) return content;
  // 展示策略由 MCP result 显式声明；通用 bridge 不应识别具体 server，
  // 也不应通过解析错误字符串来猜测哪些内容属于堆栈。
  const errorPresentation = output._meta?.[ZCODE_MCP_ERROR_PRESENTATION_META_KEY];
  return typeof errorPresentation === "string" &&
    errorPresentation === ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY
    ? content
    : `MCP tool returned an error:\n${modelMessageContentToText(content)}`;
}

function formatContentBlock(block: Record<string, unknown>): ModelMessageContentBlock[] {
  if (block.type === "text" && typeof block.text === "string") {
    return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
  }
  if (block.type === "image") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
    if (typeof block.data === "string" && typeof block.mimeType === "string") {
      return [
        {
          type: "image",
          mediaType: block.mimeType,
          dataUrl: asDataUrl(block.data, block.mimeType),
          source: {
            id: "mcp-image",
            kind: "inline",
            mimeType: block.mimeType,
            placeholder: "MCP image",
            sizeBytes: estimateBase64Bytes(block.data),
          },
        },
      ];
    }
    return [{ type: "text", text: `[MCP image content omitted: ${mimeType}]` }];
  }
  if (block.type === "audio") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
    return [{ type: "text", text: `[MCP audio content omitted: ${mimeType}]` }];
  }
  if (block.type === "resource") {
    return [{ type: "text", text: `MCP resource content:\n${stringify(block.resource ?? block)}` }];
  }
  return [{ type: "text", text: stringify(block) }];
}

function collapseModelBlocks(blocks: ModelMessageContentBlock[]): ModelMessageContent {
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n");
  }
  return blocks;
}

function estimateBase64Bytes(value: string): number | undefined {
  const data = base64PayloadFromMcpImageData(value);
  if (data.length === 0) return undefined;
  return Math.floor((data.replace(/=+$/, "").length * 3) / 4);
}

function isMcpToolCallResult(value: unknown): value is McpToolCallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as McpToolCallResult).content)
  );
}

function toRecordInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

// title 只存在于模型侧契约，dispatch 前必须剥离，否则上游严格 schema 会拒收。
// 无 title 字段时直接返回原引用，避免为常见路径复制对象。
function toMcpRuntimeArguments(
  input: unknown,
  stripCuaUserTitle: boolean,
): Record<string, unknown> {
  const argumentsRecord = toRecordInput(input);
  if (!stripCuaUserTitle || !("title" in argumentsRecord)) return argumentsRecord;

  const runtimeArguments = { ...argumentsRecord };
  delete runtimeArguments.title;
  return runtimeArguments;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
