// INV-01 读不出结构化结果时必须返回 null 而不是空结果；守住位置：readListSavedWorkflowsResult 的两条返回路径；改错故障：解析失败被画成「这个项目里没有工作流」，用户误以为配置丢失
// INV-02 display 通道必须优先于四个 legacy JSON 候选；守住位置：readListSavedWorkflowsResult 的首个分支；改错故障：v4 wire 的 XML 投影先被 JSON 探针白跑一轮，真数据反被 raw 兜底覆盖
// INV-03 legacy 探测顺序固定为 toolCall.output、raw.rawOutput、raw.output、raw.result；守住位置：候选数组字面量；改错故障：历史宿主读到陈旧 raw 字段，卡片显示上一轮的列表
// INV-04 display 分支必须重建 workflows 与 invalid，不得透传 display 内的数组；守住位置：两处映射构造；改错故障：卡片与上游共享引用，字段增量加载时就地改写已渲染数据
// INV-05 readResultRecord 在 workflows 非数组时返回 null；守住位置：isPlainRecord 与数组判断的联合条件；改错故障：契约缺失退化成空列表，坏响应看起来像正常空结果
// INV-06 名字缺失或纯空白的条目必须跳过，name 是条目唯一必填项；守住位置：readResultRecord 的首个 for 循环；改错故障：无名字条目渲染出空行，列表 key 退化为 undefined
// INV-07 invalid 段整体缺失按空数组处理，条目缺 path 则跳过；守住位置：invalid 的构造分支；改错故障：旧宿主没有该字段时误报坏文件区域
// INV-08 argNames 只取参数对象的键名，不取脚本正文；守住位置：argNames 的赋值处；改错故障：一次列举把二十段脚本灌进聊天区，正是本卡片要避免的最坏情况
// INV-09 空列表文案只在解析成功且 workflows 长度为零时出现；守住位置：renderContent 内的长度判断；改错故障：读取失败也显示「暂无工作流」，与 fallback 语义冲突
// INV-10 坏文件区域用 warning 边框单独成块，不静默跳过；守住位置：invalid 的渲染分支；改错故障：损坏的工作流文件从此不可见，用户无法定位要修的对象
// INV-11 scope 只特判 global 与 project，其余原样输出；守住位置：scope 标签的三元链；改错故障：新增作用域被吞成空白标签，卡片看不出文件归属
// INV-12 列表项 key 固定为 path 优先、name 兜底；守住位置：workflows 映射的 key；改错故障：同名不同目录的工作流互相复用节点，展开状态串位
// INV-13 primaryText 必须 memo 且依赖 countLabel、emptyLabel、workflowCount；守住位置：primaryText 的 useMemo；改错故障：内联 JSX 每次新建引用，ToolLayout 的记忆化整体失效
// INV-14 renderContent 必须 useCallback，依赖含 result 与四个标签；守住位置：renderContent 的依赖数组；改错故障：切换工作流快照后内容区仍渲染旧结果
// INV-15 单复数文案各用独立 message key，不依赖 ICU 复数；守住位置：countLabel 与 invalidLabel；改错故障：单数场景显示成复数文案，或直接回落成 key 原文
// INV-16 isPlainRecord 必须同时排除 null 与数组；守住位置：typeof 判断链；改错故障：null 通过收窄后取键抛异常，整张卡片白屏
// INV-17 parseJsonCandidate 只对左花括号或左方括号开头的字符串尝试解析，异常一律吞成 undefined；守住位置：startsWith 预筛与 try 块；改错故障：XML 投影被反复解析，或在坏数据上抛出未捕获异常
// INV-18 无结构化结果时组件返回 context.fallback 或 null，且该判断位于全部 hooks 之后；守住位置：组件尾部提前返回；改错故障：提前返回打断 hooks 顺序，运行时抛渲染错误
//
// 模块职责：把 list_saved_workflows 的工具结果结构化成工作流清单卡，回答「有哪些、干什么用、在哪个作用域」，并单独暴露无法解析的坏文件
// 状态所有权：本文件不持有状态，输入只有 toolCall 与 render context，读取结果与文案全部由 useMemo 派生，不回写 toolCall
// 阅读顺序：先看 readListSavedWorkflowsResult 的 display 与 legacy 双通道，再看 readResultRecord 的收窄规则，最后看 ListSavedWorkflowsPresentation 的渲染与 fallback 分支
import { Library } from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

// 图标常量在模块作用域只创建一次，避免每次渲染重建 Library 元素的属性对象
// [资源] 恒定的 size-4 与 shrink-0 保证窄侧栏下图标不被压缩变形，标题让位给 truncate
const LIST_SAVED_WORKFLOWS_TOOL_ICON = (
  <Library className="size-4 shrink-0 text-foreground-subtle" />
);

// 只把非 null 且非数组的 object 视为记录，因为 typeof null 同样返回 object，漏判会在后续取键时抛类型错误
// 数组单独排除，工作流条目必须是键值对象，出现数组说明服务端契约已经漂移
// [失败路径] 输入是 unknown，这里是所有字段访问前唯一的收窄闸门，收窄一旦放宽，脏数据就直接进入渲染树
// 收窄结果只在本文件内消费，不写回 toolCall，保证渲染链路保持纯函数性质
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 非 string 一律返回 undefined，数字与布尔不做隐式转字符串，避免把 0 或 false 显示成文案
// 去空白之后再判空，只有纯空白的字段视为缺失，让「有值」与「空值」在卡片上可分辨
// [权衡] 不做长度截断，超长描述交给渲染层的 truncate 与 break-words 处理，读取层只负责取值语义
function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// name 是唯一必填字段，其余全部可选，读入阶段对缺失保持 undefined 而不填默认值
// argNames 只保留参数名，脚本正文本来就不在结果里，因此卡片永远不会展示调用细节
// path 同时用于列表 key 与悬停提示，缺失时下游回退到 name，两个字段不能同时为空
// [并发] 该结构是渲染期只读快照，不参与任何写回，多张卡片并存时互不影响
interface SavedWorkflowEntry {
  name: string;
  description: string | undefined;
  whenToUse: string | undefined;
  scope: string | undefined;
  path: string | undefined;
  argNames: string[];
}

// 坏文件只需要 path 与原因两个字段，缺 path 的条目在读取阶段就被丢弃
// 此结构存在的意义是让坏文件刻意可见，而不是在解析时静默过滤
interface InvalidSavedWorkflowEntry {
  path: string;
  reason: string | undefined;
}

// workflows 与 invalid 恒为两个数组，读取函数保证形状恒定，消费方不必判空
// 长度为零与整体不可读是两件事：前者渲染空列表文案，后者交回 fallback
interface ListSavedWorkflowsResult {
  workflows: SavedWorkflowEntry[];
  invalid: InvalidSavedWorkflowEntry[];
}

// 只对以左花括号或左方括号开头的字符串尝试解析，XML 风格的正文在这里就被排除
// 非字符串原样返回，调用方随后统一用 isPlainRecord 收窄
// [失败路径] 解析异常被 catch 吞成 undefined，坏 JSON 不会冒泡打断整张卡片
// [权衡] 保留 legacy JSON 探针是为了兜老会话与非 v4 宿主，新链路走 display 通道更快也更准
function parseJsonCandidate(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

// workflows 不是数组时返回 null 而不是空结果，避免把契约缺失画成「没有工作流」
// 逐条遍历，非对象或 name 为空的条目直接跳过，坏条目只影响自己
// argNames 取参数对象的键名，参数对象不是普通记录时退化为空数组
// invalid 段可以整体缺失，缺失即视为没有坏文件，不报错也不补位置
// [失败路径] 任意一层结构不符都在本函数收敛为 null，由 readListSavedWorkflowsResult 决定下一跳
function readResultRecord(value: unknown): ListSavedWorkflowsResult | null {
  const normalized = parseJsonCandidate(value);
  if (!isPlainRecord(normalized) || !Array.isArray(normalized.workflows)) {
    return null;
  }

  const workflows: SavedWorkflowEntry[] = [];
  for (const entry of normalized.workflows) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const name = readTrimmedString(entry.name);
    if (name === undefined) {
      continue;
    }
    workflows.push({
      name,
      description: readTrimmedString(entry.description),
      whenToUse: readTrimmedString(entry.whenToUse),
      scope: readTrimmedString(entry.scope),
      path: readTrimmedString(entry.path),
      argNames: isPlainRecord(entry.args) ? Object.keys(entry.args) : [],
    });
  }

  const invalid: InvalidSavedWorkflowEntry[] = [];
  if (Array.isArray(normalized.invalid)) {
    for (const entry of normalized.invalid) {
      if (!isPlainRecord(entry)) {
        continue;
      }
      const path = readTrimmedString(entry.path);
      if (path === undefined) {
        continue;
      }
      invalid.push({ path, reason: readTrimmedString(entry.reason) });
    }
  }

  return { workflows, invalid };
}

/**
 * 结果读取顺序：**display 通道优先**——v4 wire 上 output.text
 * 是 formatModelContent 的 XML 风格投影，下面的 JSON 探针对它永不命中（会掉进
 * raw 兜底卡）；legacy JSON 探针保留，兜老会话与非 v4 宿主。一个都读不出来就交回
 * fallback——空列表与「读不懂」必须可分辨，不能把解析失败画成「这个项目里没有工作流」。
 */
// display 通道优先：kind 命中 saved_workflow_list 时直接采用，字段已由上游校验过
// display 分支逐字段重建数组，argNames 与 invalid 都复制一份，切断与 display 对象的共享引用
// [失败路径] 否则依次探测 toolCall.output、raw.rawOutput、raw.output、raw.result 四个候选，全部失败返回 null
// 探测顺序不可调换，output 是当前宿主的主通道，raw 上的字段只作历史兼容
// [权衡] 不做跨候选字段合并，任一候选读出完整结果即返回，避免半新半旧的拼接结果
// 返回 null 是显式信号，调用方据此交回通用卡，空列表与不可读必须可分辨
export function readListSavedWorkflowsResult(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ListSavedWorkflowsResult | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "saved_workflow_list") {
    return {
      workflows: display.workflows.map((entry) => ({
        name: entry.name,
        description: entry.description,
        whenToUse: entry.whenToUse,
        scope: entry.scope,
        path: entry.path,
        argNames: [...entry.argNames],
      })),
      invalid: (display.invalid ?? []).map((entry) => ({
        path: entry.path,
        reason: entry.reason,
      })),
    };
  }

  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  for (const candidate of [toolCall.output, raw?.rawOutput, raw?.output, raw?.result]) {
    const result = readResultRecord(candidate);
    if (result) {
      return result;
    }
  }
  return null;
}

/**
 * ListSavedWorkflows 的聊天卡。
 *
 * 为什么值得一个专用 renderer：这个工具名没登记在 shared 的已知工具表里，通用路径是
 * `FallbackToolCallBlock`，而它的默认 display model 没有 inlinePreview，于是会把
 * `JSON.stringify(toolCall)` 整包摊进聊天区——对这个工具正好是最坏情况，因为那包 JSON
 * 就是全部工作流的 description / whenToUse / args 声明。
 *
 * 卡片只回答「有哪些、干什么用」；脚本本体本来就不在结果里（spec：一次列举不该把 20 段脚本
 * 灌进上下文）。坏文件单独一行——它们是**刻意可见**的，不静默跳过。
 */
// 组件只做投影：状态全部来自 context 与 toolCall，自身不持有 useState 也不发起请求
// 结果读取包在 useMemo 里并以 toolCall 为依赖，只有引用变化才重新解析
// 单复数各用独立 message key，因为轻量 intl 没有 ICU 复数能力
// scope 只认 global 与 project 两种已知值，其余原样输出，不吞掉未来新增的作用域
// [失败路径] 图标、标题、状态与折叠全部交给 ToolLayout，本组件只决定内容区与坏文件提示
export function ListSavedWorkflowsPresentation(
  context: ToolCallBlockRenderContext & { fallback?: ReactNode },
) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;

  const result = useMemo(() => readListSavedWorkflowsResult(toolCall), [toolCall]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.list.listing"
      : "chat.toolCall.workflow.list.listed",
  });
  const scopeProjectLabel = intl.formatMessage({
    id: "chat.permission.workflow.saved.scope.project",
  });
  const scopeGlobalLabel = intl.formatMessage({ id: "chat.toolCall.workflow.scope.global" });
  const emptyLabel = intl.formatMessage({ id: "chat.toolCall.workflow.list.empty" });

  const workflowCount = result?.workflows.length ?? 0;
  const invalidCount = result?.invalid.length ?? 0;
  // 轻量 intl 没有 ICU 复数，单复数各用独立 message key（同 workflow.error/errors 的先例）。
  const countLabel = intl.formatMessage(
    {
      id:
        workflowCount === 1
          ? "chat.toolCall.workflow.list.countOne"
          : "chat.toolCall.workflow.list.count",
    },
    { count: workflowCount },
  );
  const invalidLabel = intl.formatMessage(
    {
      id:
        invalidCount === 1
          ? "chat.toolCall.workflow.list.invalidOne"
          : "chat.toolCall.workflow.list.invalid",
    },
    { count: invalidCount },
  );

  // ToolLayout 是 memo 组件：内联 JSX prop 每次渲染都是新引用，会让记忆化失效。
  const primaryText = useMemo(
    () => (
      <span className="truncate text-foreground-subtlest">
        {workflowCount === 0 ? emptyLabel : countLabel}
      </span>
    ),
    [countLabel, emptyLabel, workflowCount],
  );

  const renderContent = useCallback(() => {
    if (!result) {
      return null;
    }

    return (
      <div className="mb-2 space-y-2" data-saved-workflow-list="true">
        {result.workflows.map((workflow) => (
          <div key={workflow.path ?? workflow.name} className="min-w-0 space-y-0.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                className="min-w-0 truncate font-mono text-ui-base text-foreground-subtle"
                title={workflow.path ?? workflow.name}
              >
                {workflow.name}
              </span>
              {workflow.scope === "global" ? (
                <span
                  data-workflow-scope-tag="global"
                  className="shrink-0 rounded-xs border border-border px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest"
                >
                  {scopeGlobalLabel}
                </span>
              ) : (
                <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                  {workflow.scope === "project" ? scopeProjectLabel : workflow.scope}
                </span>
              )}
            </div>
            {workflow.description === undefined ? null : (
              <p className="min-w-0 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtlest">
                {workflow.description}
              </p>
            )}
            {workflow.argNames.length === 0 ? null : (
              <div className="flex min-w-0 flex-wrap gap-1 pt-0.5">
                {workflow.argNames.map((argName) => (
                  <span
                    key={argName}
                    className="rounded-xs border border-border px-1.5 py-0.5 font-mono text-ui-xs leading-none text-foreground-subtlest"
                  >
                    {argName}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {result.workflows.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtlest">{emptyLabel}</p>
        ) : null}

        {result.invalid.length === 0 ? null : (
          <div className="space-y-0.5 rounded-lg border border-warning/40 px-2.5 py-2">
            <p className="text-ui-sm text-warning">{invalidLabel}</p>
            {result.invalid.map((entry) => (
              <p
                key={entry.path}
                className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
                title={entry.reason ?? entry.path}
              >
                {entry.path}
              </p>
            ))}
          </div>
        )}
      </div>
    );
  }, [emptyLabel, invalidLabel, result, scopeGlobalLabel, scopeProjectLabel]);

  // 读不出结构化结果（老会话、失败、降级路径）就交回通用卡，而不是画一张空列表。
  if (!result) {
    // 读不出结构化结果时交回通用卡，绝不能在聊天区画一张误导性的空列表
    // [失败路径] 老会话、工具失败、降级路径都会走到这里，fallback 缺失时渲染空节点
    // 这个判断放在全部 hooks 之后，保证两条分支上的 hooks 调用顺序完全一致
    return context.fallback ?? null;
  }

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={LIST_SAVED_WORKFLOWS_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={context.statusLabel}
        statusTooltip={context.errorText}
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
