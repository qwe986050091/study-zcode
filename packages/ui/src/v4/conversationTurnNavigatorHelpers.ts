// INV-01 目录项是一次真实用户 query 的投影，数量等于所有非 timelineOnly 单元里 origin 为 realUser 的行数；守住位置：buildConversationTurnNavigatorItems 的 realUserInputs 过滤与 flatMap；改错故障：把系统上下文当 query 展示，导航条跳到用户从未输入过的位置。
// INV-02 每个目录项的 key 由 unit.key、query 段标记与 entityId 优先的稳定身份拼成，在同一份 units 内唯一；守住位置：buildConversationTurnNavigatorItems 的 key 构造；改错故障：虚拟列表出现重复 key，滚动定位串到别的 turn，点击跳错消息。
// INV-03 入参 units 只读，函数不排序、不就地改写、不缓存其引用；守住位置：buildConversationTurnNavigatorItems 全流程；改错故障：调用方复用同一 units 时顺序被外部副作用打乱，列表顺序随机跳变。
// INV-04 返回数组全新分配，元素也是新对象，调用方可改字段而不污染 unit 与 row；守住位置：buildConversationTurnNavigatorItems 末尾的 map 结果；改错故障：目录改一次预览会同时改到消息正文共享的对象。
// INV-05 timelineOnly 单元一律不产生目录项；守住位置：buildConversationTurnNavigatorItems 的跳过分支；改错故障：仅存在于时间线的隐藏 turn 出现在目录里，点击后没有对应可视内容。
// INV-06 同一 product turn 的多条 steer query 各自成项，但 assistant 摘要与被强调的 running 只挂在最后一条上；守住位置：isRunning 的 queryIndex 判定；改错故障：多条旧 query 同时闪动 running，用户以为多个请求并发在跑。
// INV-07 assistantPreviewKind 与 assistantPreview 必须同步产出，text 对应真实文本、running 对应占位、empty 对应兜底；守住位置：buildAssistantPreview 的三个返回分支；改错故障：界面按 text 渲染却拿到空串，气泡高度塌成 0 像素。
// INV-08 预览为空时返回 fallback 而不是空串，且 fallback 由调用方注入；守住位置：buildPreviewText 的 paragraphs.length 判空；改错故障：目录项显示空白行，用户无法辨认那一条 query。
// INV-09 预览字符上限先夹到不小于 8，超长时保留上限减 3 个字符再拼省略号；守住位置：truncatePreview；改错故障：上限配成 1 时切片负长度得到空串，省略号本身反而超出预算。
// INV-10 段落上限先夹到不小于 1，空白段落被丢弃，因此结果要么全空要么至少一段；守住位置：normalizePreviewParagraphs 的 filter 与 slice；改错故障：maxParagraphs 传 0 时预览整段消失，只剩兜底文案。
// INV-11 滚动偏移与视口高度都先归一为有限非负数，非有限值按 0 处理，视口高度再夹到至少 1；守住位置：resolveFiniteNonNegative 及其三处调用；改错故障：NaN 传播使所有区间比较为假，活跃项永远选不出来。
// INV-12 items 为空时活跃单元索引返回 undefined 而不是抛错，调用方必须容忍该值；守住位置：resolveConversationTurnNavigatorActiveUnitIndex 首行；改错故障：首帧列表尚未填充时渲染崩溃白屏。
// INV-13 同一 unitIndex 有多项时以最后一项为准，距离比较用严格小于，等距时保留先遍历到的项；守住位置：itemByUnitIndex 构造与 activeDistance 比较；改错故障：结果随 items 顺序抖动，高亮在两条 query 之间闪烁。
// INV-14 视口重叠判定两端都取闭区间，行首等于视口尾或行尾等于视口首都算可见；守住位置：两处 rowEnd 与 viewportStart 的比较；改错故障：滚到边界那一像素时活跃项瞬间清空。
// INV-15 没有可见行时按虚拟索引就近兜底，依次尝试不小于该索引的首项、不大于该索引的末项、第一项；守住位置：活跃单元索引函数尾部兜底链；改错故障：快速滚动越过视口后高亮留在旧位置，手指与内容脱节。
// INV-16 活跃 query 行在归一后按起点升序、同起点按 rowId 升序排序，排序只作用于副本；守住位置：resolveConversationTurnNavigatorActiveQueryRowId 的 map 与 sort；改错故障：就地排序改写调用方数组，下一次读取顺序错乱。
// INV-17 活跃 query 行的兜底规则是优先取起点不晚于滚动位置的最后一段，其次才取之后的第一个；守住位置：该函数末尾的两级查找；改错故障：停在两段之间时高亮突然跳到很远的 query。
// INV-18 视觉焦点只由交互索引决定，未交互时继承活跃项，两者都缺省时所有条进入 idle 档；守住位置：视觉焦点解析与 bar 视觉状态的首个分支；改错故障：hover 结束后条状图不回落，长期停在放大态。
// INV-19 条状样式只按与焦点索引的距离分四档，距离 3 及以上与无焦点共用 idle 参数；守住位置：resolveConversationTurnNavigatorBarVisualState；改错故障：远距离条目仍保持放大，整条导航视觉噪声过大。
// INV-20 水合只在可加载更早、未在加载、有加载回调且容器宽度达标时成立，重试超过 2 次返回 null 终止；守住位置：shouldHydrate 判定与重试延迟函数；改错故障：窄屏反复触发目录水合并持续重试，形成请求风暴。
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export type ConversationTurnNavigatorAssistantPreviewKind =
  | "empty"
  | "running"
  | "text";

// [权衡] 目录项同时带 key、turnId、unitIndex、rowId 属刻意冗余：key 由虚拟列表
// 去重与复用，turnId 供先把视口定位到所属容器，rowId 供滚动到具体消息，
// unitIndex 供反查活跃单元。只留 key 会让调用方解析字符串才能定位，把格式
// 约定泄漏到渲染层；只留 rowId 则同一 row 被重渲染成新 turn 时无法区分。
// 三个预览字段成组出现，kind 是判别式，读取方必须按 kind 决定是否信任 text。
// userPreview 与 assistantPreview 允许为空串，只有 kind 为 text 才代表真实内容。
// isRunning 描述该条 query 是否仍代表当前进行中的工作，不是全局忙闲标志。
// 新增字段应保持可序列化，目录项会进虚拟列表缓存与后端状态快照。
export interface ConversationTurnNavigatorItem {
  key: string;
  turnId: string;
  unitIndex: number;
  rowId: number;
  userPreview: string;
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
  isRunning: boolean;
}

// 三个必填预览文案（如 userFallbackPreview）由调用方注入，避免本模块硬编码界面语，便于多语言与测试断言；
// 两个上限可省略，省略时走 DEFAULT_MAX_PREVIEW_CHARS 与 DEFAULT_MAX_PREVIEW_PARAGRAPHS。
// 函数内部用 Required 收窄成全部必填，因此默认值必须在进入 flatMap 之前补齐，
// 不能在每条 unit 上重复回填，否则同一次构建里不同项会拿到不同默认值。
// [权衡] 越界上限直接夹到安全下限而不抛错：目录是滚动路径上的高频调用，
// 参数配错时应降级成可读截断，而不是让整条会话列表因一个配置错误而崩溃。
export interface BuildConversationTurnNavigatorItemsOptions {
  assistantEmptyPreview: string;
  assistantRunningPreview: string;
  userFallbackPreview: string;
  maxPreviewChars?: number;
  maxPreviewParagraphs?: number;
}

export interface ConversationTurnNavigatorVirtualItem {
  index: number;
  start: number;
  size: number;
}

export interface ResolveConversationTurnNavigatorActiveUnitIndexOptions {
  items: readonly ConversationTurnNavigatorItem[];
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

export interface ConversationTurnNavigatorQueryPosition {
  rowId: number;
  start: number;
  end: number;
}

export interface ResolveConversationTurnNavigatorActiveQueryRowIdOptions {
  positions: readonly ConversationTurnNavigatorQueryPosition[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

export type ConversationTurnNavigatorBarTone = "idle" | "mid" | "near" | "peak";
export type ConversationTurnNavigatorBarColorTone = "focus" | "muted";

export interface ConversationTurnNavigatorBarVisualState {
  colorTone: ConversationTurnNavigatorBarColorTone;
  opacity: number;
  scaleX: number;
  tone: ConversationTurnNavigatorBarTone;
}

export interface ResolveConversationTurnNavigatorBarVisualStateOptions {
  itemIndex: number;
  visualFocusItemIndex: number | undefined;
}

export interface ResolveConversationTurnNavigatorVisualFocusItemIndexOptions {
  activeItemIndex: number;
  interactionItemIndex: number | undefined;
}

// 864px 是可容纳目录条与消息列的实测最小宽度，低于它目录会压住正文，是硬门槛
// 而非建议值；containerWidthPx 达到 864 即开启水合，恰好 864 时仍开启。
// [权衡] 用像素常量而不是断点 token：目录宽度取决于侧栏折叠与分栏比例，媒体
// media query 表达的是视口宽度，折叠侧栏后两者不再等价，而只有 containerWidthPx 是真实可用空间。
// 该值被水合判定与视觉回归快照共同引用，改动会使已归档截图基线失效，需同步更新快照。
// [失败路径] 容器宽度为 NaN 或负数时比较恒为假，水合会静默不开启，界面表现为目录
// 按钮始终置灰；排查应先怀疑 containerWidthPx 的布局测量，常量保持纯数字，不要引入带单位字符串。
export const CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX = 864;

export type ConversationTurnNavigatorHydrationResult =
  | { status: "hydrated"; logEpoch: string }
  | { status: "not-enough-queries"; logEpoch: string }
  | { status: "retryable-failure"; logEpoch: string }
  | { status: "stale"; logEpoch: string };

export function shouldHydrateConversationTurnNavigatorDirectory(params: {
  canLoadOlder: boolean;
  containerWidthPx: number;
  hasLoadHandler: boolean;
  loadingOlder: boolean;
}): boolean {
  return (
    params.canLoadOlder &&
    !params.loadingOlder &&
    params.hasLoadHandler &&
    params.containerWidthPx >= CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX
  );
}

export function resolveConversationTurnNavigatorHydrationRetryDelayMs(
  failedAttemptCount: number,
): number | null {
  // 重试预算是固定两档：首次失败 250ms 后重试，第二次失败 1s 后重试，第三次起放弃。
  // 返回 null 表示终止，而不是返回一个很大的延迟，避免调用方继续排定时器。
  // [失败路径] 放弃后目录保持未水合且不抛错：水合只是提速手段，缺失时仍可按需
  // 加载，把失败升级成异常会让一次网络抖动拖垮整条会话视图。
  // [权衡] 不做长周期指数退避：failedAttemptCount 越大，持续重试会导致用户看到空目录的时间更久，两档
  // 已能覆盖冷启动竞态；更长的退避应由外层 useEffect 重新进入页面时再触发。
  if (failedAttemptCount === 1) return 250;
  if (failedAttemptCount === 2) return 1_000;
  return null;
}

const DEFAULT_MAX_PREVIEW_CHARS = 220;
const DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2;

// normalizePreviewParagraphs 只认空行切段，行内单个换行会被折叠成空格，消息里的软换行属于排版细节，
// 若也当段落，目录里会塞满只有一行的碎片。
// 每段再压缩连续空白并 trim，使预览长度可预测，避免制表符撑开布局。
// 空段在这里被丢弃，这正是返回数组可能为空的唯一来源。
// 上限先夹到不小于 1（Math.max(1, maxParagraphs)），传 0 或负数等价于只要一段，而不是一段都不要。
// [权衡] 先切段再截字符而非反过来：反过来会把最后一段截成半句，拼回单行后
// 看起来像正文缺字；当前顺序保证省略号一定落在完整段落之后。
function normalizePreviewParagraphs(text: string, maxParagraphs: number): string[] {
  return text
    .trim()
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxParagraphs));
}

function truncatePreview(text: string, maxChars: number): string {
  // 下限 8 保证「上限减 3 个字符」至少还剩 5 个字符，省略号不会吃掉全部内容。
  // [失败路径] 若上限小于 4，切片长度变负会得到近乎空串，界面上只剩省略号，
  // 用户无法分辨不同 query，因此必须夹住而不是信任调用方。
  // 未超长时原样返回，不补省略号，避免短预览被误读成「还有更多内容」。
  // 尾部 trimEnd 去掉截断留下的空白，防止省略号与文字之间出现空隙。
  const normalizedMaxChars = Math.max(8, maxChars);
  if (text.length <= normalizedMaxChars) {
    return text;
  }
  return `${text.slice(0, normalizedMaxChars - 3).trimEnd()}...`;
}

function buildPreviewText({
  texts,
  fallback,
  maxPreviewChars,
  maxPreviewParagraphs,
}: {
  texts: readonly string[];
  fallback: string;
  maxPreviewChars: number;
  maxPreviewParagraphs: number;
}): string {
  const paragraphs = normalizePreviewParagraphs(texts.join("\n\n"), maxPreviewParagraphs);
  if (paragraphs.length === 0) {
    return fallback;
  }
  return truncatePreview(paragraphs.join("\n"), maxPreviewChars);
}

function buildAssistantPreview(
  unit: ConversationTurnRenderUnit,
  options: Required<BuildConversationTurnNavigatorItemsOptions>,
): {
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
} {
  if (unit.assistantTextRows.length > 0) {
    return {
      assistantPreview: buildPreviewText({
        texts: unit.assistantTextRows.map((row) => row.text),
        fallback: options.assistantEmptyPreview,
        maxPreviewChars: options.maxPreviewChars,
        maxPreviewParagraphs: options.maxPreviewParagraphs,
      }),
      assistantPreviewKind: "text",
    };
  }

  if (unit.isRunning) {
    return {
      assistantPreview: options.assistantRunningPreview,
      assistantPreviewKind: "running",
    };
  }

  return {
    assistantPreview: options.assistantEmptyPreview,
    assistantPreviewKind: "empty",
  };
}

export function buildConversationTurnNavigatorItems(
  units: readonly ConversationTurnRenderUnit[],
  options: BuildConversationTurnNavigatorItemsOptions,
): ConversationTurnNavigatorItem[] {
  const resolvedOptions: Required<BuildConversationTurnNavigatorItemsOptions> = {
    ...options,
    maxPreviewChars: options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs:
      options.maxPreviewParagraphs ?? DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  };

  return units.flatMap((unit, unitIndex) => {
    // provider/store 的物理 role=user 还包含 background/goal/mailbox
    // 等系统上下文；目录代表用户主动 query，只能使用投影明确裁决的 realUser。
    const realUserInputs = unit.visibleUserInputs.filter(
      (row) => row.origin === "realUser",
    );
    // timelineOnly 单元代表只挂在时间线上、不占用户可见 query 的位置，直接跳过。
    // 过滤用 origin 严格等于 realUser，而不是物理 role：provider 与 store 的物理
    // user 行里还混着 background、goal、mailbox 等系统上下文，把它们当目录项会让
    // 用户看到自己从未输入过的内容。
    // 返回空数组而不是占位项，让 flatMap 直接摊平，避免下游过滤 undefined。
    // [权衡] 判定放在构建预览之前，是因为空目录项没有消费方，提前返回可省掉一次
    // 段落切分与截断（normalizePreviewParagraphs 与 truncatePreview 两次调用）。
    if (unit.timelineOnly || realUserInputs.length === 0) {
      return [];
    }

    // 导航项按 query 拆分，但 hover 的 assistant 摘要保持旧产品语义：
    // 取所属 product turn 的文本结果，不在 renderer 猜测 guide 回复分段。
    const { assistantPreview, assistantPreviewKind } = buildAssistantPreview(
      unit,
      resolvedOptions,
    );
    return realUserInputs.map((row, queryIndex) => ({
      // 不能以 product turn 为目录粒度，并把同一 turn 的 steer query
      // 全部拼进一个 preview。目录真正导航的是用户可见 query，必须用稳定 row
      // 身份逐条建项，turnId 只负责把虚拟列表先定位到所属容器。
      key: `${unit.key}:query:${row.entityId ?? row.rowId}`,
      turnId: unit.turnId,
      unitIndex,
      rowId: row.rowId,
      userPreview: buildPreviewText({
        texts: [row.text],
        fallback: resolvedOptions.userFallbackPreview,
        maxPreviewChars: resolvedOptions.maxPreviewChars,
        maxPreviewParagraphs: resolvedOptions.maxPreviewParagraphs,
      }),
      assistantPreview,
      assistantPreviewKind,
      // 同一 running product turn 可能已有多个已结束 guide segment；只有最后一条
      // query 仍代表当前工作，避免所有旧 query 一起呈现 running 强调。
      // 只有最后一条 query 继承 running 标记：同一 product turn 可能已经历多个
      // 已结束的 guide 片段，若全部标 running，用户会以为多个请求同时在跑。
      // [并发] 该判定只读 unit.isRunning 快照而不订阅运行态变化，因此构建完成后
      // 运行态翻转不会反映到已生成的目录项，需要重建才能刷新强调。
      // 依赖 realUserInputs 长度而不是 unit 内原始行数，是因为被过滤掉的系统上下文
      // 不应把 realUserInputs 的最后一条推到看不见的位置。
      isRunning: unit.isRunning && queryIndex === realUserInputs.length - 1,
    }));
  });
}

function resolveFiniteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function resolveConversationTurnNavigatorActiveUnitIndex({
  items,
  virtualItems,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveUnitIndexOptions): number | undefined {
  if (items.length === 0) {
    return undefined;
  }

  // 同一 unitIndex 会对应多条 query（steer 场景），Map 构造保留最后一条，反查
  // 活跃单元时以该单元最后一条 query 的位置为准，这与「最新 query 代表当前工作」
  // 的强调口径保持一致，itemByUnitIndex 反查到的就是该单元最后一条 query。
  // [权衡] 不改成 unitIndex 到数组的映射再二次选择：多一层结构会让距离比较
  // 退化为内层循环，而收益仅是更精细的边界语义，不值得为 unitIndex 建数组映射。
  // items 为空已提前返回，这里不会构造出空 Map 后被误用。
  const itemByUnitIndex = new Map(items.map((item) => [item.unitIndex, item]));
  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd =
    viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));

  let activeUnitIndex: number | undefined;
  let activeDistance = Number.POSITIVE_INFINITY;
  for (const virtualItem of virtualItems) {
    const item = itemByUnitIndex.get(virtualItem.index);
    if (!item) {
      continue;
    }
    const rowStart = resolveFiniteNonNegative(virtualItem.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(virtualItem.size));
    if (rowEnd < viewportStart || rowStart > viewportEnd) {
      continue;
    }
    const distanceToViewportStart =
      rowStart <= viewportStart ? 0 : rowStart - viewportStart;
    if (distanceToViewportStart < activeDistance) {
      activeUnitIndex = item.unitIndex;
      activeDistance = distanceToViewportStart;
    }
  }

  if (activeUnitIndex !== undefined) {
    return activeUnitIndex;
  }

  const topVirtualIndex = virtualItems.find((item) => {
    const rowStart = resolveFiniteNonNegative(item.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(item.size));
    return rowEnd >= viewportStart && rowStart <= viewportEnd;
  })?.index;
  if (topVirtualIndex === undefined) {
    return items[0]?.unitIndex;
  }

  return (
    items.find((item) => item.unitIndex >= topVirtualIndex)?.unitIndex ??
    items.findLast((item) => item.unitIndex <= topVirtualIndex)?.unitIndex ??
    items[0]?.unitIndex
  );
}

export function resolveConversationTurnNavigatorActiveQueryRowId({
  positions,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveQueryRowIdOptions): number | undefined {
  if (positions.length === 0) return undefined;

  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd =
    viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));
  const normalized = positions
    .map((position) => {
      const start = resolveFiniteNonNegative(position.start);
      return {
        rowId: position.rowId,
        start,
        end: Math.max(start, resolveFiniteNonNegative(position.end)),
      };
    })
    // 排序作用在 map 产物上，因此调用方传入的 positions 不会被就地改写。
    // 起点相同时用 rowId 升序兜底，保证同一输入得到确定顺序；否则比较对等值
    // 返回 0 会让结果依赖引擎的排序实现，活跃行在边界像素上跳变。
    // [权衡] rowId 兜底把平台差异压掉，代价是比较函数多一次减法。
    // 归一化已保证 end 不小于 start，所以比较只需看 start。
    // 比较只用减法与逻辑或，不依赖 locale，跨环境顺序一致。
    .sort((left, right) => left.start - right.start || left.rowId - right.rowId);

  const visible = normalized.filter(
    (position) => position.end >= viewportStart && position.start <= viewportEnd,
  );
  if (visible.length > 0) {
    return visible.reduce((nearest, candidate) =>
      Math.abs(candidate.start - viewportStart) <
      Math.abs(nearest.start - viewportStart)
        ? candidate
        : nearest,
    ).rowId;
  }

  return (
    normalized.findLast((position) => position.start <= viewportStart)?.rowId ??
    normalized.find((position) => position.start > viewportStart)?.rowId
  );
}

export function resolveConversationTurnNavigatorBarVisualState({
  itemIndex,
  visualFocusItemIndex,
}: ResolveConversationTurnNavigatorBarVisualStateOptions): ConversationTurnNavigatorBarVisualState {
  if (visualFocusItemIndex === undefined) {
    return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
  }

  const distance = Math.abs(itemIndex - visualFocusItemIndex);
  if (distance === 0) {
    return { colorTone: "focus", opacity: 1, scaleX: 2.6, tone: "peak" };
  }
  if (distance === 1) {
    return { colorTone: "muted", opacity: 0.86, scaleX: 1.7, tone: "near" };
  }
  if (distance === 2) {
    return { colorTone: "muted", opacity: 0.72, scaleX: 1.25, tone: "mid" };
  }
  return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
}

export function resolveConversationTurnNavigatorVisualFocusItemIndex({
  interactionItemIndex,
}: ResolveConversationTurnNavigatorVisualFocusItemIndexOptions): number | undefined {
  return interactionItemIndex;
}
