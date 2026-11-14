// ============================================================
// workspace hook review 的端口与事件类型（controller 的契约面）
// ============================================================
// 本文件只有类型：review controller 依赖这些端口而非具体实现，宿主（TUI / 协议）负责发事件、
// 落盘信任记录与提交 bundle 编辑。字段口径以 workspaceIdentity 为作用域，remoteSessionId
// 只用于远端回显，不参与本地信任判定。

import {
  SessionEventType,
  type WorkspaceHookBundleSnapshot,
  type WorkspaceHookReasonCode,
  type WorkspaceHookTrustRecord,
  type Logger,
  type WorkspaceHookAdmissionUpdatedPayload,
} from "@zcode/contracts";
import type { WorkspaceHookRuntimeAdmissionPort, WorkspaceHookTrustCoordinator } from "@zcode/core";
import type { WorkspaceHookReviewRequestPayload } from "@zcode/shared/zcode-protocol-v4";

/**
 * 面板需要宿主投影的四种生命周期事件。
 *
 * Requested 带完整 review 请求；Settled 只带 interactionId 与终态（resolved / timed_out /
 * configuration_error）；Superseded 指出被哪一次新交互替换；AdmissionUpdated 是运行期准入
 * 快照变化。四种都由 host.emit 投递，顺序即 controller 的提交顺序。
 */
export type WorkspaceHookReviewLifecycleEvent =
  | {
      type: typeof SessionEventType.WorkspaceHookReviewRequested;
      payload: { request: WorkspaceHookReviewRequestPayload };
    }
  | {
      type: typeof SessionEventType.WorkspaceHookReviewSettled;
      payload: {
        interactionId: string;
        state: "resolved" | "timed_out" | "configuration_error";
        reasonCode?: string;
      };
    }
  | {
      type: typeof SessionEventType.WorkspaceHookReviewSuperseded;
      payload: { interactionId: string; supersededByInteractionId: string };
    }
  | {
      type: typeof SessionEventType.WorkspaceHookAdmissionUpdated;
      payload: WorkspaceHookAdmissionUpdatedPayload;
    };

/** controller 的宿主端口：身份字段用于日志/回显，emit 负责把生命周期事件送到前端。 */
export interface WorkspaceHookReviewHostPort {
  /** 当前任务 id；与 runId 一起定位一次执行。 */
  taskId: string;
  /** 当前 run id；与 taskId 共同构成日志/事件关联键。 */
  runId: string;
  /** 面板展示用的工作区标签，不是路径也不是身份键。 */
  workspaceLabel: string;
  /** 远端会话 id；仅远端宿主回显用，缺席即本地。 */
  remoteSessionId?: string;
  /** 把生命周期事件投递给前端；Promise reject 由 controller 决定是否记日志。 */
  emit(event: WorkspaceHookReviewLifecycleEvent): Promise<void>;
}

/** bundle 的启用开关写入面：由 implementation 负责原子落盘并回调已提交钩子。 */
export interface WorkspaceHookReviewMutationPort {
  /**
   * 切换单个 reviewItem 的启用状态；onWriteCommitted 在写盘成功后、返回快照前调用，
   * 让 controller 能在这个时点刷新内存投影。失败时 Promise reject，快照不可信。
   */
  toggle(
    input: {
      snapshot: WorkspaceHookBundleSnapshot;
      reviewItemId: string;
      enabled: boolean;
    },
    onWriteCommitted: () => void | Promise<void>,
  ): Promise<WorkspaceHookBundleSnapshot>;
}

/** 信任记录的持久化写面；grant/revoke 都返回写后的完整记录集，供内存表整体替换。 */
export interface WorkspaceHookTrustStoreMutationPort {
  /** 追加一批持久信任记录（按 digest 去重由实现负责）。 */
  grant(
    records: readonly WorkspaceHookTrustRecord[],
  ): Promise<{ records: WorkspaceHookTrustRecord[] }>;
  /** 删除工作区下指定 digest 的信任；省略 digests 即清空该工作区。 */
  revoke(input: {
    workspaceIdentity: string;
    hookDeclarationDigests?: readonly string[];
  }): Promise<{ records: WorkspaceHookTrustRecord[] }>;
}

/** 命令结果：接受时回显处理的 item id，拒绝时只回稳定的 reasonCode（不回错误文本）。 */
export type WorkspaceHookReviewCommandResult =
  | { accepted: true; reviewItemIds: string[] }
  | { accepted: false; reasonCode: WorkspaceHookReasonCode };

/** controller 的全部依赖；store 用 Promise 是因为存储由装配层异步打开。 */
export interface WorkspaceHookReviewControllerOptions {
  /** 运行期准入端口：决定当前 hook 是否允许执行。 */
  admission: WorkspaceHookRuntimeAdmissionPort;
  /** 应用版本，用于 review 请求与日志；缺席时由 controller 省略该字段。 */
  appVersion?: string;
  /** 信任策略与内存信任表的唯一协调者。 */
  coordinator: WorkspaceHookTrustCoordinator;
  host: WorkspaceHookReviewHostPort;
  logger?: Logger;
  /** bundle 开关写入面。 */
  mutation: WorkspaceHookReviewMutationPort;
  /** 会话身份；flow registry 按 sessionId 隔离当前交互。 */
  sessionId: string;
  /** 信任存储；打开失败会让 revoke/grant 走 store_corrupt 路径。 */
  store: Promise<WorkspaceHookTrustStoreMutationPort>;
  /** 可注入时钟，测试固定超时/时间戳；生产用默认 Date.now。 */
  now?: () => number;
  /** 可注入 id 生成器，测试固定 interactionId；生产用默认 UUID。 */
  createId?: () => string;
}
