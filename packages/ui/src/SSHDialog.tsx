// INV-01 触发器可隐藏：守住位置 条件渲染；改错故障 关闭态残留重复入口。
// INV-02 触发器样式由调用方覆盖：守住位置 变体属性；改错故障 自定义按钮被固定样式盖住。
// INV-03 触发器文案可替换：守住位置 空值合并；改错故障 自定义触发器仍显示默认文案。
// INV-04 对话框开关完全受控：守住位置 流程返回的状态；改错故障 两处真相不一致。
// INV-05 打开时把焦点移入新屏：守住位置 焦点查询；改错故障 键盘用户停留在旧屏。
// INV-06 已在新屏内则不抢焦点：守住位置 包含判断；改错故障 用户刚点的字段被重置。
// INV-07 焦点只找可交互元素：守住位置 选择器；改错故障 焦点落到禁用控件。
// INV-08 上边缘固定避免跳动：守住位置 顶部偏移类；改错故障 切换步骤时对话框上下跳。
// INV-09 高度上限跟随动态视口：守住位置 最大高类；改错故障 手机工具栏遮挡按钮。
// INV-10 内容区允许内部滚动：守住位置 溢出类；改错故障 长列表撑破对话框。
// INV-11 错误提示仅在非连接步骤显示：守住位置 双条件；改错故障 连接中重复报错。
// INV-12 错误样式使用语义色对：守住位置 表面与前景类；改错故障 两种模式错误外观不一。
// INV-13 错误图标与文本同排：守住位置 对齐类；改错故障 图标与多行文本错位。
// INV-14 四步各自独占渲染分支：守住位置 条件渲染；改错故障 两个步骤同时出现。
// INV-15 最小化能力可关闭：守住位置 条件属性；改错故障 后台模式仍可最小化。
// INV-16 关闭按钮不显示：守住位置 布尔属性；改错故障 头部出现两个关闭入口。
// INV-17 测试标识按步骤区分：守住位置 三处标识；改错故障 自动化无法判断当前步骤。
// INV-18 别名与实现同名导出：守住位置 末尾导出；改错故障 旧引用路径失效。
//
// 模块职责：远端连接向导的外壳，串起触发器、四步内容与错误提示。
// 状态所有权：开关、步骤与错误全部来自连接流程 hook。
// 阅读顺序：先看触发器与流程接线，再看焦点效果，最后看四个步骤分支。
import { RemoteConnectionSelection } from "@/remote-connection/RemoteConnectionSelection.js";
import { usePublishRemoteConnectionProgress } from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import { useEffect, useRef, type ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import {
  TID_SSH_CONNECT_TRIGGER,
  TID_SSH_DIALOG,
  TID_SSH_ERROR,
  TID_SSH_SUCCESS,
} from "@zcode/shared/test-ids";
import { AlertTriangleIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useRemoteConnectionFlow,
  type RemoteConnectionFlowOptions,
} from "@/remote-connection-flow/index.js";
import {
  RemoteConnectionConnectingStep,
  RemoteConnectionDirectoryStep,
  RemoteConnectionSettingsStep,
} from "@/RemoteConnectionDialogContent.js";
import { RemoteConnectionWizardHeader } from "@/RemoteConnectionWizardChrome.js";

interface RemoteConnectionDialogProps extends RemoteConnectionFlowOptions {
  trigger?: ReactNode;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerSize?: VariantProps<typeof buttonVariants>["size"];
  triggerClassName?: string;
  hideTriggerWhenClosed?: boolean;
  allowBackground?: boolean;
}

// 触发器与 RemoteConnectionDialog 同源开关：open 由 useRemoteConnectionFlow 给出。
// 样式与文案允许调用方覆盖。
// 流程状态来自专用 hook。
export function RemoteConnectionDialog(props: RemoteConnectionDialogProps) {
  const {
    trigger,
    triggerVariant = "outline",
    triggerSize = "sm",
    triggerClassName,
    hideTriggerWhenClosed = false,
    allowBackground = true,
  } = props;
  const { intl } = useZCodeIntl();
  // open 与 currentStep 由 useRemoteConnectionFlow 持有，本组件不另存状态。
  // currentStep 决定下方 switch 走哪个 SSH 步骤分支。
  // minimizedProgress 经 usePublishRemoteConnectionProgress 对外发布。
  const flow = useRemoteConnectionFlow(props);
  const { open, currentStep, error, handleOpenChange } = flow;
  usePublishRemoteConnectionProgress(flow.minimizedProgress);
  const screenRef = useRef<HTMLDivElement>(null);
  // 关闭时不动焦点：open=false 时 effect 直接 return。
  // screenRef 内已有焦点就不抢，保留凭据输入框的焦点位置。
  // 聚焦目标由 querySelector 选第一个可交互元素：input、button 或 [tabindex="0"]。
  useEffect(() => {
    if (!open) return;
    // 优先保留凭据等待点主动聚焦的字段；否则焦点随新屏移动。
    if (screenRef.current?.contains(document.activeElement)) return;
    screenRef.current
      ?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled), [tabindex="0"]')
      ?.focus();
  }, [open, currentStep]);

  // hideTriggerWhenClosed 为 true 时整块不渲染触发器。
  // 对话框高度跟随 dvh 动态视口，软键盘弹出时不被裁切。
  // error 只在 currentStep 非连接步骤时显示。
  return (
    <>
      {!hideTriggerWhenClosed ? (
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          onClick={() => flow.handleOpenChange(true)}
          data-testid={TID_SSH_CONNECT_TRIGGER}
          className={triggerClassName}
        >
          {trigger ?? intl.formatMessage({ id: "remote.trigger" })}
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        {/* 上边缘固定在视口 10% 处，切换类型或认证方式时只向下伸缩，不再上下跳（RDUX-27）。 */}
        <DialogContent
          showCloseButton={false}
          className="top-[10vh] flex max-h-[calc(90dvh-1rem)] w-[calc(100vw-2rem)] max-w-2xl translate-y-0 flex-col overflow-hidden rounded-2xl p-0"
        >
          <div data-testid={TID_SSH_DIALOG} className="flex min-h-0 flex-col overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:gap-4 sm:p-6">
              <DialogHeader className="space-y-2">
                <RemoteConnectionWizardHeader
                  {...flow.header}
                  onMinimize={allowBackground ? flow.header.onMinimize : undefined}
                />
              </DialogHeader>

              {error && currentStep !== "connecting" ? (
                <div
                  data-testid={TID_SSH_ERROR}
                  // 远程连接的错误提示以前直接拼接颜色 token，和全局状态反馈样式不一致。
                  // 这里统一改成 destructive 语义色对，避免 SSH/Docker 两种模式出现不同的错误视觉。
                  className="flex items-start gap-3 rounded-md bg-destructive-surface px-3 py-3 text-ui-sm text-destructive-surface-foreground"
                >
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                  {error}
                </div>
              ) : null}

              <div ref={screenRef} className="flex w-full min-h-0 flex-col">
                {currentStep === "device" ? (
                  <RemoteConnectionSelection {...flow.selectionStep} />
                ) : null}

                {currentStep === "settings" ? (
                  <RemoteConnectionSettingsStep {...flow.settingsStep} />
                ) : null}

                {currentStep === "connecting" ? (
                  <RemoteConnectionConnectingStep
                    {...flow.connectingStep}
                    onMinimize={allowBackground ? flow.connectingStep.onMinimize : undefined}
                  />
                ) : null}

                {currentStep === "directory" ? (
                  <div data-testid={TID_SSH_SUCCESS} className="flex min-h-0 flex-col">
                    <RemoteConnectionDirectoryStep {...flow.directoryStep} />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const SSHDialog = RemoteConnectionDialog;
