// INV-01 目标键覆盖四个维度：守住位置 key 构造；改错故障 切换会话后复用旧结果。
// INV-02 上下文对象按 key 记忆：守住位置 useMemo；改错故障 每次渲染都重建身份。
// INV-03 当前上下文存 ref：守住位置 赋值；改错故障 异步回调读到过期上下文。
// INV-04 就绪态存上下文对象：守住位置 ready 比较；改错故障 旧初始化结果被当成新结果。
// INV-05 卸载后不再写状态：守住位置 active 标志；改错故障 卸载后更新触发警告。
// INV-06 未就绪时列表为空：守住位置 ready 比较；改错故障 展示半初始化的空店铺。
// INV-07 推荐项按插件与面板去重：守住位置 findIndex；改错故障 同一入口出现两行。
// INV-08 匹配不到店铺项即跳过：守住位置 早退；改错故障 渲染缺字段的推荐卡。
// INV-09 忙碌项拦截重复点击：守住位置 isItemBusy；改错故障 同一插件并发安装两次。
// INV-10 操作前再验当前上下文：守住位置 isCurrent；改错故障 旧目标操作作用到新会话。
// INV-11 失败信息绑定上下文：守住位置 failure 结构；改错故障 旧会话错误显示在新会话。
// INV-12 安装与恢复分两条路：守住位置 分支；改错故障 可恢复项走了市场安装。
// INV-13 操作服务包一层遥测：守住位置 构造；改错故障 推荐入口行为无法归因。
// INV-14 成功只刷新技能存储：守住位置 后续调用；改错故障 推荐页被强制打开面板。
// INV-15 读取面板失败返回空：守住位置 捕获分支；改错故障 单次失败阻断整个面板。
// INV-16 面板读取也验上下文：守住位置 isCurrent；改错故障 返回旧工作区的面板。
// INV-17 加载态由三条件合成：守住位置 返回值；改错故障 初始化中显示空态。
// INV-18 返回值字段顺序稳定：守住位置 末尾对象；改错故障 调用方解构读到未定义。
//
// 模块职责：把推荐列表接到插件管理 store，产出可渲染条目与操作。
// 状态所有权：就绪态与失败信息归本 hook；插件数据归管理 store。
// 阅读顺序：先看上下文键，再看初始化副作用，最后看操作与读取。
import { withPluginTelemetry } from "@zcode/services";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useScopedPluginManagementStore } from "@/store/pluginManagementStore.js";
import {
  buildStoreItems,
  isItemBusy,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { useUiPluginRecommendations } from "@/plugin-ui/adapters/useUiPluginRecommendations.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { logger } from "@/logger.js";

/** 推荐曝光读取完整市场目录；安装和启用继续由现有管理 store 与 CLI 负责。 */
// 去重键 key 由 workspacePath、workspaceIdentity、sessionId 与 remoteSessionId 四项拼成。
// pluginManagementService 等三个服务都来自 useServices()。
// 管理 store 按服务作用域。
// 推荐配置独立读取。
// 就绪态与失败态分开保存。
export function useRecommendedUiPlugins(target: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  remoteSessionId?: string | null;
}) {
  const {
    pluginManagementService: service,
    skillsService,
    pluginUiBridgeService: bridge,
  } = useServices();
  const store = useScopedPluginManagementStore(service);
  const state = store();
  const { recommendations, loading: configLoading } = useUiPluginRecommendations(
    target.sessionId !== null,
  );
  // key 必须同时覆盖 workspacePath 与 sessionId，切换会话即换键。
  // workspaceIdentity 参与 key，可区分同路径不同账号。
  // context 只依赖 key 与 service，由 useMemo 缓存。
  // ref 始终指向最新上下文。
  const key = JSON.stringify([
    target.workspacePath,
    target.workspaceIdentity,
    target.sessionId,
    target.remoteSessionId,
  ]);
  const context = useMemo(() => ({ key, service }), [key, service]);
  const current = useRef<typeof context | null>(context);
  current.current = context;
  const [ready, setReady] = useState<typeof context>();
  const [failure, setFailure] = useState<{
    context: typeof context;
    message: string;
  }>();
  useEffect(() => {
    let active = true;
    current.current = context;
    setReady(undefined);
    if (service && target.sessionId !== null) {
      void store
        .getState()
        .initialize({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          pluginService: service,
        })
        .then(() => {
          if (active) setReady(context);
        });
    }
    return () => {
      active = false;
      current.current = null;
    };
  }, [context, service, store, target.workspaceIdentity, target.workspacePath, target.sessionId]);
  const items = ready === context ? buildStoreItems(state) : [];
  const entries = recommendations.flatMap((entry, index) => {
    const item = items.find((candidate) => candidate.id === entry.pluginId);
    if (
      !item ||
      recommendations.findIndex(
        (candidate) =>
          candidate.pluginId === entry.pluginId && candidate.surfaceId === entry.surfaceId,
      ) !== index
    )
      return [];
    return [{ ...entry, item }];
  });
  const isCurrent = () => current.current === context;
  // 先读 store.getState()，再用 isItemBusy() 判断同插件是否忙碌。
  // withPluginTelemetry() 只包住 operationService，不改变调用语义。
  // 按 item.installed 与 item.restorable 选择 restoreBuiltin、installPlugin 或 setEnabled。
  // setFailure 只在 isCurrent() 为真时写入。
  // 成功后调用 refreshSharedSkillStoreForWorkspace() 刷新技能存储。
  const prepare = async (item: StorePluginItem) => {
    // 读取 store 的即时状态，同插件重复点击被拦截，其他插件不受影响。
    if (!isCurrent() || !service || isItemBusy(item, store.getState())) return;
    setFailure(undefined);
    try {
      const management = store.getState();
      const operationService = withPluginTelemetry(service, {
        entry: "recommended_ui",
        client_kind: "desktop",
      });
      const succeeded = !item.installed
        ? item.restorable
          ? await management.restoreBuiltin(item.id, operationService)
          : await management.installPlugin(item.name, item.marketplace, operationService, "user")
        : await management.setEnabled(item.id, true, operationService, "workspace");
      if (!succeeded) {
        const message = store.getState().error;
        if (message && isCurrent()) setFailure({ context, message });
        return;
      }
      if (!item.installed) {
        await invalidateDeferredDraftSessionForSkillChange({
          ...target,
          reason: "settings-plugin-enabled",
        });
        await refreshSharedSkillStoreForWorkspace({ ...target, skillsService });
      }
      // 成功只刷新安装/启用态，不替用户打开面板；旧目标完成也不能打开新会话。
    } catch (error) {
      if (isCurrent()) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[plugin-ui] 推荐插件操作失败", { pluginId: item.id, message });
        setFailure({ context, message });
      }
    }
  };
  // bridge 为 null 时 resolveSurface() 直接返回 null。
  // listSurfaces() 按 target.workspacePath 与 workspaceIdentity 取面板列表。
  // 回包后再用 isCurrent() 验一次上下文。
  // 读失败由 catch 兜住，返回空而不是抛错。
  const resolveSurface = async (pluginId: string, surfaceId: string) => {
    if (!bridge) return null;
    try {
      const surfaces = await bridge.listSurfaces({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      });
      if (!isCurrent()) return undefined;
      return (
        surfaces.find((surface) => surface.pluginId === pluginId && surface.id === surfaceId) ??
        null
      );
    } catch (error) {
      if (!isCurrent()) return undefined;
      logger.warn("[plugin-ui] 推荐面板读取失败", { pluginId, message: String(error) });
      return null;
    }
  };
  return {
    entries,
    loading:
      target.sessionId !== null && (configLoading || (Boolean(service) && ready !== context)),
    resolveSurface,
    prepare,
    isBusy: (item: StorePluginItem) => isItemBusy(item, state),
    error: failure?.context === context ? failure.message : null,
  };
}
