// INV-01 行键由工作区键加 taskId 组成：守住位置 buildWebRemoteControlTaskRowKey；改错故障 跨工作区同 id 撞键。
// INV-02 跨区判定只比工作区键：守住位置 两个 resolve 结果；改错故障 同路径不同身份被误判为同区。
// INV-03 打开动作先通知调用方跨区与否：守住位置 onTaskOpen 的位置；改错故障 UI 在切换中途才知道要收起面板。
// INV-04 同区路径不看未读配置：守住位置 markTaskReadOnOpen 条件；改错故障 每次打开都写未读。
// INV-05 未读写入失败只告警：守住位置 logReadFailure；改错故障 用户因标记失败打不开任务。
// INV-06 未读是即发即忘：守住位置 void 与 catch；改错故障 打开动作被网络请求阻塞。
// INV-07 查看状态更新失败不影响打开：守住位置 try/catch；改错故障 手机端状态失败导致回不到聊天。
// INV-08 跨区先置切换态再请求：守住位置 onSwitchingChange 顺序；改错故障 切换期间仍可重复点击。
// INV-09 错误对象优先取 message：守住位置 对象判定；改错故障 bridge 拒绝原因被 String 成对象字符串。
// INV-10 失败必须复位切换态：守住位置 catch 内两处回调；改错故障 骨架屏永久卡住。
// INV-11 断连错误退回首页：守住位置 文本匹配分支；改错故障 用户卡在错误页看不到重连按钮。
// INV-12 其他错误交给调用方展示：守住位置 setError；改错故障 错误被静默吞掉。
// INV-13 可选参数透传不补默认值：守住位置 switchWorkspace 的对象展开；改错故障 未提供的字段被写成 undefined。
// INV-14 taskHostId 仅在有 hostId 时传：守住位置 条件展开；改错故障 空串 host 覆盖已有路由。
//
// 模块职责：从手机端远控列表打开指定 task，必要时先切换远控工作区。
// 阅读顺序：先看跨区判定与同区分支，再看跨区切换与失败降级。
import type {
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlTaskTarget,
} from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import { logger } from "@/logger.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

export function buildWebRemoteControlTaskRowKey(task: WebRemoteControlTaskTarget): string {
  return `${resolveWebRemoteControlWorkspaceKey(task)}:${task.taskId}`;
}

interface OpenWebRemoteControlTaskOptions {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  task: WebRemoteControlTaskTarget;
  markTaskReadOnOpen?: boolean;
  mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onNavigateToChat?: () => void;
  onTaskOpen?: (options: { crossWorkspace: boolean }) => void;
  onSwitchingChange?: (switching: boolean) => void;
  onNavigateHome?: () => void;
  setSwitchingTaskKey?: (taskKey: string | null) => void;
  setError?: (error: string | null) => void;
}

function isDisconnectedRemoteWorkspaceBridgeError(message: string): boolean {
  return message.includes("远程工作区尚未连接") || message.includes("请先重连");
}

// 同区与跨区分成两条完全独立的路径，共享的只有开头判定。
// 调用方通过回调接收切换态与错误，本函数不持有 UI 状态。
// 返回值固定为 void，打开是否成功靠回调表达。
export async function openWebRemoteControlTask({
  activeWorkspaceIdentity,
  activeWorkspacePath,
  markTaskReadOnOpen,
  mobileNavigationIntent,
  onNavigateHome,
  onNavigateToChat,
  onSelectTask,
  onSwitchingChange,
  onTaskOpen,
  setError,
  setSwitchingTaskKey,
  switcher,
  task,
}: OpenWebRemoteControlTaskOptions): Promise<void> {
  const activeWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath: activeWorkspacePath,
    workspaceIdentity: activeWorkspaceIdentity,
  });
  const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
  // activeWorkspaceKey 与 taskWorkspaceKey 都由 resolveWebRemoteControlWorkspaceKey 算出，后续跨区判断只比这两个键。
  // onTaskOpen 在任何请求之前回调，让面板先按 crossWorkspace 收起。
  // 同路径不同身份会被判为跨区，这是有意的保守策略。
  const isCrossWorkspace = taskWorkspaceKey !== activeWorkspaceKey;
  onTaskOpen?.({ crossWorkspace: isCrossWorkspace });

  if (!isCrossWorkspace) {
    // markTaskReadOnOpen、task.unreadAt 与 switcher.markTaskRead 三者同时具备才写未读，缺一个就跳过。
    // markTaskRead 失败只走 logger.warn，不阻断打开任务，蓝点由首页 tasks-index 快照恢复。
    // 这里显式调用 markTaskRead 表达已读，不能依赖桌面选择逻辑的 query cache 命中。
    if (markTaskReadOnOpen && typeof task.unreadAt === "number" && switcher.markTaskRead) {
      const logReadFailure = (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // 未读写入失败不能阻止用户打开任务；返回首页后由权威 tasks-index 快照恢复蓝点。
        logger.warn("[useWebRemoteControlTaskOpen] 标记手机端 task 已读失败", {
          error: message,
          taskId: task.taskId,
          workspaceKey: taskWorkspaceKey,
        });
      };
      try {
        // 修复原因：手机端项目侧栏的未读来自 Host 的 task 行快照，当前 Root 的 query cache
        // 可能尚未水合。这里显式表达“用户已查看”，不能继续依赖桌面选择逻辑的 cache 命中。
        void switcher.markTaskRead(task).catch(logReadFailure);
      } catch (err) {
        logReadFailure(err);
      }
    }
    onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
    try {
      await switcher.updateMobileViewState?.(taskWorkspaceKey, task.taskId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[useWebRemoteControlTaskOpen] 更新手机端查看状态失败", {
        error: message,
        taskId: task.taskId,
        workspaceKey: taskWorkspaceKey,
      });
    }
    onNavigateToChat?.();
    return;
  }

  const rowKey = buildWebRemoteControlTaskRowKey(task);
  onSwitchingChange?.(true);
  setSwitchingTaskKey?.(rowKey);
  setError?.(null);
  logger.info("[useWebRemoteControlTaskOpen] 开始切换远控 workspace", {
    taskId: task.taskId,
    workspaceKey: taskWorkspaceKey,
  });

  try {
    // 可选参数按条件展开，未提供的键不出现在请求里。
    // hostId 与跳转意图只在存在时透传，避免覆盖既有路由。
    // 未读时间随切换一起带过去，由切换侧完成已读。
    await switcher.switchWorkspace(taskWorkspaceKey, {
      taskId: task.taskId,
      ...(task.hostId ? { taskHostId: task.hostId } : {}),
      ...(mobileNavigationIntent ? { mobileNavigationIntent } : {}),
      ...(markTaskReadOnOpen && typeof task.unreadAt === "number"
        ? { markTaskReadExpectedUnreadAt: task.unreadAt }
        : {}),
    });
  } catch (err) {
    // bridge requester 拒绝的是保留 reason 的普通对象；直接 String 会丢掉错误文本。
    const message =
      err && typeof err === "object" && "message" in err && typeof err.message === "string"
        ? err.message
        : String(err);
    logger.error("[useWebRemoteControlTaskOpen] 打开远程 task 失败", {
      error: message,
      taskId: task.taskId,
      workspaceKey: taskWorkspaceKey,
    });
    setSwitchingTaskKey?.(null);
    onSwitchingChange?.(false);
    // isDisconnectedRemoteWorkspaceBridgeError 命中时调 onNavigateHome，让用户看到重连按钮而不是错误提示。
    // 其余错误交给调用方展示，函数本身不吞消息。
    if (isDisconnectedRemoteWorkspaceBridgeError(message)) {
      // Bugfix: 手机端重连后 workspace list 可能还没同步到新的 remoteSessionId，
      // 此时打开 task 会被 desktop main 拒绝创建 bridge。这里退回项目侧栏首页，
      // 让用户看到断开态和重连按钮，而不是停在聊天页错误提示里。
      onNavigateHome?.();
      return;
    }
    setError?.(message);
  }
}
