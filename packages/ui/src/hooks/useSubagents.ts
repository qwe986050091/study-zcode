// INV-01 范围单一：守住位置 三个入参；改错故障：同一面板在不同窗口读到不同子智能体。
// INV-02 显式身份优先：守住位置 explicitIdentity 的取值；改错故障：调用方指定的身份被标签推断覆盖。
// INV-03 空白归一：守住位置 trim 后的或运算；改错故障：空白身份参与匹配导致找不到标签。
// INV-04 激活优先：守住位置 当前标签与首个匹配标签的先后；改错故障：多开同一工作区时读到旧标签的会话。
// INV-05 RPC 门控：守住位置 shouldEnableWorkspaceRpc 的调用；改错故障：断连时代理错误显示成红色失败提示。
// INV-06 键含服务：守住位置 contextKey 的组成；改错故障：替换服务后仍读旧上下文。
// INV-07 空工作区不建键：守住位置 workspacePath 判断；改错故障：无工作区时命中上一条上下文。
// INV-08 旧店兼容：守住位置 useLegacyContext 的三重比较；改错故障：旧数据串到新工作区。
// INV-09 只初始化一次：守住位置 context 存在即返回；改错故障：每次渲染都触发装载。
// INV-10 刷新门控：守住位置 refresh 的两个早退；改错故障：断连时刷新请求打空。
// INV-11 开关门控：守住位置 setEnabled 的早退；改错故障：RPC 不可用时仍尝试写服务。
// INV-12 依赖完整：守住位置 三个回调的依赖数组；改错故障：闭包持有过期服务实例。
// INV-13 空值收敛：守住位置 返回值里的条件；改错故障：RPC 不可用时仍透出旧智能体列表。
// INV-14 加载二选一：守住位置 loading 的分支；改错故障：旧店与新上下文同时为真，界面闪动。
// INV-15 能力随范围：守住位置 capability 的来源；改错故障：切工作区后仍显示上一处的能力。
// INV-16 错误不吞：守住位置 error 的透传；改错故障：装载失败被当成空列表。
// INV-17 结果稳定：守住位置 返回值 useMemo；改错故障：每次渲染新建对象导致下游全量更新。
// INV-18 无内部状态：守住位置 hook 体；改错故障：本地缓存与 store 不同步。
//
// 模块职责：按工作区、供应商与身份解析子智能体上下文，并暴露刷新与开关动作。
// 状态所有权：数据归子智能体 store；本 hook 只做范围解析与门控。
// 阅读顺序：入参与身份 → 标签匹配 → 远程会话 → 上下文键 → 旧店兼容 → 动作与返回值。
import type { ZCodeProvider } from "@zcode/shared";
import { useCallback, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useServices } from "./useServices.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { shouldEnableWorkspaceRpc } from "@/lib/workspaceRpcAvailability.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WindowTabState, type WorkspaceTabState } from "@/store/tabStore.js";
import { getSubagentsContextKey, useSubagentsContextStore } from "@/store/subagentsContextStore.js";
import { useSubagentsStore } from "@/store/subagentsStore.js";

// 三个入参共同确定读取范围：工作区、供应商与可选的显式身份。
// 显式身份优先于标签推断，供调用方锁定跨窗口场景。
//
export function useSubagents(
  workspacePath: string | null,
  provider: ZCodeProvider,
  explicitWorkspaceIdentity?: string,
) {
  const { subagentsService } = useServices();
  // 空串与纯空白都归一为未指定，避免用空白身份去匹配标签。
  // `explicitIdentity` 只归一化一次，后续比较都读这个值。
  //
  const explicitIdentity = explicitWorkspaceIdentity?.trim() || undefined;
  const workspaceRpcTarget = useTabStore(
    useShallow((state) => {
      if (!workspacePath) {
        return {
          workspaceIdentity: undefined,
          preferredRemoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      const activeWorkspaceTab = state.activeTabId
        ? state.tabs.find((tab) => tab.id === state.activeTabId)
        : undefined;
      // 先按路径匹配，显式身份存在时还要求身份一致。
      // 优先当前激活标签，未命中再退回第一个匹配的工作区标签。
      //
      const matchesRequestedScope = (tab: WindowTabState): tab is WorkspaceTabState =>
        isWorkspaceTab(tab) &&
        tab.workspacePath === workspacePath &&
        (!explicitIdentity || tab.workspaceIdentity?.trim() === explicitIdentity);
      const matchedWorkspaceTab =
        activeWorkspaceTab && matchesRequestedScope(activeWorkspaceTab)
          ? activeWorkspaceTab
          : state.tabs.find(matchesRequestedScope);

      return {
        workspaceIdentity: matchedWorkspaceTab?.workspaceIdentity,
        preferredRemoteSessionId: matchedWorkspaceTab?.remoteSessionId,
        remoteTarget: matchedWorkspaceTab?.remoteTarget,
      };
    }),
  );
  // `explicitIdentity` 优先，缺失时取 `workspaceRpcTarget.workspaceIdentity`。
  // 两条来源合并成一个值，后续判定只读这一处。
  //
  const workspaceIdentity = explicitIdentity || workspaceRpcTarget.workspaceIdentity;
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    workspaceRpcTarget.preferredRemoteSessionId,
    workspaceIdentity,
    workspaceRpcTarget.remoteTarget,
  );
  const workspaceRpcEnabled = shouldEnableWorkspaceRpc({
    workspaceIdentity,
    remoteSessionId,
    remoteTarget: workspaceRpcTarget.remoteTarget,
  });
  // 工作区为空时不生成上下文键，下游不会误读旧上下文。
  // 键里包含服务与供应商，切换实例自然得到新上下文。
  //
  const contextKey = workspacePath
    ? getSubagentsContextKey(workspacePath, provider, workspaceIdentity, subagentsService)
    : null;
  const context = useSubagentsContextStore((state) =>
    contextKey ? state.contexts[contextKey] : undefined,
  );
  const initialize = useSubagentsContextStore((state) => state.initialize);
  const refreshStore = useSubagentsContextStore((state) => state.refresh);
  const setEnabledStore = useSubagentsContextStore((state) => state.setEnabled);
  const legacyContext = useSubagentsStore(
    useShallow((state) => ({
      workspacePath: state.loadedWorkspacePath,
      workspaceIdentity: state.loadedWorkspaceIdentity,
      provider: state.loadedProvider,
      agents: state.agents,
      capability: state.capability,
      loading: state.loading,
      error: state.error,
    })),
  );
  // 兼容旧店：只有工作区、身份与供应商三者都吻合才读取。
  // 身份比较做空值归一，避免两种空值被当成不同。
  //
  const useLegacyContext =
    workspacePath !== null &&
    legacyContext.workspacePath === workspacePath &&
    legacyContext.workspaceIdentity === (workspaceIdentity ?? null) &&
    legacyContext.provider === provider;

  // RPC 不可用时直接跳过，避免断连代理的错误显示成子智能体失败。
  // 已有上下文不重复初始化，保证同一范围只装载一次。
  //
  useEffect(() => {
    if (!workspacePath || !workspaceRpcEnabled) {
      // 远程 workspace 断连或 session 尚未重挂时，@ 面板会随输入框挂载预加载子智能体。
      // 这里先跳过 workspace RPC，避免 disconnected proxy 的内部错误码显示成红色子智能体提示。
      return;
    }
    if (context) return;
    void initialize(workspacePath, provider, subagentsService, workspaceIdentity);
  }, [
    context,
    initialize,
    provider,
    subagentsService,
    workspaceIdentity,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  // 刷新先判 RPC 可用与工作区存在，两个条件缺一即静默返回。
  // 依赖数组完整，避免回调持有过期的服务实例。
  //
  const refresh = useCallback(async () => {
    if (!workspaceRpcEnabled) {
      return;
    }
    if (!workspacePath) return;
    await refreshStore(workspacePath, provider, subagentsService, workspaceIdentity);
  }, [
    provider,
    refreshStore,
    subagentsService,
    workspaceIdentity,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  // 开关动作同样受 RPC 可用性门控，断连时不写远端。
  // 服务与身份放在参数尾部，调用方只关心智能体与开关。
  //
  const setEnabled = useCallback(
    async (agentId: string, enabled: boolean) => {
      if (!workspaceRpcEnabled) {
        return;
      }
      if (!workspacePath) return;
      await setEnabledStore(
        workspacePath,
        provider,
        agentId,
        enabled,
        subagentsService,
        workspaceIdentity,
      );
    },
    [
      provider,
      setEnabledStore,
      subagentsService,
      workspaceIdentity,
      workspacePath,
      workspaceRpcEnabled,
    ],
  );

  // 对外结构在 RPC 不可用时全部回到空值，调用方无需再判断。
  // 加载态在旧店与新上下文之间二选一，避免双源打架。
  //
  return useMemo(
    () => ({
      agents: workspaceRpcEnabled
        ? useLegacyContext
          ? legacyContext.agents
          : (context?.agents ?? [])
        : [],
      capability: workspaceRpcEnabled
        ? useLegacyContext
          ? legacyContext.capability
          : (context?.capability ?? null)
        : null,
      loading:
        workspaceRpcEnabled && workspacePath !== null
          ? useLegacyContext
            ? legacyContext.loading
            : !context || context.loading
          : false,
      error: workspaceRpcEnabled
        ? useLegacyContext
          ? legacyContext.error
          : (context?.error ?? null)
        : null,
      refresh,
      setEnabled,
    }),
    [
      context,
      legacyContext,
      refresh,
      setEnabled,
      useLegacyContext,
      workspacePath,
      workspaceRpcEnabled,
    ],
  );
}
