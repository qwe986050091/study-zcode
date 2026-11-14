// INV-01 未启用时视为有可用 Provider：守住位置 早退分支；改错故障 登录页被无端弹出。
// INV-02 强制刷新后才重读：守住位置 条件分支；改错故障 读到旧视图判断错误。
// INV-03 无家族域一律要求登录：守住位置 或运算；改错故障 未配置域名仍进入主界面。
// INV-04 已登录用户不强制引导：守住位置 与运算；改错故障 老用户每次启动都弹登录。
// INV-05 判定与打开同源：守住位置 单次赋值；改错故障 日志与实际弹窗不一致。
// INV-06 启动检查只跑一次：守住位置 引用标记；改错故障 每次渲染都刷新 Provider。
// INV-07 恢复会话期间不判定：守住位置 条件早退；改错故障 恢复未完成就弹登录。
// INV-08 视图未补水不判定：守住位置 空值判断；改错故障 启动门禁读空视图。
// INV-09 读取失败也结束门禁：守住位置 错误分支；改错故障 首次失败永久停在加载。
// INV-10 失败不伪装成无 Provider：守住位置 只设完成标记；改错故障 网络故障导致弹登录。
// INV-11 完成标记与状态同步更新：守住位置 两处赋值；改错故障 引用与状态短暂不一致。
// INV-12 异步结束才结束门禁：守住位置 终态回调；改错故障 判定未完成就放行。
// INV-13 缓存依赖覆盖刷新函数：守住位置 依赖数组；改错故障 换刷新实现后仍用旧闭包。
// INV-14 视图变化触发重新计算：守住位置 依赖项；改错故障 配置新增后仍认为不可用。
// INV-15 未启用时计数仍可读：守住位置 兜底字段；改错故障 统计恒为零。
// INV-16 返回值形状固定：守住位置 接口类型；改错故障 调用方解构出错。
// INV-17 日志包含判定全部输入：守住位置 日志字段；改错故障 线上无法还原这次判定。
// INV-18 关闭入口走统一 setter：守住位置 回调调用；改错故障 各处直接改 store 绕过判定。
//
// 模块职责：启动时判断是否需要弹出登录入口，并提供可复用的同步判定。
// 状态所有权：完成标记与完成态归本 hook，Provider 视图由调用方注入。
// 阅读顺序：先看同步判定，再看启动效果的门禁顺序。
import { useCallback, useEffect, useRef, useState } from "react";
import type { UserInfo } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import { logger } from "@/logger.js";

export interface ProviderAvailabilityLoginEntryGuardResult {
  hasUsableProvider: boolean;
  providerCount: number;
  shouldOpenLoginEntry: boolean;
}

// setStartupCheckCompleted 初值取 !enabled，未启用时启动门禁直接算完成。
// startupCheckCompletedRef 先于 setState 置 true，防止同一轮 effect 重复发起检查。
// providerAvailabilityHydrated 只由 modelSelectionView !== null 决定。
// 返回值只含 startupCheckCompleted 与 syncLoginEntryWithProviderAvailability。
export function useProviderAvailabilityLoginEntryGuard({
  enabled = true,
  user,
  isRestoringOAuthSession,
  providerFamilyDomain,
  modelSelectionView,
  modelSelectionError,
  refreshProviderState,
  readModelSelectionView,
  setLoginEntryOpen,
}: {
  enabled?: boolean;
  user: UserInfo | null;
  isRestoringOAuthSession: boolean;
  providerFamilyDomain: string | null | undefined;
  modelSelectionView: ModelSelectionView | null;
  modelSelectionError?: Error;
  refreshProviderState: () => Promise<void>;
  readModelSelectionView: () => Promise<ModelSelectionView>;
  setLoginEntryOpen: (open: boolean) => void;
}) {
  const [startupCheckCompleted, setStartupCheckCompleted] = useState(!enabled);
  const startupCheckCompletedRef = useRef(false);
  const providerAvailabilityHydrated = modelSelectionView !== null;

  // enabled 为 false 时直接返回 hasUsableProvider: true 且 shouldOpenLoginEntry: false。
  // options.forceRefresh 为 true 时先 await refreshProviderState 再 readModelSelectionView。
  // shouldOpenLoginEntry 由本函数算一次并 setLoginEntryOpen，弹窗与返回值不会分叉。
  // logger.info 记录 reason/source/providerCount/hasUser/hasProviderFamilyDomain。
  const syncLoginEntryWithProviderAvailability = useCallback(
    async (options: { forceRefresh?: boolean; reason: string }) => {
      if (!enabled) {
        return {
          hasUsableProvider: true,
          providerCount: modelSelectionView?.providers.length ?? 0,
          shouldOpenLoginEntry: false,
        } satisfies ProviderAvailabilityLoginEntryGuardResult;
      }

      if (options.forceRefresh) {
        await refreshProviderState();
      }

      const refreshedView = options.forceRefresh
        ? await readModelSelectionView()
        : modelSelectionView;
      const availability = resolveProviderAvailabilityState({ modelSelectionView: refreshedView });
      const { hasUsableProvider, providerCount } = availability;
      const shouldOpenLoginEntry = !providerFamilyDomain || (!user && !hasUsableProvider);

      // 未登录且没有可用模型配置时必须引导用户连接账号或填写 API Key。
      // 启动检查、API Key 设置回流等入口统一走这里，避免各处复制判断后语义分叉。
      logger.info("[Root] provider 可用性登录入口守卫完成检查", {
        reason: options.reason,
        source: availability.source,
        providerCount,
        hasUsableProvider,
        hasUser: Boolean(user),
        hasProviderFamilyDomain: Boolean(providerFamilyDomain),
        shouldOpenLoginEntry,
      });
      setLoginEntryOpen(shouldOpenLoginEntry);
      return {
        hasUsableProvider,
        providerCount,
        shouldOpenLoginEntry,
      } satisfies ProviderAvailabilityLoginEntryGuardResult;
    },
    [
      enabled,
      modelSelectionView,
      providerFamilyDomain,
      refreshProviderState,
      readModelSelectionView,
      setLoginEntryOpen,
      user,
    ],
  );

  // !enabled 时置 ref 与 state 为 true 后提前 return，不发请求。
  // modelSelectionError 存在时记 logger.error 并结束等待，避免永久 loading。
  // isRestoringOAuthSession 或 providerAvailabilityHydrated 为 false 时本轮 effect 直接返回。
  useEffect(() => {
    if (!enabled) {
      startupCheckCompletedRef.current = true;
      setStartupCheckCompleted(true);
      return;
    }

    if (modelSelectionError) {
      // 首次读取失败不能伪装成“没有 Provider”，也不能让启动门禁永久停在 loading。
      logger.error("[Root] provider 可用性读取失败，结束启动门禁等待", modelSelectionError);
      startupCheckCompletedRef.current = true;
      setStartupCheckCompleted(true);
      return;
    }

    if (
      startupCheckCompletedRef.current ||
      isRestoringOAuthSession ||
      !providerAvailabilityHydrated
    ) {
      return;
    }

    startupCheckCompletedRef.current = true;
    void syncLoginEntryWithProviderAvailability({
      reason: "startup",
    }).finally(() => {
      setStartupCheckCompleted(true);
    });
  }, [
    enabled,
    isRestoringOAuthSession,
    modelSelectionError,
    providerAvailabilityHydrated,
    syncLoginEntryWithProviderAvailability,
  ]);

  return {
    startupCheckCompleted,
    syncLoginEntryWithProviderAvailability,
  };
}
