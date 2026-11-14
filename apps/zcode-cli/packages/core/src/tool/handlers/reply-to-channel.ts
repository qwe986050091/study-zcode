// ============================================================
// ReplyToChannel Tool Handler
// ============================================================
// 在当前已授权的机器人会话里再发一条消息（飞书/Lark），支持原生 @ 提及。
//
// 为什么不需要额外工具审批：这条会话本身已经是用户授权过的渠道；工具只是向同一
// 会话追加一条回复。真正需要防的不是"是否发送"，而是"发到哪个会话、代表哪次输入"，
// 所以本文件的全部复杂度都在**身份绑定**上：
//   1) 用 toolCallId 在持久化历史里找到唯一一条包含该 tool part 的 assistant 消息；
//   2) 沿它的 parentID 找到对应的非合成 user 消息；
//   3) 从该 user 消息的 inputIntent 里取 sourceCommandId 作为发送身份。
// 不能拿"最新一条 user 消息"授权：工具运行前 tool part 已落盘，以它为锚才能把
// 发送绑定到**实际执行输入**，否则并发/续聊时会把回复发错会话或错消息。
//
// 失败语义：任何一步身份缺失都 fail closed 抛 Error（消息 unavailable），
// 因为此时重试也无法恢复上下文；发送本身由 topicResourcePort.reply 执行，
// 取消通过 abortSignal 传播，端口返回的 channelReplyResult 原样交给上层。
// 副作用：向外部网络发送一条消息（sideEffectScope=network），不可撤销。
// ============================================================

import { z } from "zod";
import { channelReplyPartsSchema, channelReplyResultSchema } from "@zcode/shared";
import type { SessionId } from "@zcode/contracts";

import type { ToolEntry, ToolHandler } from "../types.js";

// runtime 侧严格 schema：parts 非空，每项的字段组合/长度由 shared 的 union 校验；
// provider 侧 schema 另行手写（见 toolEntry），因为 provider schema 不支持 anyOf。
const inputSchema = z.object({ parts: channelReplyPartsSchema }).strict();
const TIMEOUT_MS = 60_000;
// 最多 50 个名字各返回 10 个候选，预算需容纳完整澄清结果，避免截断后误报匹配。
// 2MB 同时是 maxOutputBytes/resultBudget：澄清结果被截断会让模型少看候选，
// 进而自行猜测或漏报未解决的名字，语义上比"工具失败"更危险。
const OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * ReplyToChannel 的 handler。
 *
 * 输入：`parts` 是文本/原生提及/按名字提及的组合，由 shared schema 严格校验；
 * `mentionName` 的候选解析由 Host 完成，模型不得猜 platform id。
 * 输出：端口返回的 channelReplyResult（sent / needs_clarification / 各类失败），
 * 本文件不做二次包装，避免与 Host 的事实口径分叉。
 * 身份：toolCallId → 唯一 assistant tool part → parentID → 非合成 user 消息 →
 * inputIntent.sourceCommandId（兼容旧字段 inputIntent）。任一环节缺失即抛错。
 * 副作用：一次网络发送；abortSignal 在发送前后各检查一次，减少"已取消仍发出"的窗口。
 * 降级：无。发送身份无法确认时不发送（fail closed），而不是退回"最新消息"猜测。
 */
export const replyToChannelHandler: ToolHandler = async (input, context) => {
  const parsed = inputSchema.parse(input);
  context.abortSignal.throwIfAborted();
  if (!context.sessionStore || !context.topicResourcePort?.reply)
    throw new Error("Channel reply is unavailable");
  const messages = await context.sessionStore.messages({
    sessionID: context.sessionId as SessionId,
  });
  // 工具运行前已落盘 tool part，以 assistant.parentID 绑定实际执行输入；不能拿队尾的新消息授权。
  const owners = messages.filter(
    ({ info, parts }) =>
      info.role === "assistant" &&
      parts.some((part) => part.type === "tool" && part.callID === context.toolCallId),
  );
  // 必须恰好一条：0 条说明 tool part 尚未落盘/被裁剪，多条说明历史损坏或 callID 复用。
  // 两种都无法确定"这次调用代表哪条输入"，宁可失败也不猜。
  if (owners.length !== 1 || owners[0]!.info.role !== "assistant")
    throw new Error("Channel reply execution input unavailable");
  const parentId = owners[0]!.info.parentID;
  const latest = messages.find(
    ({ info }) => info.id === parentId && info.role === "user" && !info.synthetic,
  );
  const metadata = latest?.info.metadata;
  // 兼容两种字段：新协议用 conversationInputIntent，旧数据可能只有 inputIntent。
  // 用 Object.hasOwn 而不是真值判断，避免字段存在但值为 undefined 时误落到旧字段。
  const intent =
    metadata && Object.hasOwn(metadata, "conversationInputIntent")
      ? metadata.conversationInputIntent
      : metadata?.inputIntent;
  // 渠道来源属于消息；发送绑定属于任务，由 Host 唯一解析，客户端续聊无需复制旧来源。
  // 这里只要求 sourceCommandId 非空；其它字段由 Host 按当前任务解析，避免 core 持有发送细节。
  const identity = z.object({ sourceCommandId: z.string().min(1) }).safeParse(intent);
  if (!identity.success)
    throw new Error("Channel reply execution input unavailable; retrying will not restore it");
  // 第二次 abort 检查：上面的 messages 查询是异步的，期间可能被取消；
  // 在真正发出网络请求前再确认一次，尽量避免"用户已取消但仍投递"。
  context.abortSignal.throwIfAborted();
  return context.topicResourcePort.reply(
    {
      taskId: context.sessionId,
      inputId: identity.data.sourceCommandId,
      toolCallId: context.toolCallId,
      parts: parsed.parts,
    },
    { signal: context.abortSignal, trace: context.traceContext },
  );
};
/**
 * ReplyToChannel 的注册声明。
 *
 * 关键字段口径：
 *   - readOnly=false / sideEffectScope="network"：会向外部会话投递消息，不可撤销；
 *   - concurrentSafe=false：同一会话的多条回复需要稳定顺序，并发发送可能让
 *     澄清/后续回复乱序；工具自身串行化比依赖 Host 排序更稳。
 *   - needsApproval=false：会话已授权，且模型被明确要求"仅当用户要求发送时"才调用；
 *     真正的拦截面是 permission 规则与描述里的使用约束。
 *   - maxOutputBytes=2MB：澄清会列出所有未解决名字及候选，截断会诱导模型猜 id。
 * provider inputSchema 手写而不复用 Zod→JSON Schema：provider schema 不支持 anyOf，
 * 字段间的互斥（text/refId/candidateRef 只在特定 type 下有效）仍由 runtimeInputSchema 严格校验。
 */
export const replyToChannelToolEntry: ToolEntry = {
  capability: "Reply to the current bot conversation with native mentions",
  metadata: {
    shouldDefer: true,
    name: "ReplyToChannel",
    description:
      "Send an additional reply to the current Feishu/Lark conversation ONLY when the user explicitly asks you to send or mention someone. No additional tool approval is needed for this authorized conversation. Prefer trusted mention refIds; when the user supplies only a name, use mentionName and let Host resolve the current group directory and trusted task mentions. Preserve spaces inside a full name (Alex Smith is one recipient); split multiple recipients only on explicit list delimiters such as 、, commas, or newlines, never whitespace alone. Host uses name containment and automatically selects a unique candidate or a unique exact name among multiple matches. Never guess platform IDs. needs_clarification lists ALL unresolved names after checking every requested name and means NOTHING was sent. Only report the returned facts; never claim delivery or invent a match. Keep all original recipients when retrying after clarification: show candidate labels and ask the user to choose; never select an ambiguous candidate yourself. After an explicit choice use a new call with name and the returned candidateRef. For not_found/unavailable/selection_expired or truncated candidates, explain the issue and ask for a native @ mention. Group member APIs do not enumerate bots; unknown bots need a native mention first. Normal final answers are delivered automatically. After sent, do not duplicate that request. A sent message does not mean another bot responded.",
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: OUTPUT_BYTES,
    sideEffectScope: "network",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: replyToChannelHandler,
  // Provider schema 不暴露 anyOf；字段组合仍由 runtimeInputSchema 的严格 union 校验。
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["parts"],
    properties: {
      parts: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["text", "mention", "mentionName"] },
            text: {
              type: "string",
              maxLength: 2000,
              description: "Required only for type=text; omit refId.",
            },
            refId: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description:
                "Required only for type=mention; use the current trusted reference and omit text.",
            },
            name: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description:
                "Required only for mentionName: recipient name or partial name supplied by the user; preserve internal spaces, one explicit list item per part; omit text/refId.",
            },
            candidateRef: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description:
                "Only for mentionName after the user explicitly selects a returned candidate; never invent or auto-select.",
            },
          },
        },
      },
    },
  },
  outputSchema: z.toJSONSchema(channelReplyResultSchema),
  runtimeInputSchema: inputSchema,
  runtimeOutputSchema: channelReplyResultSchema,
  permission: {
    permission: "channel.reply",
    reason: "Reply through the current authorized bot conversation",
    riskLevel: "medium",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: OUTPUT_BYTES,
    maxModelBytes: OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: OUTPUT_BYTES, direction: "head" },
  },
  timeout: { defaultMs: TIMEOUT_MS, maxMs: TIMEOUT_MS, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Channel reply cancelled; check delivery status before retrying",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
