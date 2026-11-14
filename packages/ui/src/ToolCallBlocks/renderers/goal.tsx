// INV-01 图标常量必须留在模块作用域：守住位置是组件外的 GOAL_TOOL_ICON 常量；改错故障是把元素移进组件体后每次渲染产生新引用，卡片头部随之无谓重绘。
// INV-02 嵌套读取前必须先做普通对象判定：守住位置是 isPlainRecord 同时排除 null 与数组；改错故障是数组被当成对象按键取值，读到下标或空值造成字段错位。
// INV-03 路径读取遇到非对象立即短路：守住位置是 readNestedValue 循环内的类型守卫；改错故障是继续向下取值触发异常，整个卡片渲染被中断。
// INV-04 只有字符串才尝试结构解析：守住位置是 normalizeResultValue 开头的类型分支；改错故障是对对象再解析一次，导致结构被重复包装或直接报错。
// INV-05 解析失败必须回退原串：守住位置是 normalizeResultValue 的异常兜底分支；改错故障是直接把失败结果置空，用户看到的文本凭空消失。
// INV-06 主结果探测顺序不可随意调整：守住位置是 readPrimaryResult 的候选顺序；改错故障是优先级变化导致界面展示的字段与工具真实结果不符。
// INV-07 首个非空候选即停止探测：守住位置是 readPrimaryResult 循环内的提前返回；改错故障是继续覆盖，使后出现的低质量副本盖掉真正的输出。
// INV-08 候选必须先归一化再判空：守住位置是 readPrimaryResult 中对每个候选先解析后判空；改错故障是仅含空白的字符串抢位，真实结果被隐藏。
// INV-09 附加内容需与主结果去重：守住位置是 readAdditionalContent 中的相同值比较；改错故障是同一段文本在结果区与附加区重复出现，界面冗余。
// INV-10 思考字段需与主结果和附加内容同时去重：守住位置是 buildGoalResultPayload 里 thought 的三重校验；改错故障是回填式思考把结果重复渲染一遍。
// INV-11 错误键仅在失败时写入：守住位置是 buildGoalResultPayload 里对 errorText 的真值判断；改错故障是成功态也带上空错误键，序列化后出现误导性字段。
// INV-12 空值字段一律不写入载荷：守住位置是 buildGoalResultPayload 中三处非空判断；改错故障是输出大量空值与空串，面板被无意义内容占满。
// INV-13 对象格式化采用两空格缩进：守住位置是 formatResultPayload 的序列化参数；改错故障是缩进不一致或丢失，长文本可读性下降且与其他工具块风格分裂。
// INV-14 序列化异常必须降级为字符串：守住位置是 formatResultPayload 的兜底分支；改错故障是循环引用或特殊数值让异常冒泡，整块渲染直接失败。
// INV-15 标题文案缓存依赖必须完整：守住位置是 primaryText 的 memo 依赖数组；改错故障是依赖缺失导致切换语言或标题变化后仍显示旧文案。
// INV-16 内容闭包依赖必须覆盖所有入参：守住位置是 renderContent 的 useCallback 依赖列表；改错故障是结果文本更新而闭包不复建，展开后仍展示上一次的内容。
// INV-17 失败态的状态信息必须换道传递：守住位置是传给 ToolLayout 的 secondaryText 与 statusLabel 三元分支；改错故障是失败状态占用普通状态位，导致错误样式与提示语同时消失。
// INV-18 快照引用需以空数组兜底：守住位置是 ToolSnapshotFieldNotice 的 refs 取值处；改错故障是空值传入下游迭代时崩溃，或在有引用时漏掉加载入口。
//
// 模块职责：把 goal 工具调用的多来源输出归一化为一份稳定载荷，并以统一布局展示；组件本身无状态，所有内容皆为每次渲染的纯派生。
// 状态所有权：展开折叠、状态标签与失败样式由 ToolLayout 与上层上下文持有；本文件只创建一个模块级图标常量，其余都是局部派生值。
// 阅读顺序：先看类型守卫、路径读取、归一化与主结果探测，再看附加内容去重与载荷装配，最后看组件如何把结果交给 ToolLayout。
import { GoalIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

// 该常量在模块作用域只创建一次，是所有 goal 卡片共享的同一个图标元素。
// [性能] 每次渲染新建图标元素会让布局组件的浅比较失效，进而重绘整个卡片头部。
// 类名固定尺寸与弱化色，保证与其它工具块的视觉基线一致，不随容器宽度变化。
// 若把该元素移入组件体内，就会丧失引用稳定性，这是最容易被误改的一处。
const GOAL_TOOL_ICON = <GoalIcon className="size-4 shrink-0 text-foreground-subtle" />;

// 类型守卫同时排除空值与数组，只有真正的普通对象才允许继续向下取键。
// 嵌套结果里常见数组或标量，若不排除数组，按键访问会命中数字下标并产生意外值。
// [边界] 该判断决定后续取值的失败形态是未定义而不是抛错，调用方因此无需异常处理。
// 放宽成仅判断对象类型会让空值通过，随后取值直接抛异常并炸掉整个卡片渲染。
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 按路径逐层下降，任意一层不是普通对象就立刻返回未定义，绝不抛异常。
// [失败路径] 上游原始结构随工具版本变化，缺字段是常态，必须降级为无值而不是错误。
// 路径元素只做属性读取，不做原型链白名单校验，因此仅可用于内部已知的字段名。
// 返回未定义与字段存在但值为空在语义上等价，下游统一按空值处理即可。
// 改成递归访问器或用异常控制流，会把一次数据缺失放大为整块渲染失败。
function readNestedValue(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isPlainRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

// 只在入参是字符串时才尝试结构解析，其它类型原样返回，避免二次序列化。
// [边界] 工具经常把结构化结果塞进字符串字段，这里负责把字符串套娃还原一层。
// 解析失败说明它只是普通文本，必须回退到原始字符串而不是丢成未定义。
// 解析成功也可能是标量，因此调用方仍需用空值判定过滤，不能假定一定是对象。
// [权衡] 只还原一层、不做递归展开，避免把用户文本里形似结构的内容误当成数据。
function normalizeResultValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function isEmptyResultValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  return false;
}

function stringifyResultValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isSameResultValue(left: unknown, right: unknown): boolean {
  if (isEmptyResultValue(left) || isEmptyResultValue(right)) {
    return false;
  }

  return stringifyResultValue(left) === stringifyResultValue(right);
}

// 按固定优先级探测主结果：先看顶层输出，再依次回退到原始结构内的多个副本字段。
// [边界] 第一个非空候选即胜出，后续字段即便更完整也不会覆盖，保证展示稳定可预期。
// 每个候选都要先归一化再判空，否则仅含空白的字符串会抢先占位并隐藏真实结果。
// 全部候选为空时返回未定义，让上层省略该字段而不是输出空字符串。
// 调整这个探测顺序会直接改变界面上展示的内容，属于需要评审的契约变更。
function readPrimaryResult(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): unknown {
  for (const candidate of [
    toolCall.output,
    readNestedValue(toolCall.raw, ["result", "content"]),
    readNestedValue(toolCall.raw, ["rawOutput"]),
    readNestedValue(toolCall.raw, ["output"]),
  ]) {
    const normalized = normalizeResultValue(candidate);
    if (!isEmptyResultValue(normalized)) {
      return normalized;
    }
  }

  return undefined;
}

function readAdditionalContent(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  primaryResult: unknown,
): unknown {
  for (const candidate of [
    toolCall.content,
    readNestedValue(toolCall.raw, ["content"]),
    readNestedValue(toolCall.raw, ["result", "display"]),
  ]) {
    const normalized = normalizeResultValue(candidate);
    if (!isEmptyResultValue(normalized) && !isSameResultValue(normalized, primaryResult)) {
      return normalized;
    }
  }

  return undefined;
}

// 把状态、结果、附加内容、思考与错误装配成一个只读快照对象，供展示层序列化。
// [不变量] 只有非空且彼此不相同的字段才会写入，避免同一段文本在多个键下重复出现。
// 思考需同时不同于主结果与附加内容，因为部分工具会把结果回填到思考字段里。
// 错误文本仅在失败分支有值，写入错误键让用户能看到失败原因而不是空白面板。
// 该函数保持纯粹：不读写外部状态，因此可以每次渲染调用，无需缓存也不会漂移。
function buildGoalResultPayload(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  errorText: string | undefined,
) {
  const primaryResult = readPrimaryResult(toolCall);
  const content = readAdditionalContent(toolCall, primaryResult);
  const thought = normalizeResultValue(toolCall.thought);
  const payload: Record<string, unknown> = {
    status: toolCall.status,
  };

  if (!isEmptyResultValue(primaryResult)) {
    payload.result = primaryResult;
  }
  if (!isEmptyResultValue(content)) {
    payload.content = content;
  }
  if (
    !isEmptyResultValue(thought) &&
    !isSameResultValue(thought, primaryResult) &&
    !isSameResultValue(thought, content)
  ) {
    payload.thought = thought;
  }
  if (errorText) {
    payload.error = errorText;
  }

  return payload;
}

function formatResultPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// 渲染入口，属性由外层统一提供，本组件不持有可变状态，全部内容都由工具调用数据派生。
// [状态所有权] 展开收起、状态标签与失败提示的所有权在布局组件与调用方，这里只做透传。
// 载荷在每次渲染重新计算，成本是几次对象遍历，远低于为它引入缓存的复杂度与失效风险。
// 传递图标、折叠与强制展开这几个开关时给出布尔默认值，调用方未显式传入也能稳定渲染。
export function GoalToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const resultPayload = buildGoalResultPayload(toolCall, context.errorText);
  const resultText = formatResultPayload(resultPayload);
  const goalLabel = intl.formatMessage({ id: "chat.toolCall.goal.label" });
  const primaryText = useMemo(
    () => <span className="min-w-0 truncate">{toolCall.title ?? goalLabel}</span>,
    [goalLabel, toolCall.title],
  );
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  // 内容渲染函数交给布局组件延迟调用，只有展开时才真正执行，减少折叠态开销。
  // [性能] 依赖里必须包含结果文本、快照引用、工具标识与加载体，任一变化都要重建闭包。
  // 失败提示与加载完整字段的入口都挂在这里，展开后用户才能补齐被裁剪的字段。
  // [边界] 快照引用缺失时传入空数组，避免下游对空值迭代导致运行时崩溃。
  const renderContent = useCallback(
    () => (
      <>
        <div className="space-y-2">
          <h4 className="text-ui-base font-medium uppercase tracking-wide text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.result" })}
          </h4>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface px-3 py-3 font-mono text-ui-base text-foreground">
            {resultText}
          </pre>
        </div>
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
      </>
    ),
    [handleLoadFullToolCallFields, intl, resultText, toolCall.snapshotRefs, toolCall.toolId],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={GOAL_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={goalLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        secondaryText={toolCall.status === "failed" ? undefined : context.statusLabel}
        statusLabel={toolCall.status === "failed" ? context.statusLabel : undefined}
        statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={renderContent}
      />
    </>
  );
}
