// INV-01 守住位置：展示只从 context.toolCallNode 派生；改错故障：组件内另取数据会与运行时事实分叉。
// INV-02 守住位置：SKILL_TOOL_ICON 为模块级常量；改错故障：移进组件会让每次渲染重建元素并破坏浅比较。
// INV-03 守住位置：isPlainRecord 排除 null 与数组；改错故障：放宽判定后数组被当对象读取，字段永远取不到。
// INV-04 守住位置：readFirstStringField 跳过非字符串与空白串；改错故障：直接取值会把占位空串渲染进界面。
// INV-05 守住位置：readFirstStringField 命中即早返回；改错故障：继续遍历会让后面的空值覆盖首个有效值。
// INV-06 守住位置：getSkillName 只认 skill 与 name 两键；改错故障：扩键会把命令参数误当成技能名展示。
// INV-07 守住位置：getSkillName 仅在 input 为普通对象时读取；改错故障：字符串 input 按对象索引会静默丢名。
// INV-08 守住位置：getSkillArgs 对字符串 input 先 trim；改错故障：空白串透传会渲染出一条空的参数行。
// INV-09 守住位置：getSkillArgs 的键序 args 优先；改错故障：调整顺序会改变同义字段的展示优先级。
// INV-10 守住位置：extractSkillText 对 null 与 undefined 直接返回 null；改错故障：过度兜底会掩盖真实空输出。
// INV-11 守住位置：extractSkillText 递归数组并按行拼接；改错故障：改成逗号拼接会破坏多段输出的换行语义。
// INV-12 守住位置：extractSkillText 的 content 分支兼容嵌套项；改错故障：去掉嵌套兜底会漏掉带包装的条目。
// INV-13 守住位置：detailText 在 failed 时优先 context.errorText；改错故障：顺序反转会让失败原因被旧输出覆盖。
// INV-14 守住位置：rawOutputText 仅在 toolCall.raw 为对象时读取；改错故障：直接索引 raw 会在非对象上抛错。
// INV-15 守住位置：primaryText 的 memo 依赖含三个文案来源；改错故障：漏依赖后切换语言会保留旧标题。
// INV-16 守住位置：renderContent 的依赖覆盖运行态与全部文案；改错故障：漏 context.isRunning 会让空输出分支不刷新。
// INV-17 守住位置：无输出提示仅在非运行态出现；改错故障：运行中也提示无输出会把进行中误报成失败。
// INV-18 守住位置：statusTooltip 与 showFailureStatus 同源于 failed 判定；改错故障：分叉会出现有提示却不标失败。
//
// 模块职责：把 toolCall 的输入与输出归一成技能名、参数与详情文本，再交给 ToolLayout 渲染。
// 状态所有权：本组件无本地状态，全部展示值由 props 与 memo 派生，不持有运行中事实。
// 阅读顺序：INV 速查 → 字段读取助手 → 名称与参数提取 → 输出归一 → 组件主体与 JSX 装配。
import { WandSparkles } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

// 图标元素提到模块级只创建一次，避免每次渲染产生新节点
// 若移入组件体内，每帧都会得到新的 React 元素，下游浅比较失效
// 尺寸与颜色沿用 DESIGN 的 size-4 与 foreground-subtle 语义
const SKILL_TOOL_ICON = <WandSparkles className="size-4 shrink-0 text-foreground-subtle" />;

// 只接受非 null 的普通对象，数组与 null 一律判否
// 调用方据此决定是否继续按键读取，放宽判定会让数组走进对象分支
// 作为类型守卫，返回真之后调用方才能安全索引任意键
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 按调用方给定的键序逐个取字符串，首个非空 trim 结果即返回
// 跳过非字符串与纯空白，避免把占位空串当成有效内容
// 键序由调用方决定，读取助手本身不假设哪个字段更可信
function readFirstStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

// 技能名只来自 input 的 skill 与 name 两键，其余键不参与
// input 不是普通对象时返回 undefined，由展示层回退到 title
// 把 args 混进候选会把命令行参数误显示成技能名
function getSkillName(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | undefined {
  if (isPlainRecord(toolCall.input)) {
    const directSkill = readFirstStringField(toolCall.input, ["skill", "name"]);
    if (directSkill) {
      return directSkill;
    }
  }

  return undefined;
}

// 字符串 input 先 trim，空白串视为无参数而非空参数
// 对象 input 按 args、arg、path、prompt、input 的次序取首个非空串
// 这个键序就是展示优先级，改动会改变用户实际看到的参数
function getSkillArgs(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | undefined {
  if (typeof toolCall.input === "string") {
    const trimmed = toolCall.input.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (isPlainRecord(toolCall.input)) {
    return readFirstStringField(toolCall.input, ["args", "arg", "path", "prompt", "input"]);
  }

  return undefined;
}

// 输出归一负责把字符串、数组与嵌套对象压成一段纯文本
// 数组按换行拼接，保留多段输出的原始行结构
// 对象先试直接文本键，再回落到 content 数组的递归提取
function extractSkillText(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => extractSkillText(item))
      .filter((item): item is string => item != null)
      .join("\n");
    return text.length > 0 ? text : null;
  }

  if (!isPlainRecord(value)) {
    return null;
  }

  const directText = readFirstStringField(value, [
    "output",
    "text",
    "content",
    "message",
    "rawOutput",
    "result",
  ]);
  if (directText) {
    return directText;
  }

  if (Array.isArray(value.content)) {
    const contentText = value.content
      .map((item) => {
        if (!isPlainRecord(item)) {
          return extractSkillText(item);
        }

        return extractSkillText(item.content ?? item);
      })
      .filter((item): item is string => item != null)
      .join("\n");
    return contentText.length > 0 ? contentText : null;
  }

  return null;
}

// 组件只接收渲染上下文，所有事实来自 toolCallNode 的 toolCall
// 标签文案统一走 intl，保证中英文切换时不留硬编码
// 本层不发起请求也不写 store，是纯投影，可安全重复渲染
export function SkillToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const skillName = getSkillName(toolCall);
  const skillArgs = getSkillArgs(toolCall);
  const outputText = extractSkillText(toolCall.output);
  const rawOutputText = isPlainRecord(toolCall.raw)
    ? extractSkillText(toolCall.raw.rawOutput)
    : null;
  // 失败态优先级为 errorText、输出文本、raw 输出文本
  // 成功态只看输出文本，不掺错误占位，避免误导读者
  // 三者皆空时留 undefined，交由下游决定是否展示无输出
  const detailText =
    toolCall.status === "failed"
      ? (context.errorText ?? outputText ?? rawOutputText ?? undefined)
      : (outputText ?? rawOutputText ?? undefined);
  const skillFallbackLabel = intl.formatMessage({ id: "chat.toolCall.skill.label" });
  const skillUnknownLabel = intl.formatMessage({ id: "chat.toolCall.skill.unknown" });
  const skillArgsLabel = intl.formatMessage({ id: "chat.toolCall.skill.args" });
  const skillNoOutputLabel = intl.formatMessage({ id: "chat.toolCall.skill.noOutput" });
  // 主文本优先技能名，其次 title，最后回退到通用标签
  // 依赖数组显式列出全部外部值，保证语言切换后重新生成
  // 折叠态只显示这段文本，truncate 用于防止超长名撑破布局
  const primaryText = useMemo(
    () => (
      <span className="truncate font-mono text-foreground-subtlest">
        {skillName ?? toolCall.title ?? skillFallbackLabel}
      </span>
    ),
    [skillFallbackLabel, skillName, toolCall.title],
  );
  const secondaryText = useMemo(
    () => (skillArgs ? <code className="truncate font-mono">{skillArgs}</code> : null),
    [skillArgs],
  );
  // 展开内容在回调内组装，`deps` 变化才重建整棵子树。
  // 参数区仅在 `args` 存在时渲染，缺失时不占位也不留空框。
  // 详情区优先归一 `outputText`，无文本且非运行态才提示无输出。
  const renderContent = useCallback(
    () => (
      <div className="space-y-3 mb-2 rounded-xl border border-border bg-panel px-4 py-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-ui-base text-foreground">
            <span className="text-foreground-subtle">{skillFallbackLabel}</span>
            <code className="rounded-md bg-surface px-2 py-1 font-mono text-ui-base text-foreground">
              {skillName ?? toolCall.title ?? skillUnknownLabel}
            </code>
          </div>
          {skillArgs ? (
            <div className="flex items-start gap-2 font-mono text-ui-base text-foreground">
              <span className="shrink-0 text-foreground-subtle">{skillArgsLabel}</span>
              <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground-subtle">
                {skillArgs}
              </pre>
            </div>
          ) : null}
        </div>

        {detailText ? (
          <div className="space-y-1">
            <pre className="max-h-25 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-base text-foreground-subtle">
              {detailText}
            </pre>
          </div>
        ) : (
          !context.isRunning && (
            <div className="space-y-1">
              <p className="font-mono text-ui-base text-foreground-subtle">{skillNoOutputLabel}</p>
            </div>
          )
        )}
      </div>
    ),
    [
      context.isRunning,
      detailText,
      skillArgs,
      skillArgsLabel,
      skillFallbackLabel,
      skillName,
      skillNoOutputLabel,
      skillUnknownLabel,
      toolCall.title,
    ],
  );

  // 返回 Fragment 包裹布局与快照提示，二者并列且不额外加容器
  // ToolLayout 承接折叠、图标与状态展示，本组件只提供内容
  // 快照提示独立成节点，避免被展开内容的条件分支吞掉
  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SKILL_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        // 展开时隐藏副标题，避免与内容区的参数块重复显示同一信息
        // 该开关属于布局层的展示约定，不改变参数数据本身
        // 去掉后展开态会同时出现参数行与参数块，信息冗余
        hideSecondaryTextWhenOpen
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id: context.isRunning ? "chat.toolCall.skill.running" : "chat.toolCall.kind.skill",
          })
        }
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        secondaryText={secondaryText}
        // 状态标签由外部传入，组件不自行推断运行中或已完成
        // 失败态同时驱动 tooltip 与失败标记，两者必须同源
        // 若分叉会出现有提示却不标失败，用户无法判断最终结果
        statusLabel={context.statusLabel}
        statusTooltip={toolCall.status === "failed" ? detailText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
