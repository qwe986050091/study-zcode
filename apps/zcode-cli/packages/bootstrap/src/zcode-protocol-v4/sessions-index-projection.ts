// sessions-index topic 的 CLI 侧归约：把一个 workspace 名下各会话的
// ConversationSnapshot 派生为 SessionSummary，并维护 conflated 最新态 + 产出 upsert/remove delta。
// 纯归约、无 IO；publisher（sessions-index-publisher）负责 seq 记账与帧构造，
// 事件订阅与 flush 调度归 gateway（v4-gateway）。
// 边界补充：本投影只回答“侧栏列表需要什么”，不承担 conversation 正文投影职责。
// 所有条目以 sessionId 为唯一键做 conflate；同一会话的多次 update 只保留最新摘要。
// 冷存储 seed 与 live 投影可能先后到达，降级保护集中在本类，publisher 不再重复判断。
import {
  deriveSessionWorkflowActivity,
  type ConversationSnapshot,
  type SessionSummary,
  type SessionsIndexDelta,
  type SessionsIndexSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

/** 派生一条 summary 需要的、快照之外的会话级元信息（来自 session-store record / 事件时刻）。 */
// workspaceId 决定归属；createdAt 是列表排序的稳定初值；lastActivityAt 驱动活跃排序；
// lastOutcome 区分成功/失败；parentSessionId 用于子代理会话归组。
// 这些字段不在 ConversationSnapshot 内，必须由调用方按持久事实补充。
export interface SessionSummaryDeriveExtra {
  workspaceId: string;
  createdAt: number;
  lastActivityAt: number;
  lastOutcome?: SessionSummary["lastOutcome"];
  parentSessionId?: string;
}

const MAX_PREVIEW_CHARS = 120;

/** 从 ConversationSnapshot + 会话元信息派生 SessionSummary（纯函数，golden 可测）。 */
// 输入只读 snapshot 的产品态（control/rows/backgroundWorks/pendingInteractions/goal/
// workflowRuns）与 extra 的持久元信息；不读 transcript 全文、不查库。
// 输出为侧栏所需最小摘要：标题、phase/sessionEnded、后台工作、工作流活动、
// 待处理交互（仅 permission/userInput）、goalStatus、最近 assistant 预览（≤120 字符）。
// 降级：裁剪快照缺 payload 时省略 pendingInteraction；workspaceHookReview 等未知交互
// 刻意不进侧栏徽标。相同输入必须得到相同 summary，conflation 与 golden 测试都依赖这一点。
export function deriveSessionSummary(
  snapshot: ConversationSnapshot,
  extra: SessionSummaryDeriveExtra,
): SessionSummary {
  // 最后一条 assistantText row 的文本作预览（≤120 字符）。
  let lastAssistantPreview: string | undefined;
  const lastOutcome = extra.lastOutcome;
  const rows = snapshot.rows.window;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (
      !lastAssistantPreview &&
      row &&
      row.kind === "assistantText" &&
      row.text.trim().length > 0
    ) {
      lastAssistantPreview = row.text.slice(0, MAX_PREVIEW_CHARS);
    }
    if (lastAssistantPreview) break;
  }
  const hasBackgroundWork = snapshot.backgroundWorks.some((work) => work.status === "running");
  // 侧栏工作流运行行的数据：
  // 同一 snapshot 的 workflowRuns + backgroundWorks 派生，侧栏不必订阅 run 进度。
  const workflowActivity = deriveSessionWorkflowActivity({
    workflowRuns: snapshot.workflowRuns,
    backgroundWorks: snapshot.backgroundWorks,
  });
  // workspaceHookReview 由 Hooks Settings 呈现，不降级成 permission/userInput 侧栏徽标。
  const pending = snapshot.pendingInteractions.find(
    (interaction) => interaction.kind === "permission" || interaction.kind === "userInput",
  );
  const permissionCount = snapshot.pendingInteractions.filter(
    (interaction) => interaction.kind === "permission",
  ).length;
  const userInputCount = snapshot.pendingInteractions.filter(
    (interaction) => interaction.kind === "userInput",
  ).length;
  // 兼容恢复迁移或归约测试构造的裁剪快照：不能因新增轻量 toolName 投影，
  // 在旧 pending interaction 暂缺 payload 时阻断整个任务列表。
  const pendingPayload = pending?.payload;
  const pendingToolName =
    pendingPayload && "toolName" in pendingPayload ? pendingPayload.toolName : undefined;
  const pendingInteraction =
    pending &&
    pendingPayload &&
    (pendingPayload.kind === "permission" || pendingPayload.kind === "userInput")
      ? {
          interactionId: pending.interactionId,
          kind: pendingPayload.kind,
          ...(pendingToolName ? { toolName: pendingToolName } : {}),
          ...(pending.autoResolution ? { autoResolution: pending.autoResolution } : {}),
        }
      : undefined;
  return {
    sessionId: snapshot.sessionId,
    workspaceId: extra.workspaceId,
    ...(extra.parentSessionId ? { parentSessionId: extra.parentSessionId } : {}),
    title: snapshot.meta.title,
    titleSource: snapshot.meta.titleSource,
    ...(lastOutcome ? { lastOutcome } : {}),
    phase: snapshot.control.phase,
    // 忠实透传 control.sessionEnded（语义：成功轮收口后即 true，不代表已删除）。
    sessionEnded: snapshot.control.sessionEnded,
    hasBackgroundWork,
    ...(workflowActivity === undefined ? {} : { workflowActivity }),
    ...(pendingInteraction ? { pendingInteraction } : {}),
    ...(permissionCount > 0 || userInputCount > 0
      ? {
          pendingInteractionSummary: {
            permissionCount,
            userInputCount,
          },
        }
      : {}),
    ...(snapshot.goal ? { goalStatus: snapshot.goal.status } : {}),
    lastActivityAt: extra.lastActivityAt,
    ...(lastAssistantPreview ? { lastAssistantPreview } : {}),
    createdAt: extra.createdAt,
  };
}

/** 两条 summary 是否等价（conflation：等价则不产 delta）。 */
// 逐字段比较：workflowActivity/pendingInteraction 这类嵌套结构用稳定序列化判等，
// 其余标量直接比较；lastActivityAt 属于活动事实，变化也算产品变化。
// 返回 true 时调用方不得推进 seq，避免向所有订阅者广播空帧。
function summariesEqual(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.workspaceId === b.workspaceId &&
    a.parentSessionId === b.parentSessionId &&
    a.title === b.title &&
    a.titleSource === b.titleSource &&
    a.lastOutcome === b.lastOutcome &&
    a.phase === b.phase &&
    a.sessionEnded === b.sessionEnded &&
    a.hasBackgroundWork === b.hasBackgroundWork &&
    // phase 翻转 / 结算 / 在跑子代理数变化永不被 conflation 吃掉；反之只改 node 的事件在这里判等
    // （真实系统里它仍会因 lastActivityAt 推进而产帧——那是活动事实，语义不变）。
    JSON.stringify(a.workflowActivity ?? null) === JSON.stringify(b.workflowActivity ?? null) &&
    JSON.stringify(a.pendingInteraction ?? null) === JSON.stringify(b.pendingInteraction ?? null) &&
    a.pendingInteractionSummary?.permissionCount === b.pendingInteractionSummary?.permissionCount &&
    a.pendingInteractionSummary?.userInputCount === b.pendingInteractionSummary?.userInputCount &&
    a.goalStatus === b.goalStatus &&
    a.lastActivityAt === b.lastActivityAt &&
    a.lastAssistantPreview === b.lastAssistantPreview &&
    a.createdAt === b.createdAt
  );
}

/**
 * 一个 workspace 的 sessions-index 归约态：Map<sessionId, SessionSummary> +
 * upsert/remove delta 生成（conflation key = sessionId）。
 */
// 只有本类持有 summaries；publisher 只消费 delta 并记账 seq，客户端不重新推导摘要。
// 不变量：同一 sessionId 至多一条 summary；delta 只在内容真实变化时产生；
// 冷 seed 不得让 live 已确认的稳定字段（custom 标题、createdAt、非 draft phase）降级。
// 无 IO、无定时器、无广播；本类抛错只可能是调用方数据形状问题，不做静默修补。
export class SessionsIndexProjection {
  private readonly summaries = new Map<string, SessionSummary>();

  constructor(
    readonly workspaceId: string,
    readonly logEpoch: string,
  ) {}

  /** 用某会话的最新 snapshot 更新其 summary；变化则返回 upsert delta，否则空。 */
  // 输出 0 或 1 条 session.upserted；本投影不做排序，排序是客户端职责。
  // 降级保护（stored→live 窗口）：hydration 完成前的空标题/draft phase/被 reset 的
  // createdAt 不得覆盖已有稳定值；custom 标题优先于自动标题。
  // 只改内存 summaries；非法数据由上游 schema 保证，本方法不做兜底重试。
  upsertFromConversation(
    snapshot: ConversationSnapshot,
    extra: Omit<SessionSummaryDeriveExtra, "workspaceId">,
  ): SessionsIndexDelta[] {
    const summary = deriveSessionSummary(snapshot, {
      workspaceId: this.workspaceId,
      ...extra,
    });
    const prev = this.summaries.get(summary.sessionId);
    // 降级防御（stored→live 切换窗口）：冷恢复的 live 投影在 hydration 补齐
    // meta 之前 title 为空、record 时间可能被 resume 重置——store 种子里的
    // 稳定字段不得被降级值覆盖（否则侧栏表现为"原会话消失、冒出新任务"）。
    if (prev) {
      // sessions-index 读侧要区分“存储/协议物理标题”和“用户显式重命名”。
      // 冷恢复 live 投影在 hydration 补齐前可能只有 default/generated 标题；旧 seed 若已是
      // custom，不得被这类自动标题降级，否则侧边栏会把用户手动标题闪回生成标题。
      if (prev.titleSource === "custom" && summary.titleSource !== "custom") {
        summary.title = prev.title;
        summary.titleSource = prev.titleSource;
      } else if (!summary.title && prev.title) {
        summary.title = prev.title;
        // 旧 store seed 的 titleSource 可缺省；冷投影的
        // default 只是暂态值。保住标题时也要保住“字段缺省”，否则
        // summariesEqual 会产生一帧无产品变化的 upsert。
        if (prev.titleSource === undefined) {
          delete summary.titleSource;
        } else {
          summary.titleSource = prev.titleSource;
        }
      }
      if (prev.createdAt > 0 && summary.createdAt > prev.createdAt) {
        summary.createdAt = prev.createdAt;
      }
      if (!summary.lastAssistantPreview && prev.lastAssistantPreview) {
        summary.lastAssistantPreview = prev.lastAssistantPreview;
      }
      // 冷恢复的 live 投影在 hydration 完成前 phase 是初始 draft。
      // 会话一旦有过真实内容就不可能退回 draft；若用它覆盖非 draft 基线，
      // 打开一个历史任务就会广播一帧「completedSuccess→draft」纯降级 delta，
      // UI 列表行状态被清空、对应 workspace 列表整体重查（表现为"点开任务列表重新加载"）。
      // phase/sessionEnded/goalStatus 同窗口同源，一并保基线。
      if (summary.phase === "draft" && prev.phase !== "draft") {
        summary.phase = prev.phase;
        summary.sessionEnded = prev.sessionEnded;
        if (summary.goalStatus === undefined && prev.goalStatus !== undefined) {
          summary.goalStatus = prev.goalStatus;
        }
      }
    }
    if (prev && summariesEqual(prev, summary)) return [];
    this.summaries.set(summary.sessionId, summary);
    return [{ op: "session.upserted", session: summary }];
  }

  /** 直接放入一条 summary（冷启动/无 live projection 的 store 会话）。 */
  // 覆盖同 sessionId 的旧值且不产 delta；调用方负责在首次 snapshot 前完成 seed。
  seed(summary: SessionSummary): void {
    this.summaries.set(summary.sessionId, summary);
  }

  /**
   * 兼容迁移后的 store 重读只补齐缺失摘要；已有 live/seed 状态不能被冷存储默认态覆盖。
   * 返回 delta 供 publisher 推进 seq，并通知已经在线的列表订阅者。
   */
  // 仅当 sessionId 尚不存在时插入并返回 upsert；已存在则返回空数组（幂等）。
  insertSeedIfMissing(summary: SessionSummary): SessionsIndexDelta[] {
    if (this.summaries.has(summary.sessionId)) return [];
    this.summaries.set(summary.sessionId, summary);
    return [{ op: "session.upserted", session: summary }];
  }

  /** 移除某会话；命中则返回 remove delta。 */
  // 输出 session.removed；只改内存并交给 publisher 记账，不触发任何持久化删除。
  remove(sessionId: string): SessionsIndexDelta[] {
    if (!this.summaries.has(sessionId)) return [];
    this.summaries.delete(sessionId);
    return [{ op: "session.removed", sessionId }];
  }

  /**
   * 会话是否已在索引中。只读、无副作用，用于 publisher/gateway 判断是否需要补种。
   */
  has(sessionId: string): boolean {
    return this.summaries.has(sessionId);
  }

  /** 当前全量快照（sessions 无序，排序是客户端逻辑）。 */
  // 携带 workspaceId 与 logEpoch 作为客户端丢弃陈旧读/跨代际恢复的依据；
  // 不包含 seq——seq 由 publisher 在打帧时统一注入。
  getSnapshot(): SessionsIndexSnapshot {
    return {
      protocolVersion: 1,
      workspaceId: this.workspaceId,
      logEpoch: this.logEpoch,
      sessions: [...this.summaries.values()],
    };
  }
}
