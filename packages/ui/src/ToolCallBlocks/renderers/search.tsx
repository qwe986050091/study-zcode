// INV-01 字符串输入直接作为查询词：守住位置 字符串分支；改错故障 纯文本检索摘要为空。
// INV-02 空白查询回退为通用检索文案：守住位置 长度判断；改错故障 显示空引号。
// INV-03 结构化命令按类型分别成句：守住位置 命令分支；改错故障 列表与搜索共用一句。
// INV-04 列表命令优先展示目录：守住位置 目录读取；改错故障 用户不知道检索范围。
// INV-05 目录尾部斜杠必须去掉：守住位置 替换调用；改错故障 路径拼接出现双斜杠。
// INV-06 搜索词按模式、查询、路径顺序回退：守住位置 空值合并链；改错故障 更明确的字段被忽略。
// INV-07 通用字段按固定顺序探测：守住位置 键数组顺序；改错故障 地址与提示词互相遮蔽。
// INV-08 只接受非空字符串字段：守住位置 类型与长度判断；改错故障 数字被当成查询词。
// INV-09 工具搜索的局部选择语法必须解析：守住位置 正则匹配；改错故障 选择语法原样展示。
// INV-10 选择列表按逗号拆分并去空白：守住位置 拆分与过滤；改错故障 出现空名称。
// INV-11 选择为空时回退到原始查询：守住位置 三元判断；改错故障 摘要为空。
// INV-12 工具搜索不展示快照提示：守住位置 隐藏标记；改错故障 出现无关提示。
// INV-13 工具搜索隐藏类型标签：守住位置 覆盖值为空；改错故障 出现重复类型。
// INV-14 主文本必须单行截断：守住位置 截断类名；改错故障 长查询撑破行。
// INV-15 检索主文本不拆次要文案：守住位置 布局入参；改错故障 标题与副标题信息重复。
// INV-16 失败状态才显示失败提示：守住位置 状态判断；改错故障 成功调用显示错误框。
// INV-17 快照字段提示由调用方开关控制：守住位置 条件渲染；改错故障 无法按场景关闭。
// INV-18 布局组件不持有状态，只做渲染：守住位置 模块边界；改错故障 摘要与状态不同步。
//
// 模块职责：为检索类工具调用生成单行摘要，并渲染统一工具卡。
// 状态所有权：摘要由输入派生；运行与失败状态来自调用上下文。
// 阅读顺序：先看主文本推导，再读工具搜索的局部选择解析，最后看布局与提示。
import { SearchIcon } from "lucide-react";
import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

// SEARCH_TOOL_ICON 在模块加载期只求值一次，被 SearchToolCallBlock 与 ToolSearchToolCallBlock 共用为 ToolLayout 的 icon 入参；size-4 / text-foreground-subtle 与其他工具卡图标对齐，若挪进组件体会每次渲染新建 JSX 元素，让 ToolLayout 的浅比较失效。
const SEARCH_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

type IntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// getSearchPrimaryText 按三级顺序推导摘要且不可调换：input 为 string 时直接用 trim 后的值填 chat.toolCall.search.findWithQuery（空串回退 chat.toolCall.search.find）；否则遍历 input.parsed_cmd，list_files 取 input.cwd 并去掉尾部斜杠 /\/+$/（防 listIn 拼出双斜杠），search/grep/glob 按 item.pattern → item.query → item.path 取首个非空；命令全不识别才落到 search_query/searchQuery/query/pattern/path/url/prompt/target/name 的固定键序（url 排在 prompt 前，避免 WebFetch 摘要被 prompt 遮住待确认地址）。换成宽泛字段优先会盖掉更具体的 pattern。
export function getSearchPrimaryText(intl: IntlLike, input: unknown): string {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0
      ? intl.formatMessage({ id: "chat.toolCall.search.findWithQuery" }, { query: trimmed })
      : intl.formatMessage({ id: "chat.toolCall.search.find" });
  }

  if (!isPlainRecord(input)) {
    return intl.formatMessage({ id: "chat.toolCall.search.find" });
  }

  const parsedCmd = input.parsed_cmd;
  if (Array.isArray(parsedCmd)) {
    for (const item of parsedCmd) {
      if (!isPlainRecord(item) || typeof item.type !== "string") {
        continue;
      }

      if (item.type === "list_files") {
        const cwd =
          typeof input.cwd === "string" && input.cwd.trim().length > 0
            ? input.cwd.trim().replace(/\/+$/, "")
            : undefined;
        return cwd
          ? intl.formatMessage({ id: "chat.toolCall.search.listIn" }, { cwd })
          : intl.formatMessage({ id: "chat.toolCall.search.list" });
      }

      if (item.type === "search" || item.type === "grep" || item.type === "glob") {
        const candidate =
          typeof item.pattern === "string"
            ? item.pattern.trim()
            : typeof item.query === "string"
              ? item.query.trim()
              : typeof item.path === "string"
                ? item.path.trim()
                : "";
        return candidate.length > 0
          ? intl.formatMessage({ id: "chat.toolCall.search.findWithQuery" }, { query: candidate })
          : intl.formatMessage({ id: "chat.toolCall.search.find" });
      }
    }
  }

  for (const key of [
    "search_query",
    "searchQuery",
    "query",
    "pattern",
    "path",
    // WebFetch 同时带 url 和 prompt 时，权限/工具摘要展示 prompt 会遮住真正需要用户确认的目标地址。
    "url",
    "prompt",
    "target",
    "name",
  ] as const) {
    const candidate = input[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return intl.formatMessage({ id: "chat.toolCall.search.findWithQuery" }, { query: trimmed });
    }
  }

  return intl.formatMessage({ id: "chat.toolCall.search.find" });
}

export function SearchToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  return (
    <SearchToolCallLayout
      {...context}
      searchPrimaryText={getSearchPrimaryText(intl, context.toolCallNode.toolCall.input)}
    />
  );
}

// ToolSearchToolCallBlock 只读 input.query（非字符串按空串处理），用 /^select:(.+)$/i 识别局部选择语法：命中则把捕获组按逗号切分、逐项 trim 后 filter(Boolean) 再 join(", ") 得到 label；label 为空（含 select: 后全是逗号的情况）回退 chat.toolCall.search.tools 而非原始 query；kindLabelOverride="" 与 hideSnapshotNotice 让工具搜索不出现类型标签和快照字段提示。
export function ToolSearchToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { input } = context.toolCallNode.toolCall;
  const query = isPlainRecord(input) && typeof input.query === "string" ? input.query.trim() : "";
  const selection = /^select:(.+)$/i.exec(query);
  const label = selection
    ? selection[1]!
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .join(", ")
    : query;
  const searchPrimaryText = label
    ? intl.formatMessage({ id: "chat.toolCall.search.toolsWithQuery" }, { query: label })
    : intl.formatMessage({ id: "chat.toolCall.search.tools" });
  return (
    <SearchToolCallLayout
      {...context}
      searchPrimaryText={searchPrimaryText}
      kindLabelOverride=""
      hideSnapshotNotice
    />
  );
}

// SearchToolCallLayout 自身不持有状态：primaryText 用 useMemo([searchPrimaryText]) 缓存 <span className="truncate">，依赖不变时元素引用稳定，工具卡不会因父级重渲染反复挂载；kindLabel 由 context.kindLabelOverride 覆盖，否则按 isRunning 取 chat.toolCall.search.searching / chat.toolCall.kind.search；statusTooltip 仅在 toolCall.status === "failed" 时取 errorText，content 恒为 null 因为检索结果不在卡片内展开。
function SearchToolCallLayout(
  context: ToolCallBlockRenderContext & { searchPrimaryText: string; hideSnapshotNotice?: boolean },
) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall } = toolCallNode;
  const { searchPrimaryText } = context;
  const primaryText = useMemo(
    () => <span className="truncate">{searchPrimaryText}</span>,
    [searchPrimaryText],
  );

  // 快照提示默认挂载，只有 context.hideSnapshotNotice 为 true 时整段不渲染；refs 取 toolCall.snapshotRefs ?? []，onLoadFullToolCallFields 只有在 context 提供回调时才闭包转发 toolCall.toolId，避免下游拿到 undefined 工具标识。
  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SEARCH_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id: isRunning ? "chat.toolCall.search.searching" : "chat.toolCall.kind.search",
          })
        }
        sourceLabel={context.sourceLabel}
        // search 的主文本直接拼成一句完整摘要，不再拆 secondaryText；
        // 这样能避免 title 干扰，也更适合列表/目录查询这类操作。
        primaryText={primaryText}
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={toolCall.title}
        content={null}
      />
      {!context.hideSnapshotNotice && (
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            context.onLoadFullToolCallFields
              ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
              : undefined
          }
        />
      )}
    </>
  );
}
