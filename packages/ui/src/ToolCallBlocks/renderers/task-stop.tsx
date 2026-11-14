// INV-01 task_stop 快照优先于原始 raw 字段，守住位置在 display 判定的先后顺序，改错故障是回退读取反过来覆盖 Core 投影的短字段
// INV-02 taskId 取值链为 display、output.task_id、input.task_id 与 shell_id，守住位置在空值合并的左侧优先，改错故障是旧快照的 shell_id 抢占真实任务号
// INV-03 仅当 task_type 等于 local_agent 时丢弃旧 command，守住位置在 isLocalAgentTask 分支，改错故障是把完整 prompt 当命令塞进描述行
// INV-04 taskDetail 与 resultCommand 分流赋值，守住位置在两者独立派生，改错故障是展示值参与标准文案裁剪导致永远失配
// INV-05 标准成功文案裁剪要求 message、taskId、command 三者齐备，守住位置在函数入口守卫，改错故障是把 provider 自定义结果误裁
// INV-06 模板裁剪必须整串全等，守住位置在拼接与严格比较，改错故障是前缀匹配吞掉随附诊断信息
// INV-07 toRecord 显式排除数组与 null，守住位置在首层类型分派，改错故障是数组被当作字段容器输出空详情
// INV-08 字符串入参先按 Hook additional context 标记截断再解析，守住位置在 markerIndex 分支，改错故障是尾部上下文让解析整体失败
// INV-09 解析异常只兜在 try 内并返回 undefined，守住位置在 catch 的静默语义，改错故障是异常顶穿到渲染层中断整块
// INV-10 readStringField 跳过空白候选并取首个命中键，守住位置在 trim 长度判断与键序，改错故障是空白 task_id 覆盖有值来源
// INV-11 readRawRecord 只接受嵌套对象形态，守住位置在逐键试探对象，改错故障是把扁平字段当成嵌套记录
// INV-12 失败、拒绝、停止三态统一顶替结果文案，守住位置在 isUnsuccessful 分支，改错故障是成功文案泄漏进失败提示
// INV-13 状态标签优先级为 failed 高于 denied 高于 stopped，守住位置在嵌套三元顺序，改错故障是停止态掩盖失败态
// INV-14 statusTooltip 与 showFailureStatus 只在 isFailed 开启，守住位置在两个 prop 的取值条件，改错故障是拒绝态被套上失败样式
// INV-15 hasDetails 同时约束折叠开关与内容挂载，守住位置在 canToggle、forceOpen、renderContent 三处同源，改错故障是空详情仍可展开
// INV-16 detailsTruncated 只认严格布尔真值，守住位置在三等号比较，改错故障是字符串真值误报截断提示
// INV-17 kindLabel 在运行中切到 stopping，守住位置在 isRunning 判定，改错故障是运行态残留已完成文案
// INV-18 snapshotRefs 缺省为空数组且补拉回调绑定当前 toolId，守住位置在 ToolSnapshotFieldNotice 的入参，改错故障是引用缺失直接崩溃
//
// 模块职责：把 TaskStop 工具调用渲染成可折叠详情块，收敛任务号、类型、命令或描述与结果文案。
// 状态所有权：本文件不持有状态，展示数据全部由 toolCall 投影与 context 注入，展开态归 ToolLayout。
// 阅读顺序：先看归一化与兜底函数，再看字段派生顺序，最后看布局装配与快照补拉。
import { CircleStopIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

// 图标元素常量化在模块作用域，避免每次渲染重建 React 元素导致标题行无谓重挂载
// text-foreground-subtle 与 size-4 shrink-0 是行内标题图标的统一契约，不要在详情区另建图标
// 该常量不依赖 context 与 intl，放在组件外才能与 memo 后的 primaryText 共存而不串味
// 同文件其余渲染分支只消费该常量，禁止在 JSX 内重复书写 CircleStopIcon 的属性组合
const TASK_STOP_TOOL_ICON = <CircleStopIcon className="size-4 shrink-0 text-foreground-subtle" />;

const HOOK_ADDITIONAL_CONTEXT_MARKER = "\n\n[Hook additional context]";

// toRecord 是全文件唯一的入参归一化入口，display 缺失时 input 与 output 都靠它从原始快照还原
// 对象分支先行返回，字符串分支才走解析，顺序颠倒会让已解析对象被二次序列化
// 数组与 null 显式排除，因为 raw 快照可能塞入数组包裹的 tool_result 片段
// 空字符串与纯空白提前返回，避免解析异常制造噪声失败路径
// 返回值语义是 undefined 表示不可用而非空对象，下游一律用可选链判断，不要改成空对象
function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const markerIndex = value.indexOf(HOOK_ADDITIONAL_CONTEXT_MARKER);
  const serialized = markerIndex >= 0 ? value.slice(0, markerIndex) : value;
  try {
    const parsed: unknown = JSON.parse(serialized);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// 键序即优先级，task_id 必须先于 shell_id，否则旧快照会用 shell 标识覆盖真实任务号
// 候选值必须通过 trim 后非空校验，空白串等同于缺失，不能作为兜底
// 返回首个命中值而非拼接，保证详情展示与结果文案裁剪引用同一份数据
// value 为 undefined 时整段跳过，因此调用方无需先判空
function readStringField(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

// 仅在 toolCall 的 input 与 output 缺失时作为二级兜底，正常情况下 Core 投影已覆盖
// 逐键试探嵌套对象，命中第一个可用记录即返回，键序需与快照序列化顺序保持一致
// 要求值是对象形态，字符串值仍会走解析分支，扁平字段不会被误认成记录
// 全部键失败返回 undefined，与归一化函数的空语义一致，禁止返回空对象让下游误判存在详情
function readRawRecord(raw: unknown, keys: readonly string[]) {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = toRecord(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

// 只对旧 snapshot 中重复 command 与 prompt 的标准文案做收敛，不改变 provider 返回的自定义结果
// 三个入参任一缺失即原样返回，因为无法确认文案是否由标准模板生成
// 模板必须与拼接结果全等才裁剪，前缀或包含匹配会把附带诊断信息的消息截断
// command 允许为空串，因此判空用严格 undefined 比较，否则空命令走不到裁剪分支
function compactLegacyTaskStopResult(
  message: string | undefined,
  taskId: string | undefined,
  command: string | undefined,
): string | undefined {
  if (!message || !taskId || command === undefined) {
    return message;
  }

  // 旧 snapshot 只保存了会重复 command/prompt 的标准成功文案。
  // 仅做完整模板匹配，避免裁剪 provider 返回的自定义结果。
  const standardMessage = `Successfully stopped task: ${taskId} (${command})`;
  return message === standardMessage ? `Successfully stopped task: ${taskId}` : message;
}

// 详情行统一走 dt 与 dd 结构，label 与 value 都必填，条目出现与否由调用方条件渲染控制
// mono 只在命令、任务类型等机器可读字段开启，描述类文本保持正文行高
// whitespace-pre-wrap 与 break-words 同时保留，长 prompt 换行但不撑破面板宽度
// 此组件不持有状态，展开收起由外层 ToolLayout 决定，因此不得在内部加折叠逻辑
function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-ui-base font-medium text-foreground-subtle">{label}</dt>
      <dd
        className={
          mono
            ? "whitespace-pre-wrap break-words font-mono text-ui-base text-foreground"
            : "whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}

// 组件是纯投影层，所有字段来源在顶部一次性派生，JSX 内不再做二次解析
// display 优先于原始字段，kind 不是 task_stop 时整块降级到 input 与 output 兜底
// taskStopDisplay 的 truncated 参与 hasDetails，决定空壳详情区是否可展开
// 派生结果全部作为 memo 与 callback 依赖，新增字段必须同步补依赖避免陈旧渲染
export function TaskStopToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const taskStopDisplay = display?.kind === "task_stop" ? display : undefined;
  const input = toRecord(toolCall.input) ?? readRawRecord(toolCall.raw, ["rawInput", "input"]);
  const output = toRecord(toolCall.output) ?? readRawRecord(toolCall.raw, ["rawOutput", "output"]);
  const taskId =
    taskStopDisplay?.taskId ??
    readStringField(output, ["task_id"]) ??
    readStringField(input, ["task_id", "shell_id"]);
  const taskType = taskStopDisplay?.taskType ?? readStringField(output, ["task_type"]);
  const displayCommand = taskStopDisplay?.command;
  const legacyCommand = readStringField(output, ["command"]);
  const isLocalAgentTask = taskType === "local_agent";
  // 旧 local_agent 快照的 command 可能是完整 prompt，只有 Core 投影的 display 才能作为短 description 展示。
  // local_agent 的 command 可能是完整 prompt，旧快照不可信，只信 Core 投影的 displayCommand
  // taskDetail 与 resultCommand 分流：前者用于展示，后者仅服务标准文案裁剪，不可互换
  // 非 local_agent 才回退 legacyCommand，保证命令类任务的命令不丢
  // description 与 command 的 label 由 isLocalAgentTask 决定，必须与取值来源保持一致
  const taskDetail = isLocalAgentTask ? displayCommand : (displayCommand ?? legacyCommand);
  const resultCommand = displayCommand ?? legacyCommand;
  const outputMessage = taskStopDisplay?.message ?? readStringField(output, ["message"]);
  const detailsTruncated = taskStopDisplay?.truncated === true;
  const isDenied = toolCall.status === "denied";
  const isStopped = toolCall.status === "stopped";
  const isFailed = toolCall.status === "failed";
  const isUnsuccessful = isFailed || isDenied || isStopped;
  const resultMessage = isUnsuccessful
    ? (context.errorText ?? outputMessage)
    : compactLegacyTaskStopResult(outputMessage, taskId, resultCommand);
  const hasDetails = Boolean(taskType || taskDetail || resultMessage || detailsTruncated);
  const kindLabelId = context.isRunning
    ? "chat.toolCall.taskStop.stopping"
    : "chat.toolCall.kind.taskStop";
  const statusLabelId = isFailed
    ? "chat.toolCall.status.failed"
    : isDenied
      ? "chat.toolCall.status.denied"
      : isStopped
        ? "chat.toolCall.status.stopped"
        : undefined;
  const primaryText = useMemo(
    () => (
      <code className="min-w-0 truncate font-mono">{taskId ?? toolCall.title ?? "TaskStop"}</code>
    ),
    [taskId, toolCall.title],
  );
  const renderContent = useCallback(
    () => (
      <div className="rounded-lg border border-border bg-panel px-4 py-3">
        <dl className="space-y-3">
          {taskType ? (
            <DetailField
              label={intl.formatMessage({ id: "chat.toolCall.taskStop.taskType" })}
              value={taskType}
              mono
            />
          ) : null}
          {taskDetail ? (
            <DetailField
              label={intl.formatMessage({
                id: isLocalAgentTask
                  ? "chat.toolCall.taskStop.description"
                  : "chat.toolCall.taskStop.command",
              })}
              value={taskDetail}
              mono={!isLocalAgentTask}
            />
          ) : null}
          {resultMessage ? (
            <DetailField
              label={intl.formatMessage({ id: "chat.toolCall.taskStop.result" })}
              value={resultMessage}
            />
          ) : null}
        </dl>
        {detailsTruncated ? (
          <p className="mt-3 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.taskStop.truncated" })}
          </p>
        ) : null}
      </div>
    ),
    [detailsTruncated, intl, isLocalAgentTask, resultMessage, taskDetail, taskType],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={TASK_STOP_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={statusLabelId ? intl.formatMessage({ id: statusLabelId }) : undefined}
        showStatusLabel={statusLabelId != null}
        statusTooltip={isFailed ? resultMessage : undefined}
        showFailureStatus={isFailed}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasDetails ? renderContent : undefined}
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
