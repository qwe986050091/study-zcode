// INV-01 三个步骤与两种屏的映射固定：守住位置 当前索引计算；改错故障 进度条高亮错位。
// INV-02 设备管理入口不显示步骤条：守住位置 设备管理早退；改错故障 设置页出现无关步骤。
// INV-03 进度页自带标题，不重复渲染步骤条：守住位置 同一早退；改错故障 标题与步骤条信息重复。
// INV-04 已完成的步骤显示勾选而不是序号：守住位置 索引与当前索引比较；改错故障 已完成步骤仍显示数字。
// INV-05 当前步骤用无障碍属性标记：守住位置 当前步骤属性；改错故障 读屏无法得知当前进度。
// INV-06 步骤标签全部来自国际化文案键：守住位置 文案数组；改错故障 出现硬编码英文。
// INV-07 预览占位按连接类型区分：守住位置 占位三元分支；改错故障 所有类型共用同一占位。
// INV-08 预览值存在时使用真实值：守住位置 空值合并；改错故障 有值仍显示占位。
// INV-09 预览文本允许任意位置换行：守住位置 换行类名；改错故障 长地址撑破对话框。
// INV-10 预览颜色按是否有值区分：守住位置 类名条件；改错故障 真实值与占位难以分辨。
// INV-11 设备管理入口不显示类型标签：守住位置 类型标签开关；改错故障 设置页重复类型信息。
// INV-12 服务端类型不显示类型标签：守住位置 类型判断；改错故障 服务端连接出现多余标签。
// INV-13 最小化与关闭按钮仅在回调存在时渲染：守住位置 条件渲染；改错故障 出现无效按钮。
// INV-14 图标按钮必须带读屏文本：守住位置 视觉隐藏文案；改错故障 读屏用户无法识别操作。
// INV-15 头部标题允许隐藏但保留无障碍语义：守住位置 隐藏方式；改错故障 视觉隐藏同时移除标题。
// INV-16 有预览时标题与预览纵向紧凑排列：守住位置 间距类名条件；改错故障 头部高度随内容跳变。
// INV-17 设备管理布局与向导布局分开返回：守住位置 末尾分支；改错故障 设置页多出步骤条容器。
// INV-18 组件只读入参，不持有向导状态：守住位置 模块边界；改错故障 步骤切换与外部状态不同步。
//
// 模块职责：渲染远程连接向导的步骤条、标题区、类型标签与窗口控制按钮。
// 状态所有权：当前步骤与预览内容全部来自入参，本文件不持有向导状态。
// 阅读顺序：先看步骤条映射，再读预览占位与标题区，最后看两种布局的返回分支。
import { CheckIcon, MinusIcon, XIcon } from "lucide-react";
import type { RemoteTarget } from "@zcode/shared";
import { TID_REMOTE_NEW_CONNECTION_PREVIEW } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RemoteConnectionKindTag } from "@/remote-connection/RemoteConnectionTags.js";

export type RemoteWizardStep = "device" | "settings" | "connecting" | "directory";

/** 表单屏头部的实时预览：target 为空时显示该类型的占位。 */
export interface RemoteSettingsPreview {
  kind: RemoteTarget["kind"];
  target: string | null;
}

/**
 * 表单是选择屏的子视图，不把尚未选择设备的首屏画成已完成。
 * 设置入口（设备管理）不显示步骤条：只有表单与进度两屏，进度页自带标题（RDUX-27）。
 */
// RemoteConnectionWizardSidebar 在 deviceManagement 为真时整段 return null：设备管理入口没有「选择/连接/目录」三屏，
// 显示步骤条会把设置页画成向导；currentIndex 用 directory→2、connecting→1、其余→0 的固定映射，顺序不可改，
// 否则「表单」与「设备」会落到同一步；index < currentIndex 的步骤渲染 CheckIcon，index === currentIndex 才置 aria-current="step" 并加粗。
export function RemoteConnectionWizardSidebar({
  currentStep,
  deviceManagement,
}: {
  currentStep: RemoteWizardStep;
  deviceManagement?: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (deviceManagement) return null;
  const currentIndex = currentStep === "directory" ? 2 : currentStep === "connecting" ? 1 : 0;
  return (
    <nav aria-label={intl.formatMessage({ id: "remote.wizard" })}>
      <ol className="flex items-center gap-2 text-ui-sm">
        {["remote.selection.step", "remote.selection.connect", "remote.step.directory"].map(
          (id, index) => (
            <li
              key={id}
              aria-current={index === currentIndex ? "step" : undefined}
              className={cn(
                "flex min-w-0 items-center gap-2",
                index === currentIndex
                  ? "font-medium text-foreground"
                  : "text-remote-foreground-muted",
              )}
            >
              {index > 0 ? <span className="h-px w-5 bg-border" /> : null}
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-md border text-ui-xs",
                  index === currentIndex && "border-primary bg-primary text-primary-foreground",
                )}
              >
                {index < currentIndex ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              <span>{intl.formatMessage({ id })}</span>
            </li>
          ),
        )}
      </ol>
    </nav>
  );
}

// SettingsPreviewText 的占位按 preview.kind 分派：ssh 固定 "user@host:22"，docker→docker.selectContainer，
// wsl→wsl.defaultDistro，其余（server）→server.urlPlaceholder；显示值用 preview.target ?? placeholder，
// 只有 target 为空才回落占位；break-all 允许地址任意位置换行，target 存在时用 text-remote-foreground-muted 区分真实值。
function SettingsPreviewText({ preview }: { preview: RemoteSettingsPreview }) {
  const { intl } = useZCodeIntl();
  const placeholder =
    preview.kind === "ssh"
      ? "user@host:22"
      : intl.formatMessage({
          id:
            preview.kind === "docker"
              ? "docker.selectContainer"
              : preview.kind === "wsl"
                ? "wsl.defaultDistro"
                : "server.urlPlaceholder",
        });
  return (
    <DialogDescription
      data-testid={TID_REMOTE_NEW_CONNECTION_PREVIEW}
      className={cn(
        "break-all font-mono text-ui-sm",
        preview.target ? "text-remote-foreground-muted" : "text-foreground-subtlest",
      )}
    >
      {preview.target ?? placeholder}
    </DialogDescription>
  );
}

// RemoteConnectionWizardHeader 的 controls 只渲染实际传入的 onMinimize/onClose，两个图标按钮都带 sr-only 文本；
// showKindTag = !deviceManagement && settingsPreview != null，服务端类型再由 settingsPreview.kind !== "server" 排除；
// hideHeading 用 sr-only 而不是不渲染，DialogTitle 仍在无障碍树里；settingsPreview 存在时标题与预览用 space-y-1.5 紧凑排列。
export function RemoteConnectionWizardHeader({
  currentStep,
  title,
  description,
  settingsPreview,
  onMinimize,
  onClose,
  hideHeading = false,
  deviceManagement,
}: {
  currentStep: RemoteWizardStep;
  title: string;
  description: string;
  settingsPreview?: RemoteSettingsPreview;
  onMinimize?: () => void;
  onClose?: () => void;
  hideHeading?: boolean;
  deviceManagement?: boolean;
}) {
  const { intl } = useZCodeIntl();
  // controls 先放最小化再放关闭，两个 Button 都是 size="icon-sm" + shrink-0；title 与 sr-only 使用同一文案键
  // （remote.minimize / common.close），读屏与悬浮提示一致；回调缺失时对应按钮整个不渲染，避免出现点了没反应的控件。
  const controls = (
    <div className="flex shrink-0 items-center gap-1">
      {onMinimize ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          title={intl.formatMessage({ id: "remote.minimize" })}
          onClick={onMinimize}
        >
          <MinusIcon className="size-4" />
          <span className="sr-only">{intl.formatMessage({ id: "remote.minimize" })}</span>
        </Button>
      ) : null}
      {onClose ? (
        <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" onClick={onClose}>
          <XIcon className="size-4" />
          <span className="sr-only">{intl.formatMessage({ id: "common.close" })}</span>
        </Button>
      ) : null}
    </div>
  );
  // 设置入口的类型切换已表达类型，只有项目/聊天入口在标题旁显示类型标签。
  const showKindTag = !deviceManagement && settingsPreview != null;
  const heading = (
    <div
      className={cn(
        "min-w-0",
        hideHeading ? "sr-only" : settingsPreview ? "space-y-1.5" : "space-y-2",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <DialogTitle className="text-ui-lg font-medium">{title}</DialogTitle>
        {showKindTag && settingsPreview.kind !== "server" ? (
          <RemoteConnectionKindTag kind={settingsPreview.kind} />
        ) : null}
      </div>
      {settingsPreview ? (
        <SettingsPreviewText preview={settingsPreview} />
      ) : (
        <DialogDescription className="text-pretty text-remote-foreground-muted">
          {description}
        </DialogDescription>
      )}
    </div>
  );

  // 两种布局在末尾收口：deviceManagement 只返回 heading + controls 的横向 flex，不包含 RemoteConnectionWizardSidebar；
  // 向导布局用 space-y-4，第一行是步骤条 + controls，第二行才是 heading；两种分支共用同一个 heading 节点，
  // 因此标题内容不会因布局切换而重建。
  if (deviceManagement) {
    return (
      <div className="flex items-start justify-between gap-4">
        {heading}
        {controls}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <RemoteConnectionWizardSidebar currentStep={currentStep} />
        {controls}
      </div>
      {heading}
    </div>
  );
}
