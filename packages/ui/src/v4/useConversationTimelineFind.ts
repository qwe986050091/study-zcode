// 职责：把「会话时间线查找」的索引、激活项、滚动、高亮与自动补齐编排成一组 React 副作用。
// 边界：只做调度与幂等保护；文本抽取与匹配算法在 conversationFindIndex，DOM 包裹在 conversationFindHighlightDom。
// 不负责：查找栏的输入状态、快捷键、结果面板渲染，也不决定用户从哪条跳到哪条（由外部 activeIndex 表达意图）。
//
// INV-01 断言：query 先 trim 再小写，缓存分代键与之一致 —— 守住它的位置：conversationFindIndex 的 useMemo 开头与 unitFindCacheQueryRef 比较 —— 改错故障：仅改变大小写或首尾空白时缓存不失效，高亮落到旧匹配上
// INV-02 断言：running turn 永不写入缓存 —— 守住它的位置：const cached = !unit.isRunning 处的三元判断 —— 改错故障：流式期间的半截文本被固化成复用结果，流结束后命中凭空消失
// INV-03 断言：globalIndex 必须等于扁平化后的数组下标 —— 守住它的位置：遍历 matches 时用当前 matches.length —— 改错故障：外部 activeIndex 指向错误条目，点下一条跳到无关消息
// INV-04 断言：findStable 为假时高亮写入与自动补齐全部停摆 —— 守住它的位置：findStable 计算以及各 effect 的早退条件 —— 改错故障：会话运行中高亮随 delta 漂移，并连锁触发历史补齐
// INV-05 断言：matchCount 恒等于 matches.length —— 守住它的位置：useMemo 返回对象的 matchCount 字段 —— 改错故障：查找栏显示的总数比实际可跳转条目多，最后几条点不到
// INV-06 断言：空 query 复位高亮、激活项与滚动键，但保留索引缓存 —— 守住它的位置：首个 effect 的空查询分支 —— 改错故障：清空输入后旧高亮残留，重新输入又要全量重扫
// INV-07 断言：激活项以匹配 key 重新基准化，不持久化裸下标 —— 守住它的位置：findConversationMatchIndexByKey 分支 —— 改错故障：补齐历史后同一下标指向别处文字，跳转错位
// INV-08 断言：外部激活下标变化优先于内部重基准 —— 守住它的位置：queryChanged 与 externalActiveIndexChanged 的判定 —— 改错故障：用户点下一条被重基准覆盖，按钮看起来失灵
// INV-09 断言：查找补齐以 query 加首行 id 加行数做幂等键 —— 守住它的位置：lastFindAutoLoadAttemptRef 的占位 —— 改错故障：一次失败后 effect 重入反复请求，形成无限加载
// INV-10 断言：自动补齐不得越过 1200 行上限 —— 守住它的位置：rows.length >= FIND_AUTO_LOAD_ROW_LIMIT 的早退 —— 改错故障：超长会话一次性拉全量历史，内存与首帧渲染同时失控
// INV-11 断言：查找滚动键包含 query 与匹配三元组 —— 守住它的位置：lastFindScrollKeyRef 的比较 —— 改错故障：换词后不滚动，或同一匹配每次渲染都重滚导致视口抖动
// INV-12 断言：高亮滚动只在导航请求号变化时触发 —— 守住它的位置：lastFindHighlightScrollKeyRef 的比较 —— 改错故障：每敲一个字符就强制滚动，用户正在读的位置被抢走
// INV-13 断言：高亮写入包在 rAF 内并在卸载时取消 —— 守住它的位置：高亮 effect 返回的取消函数 —— 改错故障：切会话后操作已卸载节点，抛 NotFoundError 且高亮丢失
// INV-14 断言：同一 requestId 的搜索结果只应用一次 —— 守住它的位置：searchResultAppliedRequestRef 的比较 —— 改错故障：同一条结果反复闪烁，完成回调被重复发出
// INV-15 断言：三秒清理计时器在重入前必须先清除 —— 守住它的位置：searchResultCleanupTimerRef 的两处写入点 —— 改错故障：旧计时器抹掉新结果的高亮，完成回调提前触发
// INV-16 断言：片段未命中且仍可继续加载时必须提前返回 —— 守住它的位置：snippet 与 canStillLoad 的组合分支 —— 改错故障：目标就在未加载的历史里，却提前报告未找到并停止补齐
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationRow,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import {
  applyConversationFindHighlights,
  applySearchResultHighlight,
  clearConversationFindHighlights,
  clearSearchResultHighlight,
  scrollConversationFindRangeIntoView,
} from "@/v4/conversationFindHighlightDom.js";
import {
  buildConversationFindIndex,
  findConversationMatchIndexByKey,
  getConversationFindMatchKey,
  resolveConversationFindActiveIndex,
  resolveSearchResultHighlightMatch,
  type ConversationFindMatch,
  type ConversationFindMatchKey,
} from "@/v4/conversationFindIndex.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";

// [权衡] 1200 是自动补齐的止步线：命中仍会继续向后找，但绝不把整段超长历史一次性拉进渲染树
// 抬高它，万行会话会多跑十几轮补齐且每轮重建 renderUnits；压低它，大量命中落在未加载区间，查找表现为找不到
// [契约] 3000 只决定搜索结果高亮的视觉寿命，与索引、命中数、自动补齐完全无关，别拿它当超时兜底
// 两个数都按行数而非字节计量，改口径会让上限在长短消息混杂的会话里失去意义
const FIND_AUTO_LOAD_ROW_LIMIT = 1200;
const SEARCH_RESULT_HIGHLIGHT_DURATION_MS = 3000;

// [契约] scrollToUnit 必须是稳定引用：它进入多个 effect 的依赖数组，父组件每次渲染新建闭包会让滚动与高亮反复重跑
// [契约] renderUnits 与 rows 是两个粒度的事实来源：前者决定命中与滚动目标，后者只用于判断还能否继续加载
// onConversationFindMatchStateChange 只上报计数与激活下标，不承担受控回写；父组件据此渲染第几条，不能反过来驱动查找
// mountedRowsKey 只作为 DOM 已换一批的信号进入依赖，不要在其中塞可变计数器，否则高亮会被无谓重刷
export interface UseConversationTimelineFindOptions {
  rootRef: React.RefObject<HTMLElement | null>;
  renderUnits: readonly ConversationTurnRenderUnit[];
  rows: readonly ConversationRow[];
  mountedRowsKey: string;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => Promise<void> | void;
  sessionPhase?: SessionPhase;
  conversationFindQuery: string;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  scrollToUnit: (unitIndex: number) => void;
}

// [契约] 搜索结果片段两侧的省略号与折行空白必须先抹平再比对，否则跨行命中会被判成没找到
// 只做归一化不做大小写折叠：大小写由调用方在比对时统一小写，避免这里改变原文语义
// 不要在这里加全角半角或标点折叠，那会让片段比对与索引匹配使用两套口径，出现索引有而贴片无的分裂
function normalizeSearchResultSnippet(text: string): string {
  return text.replace(/^\.{3}/, "").replace(/\.{3}$/, "").replace(/\s+/g, " ").trim();
}

// [权衡] 用 includes 而不是精确相等：贴片是后端截断过的，只保证是原文的子串
// 空片段直接判假：调用方用有片段来区分按片段定位与按数量判断是否加载完，空串返回真会让自动补齐永不触发
// 比对双方都走同一个归一化函数，任何一侧单独改规则都会让跨行消息稳定漏判
function sourceTextContainsSnippet(sourceText: string, snippet: string): boolean {
  const normalizedSnippet = normalizeSearchResultSnippet(snippet).toLocaleLowerCase();
  if (!normalizedSnippet) {
    return false;
  }
  return normalizeSearchResultSnippet(sourceText)
    .toLocaleLowerCase()
    .includes(normalizedSnippet);
}

export function useConversationTimelineFind({
  rootRef,
  renderUnits,
  rows,
  mountedRowsKey,
  canLoadOlder,
  loadingOlder,
  onLoadOlder,
  sessionPhase,
  conversationFindQuery,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  scrollToUnit,
}: UseConversationTimelineFindOptions) {
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const findStable = sessionPhase !== "running" && sessionPhase !== "prewarming";
  // [资源] 缓存键由归一化 query、代码注释开关与 unit.key 组成，只在 query 变化时整体清空，条目数随会话增长
  // 不要在每次匹配后删除单条缓存：稳定 turn 的缓存条目正是省掉全量重扫的依据，删掉等于退回逐 token 扫描
  // 缓存里只放匹配数组与加载行数，不放 DOM 节点或 range，否则会话切换后会随实例泄漏
  const unitFindCacheRef = useRef(
    new Map<string, { source: ConversationFindMatch[]; loadedRowCount: number }>(),
  );
  const unitFindCacheQueryRef = useRef("");
  // [并发] 这里是查找的唯一真相源：流式 delta 会让本 memo 重算，但稳定 turn 走缓存，成本与 running turn 数量成正比
  // [契约] 依赖只放开关、query 与 renderUnits；把 rows 或 sessionPhase 加进来会在补齐历史时额外触发整轮索引
  // 匹配顺序即跳转顺序：先按 renderUnits 顺序再按单元内顺序，改动遍历顺序会直接改变下一条的落点
  // [失败路径] 单个 unit 建索引抛错会让整轮放弃并停在旧结果，不要在这里吞异常返回空数组，那会被上层当成确实没有命中
  const conversationFindIndex = useMemo(
    () => {
      const query = conversationFindQuery;
      const normalizedQuery = query.trim().toLocaleLowerCase();
      if (unitFindCacheQueryRef.current !== normalizedQuery) {
        unitFindCacheRef.current.clear();
        unitFindCacheQueryRef.current = normalizedQuery;
      }
      const matches: ConversationFindMatch[] = [];
      let loadedRowCount = 0;
      // 修复原因：streaming delta 只会改变当前 running turn；稳定 turn 的全文索引可复用，
      // 避免每个 token 都扫描整段历史，导致长会话 renderer 主线程被持续占满。
      renderUnits.forEach((unit, unitIndex) => {
        // [契约] 键里必须带开关位：开关切换会改变投影文本，只按 query 命中会复用旧投影的匹配
        // unit.key 是身份而不是下标，用它做键才能在补齐历史后仍命中同一条缓存
        // [权衡] 键字符串每次匹配都要拼一次，仍比重复建索引便宜；为省这点拼接改成嵌套 Map 会让读写复杂度反升
        const cacheKey = `${normalizedQuery}:${codeCommentCardsEnabled}:${unit.key}`;
        const cached = !unit.isRunning ? unitFindCacheRef.current.get(cacheKey) : undefined;
        const unitIndexResult = cached
          ? { matches: cached.source, loadedRowCount: cached.loadedRowCount }
          : buildConversationFindIndex([unit], query, {
              projectAssistantCodeComments: codeCommentCardsEnabled,
            });
        // [并发] 只给稳定 turn 写缓存：running turn 的文本每个 delta 都变，写进去会把半截内容固化成后续复用的结果
        // 首次未命中也算有效结果并照样写缓存，否则空匹配的单元每次重算，长会话里这项会变成主要开销
        // 写缓存与累加行数必须成对：只写不累加会让补齐上限判断失真，只累加不写会让缓存永远是空的
        if (!unit.isRunning && !cached) {
          unitFindCacheRef.current.set(cacheKey, {
            source: unitIndexResult.matches,
            loadedRowCount: unitIndexResult.loadedRowCount,
          });
        }
        loadedRowCount += unitIndexResult.loadedRowCount;
        // [契约] globalIndex 必须取累加前的 matches.length，它就是扁平化后的数组下标，外部激活下标完全依赖这一点
        // 展开匹配时不要覆盖 unitIndex：单元序号用于滚动定位，被内部字段顶掉会滚到错误 turn
        // 这里的 push 顺序就是用户按下一条的顺序，任何按 rowId 之类的重排都会让跳转看起来无序
        for (const match of unitIndexResult.matches) {
          matches.push({ ...match, globalIndex: matches.length, unitIndex });
        }
      });
      // [契约] matchCount 恒等于 matches.length，不要另开计数器：两者漂移时查找栏会显示一个点不到的总数
      // 返回的 query 是归一化后的值，上层用它判断查询是否真的变了，不要在这里回填原始输入
      // loadedRowCount 是各单元求和，仅用于诊断与预算观察，不参与任何拦截判断
      return { query: normalizedQuery, matches, matchCount: matches.length, loadedRowCount };
    },
    [codeCommentCardsEnabled, conversationFindQuery, renderUnits],
  );
  // [权衡] 没有请求或会话不稳定时返回空索引而不是空值：调用方可以无条件读 matches，少一层判空
  // 这是搜索结果定位专用的第二份索引，与查找索引互不复用：两者 query 不同，合并会让缓存键失去意义
  // [契约] findStable 为假时不建索引，避免运行中把半截文本当成定位依据
  // 空索引用空 renderUnits 与空 query 构造，别改成手写字面量，字段缺失会在下游静默变成未定义
  const searchResultFindIndex = useMemo(
    () =>
      findStable && searchResultHighlightRequest
        ? buildConversationFindIndex(renderUnits, searchResultHighlightRequest.query, {
            projectAssistantCodeComments: codeCommentCardsEnabled,
          })
        : buildConversationFindIndex([], ""),
    [codeCommentCardsEnabled, findStable, renderUnits, searchResultHighlightRequest],
  );
  // [契约] -1 是「没有激活项」的唯一表示，不要用 0 兼顾无：0 是合法匹配，混用会让首条命中永远显示为未激活
  // 外部传入的 conversationFindActiveIndex 与这里的内部值不是同一个东西：外部是意图，这里是重基准后的结果
  // 不要在渲染期直接改这个 state，所有写入都放在首个 effect 内，保证同一次提交里状态与 ref 同步
  // 初值必须是 -1 而不是 0，否则挂载瞬间就会把第一条命中当成激活项并触发滚动
  const [resolvedFindActiveIndex, setResolvedFindActiveIndex] = useState(-1);
  const findActiveKeyRef = useRef<ConversationFindMatchKey | null>(null);
  const lastFindQueryRef = useRef("");
  const lastExternalActiveIndexRef = useRef(conversationFindActiveIndex);
  const lastFindScrollKeyRef = useRef("");
  const lastFindHighlightScrollKeyRef = useRef("");
  const lastFindAutoLoadAttemptRef = useRef("");
  const lastSearchResultAutoLoadAttemptRef = useRef("");
  const searchResultAppliedRequestRef = useRef<number | null>(null);
  const searchResultScrollRequestRef = useRef<number | null>(null);
  const searchResultCleanupTimerRef = useRef<number | undefined>(undefined);
  const activeFindMatch =
    resolvedFindActiveIndex >= 0
      ? (conversationFindIndex.matches[resolvedFindActiveIndex] ?? null)
      : null;

  useEffect(() => {
    // [失败路径] 空 query 是一次完整复位：清高亮、清激活、清滚动键并把计数上报为 0，缺任何一项都会留下上次查找的残影
    // 这里刻意不清 unitFindCacheRef：清空输入再输入同样内容时可直接复用稳定 turn 的索引
    // 上报 0 条必须放在清高亮之后，顺序反过来会让查找栏先闪一下旧计数
    // 该分支必须早退，不能让后面的重基准逻辑接管：空查询下 matches 为空，走重基准只会多触发一次上报
    if (!conversationFindIndex.query) {
      findActiveKeyRef.current = null;
      lastFindQueryRef.current = "";
      lastFindScrollKeyRef.current = "";
      lastFindHighlightScrollKeyRef.current = "";
      setResolvedFindActiveIndex(-1);
      clearConversationFindHighlights();
      onConversationFindMatchStateChange?.({ matchCount: 0, activeIndex: -1 });
      return;
    }

    const queryChanged = lastFindQueryRef.current !== conversationFindIndex.query;
    const externalActiveIndexChanged =
      lastExternalActiveIndexRef.current !== conversationFindActiveIndex;
    let nextActiveIndex = resolveConversationFindActiveIndex(
      conversationFindIndex,
      conversationFindActiveIndex,
    );

    // [契约] 只有查询与外部激活下标都没变时才做 key 重基准：补齐历史会让下标整体后移，此时靠 key 找回同一条
    // 两者任一变化都说明是新的意图（换词或点下一条），必须让解析函数重新裁决，不能被旧 key 拉回去
    // 重基准失败时保留解析结果，不要回退到 0，否则用户会突然跳到第一条
    // [失败路径] 这段判断依赖 lastFindQueryRef 与 lastExternalActiveIndexRef 的写入时机，两处更新必须紧跟在本段之后
    if (!queryChanged && !externalActiveIndexChanged) {
      const rebasedIndex = findConversationMatchIndexByKey(
        conversationFindIndex,
        findActiveKeyRef.current,
      );
      if (rebasedIndex >= 0) {
        nextActiveIndex = rebasedIndex;
      }
    }

    const activeMatch =
      nextActiveIndex >= 0 ? (conversationFindIndex.matches[nextActiveIndex] ?? null) : null;
    // [契约] 记录的是 key 而不是下标：下标随历史补齐漂移，key 由 rowId、行内序号与单元序号组成，跨更新稳定
    // activeMatch 为空时 key 写成空值，这是合法的无激活状态，不要跳过写入，否则下一次重基准会拿旧 key 误定位
    // 同时刷新 query 与外部下标快照，二者是下一轮重基准的输入，漏写一项会让下一轮误判为意图变了
    findActiveKeyRef.current = getConversationFindMatchKey(activeMatch);
    lastFindQueryRef.current = conversationFindIndex.query;
    lastExternalActiveIndexRef.current = nextActiveIndex;
    setResolvedFindActiveIndex(nextActiveIndex);
    onConversationFindMatchStateChange?.({
      matchCount: conversationFindIndex.matchCount,
      activeIndex: nextActiveIndex,
    });
  }, [
    conversationFindActiveIndex,
    conversationFindIndex,
    onConversationFindMatchStateChange,
  ]);

  useEffect(() => {
    if (
      !findStable ||
      !conversationFindIndex.query ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    // [并发] 幂等键由 query、当前首行 id 与行数组成：三者任一变化才允许再发一次补齐，等价于换查询或历史确实变长了
    // [失败路径] 先记键再发起加载：加载失败时键已占位，effect 重入不会立刻重试，避免失败场景下的无限请求
    // 代价是一次失败后要等首行或行数变化才重试，这是刻意取舍；改成失败即清键会让超长会话在断网时打满加载队列
    // 不要把 loadingOlder 编进键：它本来就在早退条件里，编进键会让每次加载结束都产生新键，幂等立刻失效
    // 调用方必须先做稳定态与上限判断再算键，否则键会被正常查找以外的场景污染
    const attemptKey = `${conversationFindIndex.query}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
    if (lastFindAutoLoadAttemptRef.current === attemptKey) {
      return;
    }
    lastFindAutoLoadAttemptRef.current = attemptKey;
    void onLoadOlder?.();
  }, [
    canLoadOlder,
    conversationFindIndex.query,
    findStable,
    loadingOlder,
    onLoadOlder,
    rows,
  ]);

  useEffect(() => {
    if (!conversationFindIndex.query || !activeFindMatch) {
      return;
    }
    // [契约] 滚动键含 query 与匹配三元组：同一 query 下换激活项要滚，换 query 后即便落在同一行也要滚
    // 键相同就早退，是为了挡住父组件重渲染引发的重复滚动；去掉早退会在流式结束后反复拉扯视口
    // 这里只滚到单元，不负责把命中文字对齐到视口：精确对齐由高亮 effect 里的 range 滚动完成
    // [权衡] 两个滚动入口并存看似重复，但一个跟激活项走、一个跟导航请求走，合并会让已在该行时点下一条失去反馈
    const scrollKey = `${conversationFindIndex.query}:${activeFindMatch.rowId}:${activeFindMatch.rowMatchIndex}:${activeFindMatch.unitIndex}`;
    if (lastFindScrollKeyRef.current === scrollKey) {
      return;
    }
    lastFindScrollKeyRef.current = scrollKey;
    scrollToUnit(activeFindMatch.unitIndex);
  }, [activeFindMatch, conversationFindIndex.query, scrollToUnit]);

  useEffect(() => {
    // [资源] root 为空或没有查询时必须先清高亮再退出：上一次查找包裹的标记不会自己消失
    // 不要在这里读稳定态：本 effect 负责把已有结果画上去，运行中仍要显示缓存结果的高亮
    // root 在挂载前为空，第一次执行会走清空分支，这是正常的，不要改成提前返回来漏掉清理
    // mountedRowsKey 在依赖里是为了 DOM 换批后重新包裹；它变化时旧标记已随节点销毁，无需额外清理
    const root = rootRef.current;
    if (!root || !conversationFindIndex.query) {
      clearConversationFindHighlights();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const activeRange = applyConversationFindHighlights({
        root,
        query: conversationFindQuery,
        matches: conversationFindIndex.matches,
        activeMatch: activeFindMatch,
      });
      const highlightScrollKey = `${conversationFindNavigationRequestId}:${conversationFindIndex.query}:${activeFindMatch?.rowId ?? "none"}:${activeFindMatch?.rowMatchIndex ?? -1}:${activeFindMatch?.unitIndex ?? -1}`;
      if (activeRange && lastFindHighlightScrollKeyRef.current !== highlightScrollKey) {
        lastFindHighlightScrollKeyRef.current = highlightScrollKey;
        scrollConversationFindRangeIntoView(activeRange);
      }
    });

    // [资源] 每次执行都新建一帧回调，必须在清理函数里取消：会话切换时旧回调会对着已卸载的 root 写标记
    // 不要改成同步执行以减少一帧延迟：同步写入会与 React 提交阶段撞车，在渲染中途修改 DOM
    // 取消的是本帧句柄而不是全局队列，任何复用同一个 ref 保存句柄的改动都会让两次执行互相取消
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeFindMatch,
    conversationFindIndex,
    conversationFindQuery,
    conversationFindNavigationRequestId,
    mountedRowsKey,
    rootRef,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (
      !request ||
      !findStable ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    const snippet = request.snippet?.trim();
    // [失败路径] 有片段时按片段是否已出现在现有匹配文本里判断，而不是按匹配数：贴片可能被折行或省略号截断
    // 无片段时退化为一条都没匹配到，这是唯一可用的信号，不要在这种情况下直接判定失败并回调完成
    // 判断只看已建好的搜索结果索引，不重新扫描 DOM，否则每次补齐都要重排整棵树
    // 结果为假就什么都不做，保持已就绪状态，避免无意义的加载请求抖动
    const shouldLoadMore = snippet
      ? !searchResultFindIndex.matches.some((match) =>
          sourceTextContainsSnippet(match.sourceText, snippet),
        )
      : searchResultFindIndex.matchCount === 0;
    if (shouldLoadMore) {
      const attemptKey = `${request.requestId}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
      if (lastSearchResultAutoLoadAttemptRef.current === attemptKey) {
        return;
      }
      lastSearchResultAutoLoadAttemptRef.current = attemptKey;
      void onLoadOlder?.();
    }
  }, [
    canLoadOlder,
    findStable,
    loadingOlder,
    onLoadOlder,
    rows,
    searchResultFindIndex,
    searchResultHighlightRequest,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (!request || !findStable) {
      clearSearchResultHighlight();
      searchResultAppliedRequestRef.current = null;
      searchResultScrollRequestRef.current = null;
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
        searchResultCleanupTimerRef.current = undefined;
      }
      return;
    }

    const match = resolveSearchResultHighlightMatch(searchResultFindIndex, request);
    const snippet = request.snippet?.trim();
    const snippetFound = snippet
      ? searchResultFindIndex.matches.some((candidate) =>
          sourceTextContainsSnippet(candidate.sourceText, snippet),
        )
      : true;
    const canStillLoad =
      canLoadOlder && rows.length < FIND_AUTO_LOAD_ROW_LIMIT && !loadingOlder;
    // [失败路径] 片段没命中但还能继续加载时必须静默返回：目标可能在更早的历史里，此时既不能画高亮也不能报告完成
    // 条件里带上 loadingOlder：加载进行中同样要等，否则会在中途判定找不到并把请求提前收尾
    // 返回不代表放弃，后续会在索引更新后重新裁决；不要在返回前清理 refs，那会丢掉已应用标记
    // 只有确实无法继续加载且片段不存在时才落到下面的完成回调，这一分支是真找不到的唯一出口
    if (snippet && !snippetFound && (canStillLoad || loadingOlder)) {
      return;
    }
    if (!match) {
      if (!canStillLoad) {
        onSearchResultHighlightDone?.(request.requestId);
      }
      return;
    }

    // [契约] 用请求号而不是匹配对象判断是否需要滚动：同一条匹配可能被同一请求重复解析，但只应滚一次
    // 先进 ref 再滚动，保证滚动本身抛错也不会让下一次执行重复滚动
    // 滚动目标来自匹配的 unitIndex，不要用视口里的第一个命中替代，那会在多单元命中时跳错位置
    if (searchResultScrollRequestRef.current !== request.requestId) {
      searchResultScrollRequestRef.current = request.requestId;
      scrollToUnit(match.unitIndex);
    }

    // [并发] 同一请求号只应用一次高亮：索引抖动会让本 effect 重跑，重复应用会叠加包裹节点并让清理漏掉内层
    // 早退放在滚动之后，是为了让已应用但视口被用户移走的情况仍能滚回目标
    // 清除 ref 的时机只在请求变化或会话不稳定时，不要在新请求进来前就清，否则同一请求会二次应用
    // [失败路径] 若帧回调里拿不到 root 会直接返回且不写 ref，下一轮会重试，这是刻意的重试语义
    if (searchResultAppliedRequestRef.current === request.requestId) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      const range = applySearchResultHighlight({
        root,
        query: request.query,
        match,
      });
      if (!range) {
        return;
      }
      searchResultAppliedRequestRef.current = request.requestId;
      scrollConversationFindRangeIntoView(range);
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
      }
      // [资源] 定时器句柄必须重置前先清除：同一请求重入时若不清，旧的三秒计时会把新高亮提前抹掉
      // 回调里先清高亮再回调完成，顺序反了会让父组件以为已完成但界面仍有标记
      // 回调末尾把句柄置空，供卸载与下次重入判断是否还有待清理的计时器
      // 不要在定时器里读状态或匹配数组：三秒后索引可能已经换了，只做无条件的视觉清理
      // [权衡] 固定三秒不做可配置：可配置会让不同入口传入不同时长，导致清理时机不可预测
      searchResultCleanupTimerRef.current = window.setTimeout(() => {
        clearSearchResultHighlight();
        onSearchResultHighlightDone?.(request.requestId);
        searchResultCleanupTimerRef.current = undefined;
      }, SEARCH_RESULT_HIGHLIGHT_DURATION_MS);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    canLoadOlder,
    findStable,
    loadingOlder,
    mountedRowsKey,
    onSearchResultHighlightDone,
    rootRef,
    rows,
    scrollToUnit,
    searchResultFindIndex,
    searchResultHighlightRequest,
  ]);

  useEffect(() => {
    // [资源] 卸载清理必须同时覆盖查找高亮、搜索高亮与待执行的计时器，漏掉任一项都会在下次挂载时被旧标记污染
    // 依赖数组为空是刻意的：这里只捕获取消函数，不追踪任何会变化的引用
    // 不要在这里清缓存 Map，它随组件实例一起被回收，手动清反而会与仍在进行的索引计算竞争
    return () => {
      clearConversationFindHighlights();
      clearSearchResultHighlight();
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
      }
    };
  }, []);
}
