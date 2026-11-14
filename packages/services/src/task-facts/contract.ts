// 任务事实端口契约：把「谁产生事实」与「事实存哪里」分开，CLI 侧产生、存储侧落盘，
// Host 不再从时钟或运行态推导会话事实。
// 这些类型同时被存储实现与编排层引用，新增字段需评估两侧兼容性。
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import type { SessionSummary, SessionsIndexReconcileResult } from "@zcode/shared/zcode-protocol-v4";

// 工作区定位统一为 workspacePath + 可选 workspaceIdentity：
// 路径用于文件与进程操作，identity 用于跨主机去重和缓存键，二者不可互相替代。
export interface TaskWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}
// 单任务操作在工作区之上再限定 taskId，免去调用方自行拼接路径与 id 的组合键。
export interface TaskFactTarget extends TaskWorkspace {
  taskId: string;
}
// 目前只有重命名与删除两类变更；用联合类型而非 type + payload，
// 新增动作时编译期就会要求补齐分支，防止未知意图被静默忽略。
export type TaskFactMutation = { type: "rename"; title: string } | { type: "delete" };
// CLI 上报的事实快照，三个可选字段表达「本次未提供」而非「置空」，
// 存储侧据此决定是否覆盖已有值，避免缺省字段把旧数据抹掉。
export interface CliTaskFacts {
  meta: ZCodeTaskMeta;
  titleSource?: string;
  lastOutcome?: "completed" | "interrupted" | "error";
  deleted?: boolean;
}

/** 存储端口只接受 CLI 事实，不能据 Host 时钟或运行态推导会话事实。 */
export interface TaskFactStore {
  applyCliFacts(facts: CliTaskFacts): Promise<ZCodeTaskMeta>;
// 删除与 orphan 标记分开：前者是用户明确删除，后者只是索引失联，两者不能互相替代。
  applyCliDeletion(target: TaskFactTarget): Promise<void>;
  markCliOrphan(target: TaskFactTarget): Promise<void>;
  listReconciliationRows(
    target: TaskWorkspace,
  ): Promise<Array<{ meta: ZCodeTaskMeta; handoffPending: number }>>;
  getTaskMeta(target: TaskFactTarget): Promise<ZCodeTaskMeta | null>;
}
// Source 抽象「事实从哪来」：reconcile 对账会话索引，execute 执行具体意图；
// 实现可能在本地也可能在远程，编排层不关心其物理位置。
export interface TaskFactSource {
  reconcile(target: TaskWorkspace, sessionIds: string[]): Promise<SessionsIndexReconcileResult>;
  execute(target: TaskFactTarget, intent: TaskFactMutation): Promise<void>;
}
// 变更通知里 meta 可选：删除场景没有 meta，接收方需容忍缺省；
// reason 复用协议层枚举，保证两端对「为什么变」的理解一致。
export interface TaskFactChange {
  target: TaskFactTarget;
  meta?: ZCodeTaskMeta;
  reason: ZCodeWorkspaceTaskListChanged["reason"];
}
// 编排层对外暴露的统一门面：摄取、移除、刷新、变更四类操作，
// 均以 target 为作用域，只回传任务元数据而不泄漏内部存储细节。
export interface TaskFactsContract {
  ingest(target: TaskWorkspace, summary: SessionSummary): Promise<ZCodeTaskMeta>;
  removed(target: TaskFactTarget): Promise<void>;
  refresh(target: TaskFactTarget): Promise<ZCodeTaskMeta | null>;
  mutate(target: TaskFactTarget, intent: TaskFactMutation): Promise<ZCodeTaskMeta | null>;
  reconcile(
    target: TaskWorkspace,
    presentSessionIds: ReadonlySet<string>,
    stillCurrent: () => boolean,
  ): Promise<void>;
}

/** 冷恢复仅按 CLI 身份清理 child 派生索引，不创建运行时或改写会话正文。 */
export interface SubagentIndexRepair {
  target: TaskWorkspace;
  visibleSessionIds: ReadonlySet<string>;
  agentService: {
    listSessions(
      target: TaskWorkspace & { sessionIds: string[]; runtimePolicy: "existing-only" },
    ): Promise<Array<{ sessionId: string; sessionKind?: string; workspace: TaskWorkspace }>>;
  };
  taskIndexRepo: {
    listTaskMetas(target: TaskWorkspace): Promise<Array<{ taskId: string }>>;
    removeSubagentIndexRow(target: TaskFactTarget): Promise<unknown>;
  };
  isCurrent: () => boolean;
  onRemoved: () => void;
}
