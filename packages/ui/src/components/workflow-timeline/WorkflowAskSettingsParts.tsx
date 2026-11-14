// INV-01 类名常量是确认窗两句的唯一视觉来源：守住位置 三个导出常量；改错故障 芯片与条件行样式漂移。
// INV-02 芯片悬停才显示边框与输入底色：守住位置 芯片类名；改错故障 静态行看起来像可编辑输入框。
// INV-03 条件行允许换行且保持最小高度：守住位置 行类名；改错故障 窄容器下文字被裁切。
// INV-04 尾部说明使用最淡前景色：守住位置 尾部常量；改错故障 次要信息抢走主句注意力。
// INV-05 原值尾巴只在字段被改过时渲染：守住位置 父组件条件；改错故障 未修改也显示恢复按钮。
// INV-06 重置按钮只有图标，必须同时提供读屏标签与悬停标题：守住位置 两个属性；改错故障 读屏无法识别操作。
// INV-07 重置按钮的禁用态由外部统一控制：守住位置 disabled 入参；改错故障 清理过程中仍可点击。
// INV-08 上界尾句按默认并发分三种文案：守住位置 tail 三元分支；改错故障 未设默认值时显示错误提示。
// INV-09 等于默认并发时显示「默认」而不是数值：守住位置 相等分支；改错故障 两个不同数值显示同一文案。
// INV-10 原值为空时文案使用「无」而不是空串：守住位置 initialText；改错故障 恢复按钮携带空值。
// INV-11 减少按钮在上界为空或等于 1 时禁用：守住位置 禁用表达式；改错故障 减到 0 或对空值操作。
// INV-12 增加按钮在上界为空时禁用：守住位置 禁用表达式；改错故障 从空值直接跳到 1。
// INV-13 数值输入只接受有限整数并夹到合法范围：守住位置 onChange；改错故障 NaN 或越界值进入设置。
// INV-14 空值输入显示占位符而不是 0：守住位置 value 计算；改错故障 用户误以为已设置并发。
// INV-15 改过的数值使用中等字重：守住位置 条件类名；改错故障 修改态不可辨认。
// INV-16 纯文本条件行只在有字段时渲染：守住位置 早退判断；改错故障 旧 agent 下出现空容器。
// INV-17 脚本点名模型时文案改为「默认」：守住位置 文案键选择；改错故障 逐个子代理的默认被错误承诺。
// INV-18 模型规范串只进悬停标题，不进入正文：守住位置 title 属性；改错故障 气泡被长规范串撑开。
//
// 模块职责：渲染确认窗里可调并发上界、原值恢复与旧 agent 的纯文本条件行。
// 状态所有权：所有值都由 WorkflowAskSettings 持有；本文件只接收已计算好的展示值。
// 阅读顺序：先看三个类名常量，再读原值尾巴与上界行，最后看纯文本条件行。
// ============================================================
// 确认窗两句设置的零件（docs/dynamic-workflow/presentation.md「The confirmation window」）
// ============================================================
// 从 WorkflowAskSettingsLines.tsx 拆出（max-lines 门）：两句共用的类名与「· 原为 X ↺」尾巴、上界那一句、
// 以及块缺席（旧 agent）时的纯文本条件行。状态都在 WorkflowAskSettings 里，这里的组件只收烹熟的值。

import { MinusIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { clampWorkflowRunSettingsBound } from "./workflowRunSettings.js";

/** 句中的值画成一枚芯片：平时是一小块 surface，悬停才出边框与输入底色（composer 模型触发器的语汇）。 */
// WORKFLOW_ASK_CHIP_CLASS_NAME 默认 border-transparent，悬停才换 border-hover 与 input 底色。
// max-w-[260px] 配 min-w-0，长值只压缩自己，不会把整行撑宽。
// [&_svg]:size-3 把内部图标统一成 12px，调用点不必逐个声明图标尺寸。
// 该常量同时被确认窗的其他零件复用，改这里会一并改到那些调用点。
export const WORKFLOW_ASK_CHIP_CLASS_NAME =
  "h-6 min-w-0 max-w-[260px] gap-1 rounded-md border border-transparent bg-surface pl-[7px] pr-1 text-ui-sm text-foreground hover:border-border-hover hover:bg-input focus-visible:border-input-border-focused data-[state=open]:border-border-hover data-[state=open]:bg-input [&_svg]:size-3";
export const WORKFLOW_ASK_LINE_CLASS_NAME =
  "flex min-h-6 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-sm text-foreground-subtle";
export const WORKFLOW_ASK_TAIL_CLASS_NAME = "text-foreground-subtlest";

/** 「· 原为 X ↺」：改过的那一行才有；↺ 把这一行放回起点。 */
// 文案与按钮标签都走国际化。
// 按钮只显示图标，读屏依赖 aria-label。
// 悬停标题与读屏标签使用同一文案。
// disabled 由父组件传入并原样透传给 Button，组件不自行推断这一行能否恢复。
export function WorkflowAskWasTail({
  disabled,
  onReset,
  testId,
  value,
}: {
  disabled: boolean;
  onReset: () => void;
  testId: string;
  value: string;
}) {
  const { intl } = useZCodeIntl();
  const resetLabel = intl.formatMessage({ id: "chat.permission.workflow.settings.reset" });
  // 按钮只有图标：aria-label 给读屏，title 给悬停（spec：「恢复原值」）。
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-0.5", WORKFLOW_ASK_TAIL_CLASS_NAME)}>
      <span className="min-w-0 truncate" data-testid={`${testId}-was`}>
        · {intl.formatMessage({ id: "chat.permission.workflow.settings.was" }, { value })}
      </span>
      <Button
        aria-label={resetLabel}
        className="text-foreground-subtlest hover:text-foreground"
        data-testid={`${testId}-reset`}
        disabled={disabled}
        onClick={onReset}
        size="icon-xs"
        title={resetLabel}
        type="button"
        variant="ghost"
      >
        <Undo2Icon className="size-3" />
      </Button>
    </span>
  );
}

// defaultConcurrency 只参与文案与相等判断，步进上界由 clampWorkflowRunSettingsBound 决定。
// tail 尾句与 initialText 原值文本都走 format，三个按钮标签同样不拼接字符串。
// 减少与增加都先过 clampWorkflowRunSettingsBound 再 onChange，两侧写不出越界值。
// 输入框用 parseInt 后判 Number.isFinite，解析失败就不调 onChange，保持上一次受控值。
// changed 同时驱动输入框的 font-medium 与 WorkflowAskWasTail 的显隐，两个出口同一布尔。
export function WorkflowAskBoundLine({
  bound,
  changed,
  defaultConcurrency,
  disabled,
  initial,
  onChange,
  onReset,
}: {
  bound: number | null;
  changed: boolean;
  /** 默认并发 D：只用来写「· 默认 N」与判「= 默认」，不是步进器的上界。 */
  defaultConcurrency: number | undefined;
  disabled: boolean;
  initial: number | null;
  onChange: (bound: number) => void;
  onReset: () => void;
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  // defaultConcurrency 为 undefined 时只区分 bound 是否为空，无从比较默认值。
  // bound === defaultConcurrency 时用 limit.atDefault 文案，不再重复数字。
  // 其余情况按 limit.default 模板带上 defaultConcurrency，提示当前默认值。
  // 三种分支的文案都取自 intl 消息键，切换语言后 tail 随渲染重算。
  const tail =
    defaultConcurrency === undefined
      ? bound === null
        ? format({ id: "chat.permission.workflow.settings.limit.none" })
        : undefined
      : bound === defaultConcurrency
        ? format({ id: "chat.toolCall.workflow.run.settings.limit.atDefault" })
        : format(
            { id: "chat.toolCall.workflow.run.settings.limit.default" },
            { n: defaultConcurrency },
          );
  const initialText =
    initial === null
      ? format({ id: "chat.permission.workflow.settings.limit.none" })
      : String(initial);
  return (
    <div
      className={WORKFLOW_ASK_LINE_CLASS_NAME}
      data-changed={changed ? "true" : undefined}
      data-testid="workflow-permission-settings-bound"
    >
      <span>{format({ id: "chat.permission.workflow.settings.limit.lead" })}</span>
      <InputGroup className="h-6 w-auto shrink-0">
        <InputGroupAddon align="inline-start">
          <InputGroupButton
            aria-label={format({ id: "chat.toolCall.workflow.run.settings.limit.decrease" })}
            data-testid="workflow-permission-settings-bound-decrease"
            disabled={disabled || bound === null || bound <= 1}
            onClick={() => bound !== null && onChange(clampWorkflowRunSettingsBound(bound - 1))}
            size="icon-xs"
          >
            <MinusIcon className="size-3" />
          </InputGroupButton>
        </InputGroupAddon>
        <InputGroupInput
          aria-label={format({ id: "chat.toolCall.workflow.run.settings.limit" })}
          className={cn(
            "h-6 w-[30px] px-0 text-center font-mono text-ui-sm tabular-nums",
            changed && "font-medium",
          )}
          data-testid="workflow-permission-settings-bound-value"
          disabled={disabled}
          inputMode="numeric"
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(parsed)) onChange(clampWorkflowRunSettingsBound(parsed));
          }}
          placeholder="—"
          value={bound === null ? "" : String(bound)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label={format({ id: "chat.toolCall.workflow.run.settings.limit.increase" })}
            data-testid="workflow-permission-settings-bound-increase"
            disabled={disabled || bound === null}
            onClick={() => bound !== null && onChange(clampWorkflowRunSettingsBound(bound + 1))}
            size="icon-xs"
          >
            <PlusIcon className="size-3" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <span>{format({ id: "chat.permission.workflow.settings.limit.trail" })}</span>
      {tail === undefined ? null : (
        <span
          className={WORKFLOW_ASK_TAIL_CLASS_NAME}
          data-testid="workflow-permission-settings-bound-tail"
        >
          · {tail}
        </span>
      )}
      {changed ? (
        <WorkflowAskWasTail
          disabled={disabled}
          onReset={onReset}
          testId="workflow-permission-settings-bound"
          value={initialText}
        />
      ) : null}
    </div>
  );
}

/**
 * 块缺席时的纯文本条件行（旧 agent）：只有调用设了的字段，模型在上、上界在下，`text-ui-xs` 最淡色。
 * 与可调的两行同一个次序，好让新旧两种窗读起来是同一件事。模型说解析好的名字，规范串只进 tooltip。
 */
// maxConcurrency 与 subagentModel 都缺失时返回 null，旧 agent 不留空容器。
// subagentModel 行在上且 maxConcurrency 行在下，与可调版本的字段顺序保持一致。
// subagentModel.tooltip 只进 title 属性，正文用 text 说解析后的名字。
// scriptNamesModels 为真时改用 subagentModelDefault 文案，不再替每个子代理点名。
export function WorkflowAskPlainSettings({
  maxConcurrency,
  scriptNamesModels = false,
  subagentModel,
}: {
  maxConcurrency: number | undefined;
  /** 脚本给某些子代理点名了模型：模型那一句说「默认」（它不再替每一个子代理说话）。 */
  scriptNamesModels?: boolean;
  subagentModel: { text: string; tooltip: string } | undefined;
}) {
  const { intl } = useZCodeIntl();
  // 旧 agent 可能两个字段都没有。
  // 两个字段都缺席时 return null，避免在外层留下空 div 撑出间距。
  // 任一字段存在就渲染对应行，缺失的那一行用三元短路成 null。
  // 这条联合判断是纯文本条件行唯一的早退点，后面各分支不再重复判空。
  if (maxConcurrency === undefined && subagentModel === undefined) return null;
  return (
    <div className="space-y-1">
      {subagentModel === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-subagent-model"
          title={subagentModel.tooltip}
        >
          {intl.formatMessage(
            {
              id: scriptNamesModels
                ? "chat.permission.workflow.subagentModelDefault"
                : "chat.permission.workflow.subagentModel",
            },
            { model: subagentModel.text },
          )}
        </p>
      )}
      {maxConcurrency === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-max-concurrency"
        >
          {intl.formatMessage(
            { id: "chat.permission.workflow.maxConcurrency" },
            { count: String(maxConcurrency) },
          )}
        </p>
      )}
    </div>
  );
}
