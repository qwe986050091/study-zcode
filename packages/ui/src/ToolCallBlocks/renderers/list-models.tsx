// INV-01 [失败路径] readListModelsResult 必须先用 readToolResultDisplay 走 display 通道、且 kind 等于 list_models 才收口；若把 legacy 探针提前，v4 wire 的 output.text 只是 models 投影，JSON 探针永不命中，结果直接掉进 raw 兜底卡。
// INV-02 [事务] display.models 逐字段重建视图并给 reasoningLevels 拷贝新数组；直接返回快照引用会让分组与渲染共享同一份可变数组，卡片之间互相污染档位。
// INV-03 [失败路径] parseJsonCandidate 只对 { 或 [ 开头的字符串尝试解析，解析异常在 catch 内回 undefined；若向上抛，一条脏载荷就会中断整块对话渲染。
// INV-04 [失败路径] readResultRecord 先要求 normalized 是普通对象且 models 是数组，否则回 null；改成回空 models，会把「读不懂结果」伪装成「没有模型」。
// INV-05 [失败路径] 遍历 normalized.models 时逐条校验 id、providerId、modelId 三个非空字符串，缺一即 continue；改成抛错会让一条畸形记录吞掉整份清单。
// INV-06 [权衡] 视图字段按白名单逐个拷贝，不对 entry 做展开；展开会把宿主私有字段带进渲染层，类型边界与快照体积一起失守。
// INV-07 [资源] reasoningLevels 经 readStringArray 过滤非字符串，contextWindow 仅在 typeof number 时保留；放宽成字符串数字会让格式化函数拿到 NaN 或错量级。
// INV-08 truncated 用严格等于 true 收口，避免字符串 true 或空串误点亮截断提示；该字段只影响尾行，不影响列表本体。
// INV-09 [失败路径] legacy 探针顺序固定为 output、raw.rawOutput、raw.output、raw.result，第一个命中即 return；换序会让同一份老会话在不同宿主命中不同字段。
// INV-10 readListModelsResult 末尾必须 return null 而不是空结果：调用方靠 null 区分「读不到目录」与「目录为空」两种画面。
// INV-11 当前项判定只做 model.id 与 result.current 的严格相等，不做前缀或大小写折叠；放宽后同前缀的模型会被同时打上当前标记。
// INV-12 [权衡] listModelsGroupName 的优先级固定为家族名、providerLabel、会话清单名、通用词；颠倒会让同一 provider 在不同会话显示不同组名。
// INV-13 [失败路径] 采用 providerLabel 前必须 trim 且校验不等于 providerId；漏判会让团队套餐的 UUID 直接占据组名首屏。
// INV-14 [失败路径] 会话清单名 providerName 同样要求非空且不等于 providerId，最终兜底固定用 chat.toolCall.workflow.models.provider 文案，任何分支都不许回退标识符。
// INV-15 [权衡] formatContextWindow 的三档阈值是 1000 与 1_000_000，全部用严格小于；写成小于等于会让临界整点值换档、列宽跳动。
// INV-16 [权衡] groupModelsByProvider 用 Map 去重加 groups 数组保序，只 append 不排序；加排序会与模型菜单的注册表顺序分叉。
// INV-17 [并发] groups 的 useMemo 以 result 为唯一依赖、null 时给空数组；漏掉 result 会让切换会话后仍按旧分组渲染。
// INV-18 [失败路径] 三个出口的顺序不可交换：result null 且 status failed 走空摘要 ToolLayout，裸 null 回 FallbackToolCallBlock，其余才画列表。
//
// 模块职责：ListModels 聊天卡的专用渲染器，把模型目录归一成按 provider 分组的数据，只回答有哪些、来自哪里、哪个是当前。
// 状态所有权：本文件不持有状态；toolCall 快照是唯一数据源，分组、计数与文案都是渲染期派生，provider 展示名来自 presentationCapabilities。
// 阅读顺序：先看 readListModelsResult 与 readResultRecord 的归一，再看 listModelsGroupName 与 formatContextWindow 的展示规则，最后看 ListModelsToolCallBlock 的三个出口。
import { Cpu } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  getModelProviderFamilySpec,
  resolveModelProviderFamilyIdByProviderId,
} from "@zcode/shared";
// 分享页通过 ToolPresentation 复用本渲染器；从 thoughtLevelOptions 引入会经 display → CodingPlan 拉进
// @zcode/provider 闭包，导致 web-share 构建失败，因此直接依赖纯词表模块。
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabels.js";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const LIST_MODELS_TOOL_ICON = <Cpu className="size-4 shrink-0 text-foreground-subtle" />;

type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** providerId → 会话模型清单里的 provider 名；查不到即缺席（见 useWorkflowSubagentModelProviderName）。 */
type ProviderNameLookup = ((providerId: string) => string | undefined) | undefined;

interface ListModelsEntryView {
  id: string;
  providerId: string;
  modelId: string;
  providerLabel: string | undefined;
  reasoningLevels: string[];
  defaultReasoningLevel: string | undefined;
  contextWindow: number | undefined;
  disabledReason: string | undefined;
}

interface ListModelsResult {
  current: string | undefined;
  models: ListModelsEntryView[];
  truncated: boolean;
}

// 归一化辅助族统一把 unknown 收窄成已定型视图，下游只处理确定字段，不再重复做类型判断。
// [失败路径] isPlainRecord 必须同时排除 null 与数组：数组能通过 typeof object，被当成记录后所有字段读取都会落空。
// readTrimmedString 只做 trim 与空串归一，不改大小写；返回 undefined 表示字段缺席，调用方据此走降级分支。
// readStringArray 只保留 string 成员，其余静默丢弃；抛错或强制转换都会把畸形载荷带进列表。
// parseJsonCandidate 对非字符串原样返回，对不以 { 或 [ 开头的字符串回 undefined，避免把纯文本误当 JSON。
// [失败路径] 解析异常在 catch 内吞掉并回 undefined：这里的职责是探测而不是校验，抛错会让一张脏卡毁掉整块对话渲染。
//
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

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

// readResultRecord 是唯一的结构入口：把任意载荷收敛成 ListModelsResult 或 null，不产出部分成功的中间态。
// [失败路径] normalized 非普通对象或 models 非数组时直接回 null；若改成回空 models，读不懂的结果会被画成「一个模型也没有」。
// 逐条 entry 必须同时具备 id、providerId、modelId 三个非空字符串，缺一即 continue。
// [失败路径] 缺字段条目跳过而不是抛错：一条畸形记录不能吞掉整份清单，否则用户看到的是空目录。
// 视图字段按白名单显式拷贝，不对 entry 做展开：展开会把宿主私有字段带进渲染层，也破坏 ListModelsEntryView 的类型边界。
// reasoningLevels 走 readStringArray，defaultReasoningLevel 走 readTrimmedString，两者互不推断、互不补齐。
// contextWindow 仅在 typeof number 时保留，字符串数字一律按缺失处理，保证格式化函数只见到数字。
// truncated 用严格等于 true 收口，避免字符串或空串点亮截断提示，该字段只影响尾行文案。
function readResultRecord(value: unknown): ListModelsResult | null {
  const normalized = parseJsonCandidate(value);
  if (!isPlainRecord(normalized) || !Array.isArray(normalized.models)) {
    return null;
  }

  const models: ListModelsEntryView[] = [];
  for (const entry of normalized.models) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const id = readTrimmedString(entry.id);
    const providerId = readTrimmedString(entry.providerId);
    const modelId = readTrimmedString(entry.modelId);
    if (id === undefined || providerId === undefined || modelId === undefined) {
      continue;
    }
    models.push({
      id,
      providerId,
      modelId,
      providerLabel: readTrimmedString(entry.providerLabel),
      reasoningLevels: readStringArray(entry.reasoningLevels),
      defaultReasoningLevel: readTrimmedString(entry.defaultReasoningLevel),
      contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : undefined,
      disabledReason: readTrimmedString(entry.disabledReason),
    });
  }

  return {
    current: readTrimmedString(normalized.current),
    models,
    truncated: normalized.truncated === true,
  };
}

/**
 * 结果读取顺序与 list-saved-workflows 同一条：**display 通道优先**（`list_models` kind——
 * v4 wire 上 output.text 是 formatModelContent 的 `<models>` 投影，下面的 JSON 探针对它永不
 * 命中，正是今天掉进 raw 兜底卡的根因）；legacy JSON 探针兜老会话与非 v4 宿主。一个都读不
 * 出来就回 null——「这台机器没有模型」与「读不懂这次结果」必须可分辨。
 */
export function readListModelsResult(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ListModelsResult | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "list_models") {
    return {
      current: display.current,
      models: display.models.map((model) => ({
        id: model.id,
        providerId: model.providerId,
        modelId: model.modelId,
        providerLabel: model.providerLabel,
        reasoningLevels: [...model.reasoningLevels],
        defaultReasoningLevel: model.defaultReasoningLevel,
        contextWindow: model.contextWindow,
        disabledReason: model.disabledReason,
      })),
      truncated: display.truncated === true,
    };
  }

  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  // [失败路径] legacy 探针按 output、rawOutput、output、result 的固定顺序逐字段尝试，第一个命中即返回。
  // 顺序即优先级：output 是工具直出，rawOutput 是宿主打包副本，result 是更老的壳层字段。
  // [权衡] 调整该数组顺序会让同一份老会话在不同宿主命中不同字段，同一条记录两次打开可能显示不同。
  // 探针只接受 readResultRecord 认可的形态，models 为空数组也算命中，因此不会继续向更弱的字段降级。
  // 四条全部落空才回 null，由调用方区分「读不懂这次结果」与「这台机器没有模型」。
  //
  for (const candidate of [toolCall.output, raw?.rawOutput, raw?.output, raw?.result]) {
    const result = readResultRecord(candidate);
    if (result) {
      return result;
    }
  }
  return null;
}

/**
 * 组名 = provider 的**名字**，与模型菜单同一条规则（subagent-model-label.ts 的同款纪律）：
 * 内置家族取家族名；否则取载荷里的 providerLabel；否则取会话模型清单里的名字；都没有就用
 * 「模型供应商」这个词本身。**永远不回 providerId**——团队套餐的它是一个 UUID，摆上屏幕
 * 等于让用户先跳过 36 个字符才看见模型名。
 */
// 组名解析有固定优先级：内置家族名、载荷 providerLabel、会话模型清单名、通用「模型供应商」词。
// 家族判定用 resolveModelProviderFamilyIdByProviderId，非 null 即取家族 spec 的 label，不再看载荷。
// [失败路径] 采用 providerLabel 前必须 trim 且校验不等于 providerId，漏判会让团队套餐的 UUID 直接占据组名。
// 会话清单查询 providerName 同样要求非空且不等于 providerId，缺一项就继续向下一级降级。
// 最终兜底是 i18n 文案而不是 providerId：任何分支都不允许把标识符当展示名。
//
function listModelsGroupName(
  providerId: string,
  providerLabel: string | undefined,
  providerName: ProviderNameLookup,
  formatMessage: FormatMessage,
): string {
  const familyId = resolveModelProviderFamilyIdByProviderId(providerId);
  if (familyId !== null) {
    return getModelProviderFamilySpec(familyId).label;
  }
  const label = providerLabel?.trim();
  if (label !== undefined && label.length > 0 && label !== providerId) {
    return label;
  }
  // 会话清单查不到时会退回 providerId 本身（zcodeSessionSettingsToConfigOptions），当作没查到。
  const resolved = providerName?.(providerId)?.trim();
  if (resolved !== undefined && resolved.length > 0 && resolved !== providerId) {
    return resolved;
  }
  return formatMessage({ id: "chat.toolCall.workflow.models.provider" });
}

/**
 * 上下文窗口的读法：千位以下原样，百万以下取整到 K，再往上到 M 且只在有小数时留一位
 * （`1M` / `1.5M`）。这一列是给人扫一眼比大小的，不是给人核对精确 token 数的。
 */
// [权衡] 三档阈值：小于 1000 原样、小于 1_000_000 取整到 K、再往上到 M 且整数省略小数。
// 边界严格用小于：999_999 落在 K 档显示 1000K，改成小于等于会让临界值换档、列宽跳动。
// M 档用 Number.isInteger 决定是否补一位小数，输出只有整数与一位小数两种形态。
// 这一列供扫一眼比大小，不承诺精确 token 数，不在此加入千分位或单位换算。
export function formatContextWindow(contextWindow: number): string {
  if (contextWindow < 1_000) {
    return String(contextWindow);
  }
  if (contextWindow < 1_000_000) {
    return `${Math.round(contextWindow / 1_000)}K`;
  }
  const millions = contextWindow / 1_000_000;
  return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
}

function levelWord(level: string, formatMessage: FormatMessage): string {
  // 档位词与思考控件同一张表；表里没有的值原样显示（provider 自定义的档位名）。
  const labelId = thoughtLevelLabelId(level);
  return labelId === undefined ? level : formatMessage({ id: labelId });
}

/**
 * 行的 tooltip：第一行是思考强度档位（没有档位就说没有），换行后是规范 id。规范 id 是给
 * 机器回填 `subagent_model` 用的，它只该住在这里（subagent-model-label.ts 的同款分工）。
 */
function listModelsRowTooltip(model: ListModelsEntryView, formatMessage: FormatMessage): string {
  let levelsLine: string;
  if (model.reasoningLevels.length === 0) {
    levelsLine = formatMessage({ id: "chat.toolCall.workflow.models.noLevels" });
  } else {
    const levels = model.reasoningLevels
      .map((level) => levelWord(level, formatMessage))
      .join(" · ");
    levelsLine =
      model.defaultReasoningLevel === undefined
        ? formatMessage({ id: "chat.toolCall.workflow.models.levelsNoDefault" }, { levels })
        : formatMessage(
            { id: "chat.toolCall.workflow.models.levels" },
            { default: levelWord(model.defaultReasoningLevel, formatMessage), levels },
          );
  }
  return `${levelsLine}\n${model.id}`;
}

interface ListModelsGroup {
  providerId: string;
  models: ListModelsEntryView[];
}

/** 按 providerId 分组，保持首次出现的顺序——目录的顺序是宿主注册表的顺序，卡不重排。 */
// [权衡] 分组只按 providerId 首次出现拼接，Map 负责去重、groups 数组负责保序，全程不排序。
// 顺序来自宿主注册表，卡片不重排：加排序会让模型菜单与卡片分组顺序分叉。
// 新组在首次遇到时即压入 groups，后续模型只追加，整份清单单次遍历完成。
//
function groupModelsByProvider(models: ListModelsEntryView[]): ListModelsGroup[] {
  const groups: ListModelsGroup[] = [];
  const byProviderId = new Map<string, ListModelsGroup>();
  for (const model of models) {
    let group = byProviderId.get(model.providerId);
    if (group === undefined) {
      group = { providerId: model.providerId, models: [] };
      byProviderId.set(model.providerId, group);
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/**
 * ListModels 的聊天卡。
 *
 * 为什么值得一个专用 renderer：这个工具名不在 shared 的已知工具表里，通用路径是
 * `FallbackToolCallBlock`，它会把模型面的 `<models>` 文本原样摊开——那段文本每行都以
 * providerId 开头（可能是 UUID 等长标识），「当前」藏在行尾方括号里。
 *
 * 卡只回答三件事：有哪些、来自哪里、哪个是当前。每行的档位表与规范 id 归 tooltip；
 * providerId 一个字符都不上屏。
 */
export function ListModelsToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const providerName = useToolPresentationCapabilities().modelProviderName;

  // [并发] 结果解析挂在 toolCall 快照上，useMemo 以 toolCall 为依赖，快照替换才重算，流式追加期间不重复解析。
  // result 为 null 是合法中间态，后续三个出口据此分流，任何位置都不能假设 models 已存在。
  //
  const result = useMemo(() => readListModelsResult(toolCall), [toolCall]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.models.listing"
      : "chat.toolCall.workflow.models.listed",
  });
  const emptyLabel = intl.formatMessage({ id: "chat.toolCall.workflow.models.empty" });
  const currentLabel = intl.formatMessage({ id: "chat.toolCall.workflow.models.current" });
  const truncatedLabel = intl.formatMessage({ id: "chat.toolCall.workflow.models.truncated" });

  const modelCount = result?.models.length ?? 0;
  // 轻量 intl 没有 ICU 复数，单复数各用独立 message key（同 workflow.list.count 的先例）。
  const countLabel = intl.formatMessage(
    {
      id:
        modelCount === 1
          ? "chat.toolCall.workflow.models.countOne"
          : "chat.toolCall.workflow.models.count",
    },
    { count: modelCount },
  );

  const groups = useMemo(
    () => (result === null ? [] : groupModelsByProvider(result.models)),
    [result],
  );

  // ToolLayout 是 memo 组件：内联 JSX prop 每次渲染都是新引用，会让记忆化失效。
  const primaryText = useMemo(
    () => (
      <span className="truncate text-foreground-subtlest">
        {modelCount === 0 ? emptyLabel : countLabel}
      </span>
    ),
    [countLabel, emptyLabel, modelCount],
  );

  const renderContent = useCallback(() => {
    if (result === null) {
      return null;
    }

    return (
      <div className="mb-2 space-y-2" data-model-list="true">
        {groups.map((group) => (
          <div key={group.providerId} className="min-w-0 space-y-0.5">
            <div className="text-ui-xs text-foreground-subtlest">
              {listModelsGroupName(
                group.providerId,
                group.models.find((model) => model.providerLabel !== undefined)?.providerLabel,
                providerName,
                intl.formatMessage,
              )}
            </div>
            {group.models.map((model) => (
              <div
                key={model.id}
                className="flex min-w-0 items-baseline gap-x-2"
                title={listModelsRowTooltip(model, intl.formatMessage)}
                data-model-id={model.id}
              >
                <span
                  className={
                    model.disabledReason === undefined
                      ? "min-w-0 truncate font-mono text-ui-base text-foreground-subtle"
                      : "min-w-0 truncate font-mono text-ui-base text-foreground-subtlest"
                  }
                >
                  {model.modelId}
                </span>
                {model.id === result.current ? (
                  <span
                    className="shrink-0 text-ui-xs text-foreground-subtlest"
                    data-model-current="true"
                  >
                    {currentLabel}
                  </span>
                ) : null}
                {model.disabledReason === undefined ? null : (
                  <span className="min-w-0 truncate text-ui-xs text-warning">
                    {model.disabledReason}
                  </span>
                )}
                {model.contextWindow === undefined ? null : (
                  <span className="ml-auto shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                    {formatContextWindow(model.contextWindow)}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}

        {result.truncated ? (
          <p className="text-ui-sm text-foreground-subtlest">{truncatedLabel}</p>
        ) : null}
      </div>
    );
  }, [currentLabel, groups, intl.formatMessage, providerName, result, truncatedLabel]);

  // 失败态**不**退回兜底卡：那张卡会摊开错误 JSON，而这里真正要说的是「这个会话读不到模型
  // 目录」。它与「一个模型也没有」是两回事，卡上既不画列表也不说那句空话（同
  // model_catalog_unavailable 在模型通道上的分辨）。
  // [失败路径] 顺序敏感：先判 result null 且 status failed，再判裸 null 交回兜底卡，最后才画正常列表。
  // 失败态不退回 FallbackToolCallBlock：那张卡会把错误 JSON 原样摊开，而这里要表达的是读不到模型目录。
  // 失败摘要行 primaryText 固定置空：计数与「没有配置模型」在该状态下都是谎话，只有种类词与状态词可信。
  // 该分支锁定 canToggle 为 false、forceOpen 为 false，避免展开一个必然为空的内容区。
  // ToolSnapshotFieldNotice 在两个出口都要挂载，失败态也不例外，否则用户无法回捞完整字段。
  // [权衡] 「读不到目录」与「目录为空」必须保持两种画面，合并会让空态文案掩盖解析失败。
  //
  if (result === null && toolCall.status === "failed") {
    return (
      <>
        <ToolLayout
          toolId={toolCall.toolId}
          icon={LIST_MODELS_TOOL_ICON}
          showIcon={context.showIcon !== false}
          canToggle={false}
          forceOpen={false}
          kindLabel={context.kindLabelOverride ?? kindLabel}
          sourceLabel={context.sourceLabel}
          // 失败时摘要行只有种类词与状态词：计数与那句「没有配置模型」在这里都是谎话。
          primaryText={null}
          statusLabel={context.statusLabel}
          statusTooltip={context.errorText}
          showFailureStatus
          isRunning={context.isRunning}
          title={toolCall.title}
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

  // 读不出结构化结果（老会话、降级路径）就交回通用卡，而不是画一张空目录。
  if (result === null) {
    return <FallbackToolCallBlock {...context} iconOverride={LIST_MODELS_TOOL_ICON} />;
  }

  // 一个模型也没有时摘要行就是那句话，没有可展开的内容——空卡体比没有卡体更难读。
  const hasDetails = modelCount > 0;

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={LIST_MODELS_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={context.statusLabel}
        statusTooltip={context.errorText}
        showFailureStatus={toolCall.status === "failed"}
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
