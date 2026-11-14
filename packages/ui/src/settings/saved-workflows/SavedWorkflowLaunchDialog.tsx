// INV-01 关窗语义：守住位置 打开状态绑定入口是否为空；改错故障：入口清空后窗口仍停留。
// INV-02 三段布局：守住位置 对话框限高与纵向弹性；改错故障：实参多时按钮被顶出视口。
// INV-03 中段收缩：守住位置 行数判断；改错故障：单实参窗口凭空多出空白。
// INV-04 包含块：守住位置 滚动区的相对定位；改错故障：隐藏原生控件撑出第二条滚动条。
// INV-05 聚焦时机：守住位置 聚焦请求的副作用；改错故障：错误文案未渲染就滚动，定位偏移。
// INV-06 滚动一次：守住位置 每次失败新建请求对象；改错故障：同字段连续失败不再滚动。
// INV-07 焦点不二次滚：守住位置 聚焦时的抑制选项；改错故障：浏览器再次滚动导致抖动。
// INV-08 实参重建：守住位置 入口与预填实参的副作用；改错故障：换入口后残留上一份实参。
// INV-09 目标校正：守住位置 候选变化时的校正；改错故障：选中项失效后提交到不存在的项目。
// INV-10 候选缺失：守住位置 无本地项目判断；改错故障：无项目时仍可提交。
// INV-11 防重复：守住位置 启动中判断；改错故障：连点启动发起多次运行。
// INV-12 校验先于提交：守住位置 提交函数的收集分支；改错故障：非法实参被交给上层。
// INV-13 首个错误：守住位置 按声明顺序查找；改错故障：跳转到随机字段，用户找不到问题。
// INV-14 错误清理：守住位置 字段更新的删除逻辑；改错故障：改好字段后错误提示不消失。
// INV-15 展示名回落：守住位置 句子项目名的取值；改错故障：全局档未选目标时句子缺项目名。
// INV-16 标识来源：守住位置 控件 id 生成函数；改错故障：标签与控件对不上，点击标签无效。
// INV-17 错误文案：守住位置 按原因取消息 id；改错故障：新原因找不到文案而显示原始键名。
// INV-18 文案集中：守住位置 全部 intl 调用；改错故障：硬编码中文绕过本地化。
//
// 模块职责：`SavedWorkflowLaunchDialog` 收集声明实参、校验后把启动请求交给上层。
// 状态所有权：实参、错误、运行目标与聚焦请求归组件；启动中与失败状态由启动器传入。
// 阅读顺序：属性契约 → 组件主体与副作用 → 字段代理 → 事件处理 → 三段式渲染。
import { useEffect, useState } from "react";
import { Info, Workflow } from "lucide-react";
import {
  TID_WORKFLOW_LAUNCH_ARG,
  TID_WORKFLOW_LAUNCH_DIALOG,
  TID_WORKFLOW_LAUNCH_ERROR,
  TID_WORKFLOW_LAUNCH_FIELDS,
  TID_WORKFLOW_LAUNCH_SUBMIT,
  TID_WORKFLOW_LAUNCH_TARGET,
  type ZCodeSavedWorkflowEntry,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AutomationRunNowIcon } from "@/settings/AutomationDesignPrimitives.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import {
  findAutomationWorkspaceOptionByKey,
  reconcileAutomationWorkspaceSelectionKey,
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import {
  buildSavedWorkflowArgFields,
  collectSavedWorkflowArgs,
  type SavedWorkflowArgField,
  type SavedWorkflowArgFieldError,
} from "@/settings/saved-workflows/savedWorkflowArgsForm.js";
import type { SavedWorkflowLaunchError } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

/** 实参控件的 DOM id：label 的 htmlFor 与校验失败后的聚焦都认它。 */
// 控件 id 的唯一来源：标签的指向、测试定位与校验失败后的聚焦都读它。
// 前缀固定，避免与对话框里其它表单控件撞 id。
// 改 `workflowArgInputId` 前缀时要同步检查测试定位与截图基线。
//
function workflowArgInputId(name: string): string {
  return `workflow-arg-${name}`;
}

// 属性契约：入口为 null 表示关窗，非空即打开本次工作流。
// 运行目标只在全局档传入，传空数组表示没有本地项目可运行。
// 预填实参来自再次运行，启动中与失败状态由启动器回填。
//
interface SavedWorkflowLaunchDialogProps {
  entry: ZCodeSavedWorkflowEntry | null;
  /** 作用域徽标与「将立即在 X 的新会话中运行」文案都要它；也决定启动命令的 scope。 */
  scope: "project" | "global";
  /**
   * 「将立即在 {project} 的新会话中运行」里的项目名：项目档 = 所属项目名；全局档 = 未选到
   * 「运行于」时的兜底名（选到后用选中项目 label）。
   */
  projectLabel: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    entry: ZCodeSavedWorkflowEntry,
    args: Record<string, unknown>,
    target?: AutomationWorkspaceOption,
  ) => void;
  /**
   * 「运行于」项目候选（仅全局工作流传入）。传入即渲染选择器；
   * 空数组表示没有本地项目可跑——渲染提示并禁用提交。undefined 时窗口与项目档逐字一致。
   */
  targets?: readonly AutomationWorkspaceOption[];
  /** 默认选中的项目 key（活动项目）；不在候选里时回落到首个候选。 */
  defaultTargetKey?: string | null;
  /**
   * 预填实参：完成卡的「再次运行」传这次 run 跑过的那一份（journal 给的）。声明里没有的键忽略；
   * 缺席即按声明的默认值铺（中枢自己的「运行」就是这条）。
   */
  initialArgs?: Record<string, unknown>;
  /** 正在启动：主按钮 loading + 禁用，防重复点击（launcher.pending）。 */
  pending?: boolean;
  /** 启动失败：行内错误区展示（title 按 reason + 服务端 message）；成功由组关窗清空。 */
  error?: SavedWorkflowLaunchError | null;
}

/**
 * 实参窗：头部 = Workflow 图标 + 名字（mono）
 * + 作用域徽标 + 说明；「运行于」（全局档）；实参表；一句「将立即在 X 的新会话中运行」；主按钮
 * 「运行」。点「运行」= GUI 直接启动（无模型回合、无确认窗）：loading 期禁用，失败在行内错误区
 * 显示、窗口留着，成功由组关窗并切到新会话。无实参的项目档不弹本窗（组直接启动）。
 *
 * Bugfix（实参很多时窗口溢出视口）：窗口原先不限高，头部、实参、说明、错误区与按钮又全在同一个
 * 不滚动的块里；DialogContent 垂直居中，于是几十个实参把标题/关闭顶出视口上沿、把「取消/运行」
 * 顶出下沿，页面本身不滚，整个窗口没法用。实参个数由声明决定、没有上界，所以修在布局上：窗口
 * 限高（随内容长到视口减边距为止），分成三段，只有中段（「运行于」+ 实参）自己滚，头部和底部
 * （说明、错误区、按钮）钉住。见 docs/dynamic-workflow/launch.md「The launch dialog」。
 */
// 主组件：三段式布局 —— 钉住的头部、可滚的中段、钉住的说明与按钮。
// 中段行数决定是否允许收缩，一两行时保留自然高度，避免多出空白。
// 提交前先在本地收集并校验实参，失败时留在窗内并聚焦首个出错字段。
// 启动成功由上层关窗并切到新会话，本组件不负责导航。
//
export function SavedWorkflowLaunchDialog({
  entry,
  scope,
  projectLabel,
  onOpenChange,
  onSubmit,
  targets,
  defaultTargetKey,
  initialArgs,
  pending = false,
  error = null,
}: SavedWorkflowLaunchDialogProps) {
  const { intl } = useZCodeIntl();
  const [fields, setFields] = useState<SavedWorkflowArgField[]>([]);
  const [errors, setErrors] = useState<Record<string, SavedWorkflowArgFieldError>>({});
  const [targetKey, setTargetKey] = useState<string | null>(null);
  // 校验失败后要带进视野的字段。每次失败都是一个新对象，同一字段连续失败两次也会再滚一次。
  // 聚焦请求：每次失败都换新对象，同一字段连续失败两次也会重新滚动。
  // 真正滚动放到副作用里，等错误文案渲染完成后再整行滚入视野。
  //
  const [revealRequest, setRevealRequest] = useState<{ name: string } | null>(null);

  // Bugfix：实参区自己滚动后，出错字段和它的错误文案可能远在可视区之外，点「运行」后屏幕上什么都
  // 不变，看起来像按钮坏了。放在 effect 里而不是提交回调里：要等错误文案渲染出来，整行（标签 +
  // 控件 + 错误文案）才能一起滚进视野；焦点随后落到控件上，preventScroll 避免浏览器再滚一次。
  useEffect(() => {
    if (!revealRequest) return;
    const control = document.getElementById(workflowArgInputId(revealRequest.name));
    if (!control) return;
    (control.closest("[data-workflow-arg-row]") ?? control).scrollIntoView({ block: "nearest" });
    control.focus({ preventScroll: true });
  }, [revealRequest]);

  useEffect(() => {
    setFields(buildSavedWorkflowArgFields(entry?.args, initialArgs));
    setErrors({});
  }, [entry, initialArgs]);

  // 候选变化时保留仍有效的选择，否则回落到默认项目、首个候选或 null（reconcile 同一套规则）。
  useEffect(() => {
    if (!targets) {
      setTargetKey(null);
      return;
    }
    const defaultOption = defaultTargetKey
      ? findAutomationWorkspaceOptionByKey(targets, defaultTargetKey)
      : undefined;
    setTargetKey((current) =>
      reconcileAutomationWorkspaceSelectionKey(targets, current, defaultOption),
    );
  }, [targets, defaultTargetKey]);

  // 运行目标候选：未定义表示项目档，选择器整体不渲染。
  // 空数组表示全局档但没有本地项目，渲染提示并禁用提交。
  // 选中项缺失时回落到默认项目或首个候选，规则与校正函数保持一致。
  //
  const hasTargets = targets !== undefined;
  const noLocalProject = hasTargets && targets.length === 0;
  const selectedTarget = targets
    ? findAutomationWorkspaceOptionByKey(targets, targetKey)
    : undefined;
  // 「将立即在 {project} 的新会话中运行」：全局档用选中的「运行于」项目名，项目档用所属项目名。
  const noteProject = selectedTarget?.label ?? projectLabel;
  // 中段的行数（「运行于」算一行）。三行起内容必然高过 6rem 的下限，才给下限、才允许收缩；
  // 一两行时直接不收缩——下限若无条件加上，最常见的单实参窗口会凭空多出一截空白。
  const fieldRowCount = fields.length + (hasTargets ? 1 : 0);

  const scopeBadge = intl.formatMessage({
    id:
      scope === "global"
        ? "workflows.hub.launch.scope.global"
        : "workflows.hub.launch.scope.project",
  });

  // 字段更新：只替换目标字段，同时清掉该字段的错误。
  // 没有错误时直接返回原对象，避免制造无意义的快照变化。
  // 字段值统一存字符串，布尔与数字在收集阶段再转换。
  //
  const updateField = (name: string, value: string) => {
    setFields((current) =>
      current.map((field) => (field.name === name ? { ...field, value } : field)),
    );
    setErrors((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  // 提交入口：无入口、无可用项目或正在启动时直接返回，防重复提交。
  // 校验失败写回错误表，并按声明顺序挑第一个出错字段请求滚动。
  // 校验通过后把入口与运行目标交给上层，实参随 `args` 一起带出。
  //
  const handleSubmit = () => {
    if (!entry) return;
    if (noLocalProject || pending) return;
    const collected = collectSavedWorkflowArgs(fields);
    if (!collected.ok) {
      setErrors(collected.errors);
      // 按声明顺序取第一个出错字段。
      const firstInvalid = fields.find((field) => field.name in collected.errors);
      if (firstInvalid) setRevealRequest({ name: firstInvalid.name });
      return;
    }
    onSubmit(entry, collected.args, selectedTarget);
  };

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      {/* 限高 + 三段式：form 的 min-h-0 让中段在 flex 列里可收缩；视口矮到连钉住的两段都放不下时，
          中段停在自己的下限，由窗口自身的 overflow-y-auto 兜底整体滚动，任何一段都还够得着。 */}
      <DialogContent
        className="flex max-h-[min(calc(100dvh-2rem),45rem)] flex-col overflow-y-auto sm:max-w-[480px]"
        data-testid={TID_WORKFLOW_LAUNCH_DIALOG}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Workflow className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
            <span className="min-w-0 truncate font-mono">{entry?.name}</span>
            <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-ui-xs font-normal leading-none text-foreground-subtlest">
              {scopeBadge}
            </span>
          </DialogTitle>
          {entry?.description ? (
            <p className="text-ui-sm text-foreground-subtle">{entry.description}</p>
          ) : null}
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          {fieldRowCount > 0 ? (
            // 负外边距 + 等量内边距：滚动条贴窗口边缘，控件的焦点/错误描边不被 overflow 裁掉；
            // 纵向留 2 个单位，正好盖住 Switch 伸出自身 8px 的点击热区，否则只有开关的短表单
            // 会多出几像素可滚。
            // Bugfix（内外两条滚动条）：Radix 的 Switch / Select 在 form 里会各带一个绝对定位的隐藏
            // 原生控件。滚动区不是定位祖先时，它们的包含块落到 DialogContent 上，静态位置却仍在
            // 几千像素深的列表里——不被滚动区裁剪，反而把窗口自身撑出可滚范围，于是窗口外层又多出
            // 一条滚动条。relative 让滚动区成为包含块，这些控件随列表一起滚。
            <div
              data-testid={TID_WORKFLOW_LAUNCH_FIELDS}
              className={cn(
                "relative -mx-4 -my-2 flex flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-2",
                fieldRowCount >= 3 ? "min-h-24 flex-1" : "shrink-0",
              )}
            >
              {hasTargets ? (
                <div className="flex shrink-0 flex-col gap-1.5">
                  <span className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({ id: "workflows.hub.launch.target" })}
                  </span>
                  {noLocalProject ? (
                    <p className="text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({ id: "workflows.hub.launch.noLocalProject" })}
                    </p>
                  ) : (
                    <Select value={targetKey ?? undefined} onValueChange={setTargetKey}>
                      <SelectTrigger data-testid={TID_WORKFLOW_LAUNCH_TARGET}>
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
              ) : null}
              {fields.map((field) => {
                const fieldError = errors[field.name];
                const inputId = workflowArgInputId(field.name);
                const errorText = fieldError
                  ? intl.formatMessage({ id: `workflows.hub.launch.error.${fieldError}` })
                  : null;
                return (
                  <div
                    key={field.name}
                    data-workflow-arg-row={field.name}
                    className="flex shrink-0 flex-col gap-1.5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <label
                            htmlFor={inputId}
                            className="font-mono text-ui-base font-medium text-foreground"
                          >
                            {field.name}
                          </label>
                          {field.required ? (
                            <span className="rounded-sm border border-border px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest">
                              {intl.formatMessage({ id: "workflows.hub.launch.required" })}
                            </span>
                          ) : null}
                        </div>
                        {field.description ? (
                          <p className="text-ui-sm text-foreground-subtle">{field.description}</p>
                        ) : null}
                      </div>
                      {field.type === "boolean" ? (
                        <Switch
                          id={inputId}
                          data-testid={testId(TID_WORKFLOW_LAUNCH_ARG, field.name)}
                          checked={field.value === "true"}
                          onCheckedChange={(checked) =>
                            updateField(field.name, checked ? "true" : "false")
                          }
                        />
                      ) : null}
                    </div>
                    {field.type === "json" ? (
                      <SettingsFormTextarea
                        id={inputId}
                        data-testid={testId(TID_WORKFLOW_LAUNCH_ARG, field.name)}
                        className={cn("min-h-20 font-mono", fieldError && "border-destructive")}
                        value={field.value}
                        aria-invalid={Boolean(fieldError)}
                        onChange={(event) => updateField(field.name, event.target.value)}
                      />
                    ) : field.type === "boolean" ? null : (
                      <Input
                        id={inputId}
                        data-testid={testId(TID_WORKFLOW_LAUNCH_ARG, field.name)}
                        type={field.type === "number" ? "number" : "text"}
                        inputMode={field.type === "number" ? "decimal" : undefined}
                        className={cn("font-mono", fieldError && "border-destructive")}
                        value={field.value}
                        aria-invalid={Boolean(fieldError)}
                        onChange={(event) => updateField(field.name, event.target.value)}
                      />
                    )}
                    {errorText ? <p className="text-ui-sm text-destructive">{errorText}</p> : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="flex shrink-0 flex-col gap-4">
            <div className="flex items-start gap-2 rounded-lg bg-surface px-3 py-2.5 text-ui-base text-foreground-subtle">
              <span className="flex size-5 shrink-0 items-center justify-center">
                <Info className="size-4" aria-hidden="true" />
              </span>
              <p className="min-w-0 leading-5">
                {intl.formatMessage({ id: "workflows.hub.launch.note" }, { project: noteProject })}
              </p>
            </div>
            {error ? (
              <div
                data-testid={TID_WORKFLOW_LAUNCH_ERROR}
                className="flex flex-col gap-1.5 rounded-lg border border-destructive/40 px-3 py-2.5"
              >
                <p className="text-ui-sm font-medium text-destructive">
                  {intl.formatMessage({ id: `workflows.hub.launch.error.${error.reason}` })}
                </p>
                {error.message ? (
                  <pre className="max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground-subtle">
                    {error.message}
                  </pre>
                ) : null}
              </div>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                {intl.formatMessage({ id: "workflows.hub.launch.cancel" })}
              </Button>
              <Button
                type="submit"
                size="lg"
                data-icon="inline-start"
                data-testid={TID_WORKFLOW_LAUNCH_SUBMIT}
                disabled={noLocalProject || pending}
              >
                {pending ? (
                  <Spinner className="size-4" />
                ) : (
                  <AutomationRunNowIcon className="size-4" aria-hidden="true" />
                )}
                {intl.formatMessage({ id: "workflows.hub.launch.submit" })}
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
