// INV-01 单一挂载点统一渲染所有确认请求：守住位置 ConfirmDialogHost 顶层；改错故障：多处各自渲染会让同一请求弹出两次并双份结算。
// INV-02 退场动画期间沿用最后一次可见内容：守住位置 displayedRequestRef；改错故障：直接读 pendingRequest 会让标题先变空只剩按钮闪一帧。
// INV-03 open 只由 pendingRequest 决定：守住位置 open 计算；改错故障：用 displayedRequest 判断会让弹窗在结算后无法关闭。
// INV-04 结算后 store 立刻清空请求：守住位置 settle 调用点；改错故障：清空与结算拆成两步会让 Promise 永远悬空。
// INV-05 requiredAcknowledgement 禁止 dismiss 与取消：守住位置 handleOpenChange 分支；改错故障：遮罩点击会被当成已读确认。
// INV-06 复选框状态按请求实例绑定：守住位置 checkboxSelection.request 比较；改错故障：跨请求复用勾选会把上次同意带到下次。
// INV-07 Enter 快捷键在窗口捕获阶段统一兜底：守住位置 handleKeyDown 注册；改错故障：只在按钮上监听会让键盘用户必须 Tab 到按钮。
// INV-08 destructive 弹窗打开时焦点落在取消上：守住位置 onOpenAutoFocus；改错故障：默认聚焦确认会让回车直接执行不可恢复动作。
// INV-09 带复选框时不抢按钮的 Enter 语义：守住位置 closest 判断；改错故障：在勾选框上回车会误触发确认。
// INV-10 主按钮颜色只认显式 destructive：守住位置 confirmVariant 回落；改错故障：所有删除确认都变红会稀释危险信号。
// INV-11 键盘提示可被调用方关闭：守住位置 showKeyboardHints 判断；改错故障：移动端仍显示 esc 会误导用户。
// INV-12 compact 只影响遮罩与尺寸：守住位置 compact 分支；改错故障：把紧凑模式接到逻辑结算会改变行为。
// INV-13 automation 确认使用固定 presentation：守住位置 类名拼接；改错故障：不同入口尺寸不一致会让同一动作看起来不同。
// INV-14 source-server-boundary 走专用内容组件：守住位置 提前返回分支；改错故障：复用普通布局会丢掉边界说明与专用面板。
// INV-15 关闭按钮为可选项且受 requiredAcknowledgement 抑制：守住位置 尾部条件渲染；改错故障：必读弹窗出现关闭按钮会让用户绕过确认。
// INV-16 取消与确认标签支持调用方覆盖：守住位置 label 回落；改错故障：硬编码文案会让业务弹窗无法本地化。
// INV-17 事件监听器随弹窗状态正确解绑：守住位置 effect 清理；改错故障：残留监听会在关闭后仍拦截 Enter。
// INV-18 data-testid 与 intent 透传到内容层：守住位置 DialogContent 属性；改错故障：E2E 无法区分不同确认来源。
//
// 模块职责：确认对话框的唯一宿主，把 store 中的待决请求渲染为弹窗并完成结算。
// 状态所有权：请求与结算归 confirmDialogStore；勾选与可见内容快照归本组件。
// 阅读顺序：先看可见快照与 open 推导，再看两条关闭路径，最后看两种 presentation 的渲染分支。
import { useCallback, useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.js";
import { XIcon } from "lucide-react";
import { TID_CONFIRM_DIALOG_CONFIRM } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { cn } from "@/components/lib/utils.js";
import {
  AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS,
  AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS,
} from "@/settings/automationConfirmDialogPresentation.js";
import { SourceServerBoundaryDialogContent } from "@/remote/SourceServerBoundaryDialogContent.js";

export function ConfirmDialogHost() {
  const { intl } = useZCodeIntl();
  // pendingRequest/settleConfirmation/settleChoice 用三个独立 selector 订阅，避免把整个 store 拉进渲染依赖；
  // 确认与选择是两条结算路径（settleConfirmation vs settleChoice("dismiss")），合并会让遮罩关闭误触发确认；
  // 请求为空时组件仍保持挂载，只为承接 Radix 的关闭动画。
  const pendingRequest = useConfirmDialogStore((state) => state.pendingRequest);
  const settleConfirmation = useConfirmDialogStore((state) => state.settleConfirmation);

  const settleChoice = useConfirmDialogStore((state) => state.settleChoice);

  const displayedRequestRef = useRef(pendingRequest);
  if (pendingRequest) {
    // Promise 结算后 store 会立刻清空 pendingRequest，但 Radix 关闭动画还会保留一帧内容层。
    // 如果这里直接读取 pendingRequest，退场动画期间标题/描述会先变空，只剩“确认 / 取消”按钮闪一下。
    // 因此关闭完成前继续沿用最后一次可见内容，只让 open 状态控制弹窗退场。
    displayedRequestRef.current = pendingRequest;
  }
  // displayedRequest 取 pendingRequest ?? displayedRequestRef.current：结算后 store 立刻清空 pendingRequest，
  // 但 Radix 关闭动画还要渲染一帧，直接读 pendingRequest 会让标题先变空；快照只在 pendingRequest 非空时于渲染期覆盖；
  // open 只由 Boolean(pendingRequest) 决定，若改用 displayedRequest 推导，弹窗将永远关不掉。
  const displayedRequest = pendingRequest ?? displayedRequestRef.current;
  const [checkboxSelection, setCheckboxSelection] = useState<{
    request: typeof displayedRequest;
    checked: boolean;
  }>({ request: undefined, checked: false });
  const open = Boolean(pendingRequest);
  const isAutomationConfirmation = displayedRequest?.presentation === "automation-confirmation";
  const isSourceServerBoundary = displayedRequest?.presentation === "source-server-boundary";
  const confirmLabel =
    displayedRequest?.confirmLabel ?? intl.formatMessage({ id: "common.confirm" });
  const cancelLabel = displayedRequest?.cancelLabel ?? intl.formatMessage({ id: "common.cancel" });
  const compact = displayedRequest?.compact === true;
  const destructive = displayedRequest?.confirmVariant === "destructive";
  const cancelRef = useRef<HTMLButtonElement>(null);
  const requiredAcknowledgement = displayedRequest?.requiredAcknowledgement === true;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      // Bugfix: Radix 在点击遮罩或按 Esc 时只会回调 onOpenChange(false)。
      // 选择对话框保留 dismiss 与取消的区别；required acknowledgement 必须保持打开，避免未确认却被记为已读。
      // 因此只有 !nextOpen && !requiredAcknowledgement 时才 settleChoice("dismiss")，确认按钮才走
      // settleConfirmation(false)；依赖 [requiredAcknowledgement, settleChoice] 保证闭包读到当前 store 动作。
      if (!nextOpen && !requiredAcknowledgement) {
        settleChoice("dismiss");
      }
    },
    [requiredAcknowledgement, settleChoice],
  );

  const handleConfirm = useCallback(() => {
    settleConfirmation(true);
  }, [settleConfirmation]);

  // 该 effect 只在 open && !destructive 时注册 window keydown：destructive 弹窗必须由用户显式点确认，
  // 不能用一个回车就执行不可恢复操作；监听用捕获阶段（第三参 true），先于焦点元素自身的 Enter 处理；
  // 目标落在 button/input 且请求带 checkbox 时直接 return，保留「不了」这类按钮的原生键盘语义；
  // 其余情况 preventDefault + stopPropagation 后 settleConfirmation(true)，清理函数用同一 handleKeyDown 引用 removeEventListener。
  useEffect(() => {
    if (!open || destructive) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter") {
        return;
      }

      // 带复选框的选择对话框保留焦点按钮的键盘语义，避免“不了”按 Enter 变成切换。
      if (
        displayedRequest?.checkbox &&
        event.target instanceof HTMLElement &&
        event.target.closest("button,input")
      )
        return;
      // 二次确认场景下如果不接 Enter，键盘用户会只能切到按钮再触发，
      // 体验和桌面端的确认弹窗不一致。这里在弹窗打开时统一兜住 Enter，保持可预期的确认手势。
      event.preventDefault();
      event.stopPropagation();
      settleConfirmation(true);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, destructive, settleConfirmation, displayedRequest]);

  // isSourceServerBoundary 分支必须在通用渲染之前 return：它把内容交给 SourceServerBoundaryDialogContent，
  // 该组件自带标题/描述/确认按钮且没有取消按钮；若走下面的 DialogFooter 会叠加两套页脚；
  // DialogContent 用 p-0 与 bg-popover，让边界面板自己排版，showCloseButton={false} 防止绕过确认。
  if (isSourceServerBoundary) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          data-confirm-intent={displayedRequest?.intent}
          data-testid="source-server-boundary-dialog"
          showCloseButton={false}
          // Bug 原因：continuity dialog 曾用 bg-popover/98 组件级拼接 alpha，主题表面 token 因而无法统一维护。
          // 直接使用完整的 popover surface，保留对话框层级和专用 continuity panel。
          className="gap-0 overflow-hidden rounded-2xl border-none bg-popover p-0 ring-border shadow-2xl sm:max-w-xl"
        >
          <SourceServerBoundaryDialogContent
            title={displayedRequest?.title}
            description={displayedRequest?.description}
            confirmLabel={confirmLabel}
            onConfirm={handleConfirm}
          />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    // displayedRequest.showCloseButton && !requiredAcknowledgement 时才渲染 DialogClose 的右上角 X：
    // Button 用 absolute right-5 top-5 脱离 DialogFooter 布局，[app-region:no-drag] 保证桌面端可点；
    // 必读弹窗即使请求了 showCloseButton 也抑制，否则用户可绕过确认直接关闭。
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-confirm-intent={displayedRequest?.intent}
        data-testid={displayedRequest?.testId}
        onOpenAutoFocus={(event) => {
          if (destructive) {
            event.preventDefault();
            cancelRef.current?.focus();
          }
        }}
        showCloseButton={false}
        overlayClassName={
          compact ? "bg-black/20 supports-backdrop-filter:backdrop-blur-[2px]" : undefined
        }
        className={cn(
          "gap-5 rounded-2xl border-none bg-popover/98 p-5 ring-border shadow-2xl",
          // 仅依赖共享弹框的响应式 max-width 时，不同入口所在 viewport 会让
          // 同一删除确认框看起来尺寸不一致。定时任务删除按设计固定同一 presentation。
          isAutomationConfirmation ? AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS : "sm:max-w-md",
          displayedRequest?.compact && "top-[44%] min-h-[161px] gap-4 sm:max-w-[400px]",
        )}
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="text-ui-lg font-semibold text-foreground">
            {displayedRequest?.title}
          </DialogTitle>
          {displayedRequest?.description ? (
            <DialogDescription
              className={cn(
                "whitespace-pre-line pt-0.5 text-ui-base leading-6 text-foreground-subtle",
                isAutomationConfirmation && AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS,
              )}
            >
              {displayedRequest.description}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter
          className={cn(
            "gap-2 sm:justify-end",
            displayedRequest?.checkbox && "flex-row flex-wrap items-center",
            // Automation 弹窗的最小高度会拉伸 Grid footer 行，按钮停在行顶导致视觉底距超过 20px。
            isAutomationConfirmation && "mt-auto",
          )}
        >
          {displayedRequest?.checkbox ? (
            <label className="mr-auto flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle">
              <Checkbox
                checked={
                  checkboxSelection.request === displayedRequest && checkboxSelection.checked
                }
                onCheckedChange={(value) => {
                  setCheckboxSelection({ request: displayedRequest, checked: value === true });
                  displayedRequest.checkbox?.onCheckedChange(value === true);
                }}
              />
              {displayedRequest.checkbox.label}
            </label>
          ) : null}
          <div
            className={displayedRequest?.checkbox ? "ml-auto flex items-center gap-2" : "contents"}
          >
            {requiredAcknowledgement ? null : (
              <Button
                type="button"
                ref={cancelRef}
                variant={compact ? "outline" : "secondary"}
                size={"lg"}
                onClick={() => settleConfirmation(false)}
                className={cn(
                  "h-9 gap-3 px-4",
                  displayedRequest?.showKeyboardHints !== false && "justify-between sm:min-w-28",
                )}
              >
                <span>{cancelLabel}</span>
                {displayedRequest?.showKeyboardHints !== false ? (
                  <span className="font-mono text-ui-base text-foreground-subtle">esc</span>
                ) : null}
              </Button>
            )}
            <Button
              type="button"
              autoFocus={!destructive}
              // 普通确认沿用主按钮；仅显式声明 destructive 的不可恢复动作使用危险色。
              variant={displayedRequest?.confirmVariant ?? "default"}
              size={"lg"}
              data-testid={TID_CONFIRM_DIALOG_CONFIRM}
              onClick={handleConfirm}
              className={cn(
                "h-9 gap-3 px-4",
                displayedRequest?.showKeyboardHints !== false && "justify-between sm:min-w-32",
              )}
            >
              <span>{confirmLabel}</span>
              {!destructive && displayedRequest?.showKeyboardHints !== false ? (
                <span
                  className={
                    displayedRequest?.confirmVariant === "destructive"
                      ? "text-ui-base text-destructive-foreground/60"
                      : "text-ui-base text-primary-foreground/60"
                  }
                >
                  ⏎
                </span>
              ) : null}
            </Button>
          </div>
        </DialogFooter>
        {displayedRequest?.showCloseButton && !requiredAcknowledgement ? (
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute right-5 top-5 z-20 text-foreground-subtle hover:bg-surface-hover hover:text-foreground [app-region:no-drag]"
            >
              <XIcon className="size-4" strokeWidth={4 / 3} />
            </Button>
          </DialogClose>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
