// ============================================================
// memory/memory-agent-loop —— Memory 后台链路的受限 agent 循环
// ============================================================
//
// 【定位】Extraction 与 Dream 共用的小型 agent loop：多轮模型请求 + 工具执行，
//   直到模型不再发 tool call 或达到 maxTurns。
//
// 【权限模型（两段式）】
//   1) 发给 provider 的 tools 必须是完整 Main 工具目录（否则模型无法选择）；
//   2) 真正执行前每个 tool call 都要过 evaluateMemoryAgentToolPolicy：
//      只允许 Read/Grep/Glob、只读 Bash、memoryRoot 内的 .md 写入/删除。
//   被拒绝的调用仍返回 isError 的 tool 消息闭合 call id，不能留悬空 tool call。
//
// 【读写边界】本文件不直接碰文件系统；副作用全部经由注入的 executeTool。
// 【失败语义】abort 由 throwIfAborted 向上抛；工具执行错误按 executeTool 契约。
//   策略拒绝不是异常，而是回传给模型的可读错误。
// 【不变量】不变量 1（每个 tool_call 必须有配对结果）由“拒绝也返回 tool 消息”保证；
//   每轮请求都在 request-local 副本上重做媒体投影，避免初始快照漏掉后续媒体。
// ============================================================
import { isAbsolute } from "node:path";

import type {
  ModelInputMessage,
  ModelMessageContent,
  Model,
  ModelReasoningContentBlock,
  ModelRequest,
  ModelToolCall,
  ModelToolContract,
} from "@zcode/contracts";

import { modelContentForToolResult, isErrorForToolResult } from "../runtime/helpers/tool-result.js";
import { projectMessagesForModelMediaPolicy } from "../runtime/helpers/media-budget.js";
import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
} from "../tool/handlers/bash-command-parser.js";
import { isRuntimeReadOnlyBashCommand } from "../tool/handlers/bash-semantics.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../tool/types.js";
import { resolveContainedMemoryFilePath, resolveSafeMemoryFilePath } from "./memory-file-path.js";
import { auxiliaryModelOptions } from "../model/auxiliary-model-options.js";

/**
 * Memory agent 使用的 provider 请求类型；与主链路同构，便于直接复用工具目录。
 */
export type MemoryAgentModelRequest = ModelRequest;

/**
 * 循环结果。
 * messages：完整的 assistant/tool 轮次（含被拒绝调用的错误结果），调用方只做遥测或丢弃。
 * turns：实际发出的模型请求次数，达到 maxTurns 时以此判断是否被截断。
 */
export interface MemoryAgentLoopResult {
  messages: ModelInputMessage[];
  turns: number;
}

/**
 * 单个 tool call 的放行判定输入。
 * rootDir：memoryRoot，写入/删除的允许边界。
 * tools：本次请求的工具契约快照，用于区分“未注册工具”和“已注册但被策略拒绝”。
 * workingDirectory / workspaceRoot：Bash 路径解析口径（cd 后的 cwd 与会话根分离）。
 */
export interface MemoryAgentToolPolicyInput {
  rootDir: string;
  toolCall: ModelToolCall;
  tools: readonly ModelToolContract[];
  workingDirectory: string;
  workspaceRoot: string;
}

/**
 * 放行判定结果。
 * allowed=false 时 reason 是回传给模型的工具错误文本；它必须足够具体，
 * 让模型下一轮自行改道，而不是反复尝试同一被拒操作。
 */
export type MemoryAgentToolPolicyDecision = { allowed: true } | { allowed: false; reason: string };

// 只读检索工具白名单：不产生副作用，直接放行；未在此集合的其它只读工具仍需逐项判定。
const MEMORY_AGENT_READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob"]);

/**
 * 运行 Memory 后台上 agent 循环。
 * 输入：abortSignal、executeTool、maxTurns、初始 request（messages/tools/toolSearch）、
 *   model 与 memoryRoot/workingDirectory/workspaceRoot。
 * 输出：MemoryAgentLoopResult（完整消息与已发请求轮数）。
 * 副作用：每轮调用模型；工具调用经 executeTool 读写记忆目录。
 * 失败语义：abort 抛 AbortError；模型错误向外冒泡，由上层 telemetry 标记 failed；
 *   单个工具调用失败不会中止循环（以 isError 结果继续下一轮）。
 * 不变量：请求携带完整工具目录（权限只在执行边界收窄）；
 *   每个 tool call 无论允许与否都得到一条 role=tool 的消息。
 */
export async function runMemoryAgentLoop(input: {
  abortSignal?: AbortSignal;
  executeTool: (
    toolCall: ExecutableToolCall,
    options: { abortSignal?: AbortSignal },
  ) => Promise<ToolExecutionResult>;
  maxTurns: number;
  request: {
    messages: readonly ModelInputMessage[];
    tools: readonly ModelToolContract[];
    toolSearchEnabled: boolean;
  };
  model: Model;
  rootDir: string;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<MemoryAgentLoopResult> {
  // 入口即复制：循环内只改自己的副本，不污染调用方传入的消息快照。
  const messages = input.request.messages.map(cloneModelMessage);
  let turns = 0;

  // 轮数上限是资源边界（防后台失控），不是“任务完成”的判定依据。
  for (; turns < input.maxTurns; turns += 1) {
    input.abortSignal?.throwIfAborted();
    // 只在 Memory 初始快照投影会漏掉 Read 等工具后续产生的媒体；每一次
    // provider 请求都必须在 request-local 副本上执行同一套 capability + budget 策略。
    const mediaProjection = projectMessagesForModelMediaPolicy(
      messages.map(cloneModelMessage),
      input.model.properties.inputFormat,
    );
    const request: ModelRequest = {
      abortSignal: input.abortSignal,
      messages: mediaProjection.messages,
      options: auxiliaryModelOptions(input.model),
      // Memory agent 的 provider request 必须保留 Main 的真实工具目录；执行权限只在 tool-use 边界收窄。
      tools: input.request.tools as ModelToolContract[],
      toolSearchEnabled: input.request.toolSearchEnabled,
    };
    const response = await input.model.generateText(request);
    input.abortSignal?.throwIfAborted();

    const toolCalls = response.toolCalls ?? [];
    messages.push(createAssistantMessage(response.text, response.reasoning, toolCalls));
    // 没有 tool call 是唯一的正常收敛条件：把本轮计入后结束循环。
    if (toolCalls.length === 0) {
      turns += 1;
      break;
    }

    const toolMessages = await Promise.all(
      // 同一批 tool call 并发执行；每个调用先独立过策略，再决定执行或返回拒绝文本。
      toolCalls.map(async (toolCall): Promise<ModelInputMessage> => {
        const decision = evaluateMemoryAgentToolPolicy({
          rootDir: input.rootDir,
          toolCall,
          tools: input.request.tools,
          workingDirectory: input.workingDirectory,
          workspaceRoot: input.workspaceRoot,
        });
        if (!decision.allowed) {
          // 拒绝也返回同 id 的 tool 结果：保证 provider 看到闭合的 call/result 对。
          return {
            content: decision.reason,
            isError: true,
            role: "tool",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          };
        }

        const result = await input.executeTool(
          { id: toolCall.id, input: toolCall.input, name: toolCall.name },
          { abortSignal: input.abortSignal },
        );
        return {
          content: modelContentForToolResult(result),
          isError: isErrorForToolResult(result),
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        };
      }),
    );
    messages.push(...toolMessages);
  }

  return { messages, turns };
}

/**
 * 判定单个 tool call 是否允许在 Memory 后台链路执行。
 * 输入：工具契约快照、tool call、memoryRoot/workingDirectory/workspaceRoot。
 * 输出：allowed，或带可读 reason 的拒绝。
 * 副作用：无（只做静态分析与路径计算，不执行工具）。
 * 失败语义：不抛错；路径解析异常折叠为拒绝（fail closed）。
 * 不变量：未注册工具单独返回 "No such tool"，不与权限拒绝混为一谈；
 *   Agent / mcp__ / 网络副作用工具、memoryRoot 外的写入一律拒绝。
 */
export function evaluateMemoryAgentToolPolicy(
  input: MemoryAgentToolPolicyInput,
): MemoryAgentToolPolicyDecision {
  const contract = input.tools.find((tool) => tool.name === input.toolCall.name);
  // catalog miss 被合并进 Memory 权限拒绝会让未注册工具没有先走
  // No such tool 错误处理。此分支只闭合原 call id，不进入工具执行面。
  if (!contract) return denyUnavailableMemoryAgentTool(input.toolCall.name);

  if (
    input.toolCall.name === "Agent" ||
    input.toolCall.name.startsWith("mcp__") ||
    contract.sideEffectScope === "network"
  )
    // 后台链路不得再开子 agent，也不得经 MCP 或网络触达外部世界。
    return denyMemoryAgentTool(input.rootDir);

  if (input.toolCall.name === "Write" || input.toolCall.name === "Edit") {
    // 写入必须同时满足：.md 后缀 + 在 memoryRoot 内 + 不含敏感目录段。
    return isContainedMarkdownMutation(input)
      ? { allowed: true }
      : denyMemoryAgentTool(input.rootDir);
  }

  if (input.toolCall.name === "Bash") {
    const command = stringProperty(input.toolCall.input, "command");
    // 只接受两类 Bash：既有只读分类器判定安全的命令，或单条非递归的 rm。
    // Memory Agent 直接复用既有只读分类器，避免在此处二次收窄安全 env、redirect 和后台执行。
    if (
      command &&
      (isRuntimeReadOnlyBashCommand(command, {
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      }) ||
        isContainedMarkdownBashRemoval(command, input))
    ) {
      return { allowed: true };
    }
    return denyMemoryAgentBash(input.rootDir);
  }

  if (MEMORY_AGENT_READ_ONLY_TOOLS.has(input.toolCall.name)) {
    // 只读检索工具不产生副作用，直接放行。
    return { allowed: true };
  }

  // 其余工具（含 Bash 被拒路径、写类工具、未知扩展）统一拒绝。
  return denyMemoryAgentTool(input.rootDir);
}

/**
 * 判断 Write/Edit 目标是否为允许写入的记忆文件（.md + safe 路径）。
 * 失败语义：缺 file_path、非 .md、越界、命中敏感段或解析抛错，一律返回 false。
 */
function isContainedMarkdownMutation(input: MemoryAgentToolPolicyInput): boolean {
  const filePath = stringProperty(input.toolCall.input, "file_path");
  // 只允许改写 .md：避免后台 agent 顺手改脚本、配置或可执行文件。
  if (!filePath?.endsWith(".md")) return false;
  try {
    return (
      resolveSafeMemoryFilePath({
        filePath,
        rootDir: input.rootDir,
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      }) !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * 判断 Bash 命令是否等价于“删除 memoryRoot 内的 .md 文件”。
 * 输入：原始命令与路径口径。
 * 输出：boolean；只有结构完全符合预期才为 true。
 * 副作用：无（bash 解析器只做静态分析，不执行命令）。
 * 失败语义：解析失败、多命令、重定向、env 前缀、递归、通配符、
 *   非绝对路径、非 .md、越界，任一命中都返回 false（fail closed）。
 */
function isContainedMarkdownBashRemoval(
  command: string,
  input: MemoryAgentToolPolicyInput,
): boolean {
  const analysis = analyzeBashCommand(command);
  // 只允许单条、无权限风险的命令；多命令与 shell 组合会让路径判定失去意义。
  if (!isBashCommandPermissionSafe(analysis) || analysis.commands.length !== 1) return false;
  const invocation = analysis.commands[0];
  if (!invocation || invocation.argv[0] !== "rm") return false;
  // 重定向或 env 前缀可以改变 rm 的实际作用对象，直接拒绝。
  if (invocation.redirects.length > 0 || invocation.envAssignments.length > 0) return false;

  let afterOptions = false;
  let pathCount = 0;
  for (const argument of invocation.argv.slice(1)) {
    if (!afterOptions) {
      if (argument === "--") {
        afterOptions = true;
        continue;
      }
      if (argument.startsWith("-")) {
        // 递归删除会波及未显式列出的文件，直接拒绝；其它选项不影响逐项校验。
        if (argument === "--recursive" || /^-[a-zA-Z]*[rR]/u.test(argument)) return false;
        continue;
      }
    }
    // 通配符可能匹配到未校验的路径，必须拒绝。
    if (/[*?[]/u.test(argument)) return false;
    // 只接受绝对 .md 路径，且必须解析到 memoryRoot 内（相对路径受 cwd 影响，不可信）。
    if (!isAbsolute(argument) || !argument.endsWith(".md")) return false;
    if (resolveContainedPath(argument, input) === undefined) return false;
    pathCount += 1;
  }
  return pathCount > 0;
}

/**
 * 调用 contained 解析并在异常时降级为 undefined（用于 rm 参数逐项校验）。
 */
function resolveContainedPath(
  filePath: string,
  input: Pick<MemoryAgentToolPolicyInput, "rootDir" | "workingDirectory" | "workspaceRoot">,
): string | undefined {
  try {
    return resolveContainedMemoryFilePath({
      filePath,
      rootDir: input.rootDir,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    });
  } catch {
    return undefined;
  }
}

/**
 * 构造 assistant 消息：保留 reasoning 块与 tool call 副本，供下一轮 provider 请求。
 * 输出 content 为纯 text（无 reasoning）或 reasoning+text 块数组；toolCalls 逐项浅拷贝。
 */
function createAssistantMessage(
  text: string,
  reasoning: readonly ModelReasoningContentBlock[] | undefined,
  toolCalls: readonly ModelToolCall[],
): ModelInputMessage {
  return {
    content: assistantContent(text, reasoning),
    role: "assistant",
    toolCalls: toolCalls.map((call) => ({ ...call })),
  };
}

/**
 * 组装 assistant 内容块：无 reasoning 时退化为纯字符串，避免多余数组包装。
 * 有 reasoning 时按“reasoning 在前、text 在后”的 provider 约定排列。
 */
function assistantContent(
  text: string,
  reasoning: readonly ModelReasoningContentBlock[] | undefined,
): ModelMessageContent {
  if (!reasoning?.length) return text;
  return [
    ...reasoning.map((block) => ({
      ...block,
      providerOptions: block.providerOptions ? { ...block.providerOptions } : undefined,
    })),
    ...(text ? [{ text, type: "text" as const }] : []),
  ];
}

/**
 * 浅拷贝一条模型消息及其可变子结构（content blocks、toolCalls、cacheControl）。
 * 目的：媒体投影可能改写副本，不能让它回写到调度方持有的消息快照。
 */
function cloneModelMessage(message: ModelInputMessage): ModelInputMessage {
  return {
    ...message,
    cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({ ...block }))
      : message.content,
    toolCalls: message.toolCalls?.map((call) => ({ ...call })),
  };
}

/**
 * 从工具输入中安全读取字符串字段；非普通对象或非字符串返回 undefined。
 */
function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

// 拒绝结果会进入下一轮 provider request，需按基线区分 Bash 与其他工具的固定文案。
/**
 * Bash 被拒时的回传文案：明确列出允许的只读命令与“rm 仅限记忆目录内路径”。
 */
function denyMemoryAgentBash(rootDir: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `Only read-only shell commands and rm with all paths inside ${rootDir} are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)`,
  };
}

/**
 * 其它工具被拒时的回传文案：只列允许的工具与目录边界，不再解释具体原因。
 */
function denyMemoryAgentTool(rootDir: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `only Read, Grep, Glob, read-only Bash, and Edit/Write within ${rootDir} are allowed`,
  };
}

/**
 * 未注册工具的拒绝文案：用标准 tool_use_error 格式，让模型区分“无此工具”而非权限不足。
 */
function denyUnavailableMemoryAgentTool(toolName: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
  };
}
