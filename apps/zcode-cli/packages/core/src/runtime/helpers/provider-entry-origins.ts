import { parseRuntimeInputPresentation } from "@zcode/contracts";
import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  formatIncomingMessage,
  isMidTurnInputPresentation,
} from "../../system-reminder/incoming-message.js";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";

/**
 * 一次 provider 请求内的"投影条目 → 原始条目"来源映射。
 *
 * 为什么需要：投影会合成新条目（incoming message 包装、MCS system、legacy fallback），
 * 但 usage 归属、latest real user 判定、token 估算仍必须以 canonical history 的条目为准。
 *
 * 生命周期：WeakMap 只在本次 buildProviderRequestMessages 调用内存活，不落盘、不进入
 * provider payload；请求结束后随对象一起回收。
 */
/** 仅单次请求拥有的投影映射；不写入 canonical history 或 provider payload。 */
export class ProviderEntryOrigins {
  private readonly origins = new WeakMap<RuntimeMessageEntry, readonly RuntimeMessageEntry[]>();

  /**
   * 读取条目的来源集合。
   *
   * 未登记过的条目视为"来源就是自身"，因此正常历史条目无需逐条写入映射；
   * 返回值始终非空，调用方不需要额外判空。纯查询，无副作用。
   */
  get(entry: RuntimeMessageEntry): readonly RuntimeMessageEntry[] {
    return this.origins.get(entry) ?? [entry];
  }

  /**
   * 登记投影条目的来源，并对来源做一次展开合并。
   *
   * 用 flatMap 递归到每个 input 已有来源，保证多层投影（incoming 包装后再被 MCS 合并）
   * 仍然指向最内层原始条目，而不是指向中间产物。只写本次请求的 WeakMap，无持久化。
   */
  set(entry: RuntimeMessageEntry, inputs: readonly RuntimeMessageEntry[]): void {
    this.origins.set(
      entry,
      inputs.flatMap((input) => this.get(input)),
    );
  }

  /**
   * 判断该投影条目是否"至少包含一条真实用户输入"。
   *
   * 用于 latest real user 定位：合成条目（MCS/tool result 包装）不应该因为 role=user
   * 就被误判为真实用户。纯查询，无副作用。
   */
  hasRealUser(entry: RuntimeMessageEntry): boolean {
    return this.get(entry).some(isCanonicalRealUser);
  }

  /**
   * 选出该投影条目的"代表性来源"，用于 messages[] 的 sourceEntries 归属。
   *
   * 优先级：最新的真实 user > 最新的非 attachment 条目。选中最新是因为 usage/token
   * 归属更接近本请求的末端上下文；全部都是 attachment 时返回 undefined，表示
   * "没有可归属的 canonical 条目"，调用方按缺失处理。纯查询，无副作用。
   */
  representative(entry: RuntimeMessageEntry): RuntimeMessageEntry | undefined {
    const entries = this.get(entry);
    return (
      entries.findLast(isCanonicalRealUser) ??
      entries.findLast((item) => !isRuntimeAttachmentEntry(item))
    );
  }
}

/**
 * 判定某条来源是否为"canonical 真实用户输入"。
 *
 * 需要同时排除：attachment（系统提醒包装）、output_token_continuation（续写产生的
 * 内部 user）、带 toolCallId/toolName 的工具结果型 user、以及 metadata.source 明确
 * 不是 real_user 的合成条目。只有全部满足才算真实用户，避免把影子 user 当成
 * latest real user 而错误地保护媒体/cache 锚点。纯函数，无副作用。
 */
function isCanonicalRealUser(entry: RuntimeMessageEntry): boolean {
  return (
    !isRuntimeAttachmentEntry(entry) &&
    entry.queryScope !== "output_token_continuation" &&
    entry.message.role === "user" &&
    !entry.message.toolCallId &&
    !entry.message.toolName &&
    (!entry.metadata || entry.metadata.source === "real_user")
  );
}

/**
 * 判断条目是否为"中途展示给模型的输入"（incoming message 等）。
 *
 * 只是 metadata.inputPresentation 存在即成立，不关心具体 presentation 取值；
 * 该标记是因果边界：相邻附件上浮与 MCS 落点都不能跨过它。纯函数，无副作用。
 */
export function isPresentedInput(entry: RuntimeMessageEntry): boolean {
  return parseRuntimeInputPresentation(entry.metadata?.inputPresentation) !== undefined;
}

/**
 * 把带 inputPresentation 的 canonical 条目投影成 provider 可发送形态。
 *
 * 输入：entries 是即将进入 provider 渲染的条目序列；origins 是本次请求的来源映射。
 * 处理：
 * - attachment 或非 user 条目原样返回（它们由附件/MCS 链路处理）；
 * - 没有 inputPresentation 的真实历史原样返回，不产生新对象；
 * - 将正文格式化为 incoming message 形态；task_notification 额外套 source 包装，
 *   因为新轮通知不经过 Attachment 包装，必须在此补齐标签与转义；
 * - 中途输入（mid-turn）投影成 attachment 条目，保持"不是真实 user"的身份，
 *   避免被下游当成新的用户轮次；其余则只替换 message.content，保留原 metadata。
 * - 每个新对象都登记 origins=[entry]，使 usage/real-user 判定仍能回溯到原条目。
 *
 * 输出：新数组，长度与顺序不变；不修改入参对象。
 * 失败与降级：解析不出 presentation、或正文含非文本块时直接返回原条目（不抛错）。
 */
export function projectIncomingMessageEntries(
  entries: readonly RuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): RuntimeMessageEntry[] {
  return entries.map((entry) => {
    if (isRuntimeAttachmentEntry(entry) || entry.message.role !== "user") return entry;
    const presentation = parseRuntimeInputPresentation(entry.metadata?.inputPresentation);
    if (!presentation) return entry;
    const content = entry.message.content;
    // 含非文本块的输入体（附件/媒体）不能被文本化，否则会丢掉附件块；保留原条目交给附件链路。
    if (typeof content !== "string" && content.some((block) => block.type !== "text")) return entry;
    const body =
      typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    const formatted = formatIncomingMessage(body, presentation);
    // 新轮通知不经过 Attachment 包装；在同一投影边界补齐标签与转义，保持 user 身份和原始历史。
    const text =
      presentation === "task_notification"
        ? wrapSystemReminderForSource("incoming_message", formatted)
        : formatted;
    const projected: RuntimeMessageEntry = isMidTurnInputPresentation(presentation)
      ? {
          kind: "attachment",
          content: text,
          metadata: { source: "incoming_message", inputPresentation: presentation },
        }
      : { ...entry, message: { ...entry.message, content: text } };
    origins.set(projected, [entry]);
    return projected;
  });
}
