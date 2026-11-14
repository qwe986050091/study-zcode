/* oxlint-disable eslint(max-lines) -- 提示面板集中承载虚拟列表和 E2E 定位属性，暂不为少量测试属性拆组件。 */
// MentionPanel.tsx — 提示面板的虚拟列表投影：分组扁平化、行高估算、选中项跟随、滚动遮罩
//
// 职责边界
//   拥有：sections 到虚拟行（分组标题 / 状态行 / 选项行）的扁平化与 flatOptionIndex 分配、
//         行高估算（选项 34 / 分组标题 34 / 状态 40）、overscan 8 的窗口渲染、
//         选中项 scrollToIndex 跟随、上下滚动遮罩、空结果与无查询的降级文案、选项禁用态与 hover。
//   不拥有：候选查询本身、查询序号与过期响应丢弃、键盘事件与 selectedIndex 推进、禁用项跳过规则、
//           各分组 emptyText / loadingText / errorText 的内容。
//   边界：纯受控视图 —— selectedIndex、hasActiveQuery、sections 全部来自上层；
//         自身只持有 hoveredOptionIndex 与 scrollMaskState 两个局部状态，不发起任何请求。
//   依赖：@tanstack/react-virtual、lucide-react 图标、@zcode/shared/test-ids、scrollMask 工具。
//
// INV（不变量）—— 任一条被破坏都会表现为高亮错位、滚动跳变或点击选中错项
// INV-01 断言：flatOptionIndex 必须按选项出现顺序连续递增且只在 option 行分配 —— 守住它的位置：buildVirtualRows 末尾的 flatOptionIndex += 1 —— 改错故障：键盘下标与 data-option-index 错位，回车插入错项
// INV-02 断言：同一分组同一时刻只能产出一类状态行，优先级 error > loading > empty —— 守住它的位置：buildVirtualRows 的 if / else if 链 —— 改错故障：错误行与空态行同时上屏
// INV-03 断言：分组标题行与状态行不得占用 flatOptionIndex —— 守住它的位置：仅 option 分支自增 —— 改错故障：selectedIndex 指向不存在的选项，高亮整段消失
// INV-04 断言：单分组且未置 showHeader 时不渲染分组标题 —— 守住它的位置：shouldRenderSectionHeader —— 改错故障：单项列表顶部多出一行空标题
// INV-05 断言：虚拟行顺序必须与 sections 顺序一致 —— 守住它的位置：外层 for...of 的串行产出 —— 改错故障：跨分组上下键跳序
// INV-06 断言：窗口内的行 key 必须来自 virtualItem.key —— 守住它的位置：map 渲染的 key —— 改错故障：滚动复用错行组件，hover 背景残留在别的选项上
// INV-07 断言：estimateSize 必须与实际可见行高常量一致 —— 守住它的位置：estimateSize 的三元表达式 —— 改错故障：滚动位置漂移，行间重叠或露底
// INV-08 断言：selectedVirtualIndex 只能在 option 行匹配 —— 守住它的位置：findIndex 的 kind 判断 —— 改错故障：数值相同的标题行被当作选中项，滚动跳到标题
// INV-09 断言：selectedIndex 越界或为负时不得触发滚动 —— 守住它的位置：selectedVirtualIndex >= 0 守卫 —— 改错故障：scrollToIndex(-1) 抛错或把列表拽回顶部
// INV-10 断言：滚动跟随只随 selectedVirtualIndex 变化触发 —— 守住它的位置：该 effect 的依赖数组 —— 改错故障：每次重渲染都强制滚动，用户无法手动浏览长列表
// INV-11 断言：scrollMaskState 必须按字段比较后写入 —— 守住它的位置：setScrollMaskState 中复用 current 的短路 —— 改错故障：每帧新建对象，遮罩闪烁并额外渲染整树
// INV-12 断言：scroll / resize 监听必须随依赖变化解绑重建 —— 守住它的位置：effect cleanup 的 removeEventListener 与 disconnect —— 改错故障：监听叠加，一次滚动排程多次计算
// INV-13 断言：未执行的 rAF 必须在 cleanup 中取消 —— 守住它的位置：cancelAnimationFrame(frameId) —— 改错故障：卸载后回调仍读已脱离的 DOM，遮罩写回旧容器
// INV-14 断言：禁选项必须双重拦截，disabled 属性之外还要在按下时提前返回 —— 守住它的位置：OptionRow 的 onMouseDown —— 改错故障：合成事件绕过禁用态，冲突 Plugin 被插入
//
// 状态所有者：上层持有 sections / selectedIndex / hasActiveQuery；本组件持有 hoveredOptionIndex、
//             scrollMaskState；virtualRows 是 sections 的派生投影，virtualizer 是行索引的派生视图。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  TID_PROMPT_SUGGESTION_OPTION,
  TID_PROMPT_SUGGESTION_PANEL,
  TID_PROMPT_SUGGESTION_SECTION,
  TID_PROMPT_SUGGESTION_STATUS,
  testId,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Info, LoaderIcon } from "lucide-react";
import {
  EMPTY_SCROLL_MASK_STATE,
  getVerticalScrollMaskStyle,
  resolveVerticalScrollMaskState,
  type ScrollMaskState,
} from "@/mentions/components/scrollMask.js";

// [契约] 单个候选项的唯一形状：id 决定 test-id 与 data-option-id，label 与 description 供默认两行布局使用。
// content 存在时整块替换默认排版，meta 只作行内附注；调用方不得依赖默认排版的 DOM 结构做断言。
// disabled 是「可见但不可选」的 fail closed 语义，disabledReason 只影响展示，不参与可选性判断。
export interface MentionPanelOption {
  id: string;
  label: string;
  description: string;
  content?: ReactNode;
  meta?: ReactNode;
  /** 禁选态（如同名 Plugin 冲突 fail closed）：可见但不可点击，键盘导航由上层跳过。 */
  disabled?: boolean;
  /** 禁选原因；无自定义 content 时展示在描述位。 */
  disabledReason?: string;
}

// [契约] 一个分组等于一次查询的子结果；options 为空并不等于空态，errorText 与 loading 的优先级更高。
// loading 为真时状态行文本取 loadingText，缺省回落到 emptyText —— 两个字段语义不同但展示位复用。
// showHeader 只是单分组的冗余开关；想让项目名在单组结果里可见才置真。
// [失败路径] errorText 一旦非空，该组的 options 即使有内容也不会渲染，避免错误提示与旧结果同时出现。
export interface MentionPanelSection {
  id: string;
  title: string;
  options: MentionPanelOption[];
  emptyText: string;
  loadingText?: string;
  loading?: boolean;
  errorText?: string | null;
  /** 项目名称在单组搜索结果中也需要可见。 */
  showHeader?: boolean;
}

// [契约] selectedIndex 是跨分组的扁平选项下标，不是分组内下标，也不含标题行与状态行。
// hasActiveQuery 只切换降级文案：有查询时展示空结果，无查询时改由 footer 与 description 承接。
// onSelect 只回传扁平下标，插入与关闭面板由上层负责；本组件不持有选中事实。
interface MentionPanelProps {
  title: string;
  description: string;
  footer?: ReactNode;
  listMaxHeight?: string;
  trigger: string;
  sections: MentionPanelSection[];
  emptyText: string;
  selectedIndex: number;
  hasActiveQuery: boolean;
  onSelect: (index: number) => void;
}

// [契约] 虚拟行是渲染用的判别联合，kind 同时决定行高、可交互性与是否参与选中匹配。
// status 行的 content 三态与 buildVirtualRows 的优先级一一对应，不存在既空又错的组合。
// option 行携带 flatOptionIndex，使虚拟位置与上层键盘下标解耦：滚动窗口变化不改变选中语义。
// section_header 只带 sectionId 与 title，不复制 options，避免与 sections 形成第二份数据源。
type VirtualRow =
  | {
      kind: "section_header";
      sectionId: string;
      title: string;
    }
  | {
      kind: "status";
      sectionId: string;
      content: "loading" | "error" | "empty";
      text: string;
    }
  | {
      kind: "option";
      sectionId: string;
      option: MentionPanelOption;
      flatOptionIndex: number;
    };

// [权衡] 行高是估算值而非实测值：定高换滚动稳定，代价是内容换行时会被裁切。
// 选项 32px 可见高度加 2px 间隙对齐 34px 虚拟行；分组标题同高，只差字号与内边距。
// 状态行 40px 容纳图标与单行文本；改动任一常量都必须同步 estimateSize，见 INV-07。
const OPTION_ROW_HEIGHT = 34;
const STATUS_ROW_HEIGHT = 40;
export const SECTION_HEADER_ROW_HEIGHT = 34;

// 分组标题改用 base 字号后，旧的 28px 虚拟行装不下默认行高与 12px 上下 padding。
// 使用与命令项一致的 32px 可见高度和 34px 虚拟行高度，避免裁切或覆盖下一行。
// [权衡] 导出的是类名而不是行高，让外部测试与复用方在不复制样式的前提下断言标题可见性。
// h-8 必须与 SECTION_HEADER_ROW_HEIGHT 保持一致：只改类名会让标题覆盖下一行。
// uppercase 会改变拉丁字母的视觉宽度，中文标题不受影响，文案本身不做大小写转换。
export const SECTION_HEADER_CLASS_NAME =
  "flex h-8 items-center px-3 text-ui-base font-semibold uppercase tracking-wide text-foreground-subtle";

// [契约] 纯函数：只读 sections 的字段，不碰 ref、时间与随机数，同一输入必定得到同一行序列。
// 输出顺序即渲染顺序，也是键盘上下键的遍历顺序；调用方不得再排序或过滤。
// 标题、状态、选项三类行按分组顺序串行产出，跨分组的扁平下标因此天然连续。
// [并发] 若上层在异步结果到达后原地 push 而不换数组引用，memo 不会重算，候选与行序列会脱节。
export function buildVirtualRows(sections: MentionPanelSection[]): VirtualRow[] {
  // [契约] rows 与 flatOptionIndex 是本帧唯一的累加器，不存在分组内独立计数。
  // 空 sections 得到空数组，直接落到无虚拟行分支，不产生任何占位行。
  // flatOptionIndex 从 0 开始且只在闭包内可见，保证与上层 selectedIndex 的基准一致。
  const rows: VirtualRow[] = [];
  let flatOptionIndex = 0;
  const shouldRenderSectionHeader = sections.length > 1;

  // [契约] 逐组展开而非先拍平选项再插标题，保证状态行位置稳定且不依赖后续排序。
  // [并发] sections 的顺序即结果顺序；旧查询晚到并覆盖后，行序会整体跳变，
  // 因此过期响应必须在上层按查询序号丢弃，本组件无法识别新旧。
  for (const section of sections) {
    // [契约] 仅在多分组或显式 showHeader 时产出标题行，单分组且未要求时整行省略以省空间。
    // title 全空白的分组即使满足前一条也不产出标题，避免渲染零高度的可见区。
    // 标题行不参与 flatOptionIndex 分配，因此不会挤占键盘下标。
    if ((shouldRenderSectionHeader || section.showHeader) && section.title.trim().length > 0) {
      rows.push({
        kind: "section_header",
        sectionId: section.id,
        title: section.title,
      });
    }

    // [失败路径] 错误行优先于加载与空态：同一分组只暴露一种状态，避免「有错却又显示无结果」。
    // 错误文本直接取 errorText，不回落到 emptyText —— 失败原因必须原样呈现。
    // 错误态下该组 options 不再展开，即使上层保留了上一次的候选快照也不会被渲染。
    // 错误行占 40px 虚拟高度且不可聚焦，键盘导航会直接跨过它。
    if (section.errorText) {
      rows.push({
        kind: "status",
        sectionId: section.id,
        content: "error",
        text: section.errorText,
      });
    // [失败路径] 加载态在无错误时优先于空态：options 暂时为空是正常中间态，不应显示无结果。
    // loadingText 缺省时用 emptyText 兜底，这是展示位复用，不代表两种语义等价。
    // 加载行不可点击也不分配扁平下标，选中项仍停留在上一帧的候选位置。
    } else if (section.loading) {
      rows.push({
        kind: "status",
        sectionId: section.id,
        content: "loading",
        text: section.loadingText ?? section.emptyText,
      });
    // [契约] 选项数为 0 且未加载未出错才产出空态行，文本固定为分组的 emptyText。
    // [并发] 空态与「查询尚未返回」共用 options.length，上层必须用 loading 区分二者，
    // 否则旧查询结果为空时会先闪一帧空态再被新结果替换。
    // 空态行不进 `flatOptionIndex` 分配，键盘导航按不可选跳过。
    } else if (section.options.length === 0) {
      rows.push({
        kind: "status",
        sectionId: section.id,
        content: "empty",
        text: section.emptyText,
      });
    } else {
      for (const option of section.options) {
        rows.push({
          kind: "option",
          sectionId: section.id,
          option,
          flatOptionIndex,
        });
        // [契约] 只有真正产出的选项才递增，跳过状态行与标题后下标仍连续，见 INV-01。
        // 递增发生在 push 之后，当前选项拿到的始终是自增前的值。
        flatOptionIndex += 1;
      }
    }
  }

  return rows;
}

// [契约] `MentionPanel` 只做虚拟化与展示编排：候选查询与序号比较全在上层，组件可安全重渲染。
// [并发] 同一帧只渲染一份 sections 快照；异步竞态表现为旧查询覆盖新查询，
// 旧响应若晚于新响应到达并被直接写入 state，列表会回退到过期候选，需上层按序号丢弃。
// 本组件不去重、不缓存上一次结果，也不在渲染期发起请求。
export function MentionPanel({
  title,
  description,
  footer,
  listMaxHeight,
  sections,
  emptyText,
  selectedIndex,
  hasActiveQuery,
  onSelect,
  trigger,
}: MentionPanelProps) {
  // [资源] 该 ref 既是 virtualizer 的 getScrollElement 来源，也是遮罩计算的 DOM 依据。
  // 挂载前 ref 为 null，virtualizer 以空窗口渲染，首帧行数可能少于最终窗口。
  // hoveredOptionIndex 只影响背景色，不参与选中；离开容器时统一清空。
  // scrollMaskState 由滚动位置派生，切组或数据变化后由下方 effect 重算。
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [hoveredOptionIndex, setHoveredOptionIndex] = useState<number | null>(null);
  const [scrollMaskState, setScrollMaskState] = useState<ScrollMaskState>(EMPTY_SCROLL_MASK_STATE);

  // [并发] 依赖整个 sections 引用：上层原地修改不会触发重算，可见候选与行序列会脱节。
  // [契约] 虚拟行只是派生投影，不缓存也不回写；选中只与 flatOptionIndex 比对。
  // 数据量变化时行数同帧变化，virtualizer 的 count 随之更新，过期行不会被继续渲染。
  // 本层不做防抖：高频查询结果到达就立即重算，滚动位置交给 virtualizer 自行收敛。
  const virtualRows = useMemo(() => buildVirtualRows(sections), [sections]);

  // [并发] count 跟随行数、窗口随 scrollTop 计算；新结果比旧结果短时滚动位置会超出总高度，
  // virtualizer 回落到有效范围，选中项随之重新定位。
  // [权衡] overscan 8 换取快速滚动时行不空白；过大会让每帧渲染行数翻倍，过小会露出底色。
  // getScrollElement 每次读取 ref 当前值，容器重挂载后无需重建实例。
  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) =>
      virtualRows[index]?.kind === "option"
        ? OPTION_ROW_HEIGHT
        : virtualRows[index]?.kind === "section_header"
          ? SECTION_HEADER_ROW_HEIGHT
          : STATUS_ROW_HEIGHT,
    overscan: 8,
  });
  // [资源] 总高度只由行数与估算行高决定，用于撑开滚动区域，不等于内容的真实高度。
  // 该值变化会让下方遮罩 effect 重算，因为可视比例与最大滚动距离都变了。
  const totalVirtualSize = virtualizer.getTotalSize();

  // [资源] 遮罩按 clientHeight / scrollHeight / scrollTop 推导，容器缺失时回落空状态而非保留旧值。
  // [权衡] 写入前做字段级比较并复用 current，避免每次滚动都造新对象触发整树重渲染。
  // 该回调不依赖任何 props，可被 effect 长期持有；DOM 高度变化由调用方主动触发。
  // `updateScrollMaskState` 只算视觉渐隐，不阻挡滚动与命中测试。
  const updateScrollMaskState = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      setScrollMaskState(EMPTY_SCROLL_MASK_STATE);
      return;
    }

    const nextState = resolveVerticalScrollMaskState({
      clientHeight: scrollContainer.clientHeight,
      scrollHeight: scrollContainer.scrollHeight,
      scrollTop: scrollContainer.scrollTop,
    });

    setScrollMaskState((current) =>
      current.showTop === nextState.showTop && current.showBottom === nextState.showBottom
        ? current
        : nextState,
    );
  }, []);

  const scrollMaskStyle = useMemo(
    () => getVerticalScrollMaskStyle(scrollMaskState),
    [scrollMaskState],
  );

  // Scroll selected option into view
  // [并发] 选中由上层键盘推进，虚拟下标靠 flatOptionIndex 反查；禁用项是否跳过由上层决定。
  // findIndex 只匹配 option 行，状态行与标题即使数值相同也不会高亮。
  // 越界或负值返回 -1，下方 effect 据此不滚动 —— 键盘选中越界不会引发异常滚动。
  const selectedVirtualIndex = useMemo(
    () =>
      virtualRows.findIndex(
        (row) => row.kind === "option" && row.flatOptionIndex === selectedIndex,
      ),
    [virtualRows, selectedIndex],
  );

  useEffect(() => {
    // [并发] 仅在有效下标时滚动，align:auto 让已可见的行不再跳动，减少手动浏览被打断。
    // 依赖里含 virtualizer 实例本身，实例重建会重新滚一次到当前选中项。
    // [权衡] 未抑制「用户正在手动滚动」：长列表连续按键时，跟随滚动会覆盖用户滚动意图。
    // 滚动在 effect 中执行、晚于提交，遮罩的 rAF 更新可能在同帧内看到中间滚动位置。
    if (selectedVirtualIndex >= 0) {
      virtualizer.scrollToIndex(selectedVirtualIndex, { align: "auto" });
    }
  }, [selectedVirtualIndex, virtualizer]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      setScrollMaskState(EMPTY_SCROLL_MASK_STATE);
      return;
    }

    // [资源] 同一帧内多次 scroll / resize 只调度一次遮罩计算，frameId 充当去重闸门。
    // 回调先把句柄置空再计算，保证下一帧的滚动能重新排程；不置空会让遮罩永久冻结。
    // 监听以 passive 注册，滚动期间不阻塞合成器；遮罩计算只读布局，不写几何。
    // 初始挂载直接算一次，覆盖内容已超出容器但尚未滚动的首帧。
    let frameId: number | null = null;
    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }
      frameId = requestAnimationFrame(() => {
        frameId = null;
        updateScrollMaskState();
      });
    };

    updateScrollMaskState();
    scrollContainer.addEventListener("scroll", scheduleUpdate, {
      passive: true,
    });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleUpdate);
      resizeObserver.observe(scrollContainer);
      const contentElement = scrollContainer.firstElementChild;
      if (contentElement) {
        resizeObserver.observe(contentElement);
      }
    } else {
      window.addEventListener("resize", scheduleUpdate);
    }

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      scrollContainer.removeEventListener("scroll", scheduleUpdate);
      resizeObserver?.disconnect();
      if (typeof ResizeObserver === "undefined") {
        window.removeEventListener("resize", scheduleUpdate);
      }
    };
  // [失败路径] 依赖含总高度与行数：数据变长变短后必须重建，否则遮罩停留在旧可视比例。
  // ResizeObserver 可用时同时观察容器与首个子元素那层虚拟内容，内容变化也能触发。
  // 不可用时退回 window.resize，粒度更粗但仍保证窗口缩放后重算。
  // [资源] cleanup 取消未执行的 rAF、解绑 scroll、disconnect observer，避免监听叠加，见 INV-12。
  }, [totalVirtualSize, updateScrollMaskState, virtualRows.length]);

  // [契约] 有虚拟行才渲染 listbox 容器；行数为 0 时整块滚动结构与 ref 都不存在。
  // 无行且存在查询时展示空结果文案，无查询时改由 footer 与 description 承接，二者互斥。
  // 滚动容器同时承载 role=listbox 与遮罩样式，listMaxHeight 覆盖默认的 max-h-56。
  // [并发] 从有行切到无行会卸载滚动容器，ref 变 null、窗口归零；再次出结果时从顶部开始，不保留旧查询的滚动位置。
  return (
    <div
      className="mb-1 overflow-hidden rounded-2xl border border-border bg-menu shadow-xs"
      data-testid={TID_PROMPT_SUGGESTION_PANEL}
      data-trigger={trigger}
    >
      {virtualRows.length > 0 ? (
        <div
          ref={scrollContainerRef}
          className="max-h-56 overflow-y-auto px-1 py-0.75"
          role="listbox"
          aria-label={title}
          onMouseLeave={() => setHoveredOptionIndex(null)}
          style={{ ...scrollMaskStyle, ...(listMaxHeight ? { maxHeight: listMaxHeight } : {}) }}
        >
          <div
            style={{
              height: `${totalVirtualSize}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = virtualRows[virtualItem.index];
              if (!row) return null;

              return (
                <div
                  key={virtualItem.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {row.kind === "status" ? (
                    <StatusRow row={row} />
                  ) : row.kind === "section_header" ? (
                    <SectionHeaderRow row={row} />
                  ) : (
                    <OptionRow
                      row={row}
                      isSelected={row.flatOptionIndex === selectedIndex}
                      isHovered={row.flatOptionIndex === hoveredOptionIndex}
                      onSelect={onSelect}
                      onHover={setHoveredOptionIndex}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : hasActiveQuery && emptyText ? (
        <div className="flex items-center justify-between px-4 py-3 text-ui-base text-foreground-subtlest">
          {emptyText}
        </div>
      ) : null}
      {!hasActiveQuery && footer ? footer : null}
      {!hasActiveQuery && description ? (
        <div className="flex items-center gap-2 px-4 py-3 text-ui-base text-foreground-subtle">
          <Info className="size-4 shrink-0 text-foreground" />
          <span>{description}</span>
        </div>
      ) : null}
    </div>
  );
}

function SectionHeaderRow({ row }: { row: Extract<VirtualRow, { kind: "section_header" }> }) {
  return (
    <div
      className={SECTION_HEADER_CLASS_NAME}
      data-testid={testId(TID_PROMPT_SUGGESTION_SECTION, row.sectionId)}
      data-section-id={row.sectionId}
    >
      {row.title}
    </div>
  );
}

function StatusRow({ row }: { row: Extract<VirtualRow, { kind: "status" }> }) {
  if (row.content === "loading") {
    return (
      <div
        className="flex items-center gap-2 rounded-xl px-5 py-2 text-ui-base text-foreground-subtle"
        data-testid={testId(TID_PROMPT_SUGGESTION_STATUS, row.sectionId)}
        data-section-id={row.sectionId}
        data-status="loading"
      >
        <LoaderIcon className="size-3.5 shrink-0 animate-spin" />
        <span>{row.text}</span>
      </div>
    );
  }

  if (row.content === "error") {
    return (
      <div
        className="rounded-xl bg-destructive px-5 py-2 text-ui-base text-destructive-foreground"
        data-testid={testId(TID_PROMPT_SUGGESTION_STATUS, row.sectionId)}
        data-section-id={row.sectionId}
        data-status="error"
      >
        {row.text}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl px-5 py-2 text-ui-base text-foreground-subtlest"
      data-testid={testId(TID_PROMPT_SUGGESTION_STATUS, row.sectionId)}
      data-section-id={row.sectionId}
      data-status="empty"
    >
      {row.text}
    </div>
  );
}

function OptionRow({
  row,
  isSelected,
  isHovered,
  onSelect,
  onHover,
}: {
  row: Extract<VirtualRow, { kind: "option" }>;
  isSelected: boolean;
  isHovered: boolean;
  onSelect: (index: number) => void;
  onHover: (index: number | null) => void;
}) {
  const { option, flatOptionIndex } = row;
  // [契约] 仅当 disabled 严格为 true 才禁选，缺失或 undefined 一律视为可选。
  // [失败路径] 禁用态同时作用于 button.disabled 与 onMouseDown 的提前返回，双重拦截见 INV-14。
  // 禁用项仍然可悬停、可被读屏读到：无自定义 content 时用 disabledReason 顶替描述位，说明为什么不可选。
  const isDisabled = option.disabled === true;

  return (
    <div className="py-px w-full">
      <button
        type="button"
        role="option"
        aria-selected={isSelected}
        aria-disabled={isDisabled}
        disabled={isDisabled}
        data-testid={testId(TID_PROMPT_SUGGESTION_OPTION, option.id)}
        data-section-id={row.sectionId}
        data-option-id={option.id}
        data-option-index={flatOptionIndex}
        data-selected={isSelected ? "true" : "false"}
        data-disabled={isDisabled ? "true" : "false"}
        className={cn(
          "flex h-8 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors",
          isDisabled
            ? "cursor-not-allowed opacity-50"
            : isSelected
              ? "bg-selected"
              : isHovered
                ? "bg-hover"
                : "hover:bg-hover",
        )}
        onMouseDown={(event) => {
          event.preventDefault();
          // 禁选项不触发选择：fail closed，冲突 Plugin 不能被插入。
          if (isDisabled) {
            return;
          }
          onSelect(flatOptionIndex);
        }}
        onMouseEnter={() => onHover(isDisabled ? null : flatOptionIndex)}
      >
        {option.content ? (
          <>{option.content}</>
        ) : (
          <span className="min-w-0 flex-1 flex">
            <span className="flex items-center gap-2 flex-auto">
              <span className="truncate text-ui-base font-medium text-foreground">
                {option.label}
              </span>
              {option.meta ? (
                <span className="shrink-0 text-ui-xs text-foreground-subtlest">{option.meta}</span>
              ) : null}
            </span>
            <span className="mt-1 block truncate text-ui-xs text-foreground-subtlest">
              {isDisabled && option.disabledReason ? option.disabledReason : option.description}
            </span>
          </span>
        )}
      </button>
    </div>
  );
}
