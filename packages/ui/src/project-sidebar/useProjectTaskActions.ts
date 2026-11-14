// INV-01 适配层不保存事实：守住位置 文件头注释；改错故障 侧栏另存一份状态，与 Host 分叉。
// INV-02 成功后才刷新：守住位置 每个 await refresh；改错故障 失败也刷新，出现无意义请求。
// INV-03 失败统一走 report：守住位置 catch 分支；改错故障 各处错误提示格式不一致。
// INV-04 失败返回 null：守住位置 每个 catch；改错故障 调用方需要额外 try/catch。
// INV-05 pin 先走外部钩子：守住位置 onPin 分支；改错故障 需要确认的场景被直接提交。
// INV-06 钩子存在时由它执行 commit：守住位置 await onPin；改错故障 commit 执行两次。
// INV-07 archive 只在本窗口清理一次：守住位置 removeTaskState；改错故障 主区残留已归档会话。
// INV-08 清理语义与 Header 一致：守住位置 !task.archived；改错故障 取消归档时误删状态。
// INV-09 标记已读带期望时间戳：守住位置 expectedUnreadAt；改错故障 并发下覆盖新的未读。
// INV-10 target 用 memo 固化：守住位置 useMemo；改错故障 每次渲染都重建回调与请求。
// INV-11 remoteSessionId 可为空：守住位置 解析 hook；改错故障 本地任务被要求远端会话。
// INV-12 回调依赖完整：守住位置 各依赖数组；改错故障 闭包拿到过期 task。
// INV-13 入参 id 未使用：守住位置 下划线参数；改错故障 误以为可按任意 id 操作。
// INV-14 只返回五个入口：守住位置 返回值；改错故障 service 泄漏到组件层。
//
// 模块职责：侧栏任务操作的 UI 适配，转调 Host 入口并处理提示与刷新。
// 阅读顺序：先看 target 与 mutate，再看 report，最后看五个动作的差异。
import { useCallback, useContext, useMemo } from "react";
import { mutateProjectTask, type ProjectTaskMutation } from "@/project-sidebar/task-mutation.js";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

/** UI 命令适配：复用原 Host 入口，成功后仅处理本窗口展示，不保存会话事实。 */
// 适配层只调用 Host 入口，不保存事实。
export function useProjectTaskActions(task: ProjectTask, refresh: () => Promise<void>) {
  const { zcodeTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  const { onPin } = useContext(ProjectTaskListContext);
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const { intl } = useZCodeIntl();
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    task.workspacePath,
    undefined,
    task.workspaceIdentity,
  );
  // 目标身份固化，避免回调依赖抖动。
  const target = useMemo(
    () => ({
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
      taskId: task.taskId,
    }),
    [task.workspacePath, task.workspaceIdentity, task.taskId],
  );
  // 统一注入 service、controller 与远端会话。
  const mutate = useCallback(
    (mutation: ProjectTaskMutation) =>
      mutateProjectTask({ service, controller }, target, mutation, remoteSessionId),
    [service, controller, target, remoteSessionId],
  );
  const report = useCallback(
    (kind: string, error: unknown) => {
      // 失败先记结构化日志。
      logger.error("[project-sidebar] 任务操作失败", { ...target, kind, error });
      // catch 里先记 logger.error，再由 kind 选对应 toast 文案提示用户。
      toast(intl.formatMessage({ id: `taskList.${kind}Failed` }));
    },
    [intl, target],
  );
  const rename = useCallback(
    async (_id: string, title: string) => {
      const result = await mutate({ kind: "rename", title });
      // mutate 成功后立即 await refresh()，保证列表与最新任务状态一致。
      await refresh();
      return result ?? null;
    },
    [mutate, refresh],
  );
  const pin = useCallback(
    async (_id: string, pinned: boolean) => {
      try {
        const commit = async () => {
          const result = await mutate({ kind: "pin", pinned });
          await refresh();
          return result ?? null;
        };
        // 外部钩子优先，便于插入确认流程。
        if (onPin) {
          // commit 由外部决定何时执行。
          await onPin(task, pinned, commit);
          return null;
        }
        return await commit();
      } catch (error) {
        // 失败只提示，不向上抛。
        report("pin", error);
        return null;
      }
    },
    [mutate, refresh, onPin, task, report],
  );
  const archive = useCallback(async () => {
    try {
      // 归档是取反操作，写回 archived: !task.archived，不能传固定值。
      const result = await mutate({ kind: "archive", archived: !task.archived });
      // 重构漏掉了归档后的 UI 清理，导致侧栏消失而主区继续显示；与 Header 保持同一语义。
      // 仅归档时清理本窗口任务态。
      if (!task.archived) removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
      await refresh();
      return result ?? null;
    } catch (error) {
      report("archive", error);
      return null;
    }
  }, [mutate, refresh, task, removeTaskState, report]);
  const unread = useCallback(
    async (_id: string, value: boolean) => {
      try {
        const result = await mutate(
          // 标记已读要带期望时间戳。
          value ? { kind: "mark-unread" } : { kind: "mark-read", expectedUnreadAt: task.unreadAt },
        );
        await refresh();
        return result ?? null;
      } catch (error) {
        report("markAsUnread", error);
        return null;
      }
    },
    [mutate, refresh, task.unreadAt, report],
  );
  // 只暴露五个入口，不泄漏 service。
  return { remoteSessionId, rename, pin, archive, unread };
}
