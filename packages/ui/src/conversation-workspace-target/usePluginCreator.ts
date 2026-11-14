// INV-01 目标解析与远端模式一致：守住位置 同参数构造；改错故障 远端面板创建到本地分组。
// INV-02 作用域引用标识一次调用：守住位置 引用对象；改错故障 旧调用覆盖新一轮忙碌态。
// INV-03 卸载后不写忙碌态：守住位置 作用域标记；改错故障 卸载后更新状态告警。
// INV-04 重复触发直接忽略：守住位置 引用比较；改错故障 连点创建出两个任务。
// INV-05 无目标或无回调不可用：守住位置 布尔返回；改错故障 按钮可点但无反应。
// INV-06 通道未就绪时提示：守住位置 就绪判断；改错故障 静默失败没有任何反馈。
// INV-07 创建前重算当前目标：守住位置 实时解析；改错故障 切工作区后建到旧目录。
// INV-08 只读工作区阻止创建：守住位置 只读判断；改错故障 只读工作区仍可建任务。
// INV-09 预填加载带当前性检查：守住位置 第二参数；改错故障 过期预填覆盖新请求。
// INV-10 预填为空不创建：守住位置 空值判断；改错故障 打开空任务面板。
// INV-11 创建请求带目标键：守住位置 展开字段；改错故障 任务落到错误工作区。
// INV-12 技能清单按目标查询：守住位置 入参三字段；改错故障 技能来自上一个工作区。
// INV-13 失败按当前性决定提示：守住位置 条件判断；改错故障 切走后仍弹失败提示。
// INV-14 失败日志带工作区键：守住位置 日志字段；改错故障 无法定位失败工作区。
// INV-15 结束后清理在途引用：守住位置 引用比较；改错故障 后续调用被误判为重复。
// INV-16 结束后只在有效作用域复位：守住位置 作用域判断；改错故障 卸载后复位告警。
// INV-17 缓存依赖覆盖全部输入：守住位置 依赖数组；改错故障 切换远端模式后作用域不更新。
// INV-18 忙碌态按作用域比较：守住位置 引用相等；改错故障 两个面板同时显示忙碌。
//
// 模块职责：在会话工作区里发起「创建插件」任务并解析技能预填。
// 状态所有权：忙碌与在途标记由本 hook 持有，目标来自工作区与分组状态。
// 阅读顺序：先看目标解析，再看作用域，最后看创建流程。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { loadPluginCreatorPrefill } from "@/settings/pluginCreatorPrefill.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { INITIAL_PANE_LAYOUT, usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { resolveWorkbenchNewTaskTarget } from "@/conversation-workspace-target/workbenchTarget.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

// create 与 busyScope 忙碌态一起从 usePluginCreator 返回。
// isWebRemoteControl 为真时 group 与 paneLayout 都取缺省值。
// scope 的可用性由 target 与 onCreateTask 共同决定。
// hook 不直接打开界面。
export function usePluginCreator(
  onCreateTask: ((request?: CreateTaskRequest) => void) | undefined,
  isWebRemoteControl = false,
) {
  const { intl } = useZCodeIntl();
  const tabStore = useTabStoreApi();
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const paneLayout = usePaneLayoutStore((state) => state);
  const group = useWorkbenchGroupStore((state) =>
    state.activeGroupId ? (state.groups[state.activeGroupId] ?? null) : null,
  );
  // 目标解析与创建时都调用 resolveWorkbenchNewTaskTarget。
  // 远端模式把 paneLayout 回退为 INITIAL_PANE_LAYOUT。
  // targetKey 优先取 workspaceIdentity，缺失才回落到 workspacePath。
  const target = resolveWorkbenchNewTaskTarget({
    activeWorkspacePath,
    activeWorkspaceIdentity,
    activeGroup: isWebRemoteControl ? null : group,
    paneLayout: isWebRemoteControl ? INITIAL_PANE_LAYOUT : paneLayout,
  });
  const targetKey = target?.workspaceIdentity?.trim() || target?.workspacePath || "";
  const resolution = useWorkspaceServicesResolution(
    target?.workspacePath,
    undefined,
    target?.workspaceIdentity,
  );
  const scope = useMemo(
    () => ({ active: true }),
    [targetKey, resolution.services, resolution.remoteSessionId, resolution.rpcReady, onCreateTask],
  );
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);
  const pending = useRef<object | null>(null);
  const [busyScope, setBusyScope] = useState<object | null>(null);
  // pending.current 等于 scope 时直接忽略重复触发。
  // resolution.rpcReady 为假时用 toast 给出提示。
  // loadPluginCreatorPrefill 返回空时不创建任务。
  // 结束后按 scope 作用域清理 pending 与 busyScope。
  const create = useCallback(async () => {
    if (pending.current === scope || !target || !onCreateTask) return;
    if (!resolution.rpcReady) {
      toast(intl.formatMessage({ id: "pluginCreator.unavailable" }), { variant: "warning" });
      return;
    }
    const isCurrent = () => {
      const state = tabStore.getState();
      const groups = useWorkbenchGroupStore.getState();
      const current = resolveWorkbenchNewTaskTarget({
        activeWorkspacePath: state.activeWorkspacePath,
        activeWorkspaceIdentity: state.activeWorkspaceIdentity,
        activeGroup:
          !isWebRemoteControl && groups.activeGroupId
            ? (groups.groups[groups.activeGroupId] ?? null)
            : null,
        paneLayout: isWebRemoteControl ? INITIAL_PANE_LAYOUT : usePaneLayoutStore.getState(),
      });
      return (
        scope.active &&
        (current?.workspaceIdentity?.trim() || current?.workspacePath || "") === targetKey &&
        !isWorkspaceReadOnly(state, target.workspacePath, target.workspaceIdentity)
      );
    };
    pending.current = scope;
    setBusyScope(scope);
    try {
      const prefill = await loadPluginCreatorPrefill(
        () =>
          resolution.services.skillsService.list({
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            provider: ZCODE_AGENT_PROVIDER,
          }),
        isCurrent,
      );
      if (prefill) {
        logger.info("[PluginCreator] 已解析创建技能", { workspaceKey: targetKey });
        onCreateTask({ ...prefill, expectedWorkspaceKey: targetKey });
      }
    } catch (error) {
      if (isCurrent()) {
        logger.warn("[PluginCreator] 创建技能不可用", {
          error: error instanceof Error ? error.message : String(error),
          workspaceKey: targetKey,
        });
        toast(intl.formatMessage({ id: "pluginCreator.unavailable" }), { variant: "warning" });
      }
    } finally {
      if (pending.current === scope) pending.current = null;
      if (scope.active) setBusyScope(null);
    }
  }, [intl, isWebRemoteControl, onCreateTask, resolution, scope, tabStore, target, targetKey]);
  return { create, busy: busyScope === scope, available: Boolean(target && onCreateTask) };
}
