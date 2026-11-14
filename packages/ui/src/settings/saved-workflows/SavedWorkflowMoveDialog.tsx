// INV-01 无候选时禁用提交：守住位置 禁用条件；改错故障 空项目列表仍可点击提交。
// INV-02 无候选时展示提示：守住位置 分支渲染；改错故障 只剩空白选择框。
// INV-03 提交前再次拦截空候选：守住位置 提前返回；改错故障 快捷键绕过禁用。
// INV-04 提交中不重复提交：守住位置 忙碌判断；改错故障 连点触发两次搬运。
// INV-05 选中项必须能在候选中定位：守住位置 查找结果判断；改错故障 提交空目标。
// INV-06 候选变化保留仍有效选择：守住位置 调和函数；改错故障 打开即清空用户选择。
// INV-07 失效选择回落到默认项目：守住位置 默认项查找；改错故障 每次都从首个开始。
// INV-08 再回落到首个候选或空：守住位置 调和返回值；改错故障 选择框显示空白。
// INV-09 默认键缺失视为无默认：守住位置 条件查找；改错故障 空键查出错误项目。
// INV-10 默认项与候选同源：守住位置 查找函数复用；改错故障 两处算法不一致。
// INV-11 状态只保存选择键：守住位置 状态形状；改错故障 候选刷新后持有过期对象。
// INV-12 初始选择为空：守住位置 初始值；改错故障 首次打开预选任意项目。
// INV-13 标题上下文缺失时不渲染描述：守住位置 空值分支；改错故障 描述行留空占位。
// INV-14 表单提交统一走处理器：守住位置 阻止默认；改错故障 回车刷新整个页面。
// INV-15 取消只关闭不提交：守住位置 按钮类型；改错故障 取消触发搬运。
// INV-16 提交按钮随忙碌与空候选禁用：守住位置 双条件；改错故障 请求进行中仍可点。
// INV-17 选择项键由选项派生：守住位置 选择键函数；改错故障 同键冲突导致选中错项。
// INV-18 文案全部走国际化：守住位置 格式化调用；改错故障 界面出现硬编码英文。
//
// 模块职责：「移到项目」对话框的候选选择与提交。
// 状态所有权：选中键由本地状态持有，候选与忙碌由调用方传入。
// 阅读顺序：先看属性契约，再看选择调和副作用，最后看提交与渲染分支。
import { useEffect, useState } from "react";
import {
  TID_WORKFLOW_MOVE_DIALOG,
  TID_WORKFLOW_MOVE_DIALOG_SUBMIT,
  TID_WORKFLOW_MOVE_DIALOG_TARGET,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  findAutomationWorkspaceOptionByKey,
  reconcileAutomationWorkspaceSelectionKey,
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";

// entryName 只用于对话描述，为 null 时不渲染标题上下文。
// targets 声明为 readonly AutomationWorkspaceOption[]，组件不修改候选。
// busy 由调用方控制，默认为 false，只影响提交禁用。
// onSubmit 接收完整 AutomationWorkspaceOption，而非仅 targetKey。
interface SavedWorkflowMoveDialogProps {
  open: boolean;
  /** 被移动的工作流名（用作对话描述）；null 时不渲染标题上下文。 */
  entryName: string | null;
  /** 目标项目候选（「移到项目…」的落点，同「运行于」候选）。 */
  targets: readonly AutomationWorkspaceOption[];
  defaultTargetKey?: string | null;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (target: AutomationWorkspaceOption) => void;
}

/**
 * 「移到项目」窗：全局工作流搬回某个本地项目。
 * 一个项目选择器 + 提交；没有本地项目时禁用提交并提示。结构 / 样式沿用实参窗。
 */
// targetKey 用 useState 独立维护，不从 targets 推导。
// targets 或 defaultTargetKey 变化时，用 reconcileAutomationWorkspaceSelectionKey 调和后写回。
// targetKey 失效时必须按默认项目、首个候选、null 的顺序回落。
// noTargets 为真时禁用提交并转成只读提示。
export function SavedWorkflowMoveDialog({
  open,
  entryName,
  targets,
  defaultTargetKey,
  busy = false,
  onOpenChange,
  onSubmit,
}: SavedWorkflowMoveDialogProps) {
  const { intl } = useZCodeIntl();
  const [targetKey, setTargetKey] = useState<string | null>(null);

  // 候选变化时保留仍有效的选择，否则回落到默认项目、首个候选或 null。
  useEffect(() => {
    const defaultOption = defaultTargetKey
      ? findAutomationWorkspaceOptionByKey(targets, defaultTargetKey)
      : undefined;
    setTargetKey((current) =>
      reconcileAutomationWorkspaceSelectionKey(targets, current, defaultOption),
    );
  }, [targets, defaultTargetKey]);

  const noTargets = targets.length === 0;

  // handleSubmit 先用 noTargets 与 busy 早退。
  // 再用 targetKey 调 findAutomationWorkspaceOptionByKey 定位真实候选。
  // target 未命中时直接 return，不弹错误提示。
  const handleSubmit = () => {
    if (noTargets || busy) return;
    const target = findAutomationWorkspaceOptionByKey(targets, targetKey);
    if (!target) return;
    onSubmit(target);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]" data-testid={TID_WORKFLOW_MOVE_DIALOG}>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "workflows.hub.moveDialog.title" })}</DialogTitle>
          {entryName ? (
            <DialogDescription>
              {intl.formatMessage({ id: "workflows.hub.launch.title" }, { name: entryName })}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "workflows.hub.detail.projectColumn" })}
            </span>
            {noTargets ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "workflows.hub.moveDialog.noLocalProject" })}
              </p>
            ) : (
              <Select value={targetKey ?? undefined} onValueChange={setTargetKey}>
                <SelectTrigger data-testid={TID_WORKFLOW_MOVE_DIALOG_TARGET}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((option) => {
                    const key = resolveAutomationWorkspaceSelectionKey(option);
                    return (
                      <SelectItem key={key} value={key}>
                        {option.label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)}>
              {intl.formatMessage({ id: "workflows.hub.launch.cancel" })}
            </Button>
            <Button
              type="submit"
              size="lg"
              data-testid={TID_WORKFLOW_MOVE_DIALOG_SUBMIT}
              disabled={noTargets || busy}
            >
              {intl.formatMessage({ id: "workflows.hub.moveDialog.submit" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
