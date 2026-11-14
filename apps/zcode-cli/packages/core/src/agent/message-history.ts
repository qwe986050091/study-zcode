// ============================================================
// Message History —— canonical 会话历史 + runtime 条目模型
//
// 【两类数据】
//   RuntimeMessageEntry  带 runtime metadata 的条目(user/assistant/tool/attachment);
//                        投影到 provider 前会剥离 metadata(见 provider-request-messages)。
//   ModelInputMessage     provider 可发送的纯消息(provider-request-messages 的产物)。
//
// 【所有权与不可变约定】
//   - MessageHistory 是 canonical 历史的唯一所有者;
//   - 对外借用一律用 borrowReadOnlyRuntimeEntries(只读引用);
//   - 需要修改/持久化时用 toRuntimeEntries()/cloneRuntimeMessageEntry 做防御性拷贝;
//   - 各 turn 的 turn-local 历史(turnRequestState)通过显式 commit 推进,
//     不允许绕过 MessageHistory 直接改 canonical。
//
// 【缓存语义】
//   cachedMessages 只代表"context prefix 段"(可稳定缓存);
//   setCacheHit 后整段历史都可能命中;setCacheMiss/reset 会回退到 prefix 计数。
// ============================================================

// ============================================================
// B45 深度注释：canonical 历史内核的写入、借用与克隆边界
// 职责：维护 entries 数组、缓存计数与条目克隆，输出给 provider 前的投影不在此处。
// 不负责：系统提示组装、turn 提交、compact 决策、Session 持久化与 token 裁剪。
// 以上能力由 runtime 层持有，在此处补逻辑会造成所有权分裂，改动前先确认归属。
//
// INV-01 断言：canonical 条目只能经本文件写入 —— 守住它的位置：MessageHistoryImpl 的 addUser/addAttachment/addEntries/addAssistant/addToolResult/replaceMessages —— 改错故障：绕过写入会让同一条消息在两个所有者各存一份，重放时历史重复或丢消息
// INV-02 断言：借用返回的是内部数组本体 —— 守住它的位置：borrowReadOnlyRuntimeEntries —— 改错故障：调用方跨 await 持有后遇到 push，快照错位导致请求体里消息顺序与计数不一致
// INV-03 断言：所有写入都必须克隆入参 —— 守住它的位置：各 add 方法与 replaceMessages —— 改错故障：调用方复用同一 content 数组再改，已提交历史被静默污染
// INV-04 断言：cachedMessages 只表示 context prefix 段 —— 守住它的位置：init 与 replaceMessages 中的计数 —— 改错故障：整段历史被当成可缓存，缓存统计虚高且命中率归因错误
// INV-05 断言：缓存命中只能由 usage 侧确认 —— 守住它的位置：setCacheHit —— 改错故障：提前标记命中会让成本面板与真实读取量对不上
// INV-06 断言：推理块必须排在文本之前 —— 守住它的位置：addAssistant 与 createRuntimeAssistantEntry —— 改错故障：顺序反过来 provider 拒收或思考内容被丢弃
// INV-07 断言：调用包装必须随 toolCalls 保留 —— 守住它的位置：addAssistant 的重建逻辑 —— 改错故障：恢复调用时丢失原始包装，工具回放拿不到正确入参
// INV-08 断言：空字符串工具名不能被当作缺省 —— 守住它的位置：cloneModelInputMessage —— 改错故障：可恢复调用按真值判断丢失原始名称，回放定位错工具
// INV-09 断言：attachment 没有消息表示时必须抛错 —— 守住它的位置：messageFromEntryInput —— 改错故障：吞成默认消息会让投影拿到错误角色，provider 侧报协议不合法
// INV-10 断言：prefix 计数遇到未知来源立即停止 —— 守住它的位置：countContextPrefixMessages 的 break 分支 —— 改错故障：计数越过边界，reset 后残留上一轮对话正文
// INV-11 断言：元数据数组字段必须展开拷贝 —— 守住它的位置：cloneRuntimeMessageMetadata —— 改错故障：下游 push 共享数组会回写原始元数据，跨 turn 累积重复条目
// INV-12 断言：queryScope 不得进入 canonical 或持久化 —— 守住它的位置：cloneRuntimeMessageEntry 与投影层剥离 —— 改错故障：续写标记泄漏到下一轮，模型被要求继续未完成的截断输出
// INV-13 断言：已提交 token 用量只能清零投影副本 —— 守住它的位置：invalidateRuntimeTokenUsage —— 改错故障：回写会让 SessionStore 原始账目被抹掉，成本无法恢复核对
// INV-14 断言：用户消息只在唯一入口组装 —— 守住它的位置：buildUserMessageEntries —— 改错故障：各调用方自行分组导致正文、附件、图片顺序漂移，模型引用错位
// INV-15 断言：粘贴图片判定必须结合持久化来源 —— 守住它的位置：isPastedInlineImageAttachment —— 改错故障：冷恢复的本地图片被误判为粘贴图，图片被移出正文分组
// INV-16 断言：读取失败的文本占位符不得进入正文 —— 守住它的位置：buildUserMessageEntries 的跳过分支 —— 改错故障：错误文案被当成用户内容发送，模型据此编造文件内容
//
// ============================================================
import {
  type RuntimeInputPresentation,
  type ModelCallWrapper,
  type FilePart,
  modelMessageContentToText,
  type ModelCacheControl,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type Model,
  type ModelToolCall,
  type ModelReasoningContentBlock,
  type TokenUsageInfo,
} from "@zcode/contracts";
import {
  buildPromptAttachmentReminderBodies,
  type PromptAttachmentReminderInput,
} from "../system-reminder/prompt-attachment.js";
import { parseAgentListingDelta, type AgentListingDelta } from "./agent-listing-metadata.js";
import { SYSTEM_REMINDER_SOURCES, type SystemReminderSource } from "../system-reminder/source.js";

// Tool call from model (simple type, no brand)
export interface ToolCallInput {
  modelCallWrapper?: ModelCallWrapper;
  id: string;
  name: string;
  input: unknown;
}

// 仅模型协议出口和原始调用诊断使用；内部消费者始终读取目标 name/input。
// [契约] 只有协议出口与原始调用诊断可以消费这里，内部消费者读 name/input 本体
// 未经包装的调用直接返回同一个对象，不做拷贝，调用方不得在返回后改写它
// 包装后的 input 把 name 与 input 收进嵌套结构，投影层依赖这个形状还原原始调用
export function toModelToolCall(call: ToolCallInput): ModelToolCall {
  if (!call.modelCallWrapper) return call;
  return {
    id: call.id,
    name: call.modelCallWrapper,
    input: { name: call.name, input: call.input },
  };
}

export type ReasoningContentInput = ModelReasoningContentBlock;

// 本条描述 provider 可见消息的最终形状，没有 metadata，不能拿来判断它属于哪一类输入
// 缓存控制字段属于 request-local 提示，克隆时浅拷贝，断点位置由投影层决定
// 模型标识只用于诊断与 usage 归因，不参与角色判断，也不要据此改写消息顺序
export interface ModelInputMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
  cacheControl?: ModelCacheControl;
  toolCalls?: ToolCallInput[];
  toolCallId?: string;
  toolName?: string;
  modelCallWrapper?: ModelCallWrapper;
  isError?: boolean;
  providerId?: Model["providerId"];
  modelId?: Model["modelId"];
}

export type RuntimeMessageSource =
  | SystemReminderSource
  | "shared_context"
  | "real_user"
  | "legacy_synthetic";

export interface RuntimeMessageMetadata {
  compactBoundary?: { boundaryId: string; preCompactDiscoveredTools?: readonly string[] };
  toolSearchAnnouncement?: {
    addedNames: readonly string[];
    removedNames: readonly string[];
    readdedNames: readonly string[];
  };
  source: RuntimeMessageSource;
  agentListingDelta?: AgentListingDelta;
  inputPresentation?: RuntimeInputPresentation;
}

// 条目 kind 缺省即 message，存量历史没有写 kind，所以不能把 kind 当必填判别依据
// token 用量是已提交 assistant 的 usage 副本，投影时必须剥离，否则请求体会带上无关字段
// 续写作用域只在当前 query 内有效，任何进入 canonical 或持久化的路径都算越界
export interface RuntimeMessageMessageEntry {
  kind?: "message";
  message: ModelInputMessage;
  metadata?: RuntimeMessageMetadata;
  /** 已提交 assistant 自己的 provider tokens；不会发送到 provider。 */
  tokens?: TokenUsageInfo;
  /** 仅在当前 query 内生效；不得进入 canonical history 或 Session persistence。 */
  queryScope?: "output_token_continuation";
}

export interface RuntimeAttachmentEntry {
  kind: "attachment";
  content: string;
  cacheControl?: ModelCacheControl;
  metadata: RuntimeMessageMetadata;
}

export type RuntimeMessageEntry = RuntimeMessageMessageEntry | RuntimeAttachmentEntry;

export interface CacheStats {
  totalMessages: number;
  cachedMessages: number;
  lastCacheHit: boolean;
  cacheReadTokens?: number;
}

// ============================================================
// Message History Interface
// ============================================================

/**
 * canonical 历史接口。所有写操作都会复制条目(调用方传入的对象不会被后续修改影响)。
 * 注意 addEntries/addUser/addAssistant/addToolResult 都会更新 cacheStats 的总数,
 * 但"是否命中缓存"只能由模型 usage 侧(setCacheHit)确认。
 */
// 所有写方法都负责克隆，调用方传进来的对象在返回后可以继续复用
// 写方法只更新总数，命中与否必须等 usage 侧确认，别在这里推断
export interface MessageHistory {
  // Initialize with optional system prompt or context prefix messages
  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void;

  // Add user message
  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void;

  // Add structured internal context that provider projection renders at request time.
  addAttachment(source: SystemReminderSource, content: string): void;

  // Add already-built runtime entries while preserving their source metadata.
  addEntries(entries: readonly RuntimeMessageEntry[]): void;

  // Add assistant message (may include tool calls)
  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void;

  // Add tool result
  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError?: boolean,
    modelCallWrapper?: ModelCallWrapper,
  ): void;

  // 借用当前权威 entries，只允许同步只读；跨异步边界时由调用方做数组浅快照。
  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[];

  // 创建可写的防御性副本；Runtime 内部普通只读点应使用 borrowReadOnlyRuntimeEntries。
  toRuntimeEntries(): RuntimeMessageEntry[];

  // Replace the active provider-visible history after compact/rewind.
  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void;

  // Get current message count
  getMessageCount(): number;

  // Cache management
  getCacheStats(): CacheStats;
  setCacheHit(tokens?: number): void;
  setCacheMiss(): void;

  // Reset for new turn
  reset(): void;
}

// ============================================================
// Message History Implementation
// ============================================================

/**
 * canonical 历史实现:内部只维护 entries 数组与缓存统计,
 * 不做 provider 投影、不做持久化(那些由 runtime 层负责)。
 */
// 内部状态只有 entries 与缓存统计，没有锁也没有队列，全部依赖同线程同步调用
// entries 顺序即 provider 顺序，任何插入位置的调整都会改变缓存前缀命中的范围
// 不要在类内调用外部投影或持久化，那会让本类从数据容器变成业务流程节点
export class MessageHistoryImpl implements MessageHistory {
  private entries: RuntimeMessageEntry[] = [];
  private cacheStats: CacheStats = {
    totalMessages: 0,
    cachedMessages: 0,
    lastCacheHit: false,
  };

  /**
   * 初始化历史(通常是 context prefix):字符串会被包成一条 system 消息;
   * 数组则逐条克隆。初始化后 cachedMessages = context prefix 数量。
   */
  // 字符串形态只接受非空内容，空字符串会被静默忽略，不会生成空 system 消息
  // 数组形态逐条克隆，因此调用方后续修改入参数组不会影响已初始化历史
  // 初始化即重算 prefix 计数，重复调用会把上一份历史整体丢弃，不可当追加使用
  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void {
    this.entries = [];

    if (typeof systemPromptOrMessages === "string" && systemPromptOrMessages.length > 0) {
      this.entries.push({
        message: {
          role: "system",
          content: systemPromptOrMessages,
        },
      });
    } else if (Array.isArray(systemPromptOrMessages)) {
      this.entries.push(...systemPromptOrMessages.map(cloneEntryInput));
    }

    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  /** 追加一条 user 消息(内容会克隆);metadata 用于投影时区分真实用户/合成输入。 */
  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void {
    this.entries.push(createRuntimeUserEntry(content, metadata));
    this.cacheStats.totalMessages = this.entries.length;
  }

  /** 追加一条 attachment(系统提醒/上下文),source 决定投影时的上浮与可见性。 */
  // 来源标记决定投影时的上浮与可见性，传错来源会让系统提醒出现在错误的上下文层
  // 这里只记录原文，提醒正文的拼接由调用方完成，避免本层依赖提示词模板
  addAttachment(source: SystemReminderSource, content: string): void {
    this.entries.push(systemReminderAttachmentEntry(source, content));
    this.cacheStats.totalMessages = this.entries.length;
  }

  /** 批量追加已构造好的 runtime 条目;逐条克隆,调用方后续修改不会影响历史。 */
  // 逐条克隆而不是只拷贝外层数组，内层 content 与 metadata 都会被替换
  // 批量入口不校验来源是否合法，校验责任在构造条目的那一侧
  addEntries(entries: readonly RuntimeMessageEntry[]): void {
    this.entries.push(...entries.map(cloneRuntimeMessageEntry));
    this.cacheStats.totalMessages = this.entries.length;
  }

  /**
   * 追加 assistant 消息:推理块会放到 content 前面(provider 顺序),文本紧跟其后;
   * toolCalls 保留 modelCallWrapper(用于恢复 provider 的原始调用包装)。
   */
  // [契约] 推理块必须排在文本之前，顺序反了 provider 会拒收或丢掉思考内容
  // 空文本不会生成 text 块，只有推理时 content 仍是数组，投影层要同时兼容两种形状
  // toolCalls 重建而非透传，避免外部持有的数组改动影响已提交历史
  // 包装字段只在存在时写入，缺省不能补空值，否则恢复调用会拿到无效包装
  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void {
    const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
    this.entries.push({
      message: {
        role: "assistant",
        content:
          reasoningBlocks.length > 0
            ? [
                ...reasoningBlocks,
                ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
              ]
            : content,
        toolCalls: toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
          ...(tc.modelCallWrapper ? { modelCallWrapper: tc.modelCallWrapper } : {}),
        })),
        ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
      },
      ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
    });
    this.cacheStats.totalMessages = this.entries.length;
  }

  /** 追加 tool result;isError 默认取 !success,用于 provider 端区分成功/失败结果。 */
  // 错误标记默认取反 success，显式传入时以显式值为准，两者不一致会改变模型对失败的判断
  // 空字符串工具名是合法的 provider 原始名称，这里不能按空值省略
  // 结果内容不做截断，超长输出由上层 artifact 层处理，本层只保证结构完整
  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError = !success,
    modelCallWrapper?: ModelCallWrapper,
  ): void {
    this.entries.push(
      createRuntimeToolResultEntry(toolCallId, toolName, content, isError, modelCallWrapper),
    );
    this.cacheStats.totalMessages = this.entries.length;
  }

  /** 只读借用:只允许同步读取;跨 await 前调用方须自行做数组浅快照。 */
  // [并发] 返回的是内部数组本身而不是副本，任何 push 都会被持有者立刻看见
  // 只允许同步读取，跨 await 之前调用方必须自己浅拷贝这个数组
  // 不要为了稳妥在这里改成拷贝，高频只读路径会承担不必要的深拷贝开销
  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[] {
    return this.entries;
  }

  /** 创建防御性副本(深克隆每条 entry),供需要跨异步边界修改的调用方使用。 */
  toRuntimeEntries(): RuntimeMessageEntry[] {
    return this.entries.map(cloneRuntimeMessageEntry);
  }

  /**
   * 替换 provider 可见历史(compact/rewind 后使用)。
   * 会重新克隆全部条目并重算缓存统计,避免旧引用继续指向被替换的历史。
   */
  // [事务] 整体替换不是增量合并，调用方漏传的条目会被永久丢弃
  // 替换后重算 prefix 计数并清空命中状态，旧缓存结论对新历史不成立
  // 逐条重新克隆，防止调用方在替换后继续修改入参影响 canonical
  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void {
    this.entries = messages.map(cloneEntryInput);
    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  getMessageCount(): number {
    return this.entries.length;
  }

  /** 返回缓存统计副本;调用方不能借此修改内部状态。 */
  getCacheStats(): CacheStats {
    return { ...this.cacheStats };
  }

  /** provider 报告缓存读取命中时调用:标记整段历史可能已缓存。 */
  // [失败路径] 只有 provider 明确回报缓存读取量时才可调用，提前调用会虚高命中
  // 命中即把整段历史标为可能已缓存，这是上界估计，不代表逐条消息真的命中
  // 读取量允许缺省，缺省时保留字段为空而不是写零，避免与真实的零读取混淆
  setCacheHit(tokens?: number): void {
    this.cacheStats.lastCacheHit = true;
    this.cacheStats.cacheReadTokens = tokens;
    // Mark all messages as potentially cached
    this.cacheStats.cachedMessages = this.entries.length;
  }

  /** 标记缓存未命中:清掉 cacheReadTokens,并把 cachedMessages 回退为 prefix 数。 */
  setCacheMiss(): void {
    this.cacheStats.lastCacheHit = false;
    this.cacheStats.cacheReadTokens = undefined;
    this.cacheStats.cachedMessages = countContextPrefixMessages(this.entries);
  }

  /**
   * 新 turn 开始时重置:只保留 context prefix 段(稳定系统提示),
   * 清掉上一轮对话内容,同时把缓存统计回退为"仅 prefix"。
   */
  // [事务] 只保留 prefix 段，prefix 之后的一切对话内容都会被丢弃
  // prefix 边界由 countContextPrefixMessages 决定，改判定规则会连带改变重置后的残留内容
  // 重置后 cachedMessages 等于 prefix 数，命中状态一律清零，不复用上一轮结论
  reset(): void {
    const contextPrefixMessages = this.entries.slice(0, countContextPrefixMessages(this.entries));
    this.entries = contextPrefixMessages.map(cloneRuntimeMessageEntry);
    this.cacheStats = {
      totalMessages: contextPrefixMessages.length,
      cachedMessages: contextPrefixMessages.length,
      lastCacheHit: false,
    };
  }
}

// [契约] 这是 prefix 边界的唯一判定点，reset 与缓存统计都依赖它的返回值
// 遇到 attachment 只认 context_prefix 与 skills_listing，其余来源立刻停止计数
// system 消息无条件计入，user 消息必须带可识别来源或 system-reminder 正文才算
// 一旦 break 就不再向后看，后面的可缓存内容也不会被计入，这是刻意保守
export function countContextPrefixMessages(
  messagesOrEntries: readonly (ModelInputMessage | RuntimeMessageEntry)[],
): number {
  let count = 0;
  for (const item of messagesOrEntries) {
    if (isRuntimeAttachmentEntry(item)) {
      if (item.metadata.source === "context_prefix" || item.metadata.source === "skills_listing") {
        count++;
        continue;
      }
      break;
    }
    const message = messageFromEntryInput(item);
    const metadata = metadataFromEntryInput(item);
    if (message.role === "system") {
      count++;
      continue;
    }
    // 非 user 角色即视为 prefix 结束，assistant 与 tool 之后的内容一律不算稳定前缀
    // 这里用 break 而非 continue，任何跳过继续找的改法都会让计数越过真实边界
    // 无 metadata 的普通 user 正文同样终止计数，只有 system-reminder 包裹的合成输入例外
    if (message.role !== "user") break;
    if (metadata) {
      if (metadata.source === "context_prefix" || metadata.source === "skills_listing") {
        count++;
        continue;
      }
      break;
    }
    if (isMetaUserContext(message.content)) {
      count++;
      continue;
    }
    break;
  }
  return count;
}

function isMetaUserContext(content: ModelMessageContent): boolean {
  return modelMessageContentToText(content).trimStart().startsWith("<system-reminder>");
}

export function systemReminderRuntimeMetadata(
  source: SystemReminderSource,
): RuntimeMessageMetadata {
  return { source };
}

export function realUserRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "real_user" };
}

export function legacySyntheticRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "legacy_synthetic" };
}

export function todoReminderRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "todo_reminder" };
}

export function systemReminderAttachmentEntry(
  source: SystemReminderSource,
  content: string,
): RuntimeAttachmentEntry {
  return {
    kind: "attachment",
    content,
    metadata: systemReminderRuntimeMetadata(source),
  };
}

export function createRuntimeUserEntry(
  content: ModelMessageContent,
  metadata?: RuntimeMessageMetadata,
): RuntimeMessageMessageEntry {
  return {
    message: {
      role: "user",
      content,
    },
    metadata: cloneRuntimeMessageMetadata(metadata),
  };
}

// [权衡] 与 addAssistant 是两份平行实现，形状必须保持一致，改一处要同步另一处
// toolCalls 接收只读数组，内部重建为可写结构，避免调用方数组被长期引用
// 推理块为空时不产生数组 content，直接落字符串，投影层依赖这个简化
// 这里返回新条目而不写入历史，便于 compact 与重放场景先构造后决定
export function createRuntimeAssistantEntry(
  content: string,
  toolCalls?: readonly ToolCallInput[],
  reasoning?: readonly ReasoningContentInput[],
  model?: Pick<Model, "providerId" | "modelId">,
  tokens?: TokenUsageInfo,
): RuntimeMessageMessageEntry {
  const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
  return {
    message: {
      role: "assistant",
      content:
        reasoningBlocks.length > 0
          ? [
              ...reasoningBlocks,
              ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
            ]
          : content,
      toolCalls: toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        ...(toolCall.modelCallWrapper ? { modelCallWrapper: toolCall.modelCallWrapper } : {}),
      })),
      ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
    },
    ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
  };
}

export function createRuntimeToolResultEntry(
  toolCallId: string,
  toolName: string,
  content: ModelMessageContent,
  isError: boolean,
  modelCallWrapper?: ModelCallWrapper,
): RuntimeMessageMessageEntry {
  return {
    message: {
      role: "tool",
      content,
      toolCallId,
      toolName,
      ...(modelCallWrapper ? { modelCallWrapper } : {}),
      isError,
    },
  };
}

export function isKnownSystemReminderSource(value: unknown): value is SystemReminderSource {
  return (
    typeof value === "string" && SYSTEM_REMINDER_SOURCES.includes(value as SystemReminderSource)
  );
}

function cloneEntryInput(input: ModelInputMessage | RuntimeMessageEntry): RuntimeMessageEntry {
  if (isRuntimeMessageEntry(input)) {
    return cloneRuntimeMessageEntry(input);
  }
  return { message: cloneModelInputMessage(input) };
}

// [契约] attachment 分支必须浅拷贝缓存控制，缺了会让同一条目共享缓存断点
// message 分支的可选字段用展开条件写入，缺省即不写，不能用 undefined 占位
// 续写作用域原样透传而不是深拷贝，它只是枚举标记，拷贝没有意义
// 元数据走统一克隆函数，数组字段与紧凑边界都在那里展开，不要在此另写一份
export function cloneRuntimeMessageEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  if (entry.kind === "attachment") {
    return {
      kind: "attachment",
      content: entry.content,
      cacheControl: entry.cacheControl ? { ...entry.cacheControl } : undefined,
      metadata: cloneRuntimeMessageMetadata(entry.metadata)!,
    };
  }
  return {
    message: cloneModelInputMessage(entry.message),
    metadata: cloneRuntimeMessageMetadata(entry.metadata),
    ...(entry.tokens ? { tokens: cloneTokenUsageInfo(entry.tokens) } : {}),
    ...(entry.queryScope ? { queryScope: entry.queryScope } : {}),
  };
}

/**
 * Compact 之后 preserved assistant 的 provider usage 仍属于被替换的旧前缀。
 * 只对 projection 副本清零，不能改写 SessionStore 中的原始 tokens。
 */
// [事务] 只用于投影副本，绝不能回写到 SessionStore 保存的原始 usage
// 数值字段全部归零并保留结构，缺字段会让下游求和读到 undefined
// compact 后保留的 assistant 文字仍属于旧前缀，它的用量不能计入新请求
export function invalidateRuntimeTokenUsage(tokens: TokenUsageInfo): TokenUsageInfo {
  return {
    ...tokens,
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  };
}

function cloneTokenUsageInfo(tokens: TokenUsageInfo): TokenUsageInfo {
  return {
    ...tokens,
    cache: { ...tokens.cache },
  };
}

// [契约] 三个数组字段都要展开拷贝，共享数组被下游 push 会污染原始元数据
// 增量描述走解析函数重建，直接透传引用会让增量在多次克隆后累积
// 紧凑边界只展开一层并复制工具名数组，边界 id 是字符串无需处理
// 元数据为空时直接返回 undefined，不要造空对象，那会改变来源判定分支
export function cloneRuntimeMessageMetadata(
  metadata: RuntimeMessageMetadata | undefined,
): RuntimeMessageMetadata | undefined {
  if (!metadata) return undefined;
  const { agentListingDelta, ...rest } = metadata;
  const delta = parseAgentListingDelta(agentListingDelta);
  return {
    ...rest,
    ...(delta ? { agentListingDelta: delta } : {}),
    ...(metadata.compactBoundary
      ? {
          compactBoundary: {
            ...metadata.compactBoundary,
            preCompactDiscoveredTools: metadata.compactBoundary.preCompactDiscoveredTools
              ? [...metadata.compactBoundary.preCompactDiscoveredTools]
              : undefined,
          },
        }
      : {}),
    ...(metadata.toolSearchAnnouncement
      ? {
          toolSearchAnnouncement: {
            addedNames: [...metadata.toolSearchAnnouncement.addedNames],
            removedNames: [...metadata.toolSearchAnnouncement.removedNames],
            readdedNames: [...metadata.toolSearchAnnouncement.readdedNames],
          },
        }
      : {}),
  };
}

// [失败路径] attachment 没有直接的消息表示，这里必须抛错而不是返回空消息
// 把错误吞成默认值会让投影层拿到错误角色，随后在 provider 端表现为协议不合法
function messageFromEntryInput(input: ModelInputMessage | RuntimeMessageEntry): ModelInputMessage {
  if (isRuntimeAttachmentEntry(input)) {
    throw new Error("Runtime attachment entries do not have a direct model message representation");
  }
  return isRuntimeMessageEntry(input) ? input.message : input;
}

function metadataFromEntryInput(
  input: ModelInputMessage | RuntimeMessageEntry,
): RuntimeMessageMetadata | undefined {
  return isRuntimeMessageEntry(input) ? input.metadata : undefined;
}

function isRuntimeMessageEntry(
  input: ModelInputMessage | RuntimeMessageEntry,
): input is RuntimeMessageEntry {
  return "message" in input || ("kind" in input && input.kind === "attachment");
}

export function isRuntimeAttachmentEntry(
  input: ModelInputMessage | RuntimeMessageEntry,
): input is RuntimeAttachmentEntry {
  return isRuntimeMessageEntry(input) && "kind" in input && input.kind === "attachment";
}

// 逐字段按存在性拷贝，避免把空值写进目标消息改变后续判断
// 工具名用显式 undefined 判定，空字符串是合法原始名称，按真值判断会丢
// toolCalls 逐个浅拷贝，input 属于调用方数据，这里不做深层复制
export function cloneModelInputMessage(message: ModelInputMessage): ModelInputMessage {
  const next: ModelInputMessage = {
    role: message.role,
    content: cloneModelMessageContent(message.content),
  };
  if (message.cacheControl) next.cacheControl = { ...message.cacheControl };
  if (message.toolCalls) next.toolCalls = message.toolCalls.map((toolCall) => ({ ...toolCall }));
  if (message.toolCallId) next.toolCallId = message.toolCallId;
  // 空字符串是可恢复调用的 provider 原始名称，不能在 request-local clone 时按 falsy 丢失。
  if (message.toolName !== undefined) next.toolName = message.toolName;
  if (message.modelCallWrapper) next.modelCallWrapper = message.modelCallWrapper;
  if (message.isError !== undefined) next.isError = message.isError;
  if (message.providerId) next.providerId = message.providerId;
  if (message.modelId) next.modelId = message.modelId;
  return next;
}

function cloneReasoningBlock(block: ReasoningContentInput): ReasoningContentInput {
  return {
    ...block,
    providerOptions: block.providerOptions ? { ...block.providerOptions } : undefined,
  };
}

export function cloneModelMessageContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return content;
  return content.map(cloneModelMessageContentBlock);
}

function cloneModelMessageContentBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  if (block.type === "reasoning") {
    return cloneReasoningBlock(block);
  }
  if ("source" in block && block.source) {
    return { ...block, source: { ...block.source } };
  }
  return { ...block };
}

// ============================================================
// Factory
// ============================================================

export function createMessageHistory(): MessageHistory {
  return new MessageHistoryImpl();
}

/** 用户附件的已解析内容及持久化来源；不依赖 runtime 或文件读取。 */
export type UserMessageAttachment = Pick<FilePart, "filename" | "mime" | "source" | "metadata"> & {
  contentBlock: ModelMessageContentBlock;
};

// 首发、队列消费和恢复曾分别组装，导致正文、PDF、路径引用顺序及文本附件语义漂移。
// 统一在消息历史边界组装；调用方只负责解析内容，不再各自分组。
// [契约] 这是用户消息的唯一组装点，首发、队列消费与恢复都必须走这里
// 顺序固定为正文、普通附件块、粘贴图片块，任何调整都会改变模型看到的引用位置
// 提示附件转成独立 attachment 条目，正文里不再重复出现文件内容
// 读取失败的文本占位符直接跳过，不能把错误文案当成用户内容发送
export function buildUserMessageEntries(
  input: ModelMessageContent,
  attachments: readonly UserMessageAttachment[],
): [RuntimeMessageMessageEntry, ...RuntimeAttachmentEntry[]] {
  const realUserBlocks: ModelMessageContentBlock[] = [];
  const pastedImageBlocks: ModelMessageContentBlock[] = [];
  const promptAttachmentEntries: RuntimeAttachmentEntry[] = [];

  for (const attachment of attachments) {
    if (isPastedInlineImageAttachment(attachment)) {
      pastedImageBlocks.push(attachment.contentBlock);
      continue;
    }

    const promptAttachmentInput = promptAttachmentInputForResolvedAttachment(attachment);
    if (promptAttachmentInput) {
      const reminderBody = buildPromptAttachmentReminderBodies(promptAttachmentInput).join("\n");
      promptAttachmentEntries.push(
        systemReminderAttachmentEntry("prompt_attachment", reminderBody),
      );
      continue;
    }

    if (isFailedTextAttachmentPlaceholder(attachment)) {
      continue;
    }

    realUserBlocks.push(attachment.contentBlock);
  }

  const blocks: ModelMessageContentBlock[] = [];
  if (typeof input === "string") {
    if (input.length > 0) blocks.push({ type: "text", text: input });
  } else {
    blocks.push(...input.filter((block) => block.type !== "text" || block.text.length > 0));
  }
  blocks.push(...realUserBlocks, ...pastedImageBlocks);

  return [
    {
      message: {
        role: "user",
        content: normalizeRealUserContent(blocks),
      },
      metadata: realUserRuntimeMetadata(),
    },
    ...promptAttachmentEntries,
  ];
}

function normalizeRealUserContent(
  blocks: readonly ModelMessageContentBlock[],
): ModelMessageContent {
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0]!.type === "text") {
    return blocks[0]!.text;
  }
  return blocks.map((block) => ({ ...block })) as ModelMessageContentBlock[];
}

// [权衡] 内容块已是 image 类型时，必须同时没有持久化来源才算粘贴图片
// 冷恢复会把本地媒体重建为 inline，只看 inline 会把本地图片误判成粘贴图片
// 文本占位形态用固定模式匹配，模式放宽会把普通附件文字吞进图片分组
export function isPastedInlineImageAttachment(attachment: UserMessageAttachment): boolean {
  if (attachment.contentBlock.type === "image") {
    // 冷恢复会把本地媒体重建为 inline；分组必须使用持久化来源，不能据此把本地图片当成粘贴图片。
    return !attachment.source && attachment.contentBlock.source?.kind === "inline";
  }
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("image/") &&
    /^\[Attached image\/[^:]+: \[image #\d+\]\]$/u.test(attachment.contentBlock.text)
  );
}

// [契约] 只有 text 类型、有来源、内联存储且预览正文与内容一致才成立
// 可恢复性只接受 provider_ready 与 preview_only，其余状态说明内容还不可直接发送
// 这个条件收紧后，缺来源的附件会落到 inline_text 分支，语义不同不能合并
function shouldAddReadLikePromptAttachmentReminder(
  attachment: UserMessageAttachment,
): attachment is UserMessageAttachment & {
  contentBlock: Extract<ModelMessageContentBlock, { type: "text" }>;
  source: NonNullable<UserMessageAttachment["source"]>;
} {
  if (attachment.contentBlock.type !== "text") return false;
  if (!attachment.mime.startsWith("text/")) return false;
  if (!attachment.source) return false;
  if (attachment.metadata?.storageKind !== "inline") return false;
  if (
    attachment.metadata?.recoverability !== "provider_ready" &&
    attachment.metadata?.recoverability !== "preview_only"
  ) {
    return false;
  }
  return attachment.metadata?.preview?.text === attachment.contentBlock.text;
}

export function promptAttachmentInputForResolvedAttachment(
  attachment: UserMessageAttachment,
): (PromptAttachmentReminderInput & { content: string; kind: "file" | "inline_text" }) | undefined {
  if (shouldAddReadLikePromptAttachmentReminder(attachment)) {
    return {
      content: attachment.contentBlock.text,
      kind: "file",
      // provider-visible 的 Read 输入要和用户提交的附件引用一致。
      // local file 的 filename 只是展示名；只有缺少 source 时才用它兜底，避免 live/hydrate 轨迹漂移。
      label: attachment.source.text.value ?? attachment.filename,
      preview: attachment.metadata?.preview,
    };
  }

  if (shouldAddInlinePromptAttachmentReminder(attachment)) {
    return {
      content: attachment.contentBlock.text,
      kind: "inline_text",
      label: attachment.filename,
      preview: attachment.metadata?.preview,
    };
  }

  return undefined;
}

function shouldAddInlinePromptAttachmentReminder(
  attachment: UserMessageAttachment,
): attachment is UserMessageAttachment & {
  contentBlock: Extract<ModelMessageContentBlock, { type: "text" }>;
} {
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("text/") &&
    !attachment.source
  );
}

export function isFailedTextAttachmentPlaceholder(attachment: UserMessageAttachment): boolean {
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("text/") &&
    attachment.metadata?.errorCode === "attachment_read_failed"
  );
}
