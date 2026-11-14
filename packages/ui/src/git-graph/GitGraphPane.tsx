// GitGraphPane —— Git 提交图谱面板：把 layoutGitGraph 算出的泳道几何投影成 SVG 曲线与提交表格，并在其上叠加选中、悬停、展开三种视图状态。
// 职责边界：只做渲染与交互撮合，不拉取提交、不格式化时间（formatCommitTime）、不计算泳道布局（layoutGitGraph）、不渲染详情正文（GitGraphCommitDetail）。
// 不负责：分页游标、刷新请求的真实发起、选中项的业务含义；这些由调用方的 props 回调承担，组件只负责上报意图。
//
// INV-01 断言：所有泳道颜色只由 laneIndex 对 4 取模决定 —— 守住它的位置：getLaneStrokeClass、getLaneFillClass 与两个 className 常量表 —— 改错故障：两张表长度不一致时同一条泳道的描边与填充错开，线上出现线与点不同色。
// INV-02 断言：stroke 表与 fill 表必须同长同序（descendant、renamed、added、modified） —— 守住它的位置：laneStrokeClasses 与 laneFillClasses 的数组声明 —— 改错故障：只在一侧补颜色，越界泳道拿到 undefined 类名，SVG 回落成默认黑色。
// INV-03 断言：取模结果恒可索引，依赖 laneIndex 非负这一前置条件 —— 守住它的位置：两个 getLaneXxxClass 里的取模与末尾非空断言 —— 改错故障：布局改成从 -1 起算后 JS 取模返回负值，类名变成 undefined，图形整列失色。
// INV-04 断言：表头与数据行共用唯一一份列宽模板 —— 守住它的位置：getTableColumnStyle 及两处 style 绑定 —— 改错故障：任一列单独改宽，表头与数据行错列，日期会压到作者列上。
// INV-05 断言：网格固定为「图形列 + 描述/日期/作者/提交」四列 —— 守住它的位置：两处 gridTemplateColumns 模板字符串 —— 改错故障：加列不加模板，新列被塞进 minmax(0,1fr)，描述列被压缩到不可读。
// INV-06 断言：图形列宽度取 max(layout.width + 12, 56) —— 守住它的位置：graphColumnWidth 计算与 SVG 的 width/viewBox —— 改错故障：直接用 layout.width 时窄图列短于表头文字宽度，表头「图形」二字被裁切。
// INV-07 断言：SVG 的 width、height、viewBox 三个数值必须同源 —— 守住它的位置：svg 元素的三个属性绑定 —— 改错故障：只改 width 而 viewBox 不动会整体等比缩放，提交点相对泳道向左上偏移。
// INV-08 断言：布局只在 commits 引用变化时重算 —— 守住它的位置：layout 的 useMemo 依赖数组 —— 改错故障：把 rows、paths 或主题放进依赖，每次渲染全量重排，长历史滚动明显掉帧。
// INV-09 断言：hoveredCommitHash 是悬停高亮的唯一来源，不另存派生 state —— 守住它的位置：highlightedHash 赋值与 mouseenter/mouseleave 成对写入 —— 改错故障：另存一份高亮 state 会与 mouseleave 清理不同步，鼠标移出后高亮残留。
// INV-10 断言：选中态与展开态是两份独立状态，互不覆盖 —— 守住它的位置：selectedCommitHash（父级）与 expandedCommitHash（本地） —— 改错故障：合并成一个 state 后点已展开行无法收起，详情面板永远停在上一次提交。
// INV-11 断言：展开行按 hash 从当前 commits 实时反查，不保存提交对象快照 —— 守住它的位置：expandedCommit 的 find 表达式 —— 改错故障：存对象快照后父级刷新列表，详情面板仍显示旧作者与旧时间。
// INV-12 断言：触底加载必须同时满足 hasMore、非 loadingMore、存在 onLoadMore —— 守住它的位置：handleGraphScroll 开头的早退分支 —— 改错故障：漏掉 loadingMore 判断，一次连续滚动重复上报 onLoadMore，同一页被追加多次。
// INV-13 断言：触底距离用 scrollHeight 减 scrollTop 再减 clientHeight 判定 —— 守住它的位置：distanceToBottom 计算与 96px 阈值比较 —— 改错故障：换成 scrollTop 与最大值相等判断，浏览器缩放后永远不相等，加载再不触发。
// INV-14 断言：滚动回调的依赖只有 hasMore、loadingMore、onLoadMore —— 守住它的位置：handleGraphScroll 的 useCallback 依赖数组 —— 改错故障：漏项会闭包捕获旧值，加载结束后仍以为在加载，滚动与按钮双双失效。
// INV-15 断言：空态与列表态互斥，空态不挂滚动容器 —— 守住它的位置：commits.length 为 0 的三元分支 —— 改错故障：空态也挂 onScroll，会在无数据时把 onLoadMore 反复上报，调用方拉取空页。
// INV-16 断言：高亮只压低无关泳道透明度，相关泳道与选中点保持不透明 —— 守住它的位置：path 与 circle 的 class 条件分支 —— 改错故障：条件写反会让当前提交所在泳道变灰，视觉上「选中项消失」。
// INV-17 断言：选中环是独立 circle，半径 5.5 大于节点 4.25 —— 守住它的位置：SELECTED_RING_RADIUS 的可选渲染分支 —— 改错故障：环半径改小后与节点填充重叠，选中态与普通节点看不出区别。
// INV-18 断言：容器与 SVG 高度统一为 layout.height 加一行 rowHeight —— 守住它的位置：图形列容器 style 与 svg 的 height —— 改错故障：少加一行会裁掉最后一个提交点，用户看不到最新提交的节点。
// INV-19 断言：每行最多展示 4 个 ref 标签且不换行 —— 守住它的位置：row.commit.refs.slice(0, 4) —— 改错故障：放开截断后长 ref 列表把描述列挤成零宽，提交标题完全不可见。
// INV-20 断言：提交主题为空时回退短 hash，保证每行有可读标识 —— 守住它的位置：subject 与 getShortHash 的或运算 —— 改错故障：去掉回退会出现整行空白，用户无法辨认该提交，也无法判断点中的是哪一条。
import { GitGraph, GitMergeIcon, RefreshCwIcon } from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type UIEvent,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { GitGraphCommitDetail } from "./GitGraphCommitDetail.js";
import {
  formatCommitTime,
  getRefIcon,
  getShortHash,
} from "./GitGraphDisplay.js";
import {
  type GitGraphCommit,
  type GitGraphLayoutPath,
  layoutGitGraph,
} from "./layout.js";

// [契约] 这里只声明「调用方能给什么、组件会回报什么」，不暴露 layout 内部的行与路径结构，
// 调用方因此可以替换布局实现而不用改面板类型签名。
// commits 声明为 readonly：面板内部不排序、不过滤、不增删，数组顺序即渲染顺序；
// 若在面板里排序，行的 rowIndex 会与 layout 预计算的 y 坐标脱钩，点和行整体错位。
export interface GitGraphPaneProps {
  commits: readonly GitGraphCommit[];
  hasMore?: boolean;
  loadingMore?: boolean;
  refreshing?: boolean;
  selectedCommitHash: string | null;
  onSelectCommit: (hash: string) => void;
  onLoadMore?: () => void;
  onRefresh?: () => void;
}

// [权衡] 描边色不随泳道数无限扩展，只用 4 个 git 语义色循环，
// 泳道常见 1 到 3 条，超过 4 条的仓库本来就难读，循环色比生成长尾色值更稳定。
// 不要改成动态拼类名：tailwind 扫描不到模板字符串拼出的类，颜色会整体失效。
const laneStrokeClasses = [
  "stroke-git-descendant",
  "stroke-git-renamed",
  "stroke-git-added",
  "stroke-git-modified",
];

// fill 与 stroke 两张表必须同序同长：索引来自同一个 laneIndex 取模，
// 任意一侧插入或删除一项，都会让第 N 条泳道的线色与点色错开一格。
const laneFillClasses = [
  "fill-git-descendant",
  "fill-git-renamed",
  "fill-git-added",
  "fill-git-modified",
];

// 点半径略小于行高的一半，保证密集历史里相邻提交点之间仍留出缝隙，
// 调大后父子提交的圆会粘连成一条粗线，merge 关系就看不出来了。
const NODE_RADIUS = 4;
const SELECTED_NODE_RADIUS = 4.25;
const SELECTED_RING_RADIUS = 5.5;
// [权衡] 阈值 96px 约等于两行高度：太小则用户必须精确滚到底才加载，
// 太大则首屏尚未滚完就提前请求下一页，长历史下会连续追加多页。
// 该值只影响触发时机，不改变分页语义，真实游标仍由调用方的 onLoadMore 维护。
// 不要把它调成 0：部分浏览器像素取整会让滚动位置永远差 1px，触底判断永不为真。
const LOAD_MORE_SCROLL_THRESHOLD_PX = 96;
// [契约] 56px 是图形列的下限而不是期望宽度，期望宽度由 layout.width + 12 决定，
// 多出的 12px 是左右各 6px 的内边距，给最外侧泳道留出描边不被裁掉的空间。
// 表头与数据区两侧引用同一常量，任何一侧硬编码数字都会让两段网格错列。
// 单泳道图形宽度比 Graph 表头短，保留最小列宽避免表头被挤压。
const GRAPH_COLUMN_MIN_WIDTH_PX = 56;

// 取模而不是查表兜底：laneIndex 来自布局阶段，理论上恒为非负整数，
// 这里依赖该前置条件，负数会取模出负索引，末尾的非空断言只是为了让类型收窄，
// 若将来布局改为从 1 或 -1 起算，必须先在此处归一化，否则类名变成 undefined。
function getLaneStrokeClass(laneIndex: number): string {
  return laneStrokeClasses[laneIndex % laneStrokeClasses.length]!;
}

function getLaneFillClass(laneIndex: number): string {
  return laneFillClasses[laneIndex % laneFillClasses.length]!;
}

// [契约] 四列宽度 260/128/112/84 与表头、数据行共用同一份模板，
// 描述列用 minmax(260px, 1fr) 吃掉剩余宽度，后三列固定，避免长 hash 撑破布局。
// 改动这里必须同步检查容器的 min-w-[760px] 下限，否则窄窗口会出现横向滚动条。
function getTableColumnStyle() {
  return {
    gridTemplateColumns: "minmax(260px,1fr) 128px 112px 84px",
  };
}

// relatedHashes 由布局阶段预计算，包含路径两端以及途经的提交，
// 这里只做 includes 判定，不在渲染期重新推导拓扑；高亮开启时每条路径调用一次。
// 若改成按 laneIndex 判断相关性，同一泳道上的无关提交会被一起点亮，高亮失去含义。
function isPathRelated(path: GitGraphLayoutPath, hash: string | null): boolean {
  return Boolean(hash && path.relatedHashes.includes(hash));
}

// 组件保持无副作用：不发请求、不写 store、不订阅外部事件，
// 除悬停与展开两个本地视图状态外，所有数据都从 props 单向流入。
// [失败路径] 回调全部可选：onLoadMore、onRefresh 缺失时对应入口直接不渲染，
// 不要用空函数兜底，否则会出现能点但无反应的按钮，掩盖调用方漏接线的问题。
export function GitGraphPane({
  commits,
  hasMore = false,
  loadingMore = false,
  refreshing = false,
  selectedCommitHash,
  onSelectCommit,
  onLoadMore,
  onRefresh,
}: GitGraphPaneProps) {
  const { intl, locale } = useZCodeIntl();
  // 悬停态只存 hash 不存行对象：行数据每次刷新都可能换新引用，
  // 存对象会让高亮指向已经过期的快照；进入与离开成对写入，离开时置空。
  // 该状态不参与选中逻辑，点选不会重置它，避免点击瞬间高亮闪烁一下。
  const [hoveredCommitHash, setHoveredCommitHash] = useState<string | null>(null);
  // [契约] 展开是「再次点击同一行收起」的开关语义，所以必须存 hash 而不能用布尔值，
  // 否则列表刷新后无法判断原来是哪一行处于展开状态。
  // 它与 selectedCommitHash 是两份状态：选中由父级持有，展开属于纯本地 UI 细节。
  // 不要为省一个 state 把展开并入选中，那样父级改选中项时会连带强制收起详情。
  // 收起时写 null 而不是空串，下游直接用真值判断是否存在可渲染的提交。
  const [expandedCommitHash, setExpandedCommitHash] = useState<string | null>(null);
  // [资源] 布局是整份提交列表上最重的一次计算，结果同时驱动 SVG 尺寸、行高与路径。
  // 依赖只放 commits 引用：调用方追加数据时若新建数组，这里就不会重算已有部分。
  // 不要把 locale 或主题放进依赖，时间格式化发生在渲染期，与几何无关。
  // 若调用方每次渲染都新建 commits 字面量，这里会退化为每次全量重排，长历史下明显卡顿。
  const layout = useMemo(() => layoutGitGraph(commits), [commits]);
  const highlightedHash = hoveredCommitHash;
  const tableColumnStyle = getTableColumnStyle();
  // 该宽度必须同时用于 svg 的 width 与 viewBox，两处取同一个值才不会触发等比缩放，
  // 只改其中一处会让提交点相对泳道整体偏移，且越靠右的泳道偏得越多。
  const graphColumnWidth = Math.max(layout.width + 12, GRAPH_COLUMN_MIN_WIDTH_PX);
  // 按 hash 从当前 commits 里反查，拿到的是本次渲染的最新数据；
  // 不能把展开那一刻的提交对象存进 state，否则父级刷新后详情仍显示旧作者与旧时间。
  // [失败路径] 找不到时回退 null 而不是抛错：分页截断或列表过滤后原提交可能已经不在，
  // 此时详情面板自然消失，比渲染一个没有内容的空壳容器更安全。
  const expandedCommit =
    commits.find((commit) => commit.hash === expandedCommitHash) ?? null;
  // [并发] 滚动事件高频触发，这里不做节流，靠 loadingMore 与 hasMore 两道闸门去重；
  // 请求的串行化由调用方负责，组件只保证同一时刻最多上报一次加载意图。
  // 回调固定下来，避免每次渲染都给滚动容器换一个新的监听函数。
  const handleGraphScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      // [失败路径] 三个条件缺一不可：没有更多时不请求、在途时不重复请求、
      // 没有回调时直接退出，避免滚动监听里反复做无用计算。
      // 顺序上先判 hasMore，因为它最便宜且最常为假，短路径提前返回。
      if (!hasMore || loadingMore || !onLoadMore) {
        return;
      }

      const target = event.currentTarget;
      // 用几何距离而不是与最大滚动值做相等判断：
      // 在缩放、小数滚动位置与高 DPI 下，scrollTop 很难精确等于 scrollHeight 减 clientHeight。
      // 事件里只读 currentTarget，不缓存 DOM 引用，组件卸载后不会拿到失效节点。
      const distanceToBottom =
        target.scrollHeight - target.scrollTop - target.clientHeight;
      // [并发] 这里可能连续触发：loadingMore 的更新要等父级重渲染后才回到本组件，
      // 两次滚动事件之间仍可能都读到 loadingMore 为假，从而重复上报。
      // 重复上报被调用方用游标或加载标志做幂等，组件不做客户端去抖。
      // 不要在这里加 setTimeout 延迟，延迟期间用户看到的是空白而不是加载态，
      // 也不要用 ref 自锁，请求失败后必须允许用户再次触底重试。
      if (distanceToBottom <= LOAD_MORE_SCROLL_THRESHOLD_PX) {
        onLoadMore();
      }
    },
    [hasMore, loadingMore, onLoadMore],
  );

  // 渲染树分三段：表头、图形列、数据行，表头与数据行共用同一份列模板，
  // 图形列高度取 layout.height 再加一行，给最后一个提交点留出完整的半径空间。
  return (
    // [契约] 根节点是 h-full 加 min-h-0 的纵向弹性容器，依赖父级给出确定高度内部滚动才生效，
    // 去掉 min-h-0 后 flex 子项会按内容高度撑破容器，滚动条跑到外层，触底加载再也触发不到。
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="border-b border-border bg-surface/40 px-3 py-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GitGraph className="size-3.5 text-foreground" />
              <h2 className="truncate text-ui-base font-medium">
                {intl.formatMessage({ id: "gitGraph.title" })}
              </h2>
            </div>
          </div>
          {onRefresh ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={refreshing}
              aria-label={intl.formatMessage({ id: "gitGraph.refresh" })}
              title={intl.formatMessage({ id: "gitGraph.refresh" })}
              className="mr-8 text-foreground-subtle hover:text-foreground"
              onClick={onRefresh}
            >
              <RefreshCwIcon
                className={cn("size-3.5", refreshing && "animate-spin")}
              />
            </Button>
          ) : null}
        </div>
      </div>

      {commits.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-sm text-center">
            <GitGraph className="mx-auto size-8 text-foreground-subtlest" />
            <p className="mt-3 text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "gitGraph.empty.title" })}
            </p>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "gitGraph.empty.description" })}
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" onScroll={handleGraphScroll}>
          <div className="min-h-0 overflow-auto">
            <div
              className="grid min-w-[760px]"
              style={{
                gridTemplateColumns: `minmax(${GRAPH_COLUMN_MIN_WIDTH_PX}px, ${layout.width + 12}px) minmax(0, 1fr)`,
              }}
            >
              <div
                className="border-b border-r border-border bg-surface/60 px-3 py-2 text-ui-base font-medium text-foreground-subtle"
              >
                {intl.formatMessage({ id: "gitGraph.column.graph" })}
              </div>
              <div
                className="grid border-b border-border bg-surface/60 text-ui-base font-medium text-foreground-subtle"
                style={tableColumnStyle}
              >
                <div className="border-r border-border px-3 py-2">
                  {intl.formatMessage({ id: "gitGraph.column.description" })}
                </div>
                <div className="border-r border-border px-3 py-2">
                  {intl.formatMessage({ id: "gitGraph.column.date" })}
                </div>
                <div className="border-r border-border px-3 py-2">
                  {intl.formatMessage({ id: "gitGraph.column.author" })}
                </div>
                <div className="px-3 py-2">
                  {intl.formatMessage({ id: "gitGraph.column.commit" })}
                </div>
              </div>

              <div
                className="relative border-r border-border bg-background-alt/35"
                style={{ height: layout.height + layout.rowHeight }}
              >
                <svg
                  className="absolute inset-0 overflow-visible"
                  width={graphColumnWidth}
                  height={layout.height + layout.rowHeight}
                  viewBox={`0 0 ${graphColumnWidth} ${layout.height + layout.rowHeight}`}
                  role="img"
                  aria-label={intl.formatMessage({ id: "gitGraph.graphAriaLabel" })}
                >
                  {layout.paths.map((path) => (
                    // 路径颜色按 laneIndex 取，透明度由高亮状态决定：无高亮时统一压低，
                    // 有高亮时相关路径拉满、其余进一步压暗，形成「当前提交所在链路」的视觉聚焦。
                    // 透明度走 className 而不是行内样式，避免与主题里的过渡动画互相覆盖。
                    <path
                      key={path.id}
                      d={path.path}
                      className={cn(
                        "fill-none stroke-[2] opacity-55 transition-opacity",
                        getLaneStrokeClass(path.laneIndex),
                        highlightedHash &&
                          !isPathRelated(path, highlightedHash) &&
                          "opacity-30",
                        isPathRelated(path, highlightedHash) && "opacity-100",
                      )}
                    />
                  ))}
                  {layout.rows.map((row) => {
                    // SVG 层与数据行的选中判定共用同一份 hash 比较表达式，两处必须同源，
                    // 否则会出现点变大了但对应行没高亮，或者行高亮而图形毫无变化。
                    const isSelected = row.commit.hash === selectedCommitHash;
                    const isHovered = row.commit.hash === hoveredCommitHash;
                    return (
                      // 以 hash 作 key：同一次刷新内 hash 唯一且稳定，避免用 rowIndex 导致
                      // 顶部插入新提交时所有节点重建、过渡动画整片闪烁。
                      <g key={row.commit.hash}>
                        <circle
                          cx={row.x}
                          cy={row.y}
                          r={isSelected ? SELECTED_NODE_RADIUS : NODE_RADIUS}
                          className={cn(
                            "stroke-background stroke-[2] transition-all",
                            getLaneFillClass(row.laneIndex),
                            highlightedHash && !isSelected && !isHovered && "opacity-80",
                          )}
                        />
                        {isSelected ? (
                          <circle
                            cx={row.x}
                            cy={row.y}
                            r={SELECTED_RING_RADIUS}
                            className={cn(
                              "fill-none stroke-[1] opacity-85",
                              getLaneStrokeClass(row.laneIndex),
                            )}
                          />
                        ) : null}
                      </g>
                    );
                  })}
                </svg>
              </div>

              <div className="min-w-0">
                {layout.rows.map((row) => {
                  const isSelected = row.commit.hash === selectedCommitHash;
                  const isHovered = row.commit.hash === hoveredCommitHash;
                  // 时间格式化放在渲染期而不是布局期：它依赖 locale，
                  // locale 变化时只需重渲染，不必触发昂贵的布局重算。
                  // 每行各调用一次，函数本身是纯的，重复调用不产生副作用，也不做额外缓存。
                  const commitTime = formatCommitTime(row.commit.authoredAtMs, locale);

                  return (
                    // 整行是一个按钮：键盘可达、点击区域覆盖四列，不需要再向外转发事件；
                    // 内层一律用 span，避免在 button 里嵌块级元素或可交互元素破坏无障碍语义。
                    <button
                      key={row.commit.hash}
                      type="button"
                      className={cn(
                        "grid w-full min-w-0 items-center border-y border-transparent text-left transition-colors",
                        "hover:bg-hover focus-visible:bg-hover focus-visible:outline-none",
                        isSelected && "border-b-border bg-selected",
                        isSelected && row.rowIndex > 0 && "border-t-border",
                        isHovered && !isSelected && "bg-surface-hover",
                      )}
                      style={{ ...tableColumnStyle, height: layout.rowHeight }}
                      onClick={() => {
                        // [事务] 点击做两步更新：先上报选中给父级，再本地翻转展开态，顺序不要反，
                        // 展开态用函数式更新读取当前值，避免把闭包里的旧状态写回去；
                        // 若先展开再上报，父级同步抛错时本地与父级的选中、展开会短暂不一致。
                        onSelectCommit(row.commit.hash);
                        setExpandedCommitHash((currentHash) =>
                          currentHash === row.commit.hash ? null : row.commit.hash,
                        );
                      }}
                      onMouseEnter={() => setHoveredCommitHash(row.commit.hash)}
                      onMouseLeave={() => setHoveredCommitHash(null)}
                    >
                      <span className="min-w-0 px-3">
                        <span className="flex min-w-0 items-center gap-2">
                          {row.commit.refs.length > 0 ? (
                            <span className="flex min-w-0 shrink-0 items-center gap-1 overflow-hidden">
                              {row.commit.refs.slice(0, 4).map((ref) => (
                                <span
                                  key={`${row.commit.hash}:${ref.name}`}
                                  className={cn(
                                    "inline-flex h-5 min-w-0 items-center gap-1 rounded-md border border-border bg-surface px-1.5 text-ui-base text-foreground-subtle",
                                    ref.kind === "head" &&
                                      "border-git-descendant bg-selected text-foreground",
                                    ref.kind === "tag" && "border-git-added",
                                  )}
                                >
                                  {getRefIcon(ref, "size-2.5")}
                                  <span className="max-w-32 truncate">{ref.name}</span>
                                </span>
                              ))}
                            </span>
                          ) : null}
                          <span className="truncate text-ui-base text-foreground">
                            {row.commit.subject || getShortHash(row.commit.hash)}
                          </span>
                          {row.commit.parents.length > 1 ? (
                            <GitMergeIcon className="size-3 shrink-0 text-git-renamed" />
                          ) : null}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "truncate border-l border-transparent px-3 text-ui-base text-foreground-subtle",
                          isSelected && "border-border",
                        )}
                      >
                        {commitTime}
                      </span>
                      <span
                        className={cn(
                          "truncate border-l border-transparent px-3 text-ui-base font-medium text-foreground-subtle",
                          isSelected && "border-border",
                        )}
                      >
                        {row.commit.authorName}
                      </span>
                      <span
                        className={cn(
                          "truncate border-l border-transparent px-3 font-mono text-ui-base text-foreground-subtle",
                          isSelected && "border-border",
                        )}
                      >
                        {getShortHash(row.commit.hash)}
                      </span>
                    </button>
                  );
                })}
                {hasMore && onLoadMore ? (
                  <div className="flex h-10 items-center border-b border-border px-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={loadingMore}
                      className="h-7 w-full text-ui-base sm:hidden"
                      onClick={onLoadMore}
                    >
                      {loadingMore
                        ? intl.formatMessage({ id: "gitGraph.loadMore.loading" })
                        : intl.formatMessage({ id: "gitGraph.loadMore" })}
                    </Button>
                    <button
                      type="button"
                      disabled={loadingMore}
                      className="hidden w-full rounded-md px-2 py-1 text-ui-base text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground disabled:cursor-default disabled:opacity-60 sm:block"
                      onClick={onLoadMore}
                    >
                      {loadingMore
                        ? intl.formatMessage({ id: "gitGraph.loadMore.loading" })
                        : intl.formatMessage({ id: "gitGraph.loadMore" })}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
      {expandedCommit ? <GitGraphCommitDetail commit={expandedCommit} /> : null}
    </section>
  );
}
