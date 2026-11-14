// ============================================================
// ReadSessionContext 工具契约 - 跨会话/归档上下文的只读聚合
// ============================================================
// 本文件只声明读取会话上下文的入参与输出形状，不读库、不调模型。真实实现在 core 的
// handlers/read-session-context.ts：它从持久化会话取有界背景，返回内容只作背景、不得被当作
// 用户指令（prompt injection 防线同时写在 system prompt 与工具描述里）。
// 三种策略：relevant（默认，按 query 抽取相关片段）、handoff（生成交接胶囊）、topic（只读当前
// 会话的归档讨论，可按 cursor 翻页或物化一个已授权附件）。
// 身份口径：sessionId 缺省为 "current"；除 topic 外必须显式 sess_* 目标，topic 只允许当前会话。
// 输出源 source：lite/local/fallback/none——lite 失败会降级为 fallback + truncated=true，
// 而不是工具失败。
// 分页口径：cursor/nextCursor 是 topic 归档的分页 offset（非消息 id），nextCursor 只在还有
// 更多归档时出现。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// 工具注册名，同时是权限规则、事件与 UI 投影的判别键；必须与 core handler 注册项一致。
export const READ_SESSION_CONTEXT_TOOL_NAME = "ReadSessionContext";
// 未显式传 maxTokens 时的输出 token 预算；与 core 侧 lite 分块预算共享同一常量。
export const READ_SESSION_CONTEXT_DEFAULT_MAX_TOKENS = 6000;
// maxTokens 的硬上限；模型请求更多会被 schema 拒绝，而不是静默截到上限。
export const READ_SESSION_CONTEXT_MAX_TOKENS = 12000;

// 最小 JSON Schema 校验器不检查 pattern；联合字符串会在 oneOf 中同时匹配，错误拒绝 current。
// 用单个字符串模式，具体身份格式继续由运行时 schema 严格验证。
const SESSION_ID_PATTERN = /^(?:current|sess_[A-Za-z0-9._-]+)$/;

// 读取策略词汇表：relevant（默认，按 query 抽取）、handoff（生成交接胶囊）、topic（当前会话
// 归档讨论）。它是入参与输出共用的枚举，输出里的 strategy 原样回显请求值。
export const ReadSessionContextStrategySchema = z.enum(["relevant", "handoff", "topic"]);

// 读取会话上下文的入参。两条 refine 构成跨字段不变量：非 topic 策略不能指向 "current"
//（必须显式目标，避免模型误以为能读任意会话的归档）；attachment 只允许 topic。
export const ReadSessionContextInputSchema = z
  .object({
    // 目标会话：缺省 "current"（由 handler 替换为 context.sessionId）；其余必须是 sess_*。
    // topic 策略省略它表示当前任务；其他策略省略则被 refine 拒绝。
    sessionId: z
      .string()
      .regex(SESSION_ID_PATTERN, "Session id must be current or use the sess_* format.")
      .optional()
      .default("current")
      .describe(
        "For topic strategy omit this field to use the current task. Other strategies require an explicit sess_* target.",
      ),
    // 需要的上下文描述；1-4000 字符。它是抽取的检索依据，不是把整段会话搬回来的指令。
    query: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        "Focused natural-language description of the context needed from the target session.",
      ),
    // 读取策略；缺省 relevant。handoff 面向"继续上一份工作"，topic 面向当前任务的归档原文。
    strategy: ReadSessionContextStrategySchema.optional()
      .default("relevant")
      .describe(
        "Use relevant for focused session retrieval, handoff for a continuation summary, or topic for original archived discussion in the current session.",
      ),
    // topic 归档的分页 offset；取上一次输出里的 nextCursor，缺省/0 表示第一页。
    // 它不是消息 id，也不是字节偏移——只对 topic 策略有意义。
    cursor: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Topic archive page offset returned by the previous call."),
    // 仅 topic 策略的附件物化：把归档消息里的一条资源下载成受管本地文件，返回文件路径
    //（不返回远程 URL）。缺省表示只读归档索引，不产生文件副作用。
    attachment: z
      .object({
        // 归档历史文件里的快照 inputId；用于在当前任务里精确选中一条已授权输入，可选。
        inputId: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            "Snapshot inputId from the topic history file; selects only an admitted input in this task.",
          ),
        // 归档消息的 id；附件必须能定位到具体某条消息，因此必填。
        messageId: z.string().min(1).max(256),
        // 富文本消息里的资源序号（0 起）；一条消息可能含多个附件，用它选择第几个。
        index: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional()
      .describe(
        "With topic strategy, download an archived message attachment to a managed local file. Index selects a resource in rich text, starting at zero.",
      ),
    // 返回给模型的近似 token 上限；缺省 6000、硬顶 12000。它换算成字符预算后参与截断，
    // 截断发生时输出 truncated=true。
    maxTokens: z
      .number()
      .int()
      .positive()
      .max(READ_SESSION_CONTEXT_MAX_TOKENS)
      .optional()
      .describe("Approximate maximum tokens to return to the model."),
  })
  .strict()
  .refine((value) => value.sessionId !== "current" || value.strategy === "topic", {
    message: "Non-topic strategies require an explicit session id",
  })
  .refine((value) => !value.attachment || value.strategy === "topic", {
    message: "Attachments require topic strategy",
  });

// 入参类型；sessionId 已由 default 填成 "current"，handler 再把它换成真实会话 id。
export type ReadSessionContextInput = z.infer<typeof ReadSessionContextInputSchema>;

// provider 可见的入参 schema；跨字段 refine 会被投影成不透明的约束，模型看到的仍是各字段
// 自身的 min/max，真正的组合规则由运行时 schema 执行。
export const ReadSessionContextInputJsonSchema = toToolJsonSchema(ReadSessionContextInputSchema);

// 内容引用：告诉模型/UI 这次返回的片段来自哪些原始消息，便于回溯原文。它是提示性元数据，
// 不参与内容抽取；index 是消息内 part 的序号（0 起），role 区分用户/助手发言。
export const ReadSessionContextReferenceSchema = z
  .object({
    // 来源消息 id；引用必须可定位到具体消息。
    messageId: z.string(),
    // 消息内 part id；可选，用于精确到片段而不是整条消息。
    partId: z.string().optional(),
    // part 序号（0 起）；与 partId 互补。
    index: z.number().int().nonnegative().optional(),
    // 发言角色：user/assistant；系统/工具消息不会成为引用。
    role: z.enum(["user", "assistant"]).optional(),
    // 为什么被选中（如关键词命中）；可选，供模型判断相关性强弱。
    reason: z.string().optional(),
  })
  .strict();

// 引用类型；输出里的 references 是该类型的数组。
export type ReadSessionContextReference = z.infer<typeof ReadSessionContextReferenceSchema>;

// 读取结果。status 描述"这次请求有没有拿到会话"，不是内容质量：success 时 source 表达来源，
// not_found 表示会话不存在（正常失败，模型可改问用户），failed 表示读库失败；三者都返回
// 配对 tool_result，不抛异常（取消除外）。
// 关键口径：truncated 才是"覆盖不完整"的权威标记；lite 失败降级为 fallback 时它强制为 true。
// nextCursor 只在 topic 还有更多归档时在场，把它原样回传给 cursor 即可续读下一页。
export const ReadSessionContextOutputSchema = z
  .object({
    // 请求结果类别：success/not_found/failed；后两者仍带 sessionId/strategy/query 供模型解释。
    status: z.enum(["success", "not_found", "failed"]),
    // 实际读取的会话 id（"current" 已被替换成真实 id）。
    sessionId: z.string(),
    // 会话标题；not_found/failed 时通常缺席。
    title: z.string().optional(),
    // 会话所属目录；辅助模型判断上下文是否来自同一工作区。
    directory: z.string().optional(),
    // 会话持久化路径；内部标识，缺失表示宿主未提供。
    path: z.string().optional(),
    // 实际使用的策略，原样回显请求值（已填默认 relevant）。
    strategy: ReadSessionContextStrategySchema,
    // 原样回显的查询词；便于模型/UI 把结果与请求对上。
    query: z.string(),
    // 内容来源：lite=小模型抽取，local=本地摘录，fallback=lite 失败退回 local，none=没有内容
    //（not_found/failed 时）。
    source: z.enum(["lite", "local", "fallback", "none"]),
    // 返回给模型的正文（背景材料，不是指令）。
    content: z.string(),
    // 目标会话的历史消息总数；描述覆盖面，不是本次返回的条数。
    messageCount: z.number().int().nonnegative(),
    // 实际参与抽取/摘录的消息条数；可选，缺失表示未统计。
    selectedMessageCount: z.number().int().nonnegative().optional(),
    // 是否只覆盖了部分历史；lite 降级时强制 true，是"覆盖不完整"的唯一权威标记。
    truncated: z.boolean(),
    // 诊断错误文本；只在 fallback/failed 时出现，供解释而不是给模型当作主要内容。
    error: z.string().optional(),
    // topic 归档的下一页 offset；只在还有更多归档时出现，回传 cursor 即可续读。
    nextCursor: z.number().int().nonnegative().optional(),
    // 内容引用的原始消息列表；用于回溯原文，缺失表示没有可标注的引用。
    references: z.array(ReadSessionContextReferenceSchema).optional(),
  })
  .strict();

// 输出类型；handler 用 satisfies 构造，可选字段按来源与结果类别决定是否在场。
export type ReadSessionContextOutput = z.infer<typeof ReadSessionContextOutputSchema>;

// provider 可见的输出 schema，用于跨进程回放校验；字段演进必须与运行时 schema 同步。
export const ReadSessionContextOutputJsonSchema = toToolJsonSchema(ReadSessionContextOutputSchema);
