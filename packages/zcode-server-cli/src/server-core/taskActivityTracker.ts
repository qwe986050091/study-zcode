// INV-01 工作区键优先身份：守住位置 空值合并；改错故障 同路径不同身份互相覆盖。
// INV-02 键先修剪空白：守住位置 字符串修剪；改错故障 空白身份被当成有效键。
// INV-03 任务数按活跃会话汇总：守住位置 归约求和；改错故障 多工作区任务数漏算。
// INV-04 数量未变不广播：守住位置 相等早退；改错故障 每次事件都触发重渲染。
// INV-05 生命周期不可用时按身份移除：守住位置 双条件；改错故障 新运行时被旧事件移除。
// INV-06 重新上线先清旧记录：守住位置 移除调用；改错故障 旧订阅泄漏且重复计数。
// INV-07 订阅失败则不登记：守住位置 空值判断；改错故障 有记录无订阅，计数永不回落。
// INV-08 只有回合开始与结束改变活跃集：守住位置 类型分支；改错故障 其它事实误增任务。
// INV-09 未知事实直接忽略：守住位置 默认分支；改错故障 新增事实类型改变计数。
// INV-10 结束事件只删除对应会话：守住位置 集合删除；改错故障 并行任务被整批清空。
// INV-11 已销毁后不再处理事件：守住位置 状态判断；改错故障 销毁后仍写映射。
// INV-12 销毁幂等：守住位置 重复判断；改错故障 二次销毁抛错。
// INV-13 销毁逐项释放订阅：守住位置 遍历调用；改错故障 监听器悬挂。
// INV-14 销毁清空映射并归零：守住位置 清理顺序；改错故障 重启后残留任务。
// INV-15 变更事件随销毁释放：守住位置 发射器释放；改错故障 订阅者收到已注销事件。
// INV-16 运行任务带工作区目标：守住位置 展开合并；改错故障 任务缺少路径无法跳转。
// INV-17 读取任务不复用内部集合：守住位置 展开复制；改错故障 调用方修改影响内部状态。
// INV-18 计数读取为只读快照：守住位置 闭包变量；改错故障 调用方拿到可变引用。
//
// 模块职责：按工作区聚合代理运行时会话，投影运行中任务数与任务列表。
// 状态所有权：工作区映射与计数由工厂闭包持有。
// 阅读顺序：先看工作区键与计数发布，再看事实与生命周期处理，最后看返回值与销毁。
import type { SourceServerRunningTask } from "@zcode/shared";
import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";

// TaskActivityTracker 对外只暴露三项能力。
// onDidChangeRunningTaskCount 的 Event 只携带 number。
// readRunningTasks 返回 SourceServerRunningTask 快照。
export interface TaskActivityTracker extends IDisposable {
  readonly onDidChangeRunningTaskCount: Event<number>;
  readRunningTaskCount(): number;
  readRunningTasks(): SourceServerRunningTask[];
}

type AgentActivitySource = Pick<
  IZCodeAgentService,
  "onAgentRuntimeLifecycle" | "onDynamicConversationTelemetryFact"
>;

interface WorkspaceActivity {
  target: ZCodeAgentWorkspaceTarget;
  activeSessionIds: Set<string>;
  runtimeIdentity: string;
  telemetry: IDisposable;
}

function workspaceKey(target: ZCodeAgentWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

// changed 发射器只在数量变化时 fire。
// workspaces 映射以 workspaceKey 索引。
// 计数由 activeSessionIds 汇总得出。
// disposed 标记只置一次，之后事件全部忽略。
export function createTaskActivityTracker(
  source: AgentActivitySource | undefined,
): TaskActivityTracker {
  const changed = new Emitter<number>();
  const workspaces = new Map<string, WorkspaceActivity>();
  let runningTaskCount = 0;
  let disposed = false;

  const publishCount = (): void => {
    const next = [...workspaces.values()].reduce(
      (total, workspace) => total + workspace.activeSessionIds.size,
      0,
    );
    if (next === runningTaskCount) return;
    runningTaskCount = next;
    changed.fire(next);
  };

  const removeWorkspace = (key: string, runtimeIdentity?: string): void => {
    const current = workspaces.get(key);
    if (!current || (runtimeIdentity && current.runtimeIdentity !== runtimeIdentity)) return;
    current.telemetry.dispose();
    workspaces.delete(key);
    publishCount();
  };

  const acceptFact = (key: string, fact: ConversationTelemetryFact): void => {
    const workspace = workspaces.get(key);
    if (!workspace) return;
    if (fact.kind === "turn.started") {
      workspace.activeSessionIds.add(fact.sessionId);
    } else if (fact.kind === "turn.terminal") {
      workspace.activeSessionIds.delete(fact.sessionId);
    } else {
      return;
    }
    publishCount();
  };

  // disposed 为真时 acceptLifecycle 直接返回。
  // state 为 unavailable 时按 runtimeIdentity 移除。
  // 在线则先 dispose 旧 telemetry 再登记。
  const acceptLifecycle = (event: ZCodeAgentRuntimeLifecycleEvent): void => {
    if (disposed) return;
    const key = event.workspaceKey || workspaceKey(event);
    if (event.state === "unavailable") {
      removeWorkspace(key, event.runtimeIdentity.identity);
      return;
    }
    removeWorkspace(key);
    const activeSessionIds = new Set<string>();
    const telemetry = source?.onDynamicConversationTelemetryFact(event)((fact) => acceptFact(key, fact));
    if (!telemetry) return;
    workspaces.set(key, {
      activeSessionIds,
      target: {
        workspacePath: event.workspacePath,
        ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
      },
      runtimeIdentity: event.runtimeIdentity.identity,
      telemetry,
    });
  };

  const lifecycle = source?.onAgentRuntimeLifecycle?.(acceptLifecycle);
  return {
    onDidChangeRunningTaskCount: changed.event,
    readRunningTaskCount: () => runningTaskCount,
    readRunningTasks: () =>
      [...workspaces.values()].flatMap((workspace) =>
        [...workspace.activeSessionIds].map((sessionId) => ({ ...workspace.target, sessionId })),
      ),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      lifecycle?.dispose();
      for (const workspace of workspaces.values()) workspace.telemetry.dispose();
      workspaces.clear();
      runningTaskCount = 0;
      changed.dispose();
    },
  };
}
