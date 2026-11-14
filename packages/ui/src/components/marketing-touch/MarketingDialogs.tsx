// INV-01 claim 错误走独立弹窗：守住位置 errorAction 判定；改错故障 领取失败被普通 toast 吞掉。
// INV-02 非 claim 错误只提示一次：守住位置 toast 后立即 clearError；改错故障 同一错误反复弹出。
// INV-03 提示副作用依赖 claimError：守住位置 useEffect 依赖数组；改错故障 领取失败时又叠一层 toast。
// INV-04 内容按投递位选择：守住位置 resource_position 三元；改错故障 banner 活动误用 popup 载荷。
// INV-05 缺少内容即不渲染：守住位置 payload 与 content 双条件；改错故障 空弹窗遮罩无法关闭。
// INV-06 升级导航打开时让位：守住位置 open 的 !openingUpgrade；改错故障 两个弹层同时抢占焦点。
// INV-07 claim 错误优先于内容弹窗：守住位置 open 的 !claimError；改错故障 失败提示被营销内容盖住。
// INV-08 pending 透传为 actionPending：守住位置 属性绑定；改错故障 重复点击造成多次领取。
// INV-09 四个动作语义固定：守住位置 handlers 的键名；改错故障 载荷按照错误语义派发。
// INV-10 导航动作要按 id 反查按钮：守住位置 find 的下标拼接；改错故障 点哪个都跳第一个按钮。
// INV-11 动作失败必须抛错：守住位置 两处 status 判定；改错故障 失败被当成成功，弹窗直接关闭。
// INV-12 复制失败用独立错误码：守住位置 marketing_copy_failed；改错故障 无法区分复制与导航故障。
// INV-13 文案全部走 intl：守住位置 四处 formatMessage；改错故障 多语言环境出现硬编码英文。
// INV-14 关闭动作不等待结果：守住位置 void controller.closeDialog；改错故障 React 收到 Promise 返回值。
//
// 模块职责：把营销触达控制器状态映射成失败弹窗与内容弹窗，并转译四类用户动作。
// 阅读顺序：先看错误提示副作用，再看内容选择与两个弹窗的互斥条件，最后看动作处理表。
import { useEffect } from "react";
import { useStore } from "zustand";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { CloudContentDialog } from "@/components/cloud-content-dialog/CloudContentDialog.js";
import { MarketingFailureDialog } from "@/components/marketing-touch/MarketingFailureDialog.js";
import { adaptMarketingPopup } from "@/components/marketing-touch/marketingPopupAdapter.js";
import { marketingNavigation } from "@/lib/marketingNavigation.js";
import type { MarketingTouchController } from "@/components/marketing-touch/marketingTouchController.js";

export function MarketingDialogs({ controller }: { controller: MarketingTouchController }) {
  const state = useStore(controller.store);
  const openingUpgrade = useStore(
    marketingNavigation,
    (state) => state.request?.target.page === "upgrade",
  );
  const { locale, intl } = useZCodeIntl();
  // 只有领取动作的错误才升级为阻断式弹窗。
  const claimError = state.errorAction === "claim_zcode_plan" ? state.error : null;
  useEffect(() => {
    // 领取错误已交给弹窗，这里不能重复提示。
    if (state.error && !claimError) {
      toast(state.error);
      controller.clearError();
    }
  }, [state.error, claimError, controller]);
  const dialog = state.dialog;
  // 先判空再取投递位，避免读 undefined 的 delivery。
  const content = !dialog
    ? null
    : dialog.delivery.resource_position === "popup"
      // popup 位直接取弹窗载荷。
      ? dialog.delivery.popup
      // banner 位只在成功场景展示，取 success_popup。
      : dialog.delivery.banner.success_popup;
  const payload =
    dialog && content
      // 载荷适配统一入口，页面层不直接拼字段。
      ? adaptMarketingPopup(
          dialog.delivery.campaign_id,
          locale,
          content,
          dialog.hero,
          intl.formatMessage({ id: "manualClaimPlan.claim.dialog.modelSettings" }),
        )
      : null;
  return (
    <>
      {claimError ? (
        <MarketingFailureDialog
          message={claimError}
          title={intl.formatMessage({ id: "manualClaimPlan.claim.failure.title" })}
          acknowledge={intl.formatMessage({ id: "manualClaimPlan.claim.dialog.acknowledge" })}
          onClose={() => controller.clearError()}
        />
      ) : null}
      {payload && content ? (
        <CloudContentDialog
          payload={payload}
          // 升级页已打开或领取失败时都不再显示。
          open={!openingUpgrade && !claimError}
          actionPending={state.pending}
          onClose={() => {
            // 关闭是异步的，这里显式丢弃返回值。
            void controller.closeDialog();
          }}
          labels={{
            actionFailed: intl.formatMessage({ id: "marketingTouch.failed" }),
            copySucceeded: intl.formatMessage({
              id: "manualClaimPlan.claim.share.copyTextSucceeded",
            }),
          }}
          handlers={{
            open_external: async (action) => {
              await controller.dialogAction({ type: "open_url", args: { url: action.url } });
            },
            claim_plan: async (action) => {
              await controller.dialogAction({
                type: "claim_zcode_plan",
                args: { plan_id: action.planId },
              });
            },
            // 复制结果由控制器返回，本层只做失败转抛。
            copy_text: async (action) => {
              const result = await controller.dialogAction({
                type: "copy_text",
                args: { text: action.text },
              });
              if (result?.status !== "success") throw new Error("marketing_copy_failed");
            },
            // 第一个参数不用，按 actionId 反查按钮。
            navigate: async (_action, actionId) => {
              const button = content.buttons.find(
                (_button, index) => `button-${index}` === actionId,
              );
              // `button` 缺失或 `action.type` 不是 `navigate` 都抛 `marketing_navigation_invalid`。
              if (button?.action.type !== "navigate")
                throw new Error("marketing_navigation_invalid");
              const result = await controller.dialogAction(button.action);
              if (result?.status !== "success") throw new Error("marketing_navigation_failed");
            },
          }}
        />
      ) : null}
    </>
  );
}
