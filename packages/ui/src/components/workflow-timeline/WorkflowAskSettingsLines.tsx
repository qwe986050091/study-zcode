// INV-01 初始草稿只在挂载时取一次：守住位置 初始状态；改错故障：用效果追踪入参会把用户正在改的值拽回起点。
// INV-02 换请求靠父组件按请求 id 重挂：守住位置 组件边界；改错故障：原地切请求会让上一条草稿泄漏到新请求。
// INV-03 每次改动都经内容回调把当前草稿交出去：守住位置 更新函数；改错故障：只在 Apply 时回报会让父组件拿不到最新值。
// INV-04 模型行的可调性来自入参布尔值：守住位置 可选条件；改错故障：忽略该值会让不可调字段仍提供控件。
// INV-05 宿主没有模型目录时整行不可选：守住位置 可选条件；改错故障：空清单下仍渲染下拉会让用户无从选择。
// INV-06 不可选时不渲染下拉，只给纯文本：守住位置 不可选分支；改错故障：保留禁用控件会让人误以为可以改。
// INV-07 不可选但入参有模型时照实说该模型：守住位置 不可选文案；改错故障：一律说沿用会话模型与将要发生的事相反。
// INV-08 只有入参是会话模型时才说沿用会话模型：守住位置 分支判断；改错故障：把具体模型也说成会话会让用户误判。
// INV-09 脚本点名模型时首句改口为默认运行在：守住位置 引导文案选择；改错故障：仍说替每个子代理说话会与事实不符。
// INV-10 点名的模型名不逐条列出：守住位置 文案内容；改错故障：列出作者选择会泄漏脚本内部绑定。
// INV-11 可选项数组必须记忆化：守住位置 下拉入参；改错故障：内联数组会让 memo 组件每帧重渲染。
// INV-12 值变更回调同样记忆化：守住位置 下拉回调；改错故障：内联函数会让 memo 组件每帧重渲染。
// INV-13 模型不可用只取决于异步读回的清单：守住位置 不可用判断；改错故障：把不可用写死会让清单到达后仍不恢复。
// INV-14 不可用状态经回调回报父组件：守住位置 唯一效果；改错故障：不回报会让父组件在不可用时仍允许通过。
// INV-15 改动后才显示重置尾巴：守住位置 尾巴渲染条件；改错故障：未改动也显示会让界面一直提示可回退。
// INV-16 重置把草稿恢复为初始值：守住位置 尾巴回调；改错故障：恢复成当前值会让重置按钮无效果。
// INV-17 思考档仅对具体模型且清单提供时渲染：守住位置 档位渲染条件；改错故障：会话模型上显示档位会让用户改一个不生效的值。
// INV-18 草稿变更立即回调，不等 Apply：守住位置 更新函数；改错故障：延迟回报会让父组件的允许条件滞后一次。
//
// 模块职责：渲染确认窗里可调的运行设置两行：子代理模型与并发上限，并把草稿作为内容回报。
// 状态所有权：草稿与初始值都在组件内；模型清单与描述来自共享 hook。
// 阅读顺序：先看外层两行的草稿与回调，再看模型行的可选性与不可用回报，最后看文案与重置尾巴。
// ============================================================
// 确认窗里的两项 run 设置（docs/dynamic-workflow/presentation.md「The confirmation window」）
// ============================================================
// 两句话，句中的值就是控件：「子代理运行在 [模型 ▾] [思考 高 ▾]」「最多 [− 4 +] 个子代理同时运行 · 默认 13」。
// 脚本给某些子代理点名了模型时第一句改口「子代理默认运行在」，那些名字本身不列（作者模型的选择）。
// 没动过的值安静地待在句子里；改过的那一行值加粗，句尾跟一截「· 原为 X ↺」。
//
// 块缺席（旧 agent 不回填 `adjustable_settings`）时画 `WorkflowAskPlainSettings`（WorkflowAskSettingsParts.tsx）：
// 只有调用设了的字段、纯文本、不可调——agent 不会应用的改动，窗里就不提供。
//
// 草稿住在这里，改动经 `onContentChange` 事件式地交给 PermissionDialog（它在 Allow 时把它放进应答的
// `content`）；换请求靠父组件按 requestId 给 key 重挂，不靠 effect 追。唯一的 effect 是「所选模型
// 不可用」：它取决于异步读回的模型清单，不是用户的一次操作，只能在清单到达后回报给父组件。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MODEL_CONFIG_SELECT_BADGE_CLASS_NAME, ModelConfigSelect } from "@/ModelConfigSelect.js";
import {
  workflowScriptNamesModels,
  type WorkflowAdjustableSettings,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  describeWorkflowSubagentModel,
  workflowSubagentModelText,
  workflowSubagentModelTooltip,
} from "./subagent-model-label.js";
import {
  WORKFLOW_ASK_CHIP_CLASS_NAME,
  WORKFLOW_ASK_LINE_CLASS_NAME,
  WORKFLOW_ASK_TAIL_CLASS_NAME,
  WorkflowAskBoundLine,
  WorkflowAskWasTail,
} from "./WorkflowAskSettingsParts.js";
import {
  useWorkflowSettingsModelChoices,
  type WorkflowSettingsModelScope,
} from "./useWorkflowSettingsModelChoices.js";
import {
  initialWorkflowAskSettingsDraft,
  workflowAskSettingsChangedLines,
  workflowAskSettingsContent,
  type WorkflowAskSettingsContent,
} from "./workflowAskSettings.js";
import {
  workflowRunSettingsModelCanonical,
  type WorkflowRunSettingsDraft,
  type WorkflowRunSettingsModel,
} from "./workflowRunSettings.js";

// 草稿与初始值都只在这里持有一份：initial 在挂载时定格（父组件按 requestId 重挂），
// 所以之后入参变化不再重算，也不能改成用 effect 追踪入参——那会把用户正在改的值拽回起点。
// defaultConcurrency 来自可调设置，是草稿与「文案是否为空」比较时的共同基准。
export function WorkflowAskSettings({
  adjustable,
  disabled,
  input,
  onBlockedChange,
  onContentChange,
  scope,
}: {
  adjustable: WorkflowAdjustableSettings;
  disabled: boolean;
  /** 确认窗的工具入参（CLI resolveInput 归一化过的那一份）。 */
  input: unknown;
  onContentChange?: (content: WorkflowAskSettingsContent | undefined) => void;
  /** 所选模型读好清单后仍不可用：Allow 要等用户换一个（与弹层的 Apply 同一条规则）。 */
  onBlockedChange?: (blocked: boolean) => void;
  scope: WorkflowSettingsModelScope;
}) {
  const defaultConcurrency = adjustable.defaultConcurrency;
  // 起点在挂载那一刻定下：父组件按 requestId 重挂，同一个请求的入参不会变。
  const [initial] = useState(() => initialWorkflowAskSettingsDraft(input, defaultConcurrency));
  const [draft, setDraft] = useState<WorkflowRunSettingsDraft>(initial);
  const update = (next: WorkflowRunSettingsDraft) => {
    setDraft(next);
    onContentChange?.(workflowAskSettingsContent(initial, next, defaultConcurrency));
  };
  const changed = workflowAskSettingsChangedLines(initial, draft, defaultConcurrency);

  return (
    <div className="space-y-1" data-testid="workflow-permission-settings">
      <WorkflowAskModelLine
        adjustable={adjustable.subagentModel}
        changed={changed.model}
        disabled={disabled}
        initial={initial.model}
        model={draft.model}
        onChange={(model) => update({ ...draft, model })}
        onReset={() => update({ ...draft, model: initial.model })}
        scope={scope}
        scriptNamesModels={workflowScriptNamesModels(input)}
        {...(onBlockedChange === undefined ? {} : { onBlockedChange })}
      />
      <WorkflowAskBoundLine
        bound={draft.bound}
        changed={changed.bound}
        defaultConcurrency={defaultConcurrency}
        disabled={disabled}
        initial={initial.bound}
        onChange={(bound) => update({ ...draft, bound })}
        onReset={() => update({ ...draft, bound: initial.bound })}
      />
    </div>
  );
}

// 可调且宿主给了模型目录（choices.noCatalog 为假）才出控件；不可用时降级成警告徽标，
// 不隐藏：隐藏会让用户既看不到 blocked 的原因、也没有入口换一个。
function WorkflowAskModelLine({
  adjustable,
  changed,
  disabled,
  initial,
  model,
  onBlockedChange,
  onChange,
  onReset,
  scope,
  scriptNamesModels,
}: {
  adjustable: boolean;
  changed: boolean;
  disabled: boolean;
  initial: WorkflowRunSettingsModel;
  model: WorkflowRunSettingsModel;
  onBlockedChange?: (blocked: boolean) => void;
  onChange: (model: WorkflowRunSettingsModel) => void;
  onReset: () => void;
  scope: WorkflowSettingsModelScope;
  /**
   * 脚本给某些子代理点名了模型（`model_bindings`）：窗不逐名列出——那是作者模型的选择——只把这一句
   * 改口成「子代理默认运行在」，因为它不再替每一个子代理说话。
   */
  scriptNamesModels: boolean;
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const choices = useWorkflowSettingsModelChoices(scope);
  const levelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const [levelOpen, setLevelOpen] = useState(false);
  // ModelConfigSelect 是 memo 组件：内联数组每次渲染都是新引用（reactStableReferences.test.ts）。
  // 依赖只取该项本身，清单更新时自然换引用；这里不做去重，会话模型不在普通分组的候选里。
  // 不可选时仍渲染这一行的容器，保持两行布局稳定。
  const leadingItems = useMemo(() => [choices.sessionModelItem], [choices.sessionModelItem]);
  const selectable = adjustable && !choices.noCatalog;
  const face = choices.describe(model);
  const blocked = selectable && face.unavailable;
  // ModelConfigSelect 是 memo 组件：回调同样不能是内联函数。
  const { pick } = choices;
  // 值变更回调同样要稳定，memo 组件才不会被无谓刷新
  // 新值先经选择器归一到草稿模型形态
  // 依赖里带上当前模型，切换后回调同步更新
  // 选择器本身来自共享 hook，不在此处重建
  // 选择器把下拉值归一为草稿模型，会话选中也走同一条路径
  const handleValueChange = useCallback(
    (value: string) => onChange(pick(value, model)),
    [model, onChange, pick],
  );
  useEffect(() => {
    onBlockedChange?.(blocked);
  }, [blocked, onBlockedChange]);

  // 标签与提示都走 intl 格式化；子代理模型的描述要多一个厂商名来拼品牌前缀。
  const labelOf = (choice: WorkflowRunSettingsModel) => {
    const canonical = workflowRunSettingsModelCanonical(choice);
    if (choice.kind === "session" || canonical === undefined) {
      // 会话模型的名字读不出时，名字本身就是「会话模型」，不再叠一个同词徽标。
      const text =
        scope.sessionModel === undefined
          ? choices.sessionModelName
          : `${choices.sessionModelName} · ${choices.sessionBadge}`;
      return { text, tooltip: undefined };
    }
    const label = describeWorkflowSubagentModel(canonical, {
      formatMessage: format,
      providerName: choices.providerName,
    });
    return {
      text: workflowSubagentModelText(format, label),
      tooltip: workflowSubagentModelTooltip(format, label),
    };
  };

  const lead = format({
    id: scriptNamesModels
      ? "chat.permission.workflow.settings.model.leadDefault"
      : "chat.permission.workflow.settings.model.lead",
  });
  // 选不了模型（宿主没有目录，或本机清单是空的）：句子不再有控件。入参里有模型（沿用来的）就照实说它，
  // 没有才说「沿用会话模型」——不能让窗说一句与将要发生的事相反的话。
  if (!selectable) {
    const current = labelOf(model);
    return (
      <div
        className={WORKFLOW_ASK_LINE_CLASS_NAME}
        data-testid="workflow-permission-settings-model"
      >
        {model.kind === "session" ? (
          <>
            <span>
              {format({
                id: scriptNamesModels
                  ? "chat.permission.workflow.settings.model.noCatalogDefault"
                  : "chat.permission.workflow.settings.model.noCatalog",
              })}
            </span>
            <span className={WORKFLOW_ASK_TAIL_CLASS_NAME}>
              · {format({ id: "chat.permission.workflow.settings.model.noCatalogReason" })}
            </span>
          </>
        ) : (
          <span title={current.tooltip}>
            {lead} {current.text}
          </span>
        )}
      </div>
    );
  }

  const tooltip = labelOf(model).tooltip;
  return (
    <div
      className={WORKFLOW_ASK_LINE_CLASS_NAME}
      data-changed={changed ? "true" : undefined}
      data-testid="workflow-permission-settings-model"
    >
      <span>{lead}</span>
      <ModelConfigSelect
        contentAlign="start"
        contentSide="bottom"
        disabled={disabled || choices.loading}
        focusSelectorOnClose={null}
        indicatorClassName="size-3"
        isItemLocked={MODEL_ITEM_NEVER_LOCKED}
        labelVisibilityClassName="inline-flex min-w-0"
        leadingItems={leadingItems}
        lockReasonMessage=""
        modelGroups={choices.groups}
        normalizedValue={face.value}
        onValueChange={handleValueChange}
        showManageModelsAction={false}
        triggerClassName={WORKFLOW_ASK_CHIP_CLASS_NAME}
        triggerLabel={face.triggerLabel}
        triggerLabelClassName={cn("min-w-0 truncate", changed && "font-medium")}
        triggerTestId="workflow-permission-settings-model-trigger"
        {...(tooltip === undefined ? {} : { tooltipTitle: tooltip })}
        {...(model.kind === "session"
          ? {
              triggerBadge: (
                <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>{choices.sessionBadge}</span>
              ),
            }
          : face.unavailable
            ? {
                triggerBadge: (
                  <span
                    className={cn(MODEL_CONFIG_SELECT_BADGE_CLASS_NAME, "text-warning")}
                    data-testid="workflow-permission-settings-model-unavailable"
                  >
                    {format({ id: "chat.toolCall.workflow.run.settings.model.unavailable" })}
                  </span>
                ),
              }
            : {})}
      />
      {face.thoughtOption === null || model.kind !== "model" ? null : (
        <ThoughtLevelCycleControl
          disabled={disabled}
          intl={intl}
          labelVisibilityClassName="inline-flex"
          onCurrentValueCommit={(level) => {
            if (level !== model.level) onChange({ ...model, level });
          }}
          onOpenChange={setLevelOpen}
          onValueChange={(level) => {
            if (level !== model.level) onChange({ ...model, level });
          }}
          open={disabled ? false : levelOpen}
          option={face.thoughtOption}
          provider={ZCODE_AGENT_PROVIDER}
          restoreFocusSelector={null}
          showInvalidCurrentValue
          triggerClassName={cn(WORKFLOW_ASK_CHIP_CLASS_NAME, changed && "font-medium")}
          triggerRef={levelTriggerRef}
        />
      )}
      {changed ? (
        <WorkflowAskWasTail
          disabled={disabled}
          onReset={onReset}
          testId="workflow-permission-settings-model"
          value={labelOf(initial).text}
        />
      ) : null}
    </div>
  );
}

// 下拉里没有需要锁定的条目，常量函数保证引用稳定
// [边界] 内联匿名函数会让 memo 组件每次收到新引用
// 确认窗的模型不参与锁定：MODEL_ITEM_NEVER_LOCKED 恒返回 false，下拉里所有条目都可选。
const MODEL_ITEM_NEVER_LOCKED = () => false;
