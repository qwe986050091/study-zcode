// INV-01 提及目标只认 open_id：守住位置 targetId 正则；改错故障 其他平台标识混入。
// INV-02 渠道枚举固定两种：守住位置 channel；改错故障 未知渠道被当作合法。
// INV-03 提及结构 strict：守住位置 object；改错故障 多余字段被静默保留。
// INV-04 内容片段有双上限：守住位置 parts 数量；改错故障 超长消息拖垮渲染。
// INV-05 文本片段限制十万字：守住位置 text；改错故障 超大文本占用内存。
// INV-06 回复文本限制两千字：守住位置 reply 文本；改错故障 超出平台发送上限。
// INV-07 回复至少一段：守住位置 min；改错故障 空回复被发成空消息。
// INV-08 回复至多五十段：守住位置 max；改错故障 分段爆炸触发限流。
// INV-09 提及名未解析即报错：守住位置 resolve；改错故障 模型自造引用被直接信任。
// INV-10 引用必须来自已验证输入：守住位置 targets 构造；改错故障 模型可注入任意目标。
// INV-11 同引用冲突即报错：守住位置 比较；改错故障 同名引用指向两个目标。
// INV-12 引用缺失即报错：守住位置 查找；改错故障 空目标进入发送链。
// INV-13 解析后再次校验长度：守住位置 末尾判断；改错故障 展开后超长仍被发送。
// INV-14 纯空白视为空回复：守住位置 trim；改错故障 只有空格的消息被发出。
// INV-15 澄清候选项限十个：守住位置 max；改错故障 长候选列表刷屏。
// INV-16 未解决项至少一条：守住位置 min；改错故障 空澄清结果被当成失败。
// INV-17 澄清原因四选一：守住位置 reason；改错故障 新原因直通到前端未知分支。
// INV-18 Host 请求在基础请求上扩展：守住位置 extend；改错故障 两套请求形状分叉。
//
// 模块职责：定义渠道提及、回复片段与澄清结果的校验形状。
// 状态所有权：纯 schema 与纯函数；不持有会话状态。
// 阅读顺序：先看提及与内容片段，再看回复请求，最后看解析函数。
import { zcodeProtocolTraceSchema } from "./zcode-protocol/trace.js";
import { z } from "zod";

// 引用标识与展示名等长约束。
// 渠道与实体类型都是枚举。
// 目标标识必须匹配 open_id 形状。
// 多余字段在解析期报错。
export const channelMentionSchema = z
  .object({
    type: z.literal("channelMention"),
    refId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    channel: z.enum(["feishu", "lark"]),
    targetId: z
      .string()
      .max(128)
      .regex(/^ou_[a-zA-Z0-9_-]+$/u),
    idType: z.literal("open_id"),
    entityType: z.enum(["user", "bot", "unknown"]),
  })
  .strict();
export const channelContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string().max(100_000) }).strict(),
  channelMentionSchema,
]);
export const channelContentPartsSchema = z.array(channelContentPartSchema).max(200);
export type ChannelContentPart = z.infer<typeof channelContentPartSchema>;
// channelReplyPartsSchema 的 text 片段与 channelContentPartSchema 的 text 分支字段形状一致。
// text 由 2000 字符上限约束，mention 的 refId 由 1–200 长度约束。
// mentionName 的 candidateRef 可缺省，出现时必须是 1–200 字符的候选标识。
// 数组级 .min(1) 与 .max(50) 同时限制段数，空数组与超长回复都会解析失败。
export const channelReplyPartsSchema = z
  .array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string().max(2000) }).strict(),
      z.object({ type: z.literal("mention"), refId: z.string().min(1).max(200) }).strict(),
      z
        .object({
          type: z.literal("mentionName"),
          name: z.string().trim().min(1).max(200),
          candidateRef: z.string().min(1).max(200).optional(),
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(50);
// 任务与工具调用标识必填。
// 授权标识可缺省。
// 片段形状复用回复 schema。
export const channelReplyRequestSchema = z
  .object({
    taskId: z.string().min(1),
    inputId: z.string().min(1),
    authorizationId: z.string().min(1).optional(),
    toolCallId: z.string().min(1),
    parts: channelReplyPartsSchema,
  })
  .strict();
const channelDeliveryResultSchema = z
  .object({
    status: z.enum(["sent", "failed", "unknown", "invalidated"]),
    deliveryId: z.string(),
    providerMessageId: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
export const channelMentionClarificationSchema = z
  .object({
    status: z.literal("needs_clarification"),
    unresolved: z
      .array(
        z
          .object({
            name: z.string().max(200),
            reason: z.enum(["ambiguous", "not_found", "unavailable", "selection_expired"]),
            candidates: z
              .array(
                z
                  .object({
                    ref: z.string().max(200),
                    name: z.string().max(200),
                    label: z.string().max(250),
                    kind: z.enum(["user", "bot", "unknown"]),
                  })
                  .strict(),
              )
              .max(10),
            truncated: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export const channelReplyResultSchema = z.union([
  channelDeliveryResultSchema,
  channelMentionClarificationSchema,
]);
export type ChannelReplyRequest = z.infer<typeof channelReplyRequestSchema>;
export type ChannelReplyResult = z.infer<typeof channelReplyResultSchema>;
// type === "text" 的片段原样拼入结果，不做 trim 或转义。
// 提及片段展开为 @ 加 name，name 取自 channelMentionSchema 校验后的值。
// join("") 直接拼接片段，不再插入空格或换行。
export function channelContentText(parts: readonly ChannelContentPart[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : `@${part.name}`)).join("");
}
/** 只从 Host 已验证的会话输入解析 ref；模型不得直接提供平台 ID。 */
// 先遍历 source 建立 refId 到 channelMentionSchema 结果的映射，模型侧输入此时还没参与。
// 同一 refId 出现两次且 JSON 串不同即抛错，判定粒度是整条记录而非单个字段。
// parts 里只接受 refId 或 mentionName，模型直传的平台 ID 一律拒绝。
export function resolveChannelReplyParts(
  parts: z.infer<typeof channelReplyPartsSchema>,
  source: readonly ChannelContentPart[],
): ChannelContentPart[] {
  const targets = new Map<string, z.infer<typeof channelMentionSchema>>();
  for (const part of source) {
    if (part.type !== "channelMention") continue;
    const target = channelMentionSchema.parse(part);
    const previous = targets.get(target.refId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(target))
      throw new Error("Conflicting channel mention reference");
    targets.set(target.refId, target);
  }
  channelReplyPartsSchema.parse(parts);
  const resolved = parts.map((part) => {
    if (part.type === "text") return part;
    if (part.type === "mentionName")
      throw new Error("Channel mention name must be resolved by Host");
    const target = targets.get(part.refId);
    if (!target) throw new Error("Unknown channel mention reference");
    return target;
  });
  if (!channelContentText(resolved).trim() || channelContentText(resolved).length > 2000)
    throw new Error("Channel reply must contain 1–2000 characters");
  return resolved;
}

export const channelReplyHostRequestSchema = channelReplyRequestSchema
  .extend({
    trace: zcodeProtocolTraceSchema.optional(),
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
  })
  .strict();
export type ChannelReplyHostRequest = z.infer<typeof channelReplyHostRequestSchema>;
