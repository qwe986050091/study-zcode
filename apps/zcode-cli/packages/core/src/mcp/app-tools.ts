// INV-01 条目与执行器解耦：守住位置 构造参数；改错故障 工具层反向依赖宿主实现。
// INV-02 超时取三段之和：守住位置 常量表达式；改错故障 认领等待把执行时间挤掉。
// INV-03 只读免审批：守住位置 提示位判断；改错故障 只读工具也弹审批。
// INV-04 破坏性提升风险等级：守住位置 三元判断；改错故障 危险工具按中等风险放行。
// INV-05 页面代码按不可信处理：守住位置 最低风险档；改错故障 沙箱代码获得低风险。
// INV-06 模型侧名字唯一：守住位置 名字格式；改错故障 不同服务器同名工具互相覆盖。
// INV-07 描述携带来源与时效：守住位置 尾段文案；改错故障 页面关闭后模型仍在调用。
// INV-08 输入模式先归一：守住位置 构造时替换；改错故障 缺失属性导致校验崩溃。
// INV-09 输出模式固定：守住位置 常量引用；改错故障 模型侧解析失败。
// INV-10 并发安全由只读或幂等决定：守住位置 布尔合成；改错故障 共享页面状态被并发调用。
// INV-11 副作用范围统一为网络：守住位置 字段常量；改错故障 被误判为本地文件操作。
// INV-12 审批粒度为会话级：守住位置 始终允许选项；改错故障 名字被其他页面复用后越权。
// INV-13 结果预算内联与模型分离：守住位置 两个上限；改错故障 大结果挤爆上下文。
// INV-14 预算策略为截断：守住位置 策略字段；改错故障 大结果整体丢弃。
// INV-15 超时不可被调用方覆盖：守住位置 覆盖开关；改错故障 页面调用绕过期限。
// INV-16 取消声明与清理策略明确：守住位置 取消配置；改错故障 中断后残留待执行调用。
// INV-17 追踪必开但不向适配器传播：守住位置 追踪字段；改错故障 内部标识泄露给页面。
// INV-18 执行入参规范化：守住位置 处理器入口；改错故障 数组被当成对象解构。
//
// 模块职责：把页面提供的 MCP 工具描述转换成 core 可调度的工具条目。
// 状态所有权：无状态；执行器由宿主注入，条目只做静态投影。
// 阅读顺序：先看超时常量与条目构造，再看权限与预算，最后看处理器与模式归一。
// MCP Apps App-Provided Tools → core 工具条目。条目只描述「模型怎么看见、审批怎么走、结果怎么进模型」；
// 调用本身交给宿主注入的执行器（bootstrap 的实例信箱：待执行调用投递给托管页面的渲染端，页面执行后回传）。

import type { JsonSchema, McpToolCallResult, McpToolDescriptor } from "@zcode/contracts";
import {
  MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS,
  MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS,
} from "@zcode/shared/mcp-apps";
import type { ToolEntry, ToolExecutionContext } from "../tool/types.js";
import { normalizeMcpToolResultForModel } from "./image-normalization.js";
import { McpToolOutputJsonSchema, formatMcpToolResult } from "./index.js";

/** 条目级超时：认领期限 + 执行期限 + 余量；真正的两段期限由执行器按规范值判定。 */
// MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS 是认领期限、执行期限与 5s 余量三者之和。
// MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS 与 MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS 由执行器按规范值各自判定。
// MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS 只是条目级兜底，正常路径由两段期限先触发。
// 该常量 export 供上层对齐超时展示，避免展示值与实际兜底值漂移。
export const MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS =
  MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS + MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS + 5_000;

export interface McpAppProvidedToolDefinition {
  retainExecution?: ToolEntry["retainExecution"];
  /** 模型侧名字 `app__<server>__<tool>`。 */
  modelName: string;
  serverName: string;
  /** 只做展示 / 键位（非插件 server 时等于 serverName）。 */
  pluginId: string;
  /** 暴露该工具的页面实例（同 server 最近初始化的实例）：沙箱作用域 + 代际。 */
  scopeId: string;
  generation: number;
  /** 页面里的原始工具名。 */
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export type McpAppProvidedToolExecutor = (
  call: {
    definition: McpAppProvidedToolDefinition;
    arguments: Record<string, unknown>;
    toolCallId: string;
  },
  options: { signal: AbortSignal },
) => Promise<McpToolCallResult>;

// readOnlyHint 为真即免审批，其余按现有 permission 策略走。
// 页面代码不可信，风险等级必须至少 medium，destructive 才升 high。
// 条目只描述能力与审批，调用交给宿主注入的 executor。
export function createMcpAppProvidedToolEntry(
  definition: McpAppProvidedToolDefinition,
  execute: McpAppProvidedToolExecutor,
): ToolEntry {
  const readOnly = definition.readOnlyHint === true;
  const destructive = definition.destructiveHint === true;
  // 只读自动放行，其余走现有审批；页面是不可信的沙箱代码，风险至少 medium。
  const needsApproval = !readOnly;
  const riskLevel = destructive ? "high" : readOnly ? "low" : "medium";
  const source = `the ${definition.serverName} app page`;
  const description = [
    definition.title && definition.title !== definition.toolName ? definition.title : undefined,
    definition.description,
    `(Tool provided by ${source}; available only while the app is open.)`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  const pseudoDescriptor: McpToolDescriptor = {
    serverName: definition.serverName,
    toolName: definition.toolName,
    name: definition.modelName,
    inputSchema: definition.inputSchema,
  };

  return {
    retainExecution: definition.retainExecution,
    capability: `App tool ${definition.toolName} provided by ${source}`,
    inputSchema: normalizeObjectSchema(definition.inputSchema),
    outputSchema: McpToolOutputJsonSchema,
    metadata: {
      concurrentSafe: readOnly || definition.idempotentHint === true,
      destructive,
      description,
      name: definition.modelName,
      mcpPresentation: {
        serverName: definition.serverName,
        toolName: definition.toolName,
        ...(definition.description ? { description: definition.description } : {}),
        pluginId: definition.pluginId,
      },
      needsApproval,
      readOnly,
      riskLevel,
      sideEffectScope: "network",
      timeoutMs: MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS,
    },
    permission: {
      permission: "mcp",
      reason: `App tool "${definition.toolName}" provided by ${source}`,
      riskLevel,
      sideEffectScope: "network",
      needsApproval,
      patternSources: ["toolName", "input"],
      denyPriority: "beforeAsk",
      // 模型侧名字跨会话会被别的页面复用：「始终允许」只在本会话生效，不写持久规则。
      askOptions: { allowAlways: "session" },
    },
    resultBudget: {
      maxInlineBytes: 100_000,
      maxModelBytes: 50_000,
      strategy: "truncate",
      preview: { direction: "head" },
    },
    timeout: {
      defaultMs: MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS,
      allowCallOverride: false,
    },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: `App tool ${definition.modelName} was cancelled`,
    },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
    // 入参不是对象时按空对象处理。
    // handler 把 args、toolCallId 与 abortSignal 转交 execute 执行。
    // 结果统一走 MCP 结果归一化。
    handler: async (input: unknown, context: ToolExecutionContext) => {
      const args =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const result = await execute(
        { definition, arguments: args, toolCallId: context.toolCallId },
        { signal: context.abortSignal },
      );
      return normalizeMcpToolResultForModel({
        compressOversizedImages: false,
        context,
        descriptor: pseudoDescriptor,
        result,
        toolName: definition.modelName,
      });
    },
    formatModelContent: (output) => formatMcpToolResult(output),
  };
}

// normalizeObjectSchema 把顶层 type 强制为 "object"。
// schema.properties 缺失或非对象时补 {}，避免下游逐个判空。
// 其余字段用 spread 原样透传，不增不改。
function normalizeObjectSchema(schema: JsonSchema): JsonSchema {
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
