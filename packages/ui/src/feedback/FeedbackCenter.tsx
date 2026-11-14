// INV-01 无反馈服务时整块不渲染：守住位置 早退分支；改错故障 依赖缺失直接崩溃。
// INV-02 弹窗开关来自全局反馈状态：守住位置 受控属性；改错故障 关闭后再开丢失标签页。
// INV-03 关闭只走统一出口：守住位置 关闭回调；改错故障 状态残留导致重复打开。
// INV-04 标题随标签页切换：守住位置 三元标识；改错故障 票单页显示提交标题。
// INV-05 返回按钮仅在票单页出现：守住位置 条件渲染；改错故障 提交页出现无效返回。
// INV-06 返回按钮直接切回提交页：守住位置 切换回调；改错故障 返回需要重新打开。
// INV-07 返回按钮带无障碍名：守住位置 标签属性；改错故障 读屏只念按钮。
// INV-08 关闭按钮隐藏内置关闭：守住位置 布尔属性；改错故障 头部出现两个关闭。
// INV-09 背景上传指示器覆盖两个弹窗：守住位置 或运算；改错故障 上传进度被弹窗遮住。
// INV-10 反馈弹窗与功能请求弹窗并列渲染：守住位置 兄弟节点；改错故障 两个入口互相挤掉。
// INV-11 提交表单以任务标识作键：守住位置 键属性；改错故障 换任务后草稿残留。
// INV-12 提交成功切到票单页：守住位置 回调调用；改错故障 提交后停留在空表单。
// INV-13 提交页可主动看票单：守住位置 切换回调；改错故障 提交后无法查看历史。
// INV-14 取消即关闭弹窗：守住位置 关闭回调；改错故障 取消后弹窗留在原地。
// INV-15 标签值受控：守住位置 取值属性；改错故障 标签页点击无反馈。
// INV-16 标签切换写回全局状态：守住位置 变更回调；改错故障 切页后重开回到上一页。
// INV-17 尺寸同时受视口约束：守住位置 最小函数；改错故障 窄屏弹窗超出屏幕。
// INV-18 卡片整体带记忆化：守住位置 包装调用；改错故障 父级渲染拖动整块重算。
//
// 模块职责：反馈中心的统一弹窗，承担提交与票单两个标签页。
// 状态所有权：全部页面状态来自反馈 store，组件只做分发。
// 阅读顺序：先看状态接线，再看标题派生，最后看弹窗骨架。
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Tabs, TabsContent } from "@/components/ui/tabs.js";
import { Button } from "@/components/ui/button.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { FeedbackSubmitForm } from "@/feedback/FeedbackSubmitForm.js";
import { FeatureRequestDialog } from "@/feedback/FeatureRequestDialog.js";
import { TicketsView } from "@/feedback/TicketsView.js";
import { FeedbackBackgroundUploadIndicator } from "@/feedback/FeedbackBackgroundUploadIndicator.js";
import { ArrowLeftIcon, XIcon } from "lucide-react";
import type { IFeedbackService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { memo } from "react";

// FeedbackCenter 用 memo 包一层，props 不变即跳过渲染
// feedbackService 为 undefined 时直接 return null
// open / featureRequestOpen / tab 都来自 useFeedbackStore
export const FeedbackCenter = memo(function FeedbackCenterComponent({
  feedbackService,
  platform,
}: {
  feedbackService?: IFeedbackService;
  platform: IPlatformService;
}) {
  const open = useFeedbackStore((state) => state.open);
  const featureRequestOpen = useFeedbackStore((state) => state.featureRequestOpen);
  const tab = useFeedbackStore((state) => state.tab);
  const submitDraft = useFeedbackStore((state) => state.submitDraft);
  const submissionJobId = useFeedbackStore((state) => state.submissionJobId);
  const setTab = useFeedbackStore((state) => state.setTab);
  const close = useFeedbackStore((state) => state.close);
  const openTickets = useFeedbackStore((state) => state.openTickets);
  const { intl } = useZCodeIntl();
  // titleId 按 tab === "tickets" 切到 feedback.center.ticketsTitle
  // 返回按钮仅在 tab === "tickets" 时渲染
  // XIcon 单独渲染，Dialog 内置关闭被隐藏
  // FeedbackBackgroundUploadIndicator 的 feedbackDialogOpen 覆盖两个弹窗
  const titleId =
    tab === "tickets" ? "feedback.center.ticketsTitle" : "feedback.center.submitTitle";

  if (!feedbackService) return null;

  // FeatureRequestDialog 与 Dialog 作兄弟节点，避免嵌套层级
  // 提交表单的 key 取 submissionJobId
  // 提交成功后 setTab("tickets") 切到票单页
  // DialogContent 的 max-h 按视口高度收口
  return (
    <>
      <FeedbackBackgroundUploadIndicator feedbackDialogOpen={open || featureRequestOpen} />
      <FeatureRequestDialog feedbackService={feedbackService} />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="grid h-[min(38rem,calc(100vh-2rem))] w-[min(34rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl border border-popover-border bg-popover p-0 text-foreground shadow-md backdrop-blur-2xl max-sm:h-[calc(100vh-1rem)] max-sm:w-[calc(100vw-1rem)]"
        >
          <DialogHeader className="flex-row items-center justify-between gap-2 p-6 pb-0">
            <div className="flex min-w-0 items-center gap-2">
              {tab === "tickets" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-md"
                  className="shrink-0 rounded-lg text-foreground-subtle hover:text-foreground"
                  aria-label={intl.formatMessage({ id: "feedback.center.backToSubmit" })}
                  data-feedback-back-to-submit="true"
                  onClick={() => setTab("submit")}
                >
                  <ArrowLeftIcon className="size-4" />
                </Button>
              ) : null}
              <DialogTitle className="min-w-0 truncate text-ui-lg font-medium text-foreground">
                {intl.formatMessage({ id: titleId })}
              </DialogTitle>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="shrink-0 rounded-xl"
              aria-label={intl.formatMessage({ id: "common.close" })}
              onClick={close}
            >
              <XIcon className="size-4" />
            </Button>
          </DialogHeader>
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as typeof tab)}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <TabsContent value="submit" className="min-h-0 flex-1 overflow-hidden outline-none">
              <FeedbackSubmitForm
                key={submissionJobId ?? "new-feedback"}
                feedbackService={feedbackService}
                platform={platform}
                initialDraft={submitDraft}
                submissionJobId={submissionJobId}
                onSubmitted={(ticketId) => openTickets(ticketId)}
                onViewTickets={() => setTab("tickets")}
                onCancel={close}
              />
            </TabsContent>

            <TabsContent
              value="tickets"
              className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
            >
              <TicketsView feedbackService={feedbackService} onCreateNew={() => setTab("submit")} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  );
});
