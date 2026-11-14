// INV-01 守住位置：查询归一化必须同时 trim 与 toLocaleLowerCase；改错故障：任一侧丢失都会让「大小写不敏感」退化成精确匹配，正文明明含词却报无结果。
// INV-02 守住位置：匹配偏移 start/end 取自小写化后的文本；改错故障：若改用原始文本偏移，含大写字形的片段会错位，高亮范围落到别的字符。
// INV-03 守住位置：大小写转换可能改变字符串长度（例如带点大写字母）；改错故障：偏移直接回喂原文高亮时会漂移，这是已知边界，不应在消费端再做二次换算。
// INV-04 守住位置：扫描为非重叠前进，searchStart 每次跳到 matchIndex 加查询长度；改错故障：改回加一前进会让「aa」在「aaa」里报出重叠命中，计数与上下条跳转全部虚高。
// INV-05 守住位置：globalIndex 取写入前的 matches 长度；改错故障：改为事后重算或按行重置，会让 globalIndex 与数组下标脱钩，按序号取 activeMatch 拿到错行。
// INV-06 守住位置：rowMatchIndex 每行独立从 0 递增；改错故障：若跨行累计，MatchKey 不再稳定，重算索引后同一命中会被定位成另一处。
// INV-07 守住位置：targets 的枚举顺序决定阅读顺序（unitIndex 递增，单元内先用户输入后助手文本）；改错故障：调换行类型顺序会让「下一处」在对话里来回跳。
// INV-08 守住位置：空查询走早返回，但仍回报 loadedRowCount；改错故障：直接返回零行会让 UI 把「未搜索」误显示成「尚未加载」。
// INV-09 守住位置：注释投影开关只认严格 true；改错故障：改成真值判断后，透传的 undefined 或非布尔对象会被当成开启，投影在非预期处生效。
// INV-10 守住位置：单元级注释投影仅在 running、complete、interrupted 三种最新助手状态下开启；改错故障：放宽到 pending 会按未收全的文本投影，用户搜到之后会消失的片段。
// INV-11 守住位置：逐行投影时把 streaming 状态透传给投影器；改错故障：丢失该标志会让流式行按已完成处理，代码注释剥离口径与渲染层不一致。
// INV-12 守住位置：用户输入行不做注释投影，直接使用原文；改错故障：一并投影会把用户自己写的代码注释当助手输出剥掉，命中数凭空减少。
// INV-13 守住位置：activeIndex 在 matchCount 大于零时越界回落 0 而非负一；改错故障：回落负一会让重算索引后高亮整段消失，用户以为搜索被清空。
// INV-14 守住位置：仅有零命中时才返回负一；改错故障：把负一也用于越界情形，消费端无法区分「没有结果」与「序号失效」。
// INV-15 守住位置：MatchKey 由 rowId、rowKind、rowMatchIndex 三元组构成；改错故障：加入 globalIndex 会让重算后 key 失效，加入 start 会随投影文本变化而漂移。
// INV-16 守住位置：按 key 查找必须三字段同时相等，缺失时返回负一；改错故障：只比 rowId 会命中同行的其它出现次数，滚动定位跳到错误片段。
// INV-17 守住位置：探针归一化去掉首尾省略号并压缩空白；改错故障：保留搜索结果的省略号会让片段永远不包含于正文，高亮只能退化到按序号取。
// INV-18 守住位置：探针为空时一律不命中；改错故障：允许空串做包含判断会让任意首行都被当成片段命中，跳转与高亮落在无关消息上。
//
// 模块职责：把会话渲染单元摊平成可搜索文本行，按归一化查询产出全局有序命中，并提供按稳定 key 与搜索片段回找命中位置的纯函数。
// 状态所有权：本模块无状态、无副作用，不缓存索引也不订阅 store；索引由调用方持有，单元变化时整体重建。
// 阅读顺序：类型契约 → 查询归一化 → 单元摊平与注释投影 → 全量扫描 → key 与 activeIndex 解析 → 搜索结果高亮兜底。
import type {
  AssistantTextRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { ChatSearchResultHighlightRequest } from "@/v4/legacyChatViewTypes.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import { projectAssistantCodeComments } from "@/lib/assistantCodeComment.js";

export type ConversationFindRowKind = "userInput" | "assistantText";

// 对外契约：每条命中同时给出全局序号、所属单元与行、行内第几次出现，以及归一化文本上的半开区间。
// 消费方据此做大跨度跳转、行级定位和片段高亮；三者缺一都会让 UI 只能退化成「下一条」线性翻页。
// sourceText 保留原文而不是小写副本，高亮时用它取切片，避免把用户文本按小写渲染。
// 不要在这里加去重或过滤逻辑，命中集合的完整性是计数、上下条与序号定位共同的前提。
export interface ConversationFindMatch {
  globalIndex: number;
  unitIndex: number;
  rowId: number;
  rowKind: ConversationFindRowKind;
  rowMatchIndex: number;
  start: number;
  end: number;
  sourceText: string;
}

// 索引是查询的完整结果快照，query 存归一化后的值，便于 UI 判断索引是否已过期。
// matchCount 必须与 matches 长度同步，调用方用前者做零命中短路，不同步就会在空数组上取越界。
// loadedRowCount 记录参与搜索的行数，用于区分「没有结果」与「还没有内容加载」。
// 这是纯数据，不要在构建之后原地改写 matches，任何变化都重新构建一份。
export interface ConversationFindIndex {
  query: string;
  matches: ConversationFindMatch[];
  matchCount: number;
  loadedRowCount: number;
}

export interface ConversationFindMatchKey {
  rowId: number;
  rowKind: ConversationFindRowKind;
  rowMatchIndex: number;
}

interface ConversationFindTarget {
  unitIndex: number;
  rowId: number;
  rowKind: ConversationFindRowKind;
  text: string;
}

// 归一化只在入口做一次，后续比较全部基于小写结果，避免每行重复转换。
// trim 让首尾空格不参与匹配，用户从别处粘贴带空格的词仍能命中。
// 使用 toLocaleLowerCase 而非 toLowerCase，跟随运行环境的语言规则处理带变音符的字符。
// 该函数同时被索引构建与输入框回显使用，改动会同时影响显示与匹配口径。
export function normalizeConversationFindQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

// 摊平单位是「一个渲染单元」：先收可见用户输入，再收助手文本行，顺序即阅读顺序。
// unitIndex 在这里定下来，之后所有命中的单元归属都来自这一次遍历，不要在扫描阶段重算。
// 只收 visibleUserInputs，隐藏或折叠的输入不参与搜索，避免跳转到用户看不到的内容。
// 投影开关由调用方传入，本函数不读全局状态，保证索引构建可重放。
// 该函数只追加不排序，targets 的稳定性直接决定 globalIndex 的语义。
function addTargetsForUnit(
  targets: ConversationFindTarget[],
  unit: ConversationTurnRenderUnit,
  unitIndex: number,
  projectCodeComments: boolean,
) {
  const latestAssistantState = unit.latestAssistantTextRow?.state;
  // 注释投影的前提是这个单元的最新助手状态已知且已收敛；running 也要允许，否则流式期间搜不到已显示文本。
  // pending 与其它状态一律不投影，此时可见文本仍会变化，投影结果不可信。
  // 必须看单元级最新状态而不是逐行状态，否则同一单元的多个助手行会得到不一致的投影口径。
  // 判断集中在这一处，新增状态时只改这里，避免两处条件漂移。
  const projectUnitCodeComments =
    projectCodeComments &&
    (unit.isRunning ||
      latestAssistantState === "complete" ||
      latestAssistantState === "interrupted");
  for (const row of unit.visibleUserInputs) {
    targets.push(createTarget(unitIndex, row));
  }
  // 助手文本行需要投影，因为界面展示的是剥离注释后的可见文本，搜索必须与所见一致。
  // streaming 标志按行状态传入，投影器据此决定未闭合的注释块如何处理。
  // 只替换 text，其余字段仍由目标构造函数生成，保证与用户输入行同构。
  // 这里不吞异常也不兜底空串，保持与渲染层同一套投影逻辑，避免两处结果分叉。
  for (const row of unit.assistantTextRows) {
    targets.push({
      ...createTarget(unitIndex, row),
      text:
        projectUnitCodeComments
          ? projectAssistantCodeComments(row.text, {
              streaming: row.state === "streaming",
            }).visibleText
          : row.text,
    });
  }
}

function createTarget(
  unitIndex: number,
  row: UserInputRow | AssistantTextRow,
): ConversationFindTarget {
  return {
    unitIndex,
    rowId: row.rowId,
    rowKind: row.kind,
    text: row.text,
  };
}

// 入口只做三件事：归一化查询、摊平目标、全量扫描，任一步失败都不应留下半成品索引。
// options 给默认空对象，调用方无需关心注释投影开关即可获得稳定行为。
// 返回的 query 是归一化值，调用方可用它对比输入框判断索引是否过期。
// 该函数是纯函数，不读 store、不打日志，便于在测试里直接断言命中集合。
export function buildConversationFindIndex(
  units: readonly ConversationTurnRenderUnit[],
  query: string,
  options: { projectAssistantCodeComments?: boolean } = {},
): ConversationFindIndex {
  const normalizedQuery = normalizeConversationFindQuery(query);
  const targets: ConversationFindTarget[] = [];
  units.forEach((unit, unitIndex) =>
    addTargetsForUnit(
      targets,
      unit,
      unitIndex,
      options.projectAssistantCodeComments === true,
    ),
  );

  // 空查询早返回，避免用空串做 indexOf 导致每行每个位置都被判为命中。
  // 早返回仍带上已摊平的行数，UI 才能区分「占位未输入」与「确实没有匹配」。
  // 返回空 matches 而非空引用，消费端不需要额外分支判断索引是否存在。
  // 这条早返回必须留在摊平之后，提前返回会丢掉 loadedRowCount。
  if (!normalizedQuery) {
    return {
      query: normalizedQuery,
      matches: [],
      matchCount: 0,
      loadedRowCount: targets.length,
    };
  }

  const matches: ConversationFindMatch[] = [];
  for (const target of targets) {
    const normalizedText = target.text.toLocaleLowerCase();
    let searchStart = 0;
    let rowMatchIndex = 0;
    // 循环逐次前进，indexOf 找不到即结束当前行，不会把命中串到下一行。
    // 前进量是查询长度，保证同一位置只报一次，避免重叠命中把计数翻倍。
    // 查询非空由外层早返回保证，这里不再判空；若外层放开，空查询会导致死循环。
    // 行内计数 rowMatchIndex 与全局序号分开维护，两者语义不同，不能合并。
    while (searchStart < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(normalizedQuery, searchStart);
      if (matchIndex === -1) {
        break;
      }
      matches.push({
        globalIndex: matches.length,
        unitIndex: target.unitIndex,
        rowId: target.rowId,
        rowKind: target.rowKind,
        rowMatchIndex,
        start: matchIndex,
        end: matchIndex + normalizedQuery.length,
        sourceText: target.text,
      });
      rowMatchIndex += 1;
      searchStart = matchIndex + normalizedQuery.length;
    }
  }

  return {
    query: normalizedQuery,
    matches,
    matchCount: matches.length,
    loadedRowCount: targets.length,
  };
}

export function getConversationFindMatchKey(
  match: ConversationFindMatch | null | undefined,
): ConversationFindMatchKey | null {
  if (!match) {
    return null;
  }
  return {
    rowId: match.rowId,
    rowKind: match.rowKind,
    rowMatchIndex: match.rowMatchIndex,
  };
}

export function findConversationMatchIndexByKey(
  index: ConversationFindIndex,
  key: ConversationFindMatchKey | null | undefined,
): number {
  if (!key) {
    return -1;
  }
  return index.matches.findIndex(
    (match) =>
      match.rowId === key.rowId &&
      match.rowKind === key.rowKind &&
      match.rowMatchIndex === key.rowMatchIndex,
  );
}

export function resolveConversationFindActiveIndex(
  index: ConversationFindIndex,
  preferredIndex: number,
): number {
  if (index.matchCount === 0) {
    return -1;
  }
  if (preferredIndex >= 0 && preferredIndex < index.matchCount) {
    return preferredIndex;
  }
  return 0;
}

export function resolveConversationFindActiveMatch(
  index: ConversationFindIndex,
  preferredIndex: number,
): ConversationFindMatch | null {
  const activeIndex = resolveConversationFindActiveIndex(index, preferredIndex);
  return activeIndex >= 0 ? (index.matches[activeIndex] ?? null) : null;
}

function normalizeSearchResultProbeText(text: string): string {
  return text.replace(/^\.{3}/, "").replace(/\.{3}$/, "").replace(/\s+/g, " ").trim();
}

function includesProbe(sourceText: string, probe: string): boolean {
  const normalizedSource = normalizeSearchResultProbeText(sourceText).toLocaleLowerCase();
  const normalizedProbe = normalizeSearchResultProbeText(probe).toLocaleLowerCase();
  return normalizedProbe.length > 0 && normalizedSource.includes(normalizedProbe);
}

// 这是从搜索结果跳到会话内的兜底入口，优先按片段文本匹配，失败再退回序号。
// 片段先 trim，空白片段视为无片段，避免空串参与包含判断。
// snippetIndex 缺省为 0，越界时再退到首条，保证只要有命中就一定能返回一条。
// 返回空值只在零命中时出现，调用方据此决定是否提示「无可定位内容」。
export function resolveSearchResultHighlightMatch(
  index: ConversationFindIndex,
  request: ChatSearchResultHighlightRequest,
): ConversationFindMatch | null {
  if (index.matchCount === 0) {
    return null;
  }

  const snippet = request.snippet?.trim();
  if (snippet) {
    const snippetMatch = index.matches.find((match) =>
      includesProbe(match.sourceText, snippet),
    );
    if (snippetMatch) {
      return snippetMatch;
    }
  }

  const preferredIndex = request.snippetIndex ?? 0;
  return index.matches[preferredIndex] ?? index.matches[0] ?? null;
}
