// INV-01 两个字段都是受控组件：守住位置 props 形状；改错故障 内部状态与服务端值分叉。
// INV-02 只画不取数：守住位置 入参来源；改错故障 组件自行拉取配置产生第二份状态。
// INV-03 模型清单为空时整格退文案：守住位置 提前返回；改错故障 空菜单被渲染成可点控件。
// INV-04 引导项保持引用稳定：守住位置 useMemo；改错故障 memo 组件每次渲染都重算。
// INV-05 徽标缺席即不画：守住位置 可选分支；改错故障 出现空徽标占位。
// INV-06 思考档支持缺席：守住位置 空值判断；改错故障 没有档位时渲染空控件。
// INV-07 禁用时思考档强制关闭：守住位置 open 计算；改错故障 弹层在禁用态仍然展开。
// INV-08 标签走国际化：守住位置 消息 id；改错故障 文案无法随语言切换。
// INV-09 并发下限为一：守住位置 输入校验；改错故障 出现零或负并发。
// INV-10 并发没有上限：守住位置 递增逻辑；改错故障 默认值被误当成天花板。
// INV-11 默认值提示区分两种：守住位置 三元分支；改错故障 停默认值时提示语义错误。
// INV-12 默认值未知则不提示：守住位置 未定义分支；改错故障 老客户端显示错误提示。
// INV-13 空值用占位符：守住位置 输入框取值；改错故障 显示 null 或 NaN。
// INV-14 解析失败不回写：守住位置 有限数判断；改错故障 非法输入把状态写成 NaN。
// INV-15 递减受下限夹取：守住位置 夹取函数；改错故障 减到一以下。
// INV-16 递增不受上限夹取：守住位置 夹取函数；改错故障 无法调高并发。
// INV-17 测试标识稳定：守住位置 data-testid；改错故障 端到端用例找不到控件。
// INV-18 字段标签统一样式：守住位置 标签组件；改错故障 两格排版不一致。
//
// 模块职责：渲染配置弹层里的子代理模型与最大并发两个受控字段。
// 状态所有权：无自有业务状态；只保留弹层开合等临时交互态。
// 阅读顺序：先看模型字段，再看并发步进器，最后看共享标签组件。
// ============================================================
// 「配置」弹层的两个字段
// ============================================================
// 从 WorkflowRunSettingsPopover.tsx 拆出：那边管表单状态、命令与后果句，这里只画两个受控字段——
// 子代理模型（composer 的模型菜单 + 思考档）与「最大并发数」步进器。props 全是烹熟的值。

import { useMemo, useRef, useState } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { ZCODE_AGENT_PROVIDER, type ZCodeConfigOption } from "@zcode/shared";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { cn } from "@/components/lib/utils.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MODEL_CONFIG_SELECT_BADGE_CLASS_NAME,
  ModelConfigSelect,
  type ModelSelectGroup,
  type ModelSelectGroupItem,
} from "@/ModelConfigSelect.js";
import { clampWorkflowRunSettingsBound } from "./workflowRunSettings.js";

// 本场景没有锁定项，MODEL_ITEM_NEVER_LOCKED 恒返回 false，isItemLocked 因此永不生效。
// 用模块级常量函数而不是内联箭头，ModelConfigSelect 的 memo 比较不会因引用变化失效。
// 锁定判定统一交给 ModelConfigSelect 的 isItemLocked，本组件不重复判断。
// 真要做锁定就在这个常量里改，同时把 lockReasonMessage 接上，否则入口仍是全可选。
// 目前没有额外锁定条件，disabled 只来自上一层的会话状态。
const MODEL_ITEM_NEVER_LOCKED = () => false;

/** 字段标签：12px、次要色，控件上方 4px。 */
// FieldLabel 只承担排版而不接收交互属性，点击与聚焦都落在下方控件上。
// 字号与颜色取自 text-ui-sm 与 text-foreground-subtle 两个设计变量。
// 组件不接收 onClick 一类交互属性，标签本身永远不拦截指针事件。
// 模型字段与并发字段共用 FieldLabel，标签形状只在这里定义一次。
function FieldLabel({ children }: { children: string }) {
  return <div className="text-ui-sm text-foreground-subtle">{children}</div>;
}

/**
 * 子代理模型：composer 的同一份模型菜单，「会话模型」排第一；所选模型有思考档时，触发器旁边是
 * 设置页子代理那一格用的同一个思考档控件。清单为空时整格换成一句话（上限仍可调）。
 */
export function WorkflowRunSettingsModelField({
  badge,
  disabled,
  groups,
  leadingItem,
  noCatalog,
  onLevelChange,
  onValueChange,
  thoughtOption,
  triggerLabel,
  value,
}: {
  /** 触发器里的徽标：「会话模型」或「不可用」；缺席即无。 */
  badge?: { text: string; tone: "subtle" | "warning" };
  disabled: boolean;
  groups: readonly ModelSelectGroup[];
  leadingItem: ModelSelectGroupItem;
  /** 当前 agent 没有可选模型：整格退成一句话。 */
  noCatalog: boolean;
  onLevelChange: (level: string) => void;
  onValueChange: (value: string) => void;
  /** 所选模型的思考档；缺席即不画思考档控件。 */
  thoughtOption: ZCodeConfigOption | null;
  triggerLabel: string;
  value: string;
}) {
  const { intl } = useZCodeIntl();
  const levelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const [levelOpen, setLevelOpen] = useState(false);
  // label 在渲染期用 intl.formatMessage 解析，不提前缓存成模块常量。
  // 语言切换会让 formatMessage 返回新文案，label 随组件重渲染更新。
  // noCatalog 分支复用同一个 label，空清单只换下面那句说明。
  // ModelConfigSelect 只接收格式化后的字符串，不接触 intl 实例。
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.model" });
  // ModelConfigSelect 是 memo 组件：内联数组每次渲染都是新引用，会让它的 memo 形同虚设。
  const leadingItems = useMemo(() => [leadingItem], [leadingItem]);
  if (noCatalog) {
    return (
      <div className="flex flex-col gap-1" data-testid="workflow-run-settings-model">
        <FieldLabel>{label}</FieldLabel>
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.model.noCatalog" })}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="workflow-run-settings-model">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="inline-flex min-w-0 flex-1" data-model-current-value={value}>
          <ModelConfigSelect
            modelGroups={groups}
            normalizedValue={value}
            triggerLabel={triggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={MODEL_ITEM_NEVER_LOCKED}
            onValueChange={onValueChange}
            leadingItems={leadingItems}
            contentSide="bottom"
            contentAlign="start"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName="h-7 w-full min-w-0 justify-between rounded-md border border-input-border bg-input px-2 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
            triggerLabelClassName="inline-flex min-w-0 flex-1 truncate text-left"
            triggerTestId="workflow-run-settings-model-trigger"
            {...(badge === undefined
              ? {}
              : {
                  triggerBadge: (
                    <span
                      className={cn(
                        MODEL_CONFIG_SELECT_BADGE_CLASS_NAME,
                        badge.tone === "warning" && "text-warning",
                      )}
                      data-testid="workflow-run-settings-model-badge"
                    >
                      {badge.text}
                    </span>
                  ),
                })}
            disabled={disabled}
          />
        </span>
        {thoughtOption === null ? null : (
          <ThoughtLevelCycleControl
            intl={intl}
            option={thoughtOption}
            provider={ZCODE_AGENT_PROVIDER}
            onCurrentValueCommit={onLevelChange}
            showInvalidCurrentValue
            disabled={disabled}
            open={disabled ? false : levelOpen}
            onOpenChange={setLevelOpen}
            triggerRef={levelTriggerRef}
            restoreFocusSelector={null}
            labelVisibilityClassName="inline-flex"
            triggerClassName="h-7 shrink-0 rounded-md border border-input-border bg-input px-2 text-foreground hover:border-input-border-hover hover:bg-input"
            onValueChange={onLevelChange}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 「最大并发数」步进器：减、等宽数字、加，从 1 起、**没有上限**——默认并发 D 是起点不是天花板
 * （docs/dynamic-workflow/presentation.md「The settings popover」）。提示写「默认 N」，停在 D 上即
 * 「本 run 没有自己的界」，提示改写成「= 默认」。D 未知（老 CLI）时没有提示，数字照样可以直接敲。
 */
export function WorkflowRunSettingsBoundField({
  bound,
  defaultConcurrency,
  disabled,
  onChange,
}: {
  bound: number | null;
  defaultConcurrency: number | undefined;
  disabled: boolean;
  onChange: (bound: number) => void;
}) {
  const { intl } = useZCodeIntl();
  // hint 随 defaultConcurrency 变化：缺席时不画，等于默认值时换 atDefault 文案。
  // bound === defaultConcurrency 时 hint 用 limit.atDefault，不再重复默认数字。
  // defaultConcurrency 为 undefined 时 hint 也是 undefined，整条提示不渲染。
  // hint 只影响提示文本，InputGroupInput 的取值与夹取都不读它。
  const hint =
    defaultConcurrency === undefined
      ? undefined
      : bound === defaultConcurrency
        ? intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit.atDefault" })
        : intl.formatMessage(
            { id: "chat.toolCall.workflow.run.settings.limit.default" },
            { n: defaultConcurrency },
          );
  return (
    <div className="flex flex-col gap-1" data-testid="workflow-run-settings-bound">
      <FieldLabel>
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit" })}
      </FieldLabel>
      <div className="flex items-center gap-2">
        <InputGroup className="w-auto shrink-0">
          <InputGroupAddon align="inline-start">
            <InputGroupButton
              aria-label={intl.formatMessage({
                id: "chat.toolCall.workflow.run.settings.limit.decrease",
              })}
              data-testid="workflow-run-settings-bound-decrease"
              disabled={disabled || bound === null || bound <= 1}
              onClick={() => bound !== null && onChange(clampWorkflowRunSettingsBound(bound - 1))}
              size="icon-xs"
            >
              <MinusIcon className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
          <InputGroupInput
            aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit" })}
            className="h-7 w-9 px-0 text-center font-mono tabular-nums"
            data-testid="workflow-run-settings-bound-value"
            disabled={disabled}
            inputMode="numeric"
            // 输入框只接受 parseInt 能解析的整数，小数与尾随字符都会被截断。
            // 解析成功后立刻过 clampWorkflowRunSettingsBound，写回前就夹到允许区间。
            // Number.isFinite 为假时不调 onChange，非法输入不写进状态。
            // value 始终来自 bound，输入框只回显受控值而不保留打到一半的非法串。
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(parsed)) onChange(clampWorkflowRunSettingsBound(parsed));
            }}
            placeholder="—"
            value={bound === null ? "" : String(bound)}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label={intl.formatMessage({
                id: "chat.toolCall.workflow.run.settings.limit.increase",
              })}
              data-testid="workflow-run-settings-bound-increase"
              disabled={disabled || bound === null}
              onClick={() => bound !== null && onChange(clampWorkflowRunSettingsBound(bound + 1))}
              size="icon-xs"
            >
              <PlusIcon className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {hint === undefined ? null : (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{hint}</span>
        )}
      </div>
    </div>
  );
}
