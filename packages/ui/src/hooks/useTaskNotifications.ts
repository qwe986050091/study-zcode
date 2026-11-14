// INV-01 工作区签名必须唯一标识端点与工作区：守住位置 签名构造；改错故障 切换工作区后通知串台。
// INV-02 签名使用不可见字符连接避免碰撞：守住位置 连接分隔符；改错故障 路径含分隔符时签名相同。
// INV-03 签名变化必须重置基线并清空索引状态：守住位置 第一个副作用；改错故障 新工作区立刻推送旧任务通知。
// INV-04 未启用、未就绪或无平台时不得订阅：守住位置 订阅前判断；改错故障 断连代理被提前访问。
// INV-05 关闭条件命中时同时清空已观察基线：守住位置 早退分支；改错故障 下次开启误报历史任务。
// INV-06 索引获取必须配对释放：守住位置 获取与释放调用；改错故障 引用计数泄漏。
// INV-07 订阅必须先同步一次当前状态：守住位置 同步调用；改错故障 首个快照丢失。
// INV-08 只处理签名与当前一致的状态：守住位置 签名比较；改错故障 旧工作区状态触发通知。
// INV-09 只有就绪状态才产生终态通知：守住位置 状态判断；改错故障 部分加载时误报完成。
// INV-10 首次快照只作为基线不发通知：守住位置 基线空判断；改错故障 恢复会话时重放历史通知。
// INV-11 基线按会话标识建映射：守住位置 会话映射构造；改错故障 同会话多份摘要重复通知。
// INV-12 每次处理后都要推进基线：守住位置 末尾赋值；改错故障 同一终态重复通知。
// INV-13 通知失败不得中断后续通知：守住位置 发送函数的捕获；改错故障 一次失败丢掉整批。
// INV-14 交互通知按会话区分已见集合：守住位置 会话标识比较；改错故障 切换会话后旧请求被当成新请求。
// INV-15 会话变化时重建已见集合并直接返回：守住位置 重建分支；改错故障 首次快照重复通知。
// INV-16 已见集合只追加不删除：守住位置 末尾逐条写入；改错故障 同一交互反复通知。
// INV-17 平台缺失时仍要推进已见集合：守住位置 平台判断之外的写入；改错故障 后续补上平台时补发旧通知。
// INV-18 是否因窗口活跃被抑制由平台层决定：守住位置 本 hook 职责边界；改错故障 渲染层重复实现抑制逻辑。
//
// 模块职责：把会话索引与阻塞交互的边沿变化翻译为平台系统通知。
// 状态所有权：索引快照与已观察基线由本 hook 持有；事实来源是共享会话索引。
// 阅读顺序：先看签名与索引订阅，再读终态通知基线推进，最后看交互通知去重。
import { useEffect, useMemo, useRef, useState } from "react";
import type { IPlatformService, TaskNotificationPayload } from "@zcode/shared";
import type { ConversationSnapshot, SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import type { IntlInstance } from "@/i18n/index.js";
import { logger } from "@/logger.js";
import {
  collectPendingInteractionNotificationPayloads,
  collectTerminalTaskNotificationPayloads,
} from "@/lib/taskNotificationOrchestrator.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStoreStatus } from "@/v4/sessionsIndexStore.js";

type FormatMessage = IntlInstance["formatMessage"];
type TaskNotificationPlatform = Pick<IPlatformService, "showTaskNotification">;

interface WorkspaceTerminalTaskNotificationsParams {
  workspacePath: string;
  workspaceIdentity?: string;
  endpointKey?: string | null;
  enabled: boolean;
  rpcReady: boolean;
  platform: TaskNotificationPlatform | null | undefined;
  formatMessage: FormatMessage;
}

interface PendingInteractionTaskNotificationsParams {
  snapshot: ConversationSnapshot | null;
  enabled: boolean;
  platform: TaskNotificationPlatform | null | undefined;
  formatMessage: FormatMessage;
}

interface SessionsIndexNotificationState {
  signature: string;
  sessions: readonly SessionSummary[];
  status: SessionsIndexStoreStatus;
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// buildWorkspaceNotificationSignature 用 [endpointKey ?? "__base__", workspaceIdentity ?? "", workspacePath] 三段 join("\0")：
// endpointKey 缺失时的 "__base__" 是固定哨兵，不能改成空串，否则「无端点」和「端点名为空」会撞成同一签名；
// "\0" 不出现在路径里，避免 workspacePath 含分隔符时拼接结果相同（INV-02）；结果只用于比较，不参与展示。
function buildWorkspaceNotificationSignature(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  endpointKey?: string;
}): string {
  return [
    params.endpointKey ?? "__base__",
    params.workspaceIdentity ?? "",
    params.workspacePath,
  ].join("\0");
}

function toSessionMap(sessions: readonly SessionSummary[]): Map<string, SessionSummary> {
  return new Map(sessions.map((session) => [session.sessionId, session]));
}

function showTaskNotification(
  platform: TaskNotificationPlatform,
  payload: TaskNotificationPayload,
): void {
  try {
    platform.showTaskNotification(payload);
  } catch (error) {
    logger.warn("[task-notification] 触发平台通知失败", {
      taskId: payload.taskId,
      status: payload.status,
      error,
    });
  }
}

/**
 * v4 任务终态通知编排。
 *
 * v4 重构删掉旧 renderer background monitor 后，platform 通知通道仍在，
 * 但 sessions-index 事实没有再被翻译成展示命令，导致任务完成/失败没有系统通知。
 * 这里只在 renderer 做“已观察边沿”的通知意图，事实仍以 sessions-index 为准；
 * 是否因窗口活跃而抑制通知继续交给 desktop/web platform 层判断。
 */
// 身份与端点先经 trimOptional 去空白：空串等价于缺失，避免 "" 与 undefined 生成两个签名导致重复订阅；
// workspaceKey 优先 workspaceIdentity、其次 workspacePath，仅用于 sessions-index 作用域，与 signature 的三段拼接不同；
// signature 用 useMemo 随 [endpointKey, workspaceIdentity, workspacePath] 重算，indexState 按 signature 隔离。
export function useWorkspaceTerminalTaskNotifications({
  workspacePath,
  workspaceIdentity: rawWorkspaceIdentity,
  endpointKey: rawEndpointKey,
  enabled,
  rpcReady,
  platform,
  formatMessage,
}: WorkspaceTerminalTaskNotificationsParams): void {
  const { zcodeAgentService } = useServices();
  const workspaceIdentity = trimOptional(rawWorkspaceIdentity);
  const endpointKey = trimOptional(rawEndpointKey);
  const workspaceKey = workspaceIdentity ?? workspacePath;
  const signature = useMemo(
    () =>
      buildWorkspaceNotificationSignature({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(endpointKey ? { endpointKey } : {}),
      }),
    [endpointKey, workspaceIdentity, workspacePath],
  );
  const [indexState, setIndexState] = useState<SessionsIndexNotificationState>({
    signature,
    sessions: [],
    status: "idle",
  });
  const previousBySessionIdRef = useRef<Map<string, SessionSummary> | null>(null);

  useEffect(() => {
    previousBySessionIdRef.current = null;
    setIndexState({ signature, sessions: [], status: "idle" });
  }, [signature]);

  useEffect(() => {
    if (!enabled || !rpcReady || !platform) {
      // App 壳在 remote attachment 就绪前会先挂载，旧通知 hook
      // 只看用户开关就订阅 sessions-index，从而越过 conversation 的 readiness gate
      // 访问断连代理。这里共用 workspace rpcReady；本地 workspace 始终为 true。
      previousBySessionIdRef.current = null;
      setIndexState({ signature, sessions: [], status: "idle" });
      return;
    }

    // registryScope 携带 workspaceKey/workspacePath 与可选 workspaceIdentity/endpointKey——可选字段只在存在时展开，
    // 让同一工作区不同端点拿到不同共享 store；acquireSessionsIndex 返回后必须配对 releaseSessionsIndex(registryScope, store)，
    // 否则引用计数不减（INV-06）；syncState 同时读 getSessions() 与 getStatus()，订阅回调直接覆盖整份 indexState。
    const registryScope: SessionsIndexScope = {
      workspaceKey,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(endpointKey ? { endpointKey } : {}),
    };
    const store = acquireSessionsIndex(registryScope, zcodeAgentService);
    const syncState = () => {
      setIndexState({
        signature,
        sessions: store.getSessions(),
        status: store.getStatus(),
      });
    };
    const unsubscribe = store.subscribe(syncState);
    syncState();

    return () => {
      unsubscribe();
      releaseSessionsIndex(registryScope, store);
    };
  }, [
    enabled,
    endpointKey,
    platform,
    rpcReady,
    signature,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeAgentService,
  ]);

  useEffect(() => {
    if (
      !enabled ||
      !platform ||
      indexState.signature !== signature ||
      indexState.status !== "live"
    ) {
      return;
    }

    const previousBySessionId = previousBySessionIdRef.current;
    const nextBySessionId = toSessionMap(indexState.sessions);
    if (!previousBySessionId) {
      previousBySessionIdRef.current = nextBySessionId;
      return;
    }

    // collectTerminalTaskNotificationPayloads 用 previousBySessionId 与当前 sessions 计算边沿，逐条 showTaskNotification；
    // 单条发送失败被 showTaskNotification 内部 catch 吞掉（INV-13），循环不会中断；
    // 无论 payloads 是否为空都执行 previousBySessionIdRef.current = nextBySessionId，同一终态才不会重复通知（INV-12）。
    const payloads = collectTerminalTaskNotificationPayloads({
      previousBySessionId,
      sessions: indexState.sessions,
      formatMessage,
    });
    for (const payload of payloads) {
      showTaskNotification(platform, payload);
    }
    previousBySessionIdRef.current = nextBySessionId;
  }, [enabled, formatMessage, indexState, platform, signature]);
}

/**
 * 当前 conversation snapshot 的阻塞交互通知。
 *
 * 首个 snapshot 只作为基线，避免订阅历史/恢复 replayable snapshot 时重放旧权限弹窗通知；
 * 后续新增 interactionId 才发通知，重复 pending 不会刷屏。
 */
// 未启用或 snapshot 为空时 seenRef 置 null；首次看到某 sessionId 只建 { sessionId, seenRequestIds } 基线并 return，
// 恢复 replayable snapshot 时不会重放旧权限弹窗；
// 同一会话后续才把 pendingInteractions 交给 collectPendingInteractionNotificationPayloads，
// 且 platform 缺失也照常把 interactionId 写入 seenRequestIds（INV-17），补上平台时不补发旧通知。
export function usePendingInteractionTaskNotifications({
  snapshot,
  enabled,
  platform,
  formatMessage,
}: PendingInteractionTaskNotificationsParams): void {
  const seenRef = useRef<{ sessionId: string; seenRequestIds: Set<string> } | null>(null);

  useEffect(() => {
    if (!enabled || !snapshot) {
      seenRef.current = null;
      return;
    }

    const currentRequestIds = snapshot.pendingInteractions.map(
      (interaction) => interaction.interactionId,
    );
    const currentSeen = seenRef.current;
    if (!currentSeen || currentSeen.sessionId !== snapshot.sessionId) {
      seenRef.current = {
        sessionId: snapshot.sessionId,
        seenRequestIds: new Set(currentRequestIds),
      };
      return;
    }

    if (platform) {
      const payloads = collectPendingInteractionNotificationPayloads({
        snapshot,
        seenRequestIds: currentSeen.seenRequestIds,
        formatMessage,
      });
      for (const payload of payloads) {
        showTaskNotification(platform, payload);
      }
    }

    for (const requestId of currentRequestIds) {
      currentSeen.seenRequestIds.add(requestId);
    }
  }, [enabled, formatMessage, platform, snapshot]);
}
