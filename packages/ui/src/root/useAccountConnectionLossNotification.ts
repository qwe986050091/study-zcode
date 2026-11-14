// INV-01 根层只观察一次：守住位置 挂载副作用；改错故障 每次文案变化都重建账号基线。
// INV-02 最新值走引用读取：守住位置 引用赋值；改错故障 回调捕获旧文案。
// INV-03 意图变化先失效：守住位置 首个副作用；改错故障 切走后旧按钮仍可点。
// INV-04 旧通知同时撤掉：守住位置 关闭调用；改错故障 屏幕上叠着两条建议。
// INV-05 替代建议失败只降级：守住位置 捕获分支；改错故障 状态变化时无任何提示。
// INV-06 过期事件不得出通知：守住位置 当前性判断；改错故障 已切换的会话仍弹建议。
// INV-07 动作只执行一次：守住位置 提交中标记；改错故障 连点触发多次写入。
// INV-08 条件写入成功只刷新显示：守住位置 刷新放在成功之后；改错故障 刷新失败被说成保存失败。
// INV-09 失败给同一建议重试：守住位置 警告提示的动作；改错故障 后台自行换目标导致意外。
// INV-10 通知标识与事件成对保存：守住位置 引用结构；改错故障 无法判断哪条通知已过期。
// INV-11 初次读取与变更同一入口：守住位置 接受函数；改错故障 两条路径行为分叉。
// INV-12 视图过期即撤通知：守住位置 接受函数内的判断；改错故障 过期通知常驻。
// INV-13 首次读取失败只记日志：守住位置 捕获后不重试；改错故障 启动即弹出错误。
// INV-14 卸载顺序先观察者后退订：守住位置 清理块；改错故障 回调在释放后仍被调用。
// INV-15 卸载清理当前通知：守住位置 收尾判断；改错故障 离开页面后通知残留。
// INV-16 文案全部走消息键：守住位置 格式化调用；改错故障 出现硬编码语言。
// INV-17 目标为空时不出动作：守住位置 条件展开；改错故障 出现点击无反应的按钮。
// INV-18 刷新回调完全可选：守住位置 可选调用；改错故障 未注入时抛错。
//
// 模块职责：账号连接失效时在根层给出一次性通知与切换建议。
// 状态所有权：观察者与当前通知由 hook 持有，账号数据来自注入的服务。
// 阅读顺序：先看引用与意图副作用，再看观察者的通知构建，最后看订阅与清理。
import { useEffect, useRef } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast, dismissToast } from "@/components/ui/toast.js";
import {
  createAccountConnectionRefreshObserver,
  type AccountConnectionLoss,
} from "@/root/accountConnectionRefreshObserver.js";
import { prepareAccountConnectionSwitch } from "@/root/accountConnectionLossSuggestion.js";
import { logger } from "@/logger.js";

/** 根层只观察一次；页面/文案变化不重新建立账号基线。 */
// 挂载时只建一个 Account 基线观察者，页面与文案变化都不重建。
// 文案与刷新回调走 ref 读取，异步回包拿到的是最新值。
// observerRef 单独持有观察者实例，注销时只释放它。
// noticeRef 成对保存 toast id 与触发它的 AccountConnectionLoss 事件。
// 观察边界由 services、intentKey、refreshAppSettings 三个入参决定。
export function useAccountConnectionLossNotification(
  services: IServiceAccessor,
  intentKey: string,
  refreshAppSettings?: () => Promise<void>,
) {
  const { intl } = useZCodeIntl();
  const latest = useRef({ intl, refreshAppSettings });
  latest.current = { intl, refreshAppSettings };
  const observerRef = useRef<ReturnType<typeof createAccountConnectionRefreshObserver> | null>(
    null,
  );
  const noticeRef = useRef<{ id: number; event: AccountConnectionLoss } | null>(null);
  // intentKey 变化时先让旧观察者失效，再撤旧通知。
  // 旧通知随观察者一起撤，dismissToast 清掉按钮。
  // 撤掉后把 noticeRef.current 置 null，防止拿旧 id 再撤一次。
  // 切走再切回不会复活旧按钮，effect 开头已无条件失效。
  // 这个 effect 只做失效；观察者重建放在下一个 effect 里。
  useEffect(() => {
    // 设置/登录意图先于 Account 查询回包变化；即使切走又切回，旧按钮也不能重新有效。
    observerRef.current?.invalidate();
    if (noticeRef.current) dismissToast(noticeRef.current.id);
    noticeRef.current = null;
  }, [intentKey]);
  useEffect(() => {
    const observer = createAccountConnectionRefreshObserver(async (event) => {
      let suggestion: Awaited<ReturnType<typeof prepareAccountConnectionSwitch>> = null;
      try {
        suggestion = await prepareAccountConnectionSwitch(services, event);
      } catch (error) {
        logger.lifecycle.warn("[AccountConnection] 无法确认替代套餐，仅提示状态", { error });
      }
      if (!event.isCurrent()) return;
      const { intl: copy } = latest.current;
      const label =
        suggestion?.label ??
        (suggestion
          ? copy.formatMessage({
              id:
                suggestion.selection.kind === "start-plan"
                  ? "settings.modelProvider.codingPlan.purchaseBanner.startPlanTitle"
                  : "settings.modelProvider.codingPlan.purchase.individualsSectionTitle",
            })
          : "");
      const target = suggestion;
      let id: number;
      let submitting = false;
      const submit = () => {
        if (!target || submitting) return;
        submitting = true;
        void (async () => {
          try {
            const result = await target.apply();
            dismissToast(id);
            if (result === "stale") {
              toast(
                latest.current.intl.formatMessage({
                  id: "settings.modelProvider.connectionSuggestionStale",
                }),
                { variant: "info" },
              );
              return;
            }
            // 条件写入已成功；这里只刷新显示，不把刷新失败说成保存失败。
            try {
              await latest.current.refreshAppSettings?.();
            } catch (error) {
              logger.lifecycle.warn("[AccountConnection] 连接已保存，设置快照刷新失败", { error });
            }
          } catch (error) {
            logger.lifecycle.warn("[AccountConnection] 手动切换套餐失败", { error });
            if (!event.isCurrent()) return;
            // Toast 点击会自动关闭。失败时给同一建议的显式重试，不能后台选新目标。
            id = toast(
              latest.current.intl.formatMessage({
                id: "settings.modelProvider.connectionSwitchFailed",
              }),
              {
                variant: "warning",
                durationMs: 12000,
                actionLabel: latest.current.intl.formatMessage({ id: "common.retry" }),
                onAction: submit,
              },
            );
            noticeRef.current = { id, event };
          } finally {
            submitting = false;
          }
        })();
      };
      id = toast(copy.formatMessage({ id: "settings.modelProvider.connectionUnavailableNotice" }), {
        variant: "info",
        durationMs: 12000,
        actionLabel: target
          ? copy.formatMessage(
              { id: "settings.modelProvider.switchConnection" },
              { connection: label },
            )
          : undefined,
        onAction: target ? submit : undefined,
      });
      noticeRef.current = { id, event };
    });
    observerRef.current = observer;
    // accept 同时服务 getView() 首次读取与 onDidChange 变更两条路径。
    // view 过期时 accept 内顺带 dismissToast 并清 noticeRef。
    // getView() reject 只记 logger.lifecycle.warn，等下次刷新。
    // cleanup 先 observer.dispose() 并清 observerRef，再 subscription.dispose()。
    // 最后 dismissToast(noticeRef.current.id) 并把 noticeRef 置 null。
    const accept = (view: Parameters<typeof observer.accept>[0]) => {
      void observer.accept(view);
      const notice = noticeRef.current;
      if (notice && !notice.event.isCurrent()) {
        dismissToast(notice.id);
        noticeRef.current = null;
      }
    };
    const subscription = services.providerSettingsService.onDidChange(accept);
    void services.providerSettingsService
      .getView()
      .then(accept)
      .catch((error) => {
        logger.lifecycle.warn("[AccountConnection] 初次读取失败，等待正常刷新", { error });
      });
    return () => {
      observer.dispose();
      observerRef.current = null;
      subscription.dispose();
      if (noticeRef.current) dismissToast(noticeRef.current.id);
      noticeRef.current = null;
    };
  }, [services]);
}
