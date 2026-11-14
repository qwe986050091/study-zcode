// INV-01 远程目标必须注入服务：守住位置 hooksService 选择；改错故障 RPC 打到错误 host。
// INV-02 rpcReady 为假禁用链路：守住位置 平台判断；改错故障 越界 RPC 发给断连代理。
// INV-03 未就绪时不回退上下文服务：守住位置 三元；改错故障 信任链路打到激活 tab。
// INV-04 服务缺失时功能不可用：守住位置 canUseHooksService；改错故障 按钮可用但调用崩溃。
// INV-05 审核结束才刷新列表：守住位置 结算判断；改错故障 Trust 已落盘但行内仍显示旧态。
// INV-06 前一次交互标识单独保存：守住位置 previous ref；改错故障 无法判断是否结算。
// INV-07 刷新三元组同刻捕获：守住位置 target 常量；改错故障 等待期间切换工作区污染新作用域。
// INV-08 缺少工作区路径不刷新：守住位置 早退条件；改错故障 用空路径刷新。
// INV-09 信任失败不刷新：守住位置 accepted 判断；改错故障 失败也刷新造成假成功。
// INV-10 过期拒绝不弹提示：守住位置 shouldSilenceStaleRejection；改错故障 用户看到无关报错。
// INV-11 提示文案按原因码解析：守住位置 消息 id 解析；改错故障 提示千篇一律。
// INV-12 成功后按发起目标刷新：守住位置 原子刷新；改错故障 刷新到已切换的作用域。
// INV-13 刷新期间作用域切换由 store 丢弃：守住位置 守卫语义；改错故障 新工作区被旧刷新覆盖。
// INV-14 信任中记录当前 hook：守住位置 trustingHookId；改错故障 行内无法显示加载态。
// INV-15 结束必清加载态：守住位置 finally；改错故障 按钮永久转圈。
// INV-16 异常记日志并提示用户：守住位置 catch；改错故障 失败无感知。
// INV-17 回调依赖完整声明：守住位置 useCallback 依赖；改错故障 闭包读到旧 props。
// INV-18 授权能力决定按钮可用：守住位置 trustActionAvailable；改错故障 无权限也显示信任按钮。
//
// 模块职责：为设置页工作区 hooks 提供行内信任动作、审核结算后刷新与状态回传。
// 状态所有权：审核绑定归 review store；信任中标识由本 hook 本地持有。
// 阅读顺序：先看服务解析与可用性，再看结算刷新，最后看信任动作。
import { useCallback, useEffect, useRef, useState } from "react";
import type { Hook } from "@zcode/shared";
import type { IHooksService } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useHooksStore } from "@/store/hooksStore.js";
import {
  findWorkspaceHookCommandBinding,
  findWorkspaceHookReviewBinding,
  useWorkspaceHookReviewStore,
} from "@/store/workspaceHookReviewStore.js";
import { trustWorkspaceHookWithReview } from "./workspaceHookReviewCommands.js";
import {
  didWorkspaceHookReviewSettle,
  resolveWorkspaceHookReasonCodeMessageId,
  shouldSilenceStaleRejection,
} from "./workspaceHookTrustState.js";

// hooksService 由调用方按目标 workspace 解析后传入，不在内部推导。
// input.rpcReady 为 false 时不回退到 contextServices.hooksService。
// 审核 binding 结算后才调 refreshHooks，避免行内按钮停在旧快照。
// 信任中记录当前 hook。
export function useWorkspaceHookInlineTrust(input: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  authorityKey?: string;
  hooksService?: IHooksService;
  rpcReady?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const contextServices = useServices();
  // Settings 的 PluginScopeMenu 可以选中非当前激活的（远程）workspace。
  // 信任后的列表刷新与 settings 预信任回退若走 useServices() 的 context 服务（指向激活
  // tab 的 host），RPC 会打到错误 host；remote-waiting 时 fallback 更会把越界 RPC 发给
  // 断连代理。因此 hooksService 必须由调用方传入按 target workspace 解析的服务，且
  // rpcReady=false 时禁用 fallback 与 refresh——信任链路宁可不可用，不可打错 host。
  // input.rpcReady === false 时整个三元直接给 undefined。
  // input.hooksService 有值就用它，不看 contextServices。
  // 只有 rpcReady === true 才回退到 contextServices.hooksService。
  const hooksService =
    input.rpcReady === false
      ? undefined
      : (input.hooksService ??
        (input.rpcReady === true ? contextServices.hooksService : undefined));
  const canUseHooksService = hooksService !== undefined;
  const refreshHooks = useHooksStore((state) => state.refresh);
  const [trustingHookId, setTrustingHookId] = useState<string | null>(null);
  const activeReview = useWorkspaceHookReviewStore((state) =>
    findWorkspaceHookReviewBinding(state.bindings, input.workspacePath, input.workspaceIdentity),
  );
  const activeReviewInteractionId = activeReview?.request.interactionId;
  const hasWorkspaceGrantAuthority =
    canUseHooksService && Boolean(hooksService!.grantWorkspaceHookTrust);
  const trustActionAvailable = useWorkspaceHookReviewStore(
    (state) =>
      hasWorkspaceGrantAuthority ||
      Boolean(
        findWorkspaceHookReviewBinding(
          state.bindings,
          input.workspacePath,
          input.workspaceIdentity,
        ) ??
        findWorkspaceHookCommandBinding(
          state.commandBindings,
          input.workspacePath,
          input.workspaceIdentity,
        ),
      ),
  );

  // 审核绑定结束后刷新列表，避免 Trust 已落盘但行内按钮仍停留在旧快照。
  const previousReviewInteractionId = useRef(activeReviewInteractionId);
  // didWorkspaceHookReviewSettle(previous, current) 为真才算结算并刷新。
  // target 的 workspacePath、workspaceIdentity、authorityKey 与 service 由同一同步段决定。
  // 未结算、缺 workspacePath 或 canUseHooksService 为假时直接 return。
  useEffect(() => {
    const settled = didWorkspaceHookReviewSettle({
      previousInteractionId: previousReviewInteractionId.current,
      currentInteractionId: activeReviewInteractionId,
    });
    previousReviewInteractionId.current = activeReviewInteractionId;
    if (!settled || !input.workspacePath || !canUseHooksService) return;
    // 三元组与 service 同刻捕获，防止 refresh 等待期间 scope 切换后污染新 workspace。
    const service = hooksService!;
    const target = {
      workspacePath: input.workspacePath,
      workspaceIdentity: input.workspaceIdentity,
      authorityKey: input.authorityKey,
    };
    void refreshHooks(service, target);
  }, [
    activeReviewInteractionId,
    canUseHooksService,
    hooksService,
    input.authorityKey,
    input.workspaceIdentity,
    input.workspacePath,
    refreshHooks,
  ]);

  // canUseHooksService 为 false 时 trustHook 直接 return。
  // result.accepted 为 false 时不调 refreshHooks。
  // finally 里 setTrustingHookId(null)，加载态一定会清。
  const trustHook = useCallback(
    async (hook: Hook) => {
      if (!canUseHooksService) return;
      const service = hooksService!;
      setTrustingHookId(hook.id);
      try {
        const result = await trustWorkspaceHookWithReview({
          hook,
          workspacePath: input.workspacePath,
          workspaceIdentity: input.workspaceIdentity,
          ...(service.grantWorkspaceHookTrust
            ? {
                grantWithoutSession: (target) => service.grantWorkspaceHookTrust!(target),
              }
            : {}),
        });
        // 过期拒绝静默处理，不弹 toast。
        // 提示文案按 reasonCode 查表，过期拒绝走静默分支。
        // 失败分支不调 refreshHooks，列表保持旧快照。
        if (!result.accepted) {
          const currentBinding = findWorkspaceHookReviewBinding(
            useWorkspaceHookReviewStore.getState().bindings,
            input.workspacePath,
            input.workspaceIdentity,
          );
          const hasLivePendingBinding = Boolean(currentBinding);
          if (
            !shouldSilenceStaleRejection({
              reasonCode: result.reasonCode,
              hasLivePendingBinding,
            })
          ) {
            toast(
              intl.formatMessage({
                id: resolveWorkspaceHookReasonCodeMessageId(result.reasonCode),
              }),
            );
          }
          return;
        }
        // 成功后按发起时的 target 原子刷新；等待期间 scope 已切换则由 store 守卫丢弃。
        await refreshHooks(service, {
          workspacePath: input.workspacePath,
          workspaceIdentity: input.workspaceIdentity,
          authorityKey: input.authorityKey,
        });
      } catch (cause) {
        logger.error("[workspace-hook-trust] 行内信任命令失败", { cause });
        toast(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setTrustingHookId(null);
      }
    },
    [
      canUseHooksService,
      hooksService,
      input.authorityKey,
      input.workspaceIdentity,
      input.workspacePath,
      intl,
      refreshHooks,
    ],
  );

  return {
    activeReviewInteractionId,
    trustActionAvailable,
    trustingHookId,
    trustHook,
  };
}
