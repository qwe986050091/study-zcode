// INV-01 回调不随渲染重建：守住位置 空依赖数组；改错故障 每次渲染换函数导致子表重订阅。
// INV-02 最新入参放引用：守住位置 布局效果；改错故障 点击拿到上一帧目录。
// INV-03 卸载自增序号：守住位置 清理函数；改错故障 卸载后仍继续远程连接。
// INV-04 请求序号在发起时自增：守住位置 首行自增；改错故障 两次点击互相覆盖。
// INV-05 当前性同时比较身份与任务：守住位置 多项与运算；改错故障 切任务后旧连接夺回焦点。
// INV-06 当前性比较草稿版本：守住位置 版本字段；改错故障 新草稿被旧结果覆盖。
// INV-07 绑定任务必须同工作区：守住位置 双字段比较；改错故障 同名任务绑到别的工作区。
// INV-08 远端模式优先走远控：守住位置 分支顺序；改错故障 远端工作区落到本地打开。
// INV-09 任务缺失时明确报错：守住位置 空值判断；改错故障 点击之后毫无反应。
// INV-10 目录读取后才连接：守住位置 语句顺序；改错故障 主机不在列表仍尝试连接。
// INV-11 连接前再验当前性：守住位置 条件早退；改错故障 切走后仍建立会话。
// INV-12 会话查找按工作区身份：守住位置 查找谓词；改错故障 复用错误会话。
// INV-13 绑定回调透传守卫：守住位置 参数位置；改错故障 选项目标绕过当前性检查。
// INV-14 未走远端时落到通用选择：守住位置 末尾调用；改错故障 本地任务无法打开。
// INV-15 错误同时记日志与提示：守住位置 两处调用；改错故障 用户只看到空白。
// INV-16 打开失败不吞异常：守住位置 捕获分支；改错故障 未处理拒绝冒到全局。
// INV-17 只读导航不改列表：守住位置 职责边界；改错故障 打开任务触发列表刷新。
// INV-18 远控切换回调可缺省：守住位置 可选属性；改错故障 无宿主时调用即崩溃。
//
// 模块职责：项目侧栏点任务时的导航流程，含远控与远端会话两种分支。
// 状态所有权：序号与最新入参保存在引用里，不产生渲染态。
// 阅读顺序：先看稳定回调与引用同步，再看当前性判定，最后看打开流程。
import { useCallback, useLayoutEffect, useRef } from "react";
import type {
  ProjectSidebarProps,
  ProjectTree,
  IRemoteProjectService,
} from "@/project-sidebar/contract.js";
import { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { openWebRemoteControlTask } from "@/hooks/useWebRemoteControlTaskOpen.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";

/** 打开任务才绑定 workspace；列表 mutation 不借导航创建 scope。 */
// onSelectTask 由 useCallback 保持稳定引用
// latest.current 保存最新入参
// 卸载时 sequence.current++ 作废在途请求
// 打开流程只读 tree，不改列表
export function useProjectTaskNavigation(
  props: ProjectSidebarProps,
  tree: ProjectTree,
  remoteService?: IRemoteProjectService,
): ProjectSidebarProps["onSelectTask"] {
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const sequence = useRef(0);
  useLayoutEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const latest = useRef({ props, tree, remoteService, activeWorkspaceIdentity });
  useLayoutEffect(() => {
    latest.current = { props, tree, remoteService, activeWorkspaceIdentity };
  });
  return useCallback((path, taskId, identity, remoteSessionId, unreadAt) => {
    const request = ++sequence.current;
    const { props, tree, remoteService, activeWorkspaceIdentity } = latest.current;
    const readFocus = () =>
      props.workspacePath
        ? useZCodeSessionStore
            .getState()
            .getWorkspaceState(props.workspacePath, activeWorkspaceIdentity ?? undefined)
        : undefined;
    const originFocus = readFocus();
    // 同一目录内切换任务或新草稿也会使旧连接失效，不能仅比较 workspace 身份。
    // isCurrent 先比 sequence.current === request
    // 再比 activeWorkspaceIdentity 与 activeTaskId
    // draftFocusVersion 变化即视为过期
    // identity 存在时还要求任务仍在本工作区
    const isCurrent = () =>
      sequence.current === request &&
      latest.current.activeWorkspaceIdentity === activeWorkspaceIdentity &&
      readFocus()?.activeTaskId === originFocus?.activeTaskId &&
      readFocus()?.draftFocusVersion === originFocus?.draftFocusVersion &&
      (!identity ||
        latest.current.tree.tasks.some(
          (task) => task.taskId === taskId && task.workspaceIdentity === identity,
        ));
    // webRemoteControlWorkspaceSwitcher 存在时优先走远控
    // 读 tree 确认 host 后才调 openWebRemoteControlTask
    // 连接前再调 isCurrent() 复核
    const open = async () => {
      const task = tree.tasks.find(
        (item) =>
          item.taskId === taskId &&
          (item.workspaceIdentity || item.workspacePath) === (identity || path),
      );
      if (props.webRemoteControlWorkspaceSwitcher) {
        if (!task) throw new Error("project.task-not-found");
        await openWebRemoteControlTask({
          switcher: props.webRemoteControlWorkspaceSwitcher,
          activeWorkspacePath: props.workspacePath,
          activeWorkspaceIdentity: activeWorkspaceIdentity ?? undefined,
          activeTaskId: null,
          task: {
            ...task,
            workspacePath: path,
            workspaceIdentity: identity,
            taskId,
            unreadAt,
            workspaceLabel: path,
            workspaceKind: task.hostId === "local" ? "local" : "remote",
          },
          markTaskReadOnOpen: true,
          mobileNavigationIntent: "chat",
          onSelectTask: props.onSelectTask,
          onTaskOpen: props.onWebRemoteTaskOpen,
          onSwitchingChange: props.onWebRemoteTaskSwitchingChange,
          setError: (error) => {
            if (error) toast(error);
          },
        });
        return;
      }
      if (identity && task && remoteService) {
        const directory = await remoteService.readDirectory();
        if (!isCurrent()) return;
        if (directory.hosts.some((host) => host.id === task.hostId)) {
          remoteSessionId = await attachRemoteProjectWorkspace({
            hostId: task.hostId,
            workspacePath: path,
            workspaceIdentity: identity,
            remoteService,
            isCurrent,
            findSession: (key) =>
              Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
                (session) => session.workspaceIdentity === key,
              ),
            connect: props.onConnectRemote,
            bind: (sessionId, workspacePath, guard) =>
              props.onSelectRemoteProject(sessionId, workspacePath, undefined, identity, guard),
            cancel: props.onCancelRemoteProject,
          });
        }
      }
      props.onSelectTask(path, taskId, identity, remoteSessionId, unreadAt);
    };
    void open().catch((error) => {
      logger.error("[project-sidebar] 打开任务失败", error);
      toast(String(error));
    });
  }, []);
}
