// INV-01 非代理 provider 直接视作就绪：守住位置 早退判断；改错故障 外部 provider 被拦下。
// INV-02 只对空会话做前置门禁：守住位置 会话判断；改错故障 正式会话反复检查模型。
// INV-03 新草稿首帧不沿用旧就绪态：守住位置 作用域比较；改错故障 预热刚建就被回收。
// INV-04 作用域变化立即重置状态：守住位置 渲染期赋值；改错故障 切工作区后仍显示缺模型。
// INV-05 状态提交校验作用域：守住位置 更新函数；改错故障 旧检查结果覆盖新草稿。
// INV-06 关闭后同类缺失不重复弹出：守住位置 关闭标记；改错故障 关掉横幅又反复出现。
// INV-07 显式揭示时清除关闭标记：守住位置 选项分支；改错故障 发送被拒却没有提示。
// INV-08 注册表变化即时刷新状态：守住位置 订阅回调；改错故障 新配置模型后仍需重启。
// INV-09 初始读取不得覆盖更新事件：守住位置 版本比较；改错故障 旧快照把就绪改回缺失。
// INV-10 读取失败不等价于没有模型：守住位置 独立终态；改错故障 瞬时故障被当成配置问题。
// INV-11 检查失败仍放行启动：守住位置 允许条件；改错故障 网络抖动导致无法发消息。
// INV-12 卸载后不再提交状态：守住位置 释放标记；改错故障 卸载组件仍触发更新警告。
// INV-13 订阅随效果一并释放：守住位置 清理函数；改错故障 重复挂载累积订阅。
// INV-14 首发前重新读取一次视图：守住位置 发送入口；改错故障 事后关掉模型仍可发送。
// INV-15 缺失时在入站前拒绝：守住位置 返回假值；改错故障 命令进入恢复账本成为未知。
// INV-16 错误横幅由缺失与未关闭共同决定：守住位置 与运算；改错故障 关闭后错误仍常驻。
// INV-17 关闭只影响当前作用域：守住位置 比较条件；改错故障 换草稿后横幅消失。
// INV-18 对外返回稳定回调：守住位置 回调缓存；改错故障 每次渲染换函数导致下游重订阅。
//
// 模块职责：为 v4 草稿提供模型可用性的前置门禁与首发复查。
// 状态所有权：检查状态与关闭标记归本 hook，作用域随工作区与 provider 变化。
// 阅读顺序：先看就绪判定，再看挂载检查，最后看首发复查与错误投影。
import { useCallback, useEffect, useMemo, useState } from "react";
import { isZCodeAgentProvider, ZCODE_AGENT_PROVIDER, type ZCodeProvider } from "@zcode/shared";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import {
  buildModelConfigMissingUiError,
  type ModelConfigMissingUiError,
} from "@/lib/chatPrepareError.js";
import { logger } from "@/logger.js";

type DraftModelReadinessStatus = "checking" | "ready" | "missing" | "check-failed";

interface DraftModelReadinessState {
  scope: object;
  status: DraftModelReadinessStatus;
  dismissed: boolean;
}

export interface DraftModelReadinessGate {
  /** 只有 readiness 已确认或检查本身不可用时，才允许进入 workspace prepare/prewarm。 */
  agentStartupAllowed: boolean;
  error: ModelConfigMissingUiError | null;
  dismissError(): void;
  /** 首发 admission 的权威复查；false 表示应保留 composer 并返回 blocked。 */
  ensureReadyForSend(): Promise<boolean>;
  /** Host 门禁在 UI 复查后竞态命中时，将同一错误重新投影到草稿横幅。 */
  markProviderNotReady(): void;
}

export function resolveModelSelectionReadinessStatus(
  view: ModelSelectionView,
): Extract<DraftModelReadinessStatus, "ready" | "missing"> {
  return view.providers.some((provider) => provider.models.length > 0) ? "ready" : "missing";
}

/**
 * V4 草稿的 provider/model admission。
 *
 * V4 迁移删除了旧 useWorkspacePrepare 的 renderer readiness 门禁，草稿首发
 * 会先登记 pending command，再由 Host 以 provider_not_ready 拒绝。这个确定性拒绝随后会
 * 被恢复账本误判成 unknown。这里恢复 UI 前置门禁；Host 门禁继续负责进程级竞态兜底。
 */
// 工作区身份优先于路径。
// 仅空会话启用前置门禁。
// 作用域键含工作区与 provider。
// 作用域变化立即重置状态。
export function useDraftModelReadinessGate(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  sessionId: string | null;
  modelSelectionService: Pick<IModelSelectionService, "getView" | "onDidChange">;
}): DraftModelReadinessGate {
  const { workspacePath, workspaceIdentity, provider, sessionId, modelSelectionService } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const enabled = sessionId === null && isZCodeAgentProvider(displayProvider);
  const gateKey = `${workspaceKey}\u0000${displayProvider}`;
  const scope = useMemo(() => ({ gateKey }), [enabled, gateKey, modelSelectionService]);
  const [state, setState] = useState<DraftModelReadinessState>(() => ({
    scope,
    status: enabled ? "checking" : "ready",
    dismissed: false,
  }));
  // 进入新草稿的首帧不能沿用正式会话的 ready，否则先建预热、effect 再改 checking，
  // 会立刻回收在途创建。检查结果只属于本次生命周期，旧复查也不能覆盖新草稿。
  const effectiveState: DraftModelReadinessState =
    state.scope === scope
      ? state
      : { scope, status: enabled ? "checking" : "ready", dismissed: false };
  if (state.scope !== scope) setState(effectiveState);

  // current.scope 不等于 scope 时直接丢弃旧结果。
  // revealMissing 为真时清除 dismissed 标记。
  // 同类 missing 沿用既有的 dismissed。
  // 其它 status 一律把 dismissed 置假。
  const commitStatus = useCallback(
    (status: DraftModelReadinessStatus, options: { revealMissing?: boolean } = {}) => {
      setState((current) =>
        current.scope !== scope
          ? current
          : {
              scope,
              status,
              dismissed:
                status === "missing"
                  ? options.revealMissing
                    ? false
                    : current.status === "missing"
                      ? current.dismissed
                      : false
                  : false,
            },
      );
    },
    [scope],
  );

  useEffect(() => {
    if (!enabled) {
      commitStatus("ready");
      return;
    }

    commitStatus("checking");
    let disposed = false;
    let registryEventVersion = 0;
    const applyStatus = (status: DraftModelReadinessStatus) => {
      if (disposed) return;
      commitStatus(status);
    };
    const subscription = modelSelectionService.onDidChange((view) => {
      registryEventVersion += 1;
      applyStatus(resolveModelSelectionReadinessStatus(view));
    });
    const initialReadVersion = registryEventVersion;
    void modelSelectionService
      .getView()
      .then((view) => {
        // 读取在变更事件之前发起、之后才返回时，事件快照更新；禁止旧读取覆盖新状态。
        if (registryEventVersion !== initialReadVersion) return;
        applyStatus(resolveModelSelectionReadinessStatus(view));
      })
      .catch((error) => {
        handleReadinessFailure(error);
      });

    function handleReadinessFailure(error: unknown) {
      if (disposed) return;
      // registry 读取异常不等价于“确实没有模型”。保留 Host 门禁作为兜底，避免把
      // app-global service 的瞬时故障错误显示成用户配置问题。
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] provider registry 检查失败，回落 Host 门禁", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
    }

    return () => {
      disposed = true;
      subscription?.dispose();
    };
  }, [commitStatus, enabled, modelSelectionService, workspaceKey]);

  const markProviderNotReady = useCallback(() => {
    commitStatus("missing", { revealMissing: true });
  }, [commitStatus]);

  // !enabled 时 ensureReadyForSend 直接返回 true。
  // 发送前重新 await getView 拿最新选择。
  // status 为 missing 时更新状态并返回 false。
  // getView 抛错时回落主机门禁判定。
  const ensureReadyForSend = useCallback(async (): Promise<boolean> => {
    if (!enabled) return true;
    try {
      const view = await modelSelectionService.getView();
      const status = resolveModelSelectionReadinessStatus(view);
      commitStatus(status, { revealMissing: status === "missing" });
      if (status === "missing") {
        logger.info("[v4-draft-readiness] 无可用 provider/model，草稿首发在 UI admission 拒绝", {
          providerCount: view.providers.length,
          revision: view.revision,
          workspaceKey,
        });
        return false;
      }
      return true;
    } catch (error) {
      // 与 mount 检查一致：读 registry 失败不冒充“没有模型”，继续由 Host 启动门禁裁决。
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] 首发复查 provider registry 失败，回落 Host 门禁", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
      return true;
    }
  }, [commitStatus, enabled, modelSelectionService, workspaceKey]);

  const error = useMemo(
    () =>
      enabled && effectiveState.status === "missing" && !effectiveState.dismissed
        ? buildModelConfigMissingUiError()
        : null,
    [effectiveState.dismissed, effectiveState.status, enabled],
  );

  const dismissError = useCallback(() => {
    setState((current) =>
      current.scope === scope && current.status === "missing"
        ? { ...current, dismissed: true }
        : current,
    );
  }, [scope]);

  return {
    agentStartupAllowed:
      !enabled || effectiveState.status === "ready" || effectiveState.status === "check-failed",
    error,
    dismissError,
    ensureReadyForSend,
    markProviderNotReady,
  };
}
