// bots/channelMentionResolver.ts — 把模型给出的 @名字 解析成可信渠道节点。
//
// INV-01 名字只是查询条件：候选身份必须来自 members 目录或 trusted 原生节点，
//        绝不能把模型提供的 name 直接当成 targetId。
// INV-02 只有唯一精确匹配、或唯一候选时才自动选中；多候选必须返回澄清，
//        包含可信机器人在内也不放宽。
// INV-03 部分失败也要收集全部 unresolved，不能遇到第一个失败就返回，
//        否则模型会把未解析的名字误报为成功（历史 Bug）。
// INV-04 candidateRef 是作用域内目标 id 的哈希；过期或跨 scope 的 ref 必须
//        判为 selection_expired。
// [安全] idType 固定 open_id，refId=directory 表示来自目录而非模型输入。
import { createHash } from "node:crypto";
import {
  channelMentionSchema,
  resolveChannelReplyParts,
  type ChannelContentPart,
  type ChannelReplyHostRequest,
  type ChannelReplyResult,
} from "@zcode/shared";

// Mention 是 channelMention 部分的别名，便于类型收窄。
type Mention = Extract<ChannelContentPart, { type: "channelMention" }>;
type Clarification = Extract<ChannelReplyResult, { status: "needs_clarification" }>;
// [契约] MAX_CANDIDATES = 10 与卡片展示能力对齐：超过上限就转澄清提问，不无限展开候选列表。
const MAX_CANDIDATES = 10;
// 归一化口径：NFKC + trim + 小写；全角半角都归到同一比较形式。
const normalizeName = (name: string) => name.normalize("NFKC").trim().toLowerCase();

/** 名字只是查询条件；候选身份只能来自 Provider 目录与已授权原生节点。 */
// 返回 parts 或澄清结果；两者互斥。
export function resolveChannelMentionNames(
  parts: ChannelReplyHostRequest["parts"],
  trusted: ChannelContentPart[],
  members: Record<string, string> | undefined,
  scope: string,
  channel: "feishu" | "lark",
  nameCandidates: ChannelContentPart[] = [],
): { parts: ChannelContentPart[] } | Clarification {
  // 可信节点优先级高于目录节点；nameCandidates 仅供预解析参考。
  const nodes: Mention[] = [...trusted, ...nameCandidates].filter(
    (part): part is Mention => part.type === "channelMention",
  );
  // 目录节点逐个过 schema，非法条目静默丢弃。
  for (const [targetId, name] of Object.entries(members ?? {})) {
    const node = channelMentionSchema.safeParse({
      type: "channelMention",
      targetId,
      name,
      channel,
      refId: "directory",
      idType: "open_id",
      entityType: "user",
    });
    if (node.success) nodes.push(node.data);
  }
  // 输出保持输入顺序：非 mentionName 部分原样落在对应位置。
  const resolved: ChannelContentPart[] = [];
  const unresolved: Clarification["unresolved"] = [];
  for (const part of parts) {
    // 普通 text 直接保留，其余 part 走 shared 的可信解析。
    if (part.type !== "mentionName") {
      // 按原语义解析可信 ref，不能把模型提供的名字当成 ref/平台 ID。
      if (part.type === "text") resolved.push(part);
      else resolved.push(...resolveChannelReplyParts([part], trusted));
      continue;
    }
    // 以 targetId 去重：同一目标可能同时来自目录与 trusted。
    const byId = new Map<string, Mention>();
    for (const node of nodes) {
      if (
        // 只匹配同渠道节点，跨渠道 id 不能复用。
        node.channel === channel &&
        normalizeName(part.name) &&
        normalizeName(node.name).includes(normalizeName(part.name))
      )
        byId.set(node.targetId, node);
    }
    // 候选按 targetId 稳定排序，保证同样输入得到同样 ref。
    const candidates = [...byId.values()]
      .sort((a, b) => a.targetId.localeCompare(b.targetId))
      // ref 绑定 scope：同一目标在不同群/话题下的 ref 不同。
      .map((node) => ({
        node,
        ref: `name:${createHash("sha256")
          .update(JSON.stringify([scope, node.targetId]))
          .digest("hex")}`,
      }));
    // 先找精确同名，再看是否唯一候选。
    const exact = candidates.filter(
      ({ node }) => normalizeName(node.name) === normalizeName(part.name),
    );
    // 唯一精确优先；否则唯一候选也可自动选中。
    const automatic =
      exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    // 带 candidateRef 时只认该引用，避免用户意图被重新解释。
    const selected = part.candidateRef
      ? candidates.find((candidate) => candidate.ref === part.candidateRef)
      : automatic;
    // 查询失败不能将不完整候选当成唯一匹配，包含可信机器人节点时也一样。
    // 目录不可用时不做任何自动选择（见 INV-02）。
    if (members && selected) {
      resolved.push({ ...selected.node, refId: selected.ref });
      continue;
    }
    // 之前遇到首个失败就返回，后续名字未查却被模型误报为成功；必须收集全部失败项。
    // 失败原因按优先级归类，供 UI 展示不同澄清文案。
    unresolved.push({
      name: part.name,
      reason: !members
        ? "unavailable"
        : part.candidateRef
          // 带 ref 却找不到，说明候选已过期或被替换。
          ? "selection_expired"
          : candidates.length
            ? "ambiguous"
            : "not_found",
      // 最多返回 10 个候选，避免卡片过长。
      candidates: members
        ? candidates.slice(0, MAX_CANDIDATES).map(({ node, ref }) => ({
            ref,
            name: node.name,
            kind: node.entityType,
            label: `${node.name} (${node.entityType}, …${node.targetId.slice(-6)})`,
          }))
        : [],
      // 显式标记截断，调用方可提示用户缩小关键词。
      truncated: candidates.length > MAX_CANDIDATES,
    });
  }
  // 只要有一项未解析就整批澄清，不做部分提交。
  return unresolved.length ? { status: "needs_clarification", unresolved } : { parts: resolved };
}
