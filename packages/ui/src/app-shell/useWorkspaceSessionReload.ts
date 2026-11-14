// INV-01 防抖在入口：守住位置 时间窗判断；改错故障 双击并发重建同一工作区。
// INV-02 禁用或进行中直接返回：守住位置 早退条件；改错故障 重建过程中再次发起。
// INV-03 先置进行中再发起：守住位置 状态顺序；改错故障 按钮仍可点击。
// INV-04 身份只取活动标签：守住位置 选择器；改错故障 别的工作区身份串台。
// INV-05 标识不匹配返回空：守住位置 路径比较；改错故障 草稿写到错误区域。
// INV-06 提供者三级回退：守住位置 选项与作用域；改错故障 使用未选中的提供者。
// INV-07 恢复任务优先：守住位置 裁剪后或运算；改错故障 有活跃任务时仍重新准备。
// INV-08 重建前先写初始化态：守住位置 显式赋值；改错故障 界面停留在旧状态。
// INV-09 准备阶段先清旧错误：守住位置 清空调用；改错故障 输入区残留上一轮报错。
// INV-10 准备结果按提供者校验：守住位置 二次比较；改错故障 旧选项覆盖新选项。
// INV-11 成功后重置重试计数：守住位置 归零调用；改错故障 重试次数只增不减。
// INV-12 失败写标准化草稿错误：守住位置 工厂函数；改错故障 聊天区只有提示条。
// INV-13 失败回写配置状态：守住位置 错误分支；改错故障 选项面板一直转圈。
// INV-14 无论成败释放进行中：守住位置 收尾分支；改错故障 按钮永久禁用。
// INV-15 成功与失败都提示：守住位置 两处提示；改错故障 用户不知道结果。
// INV-16 依赖数组只放稳定引用：守住位置 依赖列表；改错故障 回调每次渲染重建。
// INV-17 操作结束才落完成态：守住位置 调用顺序；改错故障 半途被标记完成。
// INV-18 日志带工作区与提供者：守住位置 模板参数；改错故障 多工作区无法定位。
//
// 模块职责：工作区会话重建的入口、状态编排与错误回填。
// 状态所有权：进行中标志归本地；初始化态与配置态写入会话 store。
// 阅读顺序：先看身份解析与防抖，再看重建流程，最后看成功与失败收尾。
import { useCallback, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeProvider } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  buildWorkspaceSessionReloadDraftError,
  shouldDebounceWorkspaceSessionReload,
} from "@/lib/workspaceSessionReloadPlan.js";
import { resolveWorkspaceModelConfigSyncScope } from "@/lib/modelConfigSync.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

export function useWorkspaceSessionReload({
  intl,
  services,
  workspaceAbsPath,
  reloadSessionDisabled,
}: {
  intl: { formatMessage: (descriptor: { id: string }) => string };
  services: IServiceAccessor;
  workspaceAbsPath: string;
  reloadSessionDisabled: boolean;
}) {
  const [reloadSessionPending, setReloadSessionPending] = useState(false);
  // 无 activeTabId 时选择器返回 undefined，不订阅任何会话。
  // 只有 isWorkspaceTab 为真才继续，其他标签不参与重建。
  // workspacePath 必须与入参一致，防止跨工作区误取身份。
  // 命中后返回 workspaceIdentity，选择器只读 store 不写状态。
  // 选择器只读 store。
  const workspaceIdentity = useTabStore((state) => {
    if (!state.activeTabId) {
      return undefined;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspaceAbsPath) {
      return undefined;
    }

    return activeTab.workspaceIdentity;
  });
  const lastReloadSessionTriggeredAtRef = useRef<number | null>(null);

  // reloadSessionDisabled 或 pending 时直接返回，重复点击不叠加重建。
  // lastReloadSessionTriggeredAtRef 限制时间窗，短时间连点只生效一次。
  // 通过检查后立即置 pending，避免并发入口同时进入重建。
  // useCallback 依赖只取参数与选择器结果，回调引用保持稳定。
  // handleReloadSession 引用稳定，子组件不会因父级重渲而重建。
  const handleReloadSession = useCallback(
    async (options?: { resumeTaskId?: string | null; provider?: ZCodeProvider | null }) => {
      if (reloadSessionDisabled || reloadSessionPending) {
        return;
      }

      const now = Date.now();
      if (shouldDebounceWorkspaceSessionReload(lastReloadSessionTriggeredAtRef.current, now)) {
        // Header 与错误条都可触发 reload，会出现短时间双击/连点并发重建。
        // 这里在入口做时间窗防抖，避免并发调用 restartWorkspaceProcess 抢占同一 provider-workspace。
        logger.info(`[App] 忽略重复 workspace session 重建请求 workspace=${workspaceAbsPath}`);
        return;
      }
      lastReloadSessionTriggeredAtRef.current = now;
      setReloadSessionPending(true);

      const zcodeSessionStore = useZCodeSessionStore.getState();
      const latestWorkspaceState = zcodeSessionStore.getWorkspaceState(
        workspaceAbsPath,
        workspaceIdentity,
      );
      const actionScope = resolveWorkspaceModelConfigSyncScope(latestWorkspaceState);
      const provider: ZCodeProvider = options?.provider ?? actionScope.provider;
      const resumeTaskId =
        options?.resumeTaskId?.trim() || latestWorkspaceState.activeTaskId || undefined;
      const shouldPrepareWorkspace = !resumeTaskId;

      // Reload session 之前只调用了服务层重建流程，没有同步 workspaceInit 状态到 UI store。
      // 草稿态下后续准备流程会继续读到旧状态，用户会误判本次重建没有生效。
      // 这里显式写入 initializing/ready/failed，保证重建状态和会话流程保持一致。
      zcodeSessionStore.setWorkspaceInitState(
        workspaceAbsPath,
        "initializing",
        null,
        workspaceIdentity,
      );
      if (shouldPrepareWorkspace) {
        zcodeSessionStore.setConfigOptionsStatus(workspaceAbsPath, "loading", workspaceIdentity);
        // 草稿态点击 reload 后若不清空旧错误，输入区会继续显示上一轮失败提示，
        // 用户会误判本次重建仍失败。这里在新一轮重建开始时先清空草稿错误。
        zcodeSessionStore.setDraftError(workspaceAbsPath, null, workspaceIdentity);
        zcodeSessionStore.setTaskState(workspaceAbsPath, "idle", null, workspaceIdentity);
      }

      try {
        // restartWorkspaceProcess 是唯一重建入口，避免绕过服务层。
        // provider 与 resumeTaskId 一并传入，重建时同时恢复任务。
        // workspaceIdentity 仅在存在时附带，旧调用方不受影响。
        // restart 与 prepare 串行执行，准备失败不会留下半初始化状态。
        // 准备结果按 provider 二次校验，防止切换提供者后沿用旧配置。
        await services.zcodeTaskService.restartWorkspaceProcess({
          workspacePath: workspaceAbsPath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          provider,
          resumeTaskId,
        });

        if (shouldPrepareWorkspace) {
          const prepareResult = await prepareWorkspaceWithZCodeSessionService({
            workspacePath: workspaceAbsPath,
            workspaceIdentity,
            provider,
            zcodeSessionService: services.zcodeSessionService,
          });

          const latestAfterPrepare = zcodeSessionStore.getWorkspaceState(
            workspaceAbsPath,
            workspaceIdentity,
          );
          if (latestAfterPrepare.selectedProvider === provider) {
            const latestAfterResolve = zcodeSessionStore.getWorkspaceState(
              workspaceAbsPath,
              workspaceIdentity,
            );
            if (latestAfterResolve.selectedProvider === provider) {
              zcodeSessionStore.setConfigOptions(
                workspaceAbsPath,
                prepareResult.configOptions ?? [],
                workspaceIdentity,
              );
              zcodeSessionStore.setConfigOptionsStatus(
                workspaceAbsPath,
                "ready",
                workspaceIdentity,
              );
              zcodeSessionStore.setSlashCommands(
                workspaceAbsPath,
                prepareResult.slashCommands ?? [],
                workspaceIdentity,
              );
              zcodeSessionStore.setDraftError(workspaceAbsPath, null, workspaceIdentity);
            }
          }
        }

        zcodeSessionStore.setWorkspaceInitAttempts(workspaceAbsPath, 0, workspaceIdentity);
        zcodeSessionStore.setWorkspaceInitState(workspaceAbsPath, "ready", null, workspaceIdentity);

        logger.info(
          `[App] workspace session 重建完成 workspace=${workspaceAbsPath} provider=${provider} resumeTaskId=${resumeTaskId ?? "<none>"}`,
        );
        toast(intl.formatMessage({ id: "appHeader.reloadSessionSuccess" }));
      // buildWorkspaceSessionReloadDraftError 统一转换错误，输入区能直接展示原因。
      // workspaceInitState 写 failed，重试入口据此显示。
      // 准备阶段失败再写 configOptions 错误态，两处状态不混用。
      // message 回填输入区，用户能看到具体失败文本。
      // finally 释放 pending，无论成败都恢复可点击。
      } catch (error) {
        const reloadDraftError = buildWorkspaceSessionReloadDraftError(error, {
          workspacePath: workspaceAbsPath,
          provider,
        });
        const message = reloadDraftError.message;
        logger.warn(
          `[App] workspace session 重建失败 workspace=${workspaceAbsPath} provider=${provider}`,
          {
            resumeTaskId: resumeTaskId ?? null,
            message,
          },
        );
        zcodeSessionStore.setWorkspaceInitState(
          workspaceAbsPath,
          "failed",
          message,
          workspaceIdentity,
        );
        if (shouldPrepareWorkspace) {
          zcodeSessionStore.setConfigOptionsStatus(workspaceAbsPath, "error", workspaceIdentity);
          // 草稿态下 reload 前会先清空旧错误；如果失败后不回填 draftError，
          // 聊天区只剩 toast，用户看不到可重试的详细报错。这里统一回填标准化错误到输入区。
          zcodeSessionStore.setDraftError(workspaceAbsPath, reloadDraftError, workspaceIdentity);
        }
        toast(intl.formatMessage({ id: "appHeader.reloadSessionFailed" }));
      } finally {
        setReloadSessionPending(false);
      }
    },
    [
      intl,
      reloadSessionDisabled,
      reloadSessionPending,
      services.zcodeTaskService,
      services.zcodeSessionService,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );

  return {
    reloadSessionPending,
    handleReloadSession,
  };
}
