// changes-group.tsx —— 变更分组摘要：多子调用的文件去重、响应式 chip 截断与运行态摘要
//
// INV-01 两个宽度计算函数是纯函数，只依赖入参，不读 DOM、不读 intl；守住位置：resolveFileChipAvailableWidth 与 resolveResponsiveFileChipCount 函数体；改错故障：混入测量后同一输入在不同滚动位置给出不同可见数，测试与截图都对不上
// INV-02 可用宽度等于 ToolCall 右边界减列表左边界再减尾部预留，且钳到非负；守住位置：resolveFileChipAvailableWidth 的返回值；改错故障：窄屏出现负宽度，后续比较全部失真，chip 被错误地全部隐藏或全部显示
// INV-03 可见数按顺序线性填满可用宽度，下一枚放不下就停止，不回填更窄的后续项；守住位置：resolveResponsiveFileChipCount 的 for 循环；改错故障：跳过某枚 chip 去塞后面的矮项，展示顺序与变更顺序不一致
// INV-04 每枚候选 chip 的所需宽度必须包含它自己之后的那个 gap 和 +N 提示宽度；守住位置：requiredWidth 表达式；改错故障：可见区刚好溢出 8px，+N 被裁掉，用户看不到还有隐藏文件
// INV-05 全部 chip 能放下时直接返回全长，不走逐枚累加；守住位置：allChipsWidth 与 availableWidth 的比较分支；改错故障：边界处少显示一枚，明明放得下却出现 +1
// INV-06 visibleCount 上限为 files.length，渲染前用 Math.min 再次钳制；守住位置：resolvedVisibleCount；改错故障：文件数由多变少时旧计数越界，隐藏数算成负数，页面出现 +-2
// INV-07 hiddenCount 恒等于 files.length 减 resolvedVisibleCount，且大于 0 才渲染 +N；守住位置：hiddenCount 与条件渲染；改错故障：全部可见时仍显示 +0，摘要多出一个无意义片段
// INV-08 隐藏 chip 用 invisible 与 absolute 保留测量宽度，而不是不渲染；守住位置：isVisible 为 false 时的 className；改错故障：一旦隐藏就失去 offsetWidth，重新变宽时无法测量，列表永远停在最少枚数
// INV-09 chipRefs 按 index 写入，与 files 顺序一一对应；守住位置：ref 回调里的下标赋值；改错故障：过滤或重排后 ref 指向错位，测量值与实际节点不符，可见数抖动
// INV-10 测量以最近的 data-tool-call-id 祖先右边界为准，找不到时退回列表自身右边界；守住位置：useLayoutEffect 内 closest 与 boundaryRight；改错故障：summary 自适应收缩后自测宽度越来越小，形成越测越少的负反馈
// INV-11 监听同时挂在 boundary 的 ResizeObserver 与 window resize 上，卸载时两者都解除；守住位置：useLayoutEffect 的清理函数；改错故障：面板折叠后不重算，chip 数量停留在旧宽度对应的值
// INV-12 files 以 fileKey 归一化显示路径去重，同一文件多次编辑只出现一枚 chip；守住位置：files 的 useMemo 与 unique Map；改错故障：同一文件出现两枚 chip，计数虚高且点击后指向不同的 code viewer 源
// INV-13 归一化只把反斜杠换成斜杠，不做大小写折叠；守住位置：fileKey 的 replaceAll；改错故障：Windows 下大小写不同的同一文件被合并或拆分取决于盘符写法，行为不可预测
// INV-14 去重保留首次出现的 summary，后续同键 summary 必须丢弃；守住位置：unique 的 has 判断分支；改错故障：重复编辑把最早一次的旧统计覆盖成新统计，diff 数字与实际不符
// INV-15 hasResolvedFiles 为假时计数口径从文件数切换为分组内 tool 数；守住位置：count 与 countText 的三元；改错故障：流式期间显示 0 files，用户以为变更内容为空
// INV-16 摘要的动作文案与 diff 统计都取自最后一个有文件的子调用；守住位置：latest 的 findLast 与 latestFile；改错故障：文案描述上一个文件而 chip 显示新文件，展开与折叠时信息自相矛盾
// INV-17 运行态 diffCount 只在非 office 模式且 isRunning 时传入，展开后由 hideDiffCountWhenOpen 隐藏；守住位置：ToolLayout 的 diffCount 与 hideDiffCountWhenOpen；改错故障：内嵌视图出现重复增减统计，展开正文后计数与正文并存
// INV-18 summaryContentKey 必须随运行态子调用、动作与文件变化，并随完成态文件集合变化；守住位置：summaryContentKey 模板串；改错故障：内容变了键没变，动画不重放，摘要看起来卡在上一帧
import { PencilIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getFileDisplayPath } from "@/lib/fileDisplay.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { buildEditCodeViewerSource } from "@/ToolCallBlocks/renderers/edit.js";
import {
  readRawToolCallFileSummaries,
  type ToolCallBlockRenderContext,
} from "@/ToolCallBlocks/shared.js";
import {
  getEditKindLabelMessageId,
  renderDiffCount,
  renderFileChip,
  renderFilePath,
} from "@/ToolCallBlocks/renderers.js";

// 模块级常量区：图标元素只创建一次，两个像素值是测量与布局共用的口径
// 图标是稳定的 React 元素，分组内所有实例共享，避免每次渲染新建 PencilIcon
// 图标固定尺寸与前景色，摘要行高度因此不随主题切换而跳动
// FILE_CHIP_GAP_PX 对应容器 className 里的 gap-2，两处必须同为 8
// [权衡] 像素值写成常量而不是读计算样式，换来测量稳定与零强制回流，代价是改 gap 时必须同步改这里
// FILE_CHIP_TRAILING_SPACE_PX 为摘要尾部预留 24px，不预留在测量里就会被尾部元素压住
// 改错故障：gap 常量与 className 不一致时，可见数会比实际多一枚，最后那枚 chip 被裁掉一半
const CHANGES_GROUP_ICON = <PencilIcon className="size-4 shrink-0 text-foreground-subtle" />;
const FILE_CHIP_GAP_PX = 8;
const FILE_CHIP_TRAILING_SPACE_PX = 24;

// 可用宽度计算的契约：右边界减列表左边界，再减尾部预留，最后钳到 0
// 导出而非内联，是因为它是唯一可以单测的几何口径，DOM 测量只负责喂入坐标
// 调用方传整行 ToolCall 的右边界而非列表自身右边界，否则收缩后的测量会自我强化
// [权衡] 用 Math.max 钳到 0 而不是断言非负：布局中间态可能短暂出现负值，断言会让整块白屏
// 钳到 0 后由 resolveResponsiveFileChipCount 走零宽度分支，语义是一枚都放不下
// 三个入参都是数字，函数不读 ref 也不读 intl，因此可安全地在 effect 内每次重算
// 改错故障：忘记减 trailingWidth 时 +N 提示区被挤出容器，隐藏文件数不可见
export function resolveFileChipAvailableWidth({
  boundaryRight,
  listLeft,
  trailingWidth,
}: {
  boundaryRight: number;
  listLeft: number;
  trailingWidth: number;
}) {
  return Math.max(0, boundaryRight - listLeft - trailingWidth);
}

export function resolveResponsiveFileChipCount({
  availableWidth,
  chipWidths,
  overflowWidth,
  gap,
}: {
  availableWidth: number;
  chipWidths: readonly number[];
  overflowWidth: number;
  gap: number;
}) {
  if (chipWidths.length === 0) return 0;
  // 零可用宽度表示当前一枚 chip 都放不下，不能误解为无需裁剪。
  // 返回 0 才会保留完整的 +N 提示，避免窄屏只露出被截断的文件名。
  if (availableWidth <= 0) return 0;
  // 先算全部 chip 连同 gaps 的总宽，能放下就不进入逐枚裁剪循环
  // gap 数量是 chip 数减一，用 Math.max 兜住空数组，避免出现负间距
  // [权衡] 整宽判断与下面的逐枚循环存在重复计算，保留它是为了让全显示这条常见路径提前返回
  // 两者口径必须一致：循环里也是每枚各带一个 gap，区别只是额外计入 overflowWidth
  // 若整宽判断漏掉 gap，边界宽度下会宣称放得下，实际渲染溢出把 +N 顶出可视区
  // 改错故障：整宽比较用小于而不是小于等于，恰好等宽时少显示一枚，出现多余的 +1
  const allChipsWidth =
    chipWidths.reduce((total, width) => total + width, 0) +
    gap * Math.max(0, chipWidths.length - 1);
  if (allChipsWidth <= availableWidth) return chipWidths.length;

  let visibleWidth = 0;
  let visibleCount = 0;
  for (const chipWidth of chipWidths) {
    const nextCount = visibleCount + 1;
    const nextVisibleWidth = visibleWidth + chipWidth;
    // 仍有隐藏项时，布局包含 visible chips、+N 和两者之间的所有 gap。
    const requiredWidth = nextVisibleWidth + gap * nextCount + overflowWidth;
    if (requiredWidth > availableWidth) break;
    visibleWidth = nextVisibleWidth;
    visibleCount = nextCount;
  }
  return visibleCount;
}

type ChangeFileSummary = ReturnType<typeof readRawToolCallFileSummaries>[number];

// 响应式 chip 列表：自行测量每枚宽度，决定显示前 N 枚，其余折叠成 +N
// files 顺序即展示顺序，组件不排序也不做二次去重，上层给什么就渲染什么
// workspacePath 只用于渲染 chip 与生成 code viewer 源，不参与可见数计算
// [资源] chipRefs 是长度随 files 增长的数组 ref，不放进依赖，写入发生在 commit 阶段
// visibleCount 初值是 files.length，首帧全显示，随后 effect 立即按测量收敛
// [权衡] 首帧全显示会有一帧溢出，换来的是不必在挂载前同步测量，也避免首屏留白
// 改错故障：初值写成 0 时首帧只剩 +N，用户先看到一条空摘要再跳变
function ResponsiveFileChipList({
  files,
  workspacePath,
  onOpenCodeViewer,
}: {
  files: readonly ChangeFileSummary[];
  workspacePath: string;
  onOpenCodeViewer: ToolCallBlockRenderContext["onOpenCodeViewer"];
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const chipRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const overflowMeasureRef = useRef<HTMLSpanElement>(null);
  const [visibleCount, setVisibleCount] = useState(files.length);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 在 commit 阶段同步测量：用 layout effect 收敛可见数可以避免用户看见跳动
    // boundary 取最近的 ToolCall 容器，也就是摘要所在整行的外框，它不随 chip 收起而变窄
    // [失败路径] closest 找不到祖先时返回 null，下面的右边界表达式用列表自身矩形兜底，不抛错
    // boundaryRight 是整行右边界，listLeft 是列表左边界，二者相减才是不受收缩影响的真实空间
    // 进入 effect 立即测量一次，不等 ResizeObserver 首次回调，避免首帧用满额计数
    // [资源] observer 观察 boundary 而非列表自身，观察自身会在每次收敛后再次触发形成回调风暴
    // 改错故障：观察列表自身时收缩改变了宽度又触发回调，可见数在 N 与 N-1 之间反复震荡
    const boundary = container.closest<HTMLElement>("[data-tool-call-id]");
    const updateVisibleCount = () => {
      // summary 是 shrink-to-content，按自身宽度测量会在隐藏 chip 后继续收缩。
      // 以整行 ToolCall 的右边界计算，才能稳定得到当前真正可用的空间。
      const containerRect = container.getBoundingClientRect();
      const boundaryRight = boundary?.getBoundingClientRect().right ?? containerRect.right;
      const nextVisibleCount = resolveResponsiveFileChipCount({
        availableWidth: resolveFileChipAvailableWidth({
          boundaryRight,
          listLeft: containerRect.left,
          trailingWidth: FILE_CHIP_TRAILING_SPACE_PX,
        }),
        chipWidths: files.map((_, index) => chipRefs.current[index]?.offsetWidth ?? 0),
        overflowWidth: overflowMeasureRef.current?.offsetWidth ?? 0,
        gap: FILE_CHIP_GAP_PX,
      });
      setVisibleCount((current) => (current === nextVisibleCount ? current : nextVisibleCount));
    };
    updateVisibleCount();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateVisibleCount);
    observer.observe(boundary ?? container);
    window.addEventListener("resize", updateVisibleCount);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateVisibleCount);
    };
  }, [files]);

  const resolvedVisibleCount = Math.min(visibleCount, files.length);
  const hiddenCount = files.length - resolvedVisibleCount;
  return (
    <span
      ref={containerRef}
      className="relative inline-flex min-w-0 max-w-full flex-1 items-center gap-2 overflow-hidden"
    >
      {files.map((summary, index) => {
        const isVisible = index < resolvedVisibleCount;
        return (
          <span
            // chip 的 key 直接取 summary.path 原始字符串，去重发生在上层，这里不再归一化
            // files 已按 fileKey 去重，同一路径最多出现一次，键冲突意味着去重口径被改坏
            // key 不用数组下标：隐藏与显示会改变节点集合，下标会让 React 复用错节点并保留旧 ref
            // [失败路径] 若出现重复 path，React 丢弃其中一枚，视觉上文件无故消失且 +N 数量对不上
            // 点击目标由 buildEditCodeViewerSource 从 summary 现算，不复用行级 toolCall，保证跳对文件
            // isVisible 同时控制可点与 aria-hidden，隐藏 chip 保留 DOM 但不进读屏与 tab 序列
            // 改错故障：隐藏 chip 仍可点击时用户点到不可见的文件，编辑器打开的内容与摘要不符
            key={summary.path}
            ref={(element) => {
              chipRefs.current[index] = element;
            }}
            aria-hidden={isVisible ? undefined : true}
            className={
              isVisible
                ? "inline-flex min-w-0 shrink-0"
                : "pointer-events-none invisible absolute inline-flex shrink-0"
            }
          >
            {renderFileChip({
              summary,
              clickable: isVisible && Boolean(onOpenCodeViewer),
              basePath: workspacePath,
              onClick: () => onOpenCodeViewer?.(buildEditCodeViewerSource(summary)),
            })}
          </span>
        );
      })}
      {hiddenCount > 0 ? <span className="shrink-0">+{hiddenCount}</span> : null}
      <span
        ref={overflowMeasureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute shrink-0"
      >
        +{files.length}
      </span>
    </span>
  );
}

// 变更分组块：把多个 Write 或 Edit 子调用聚合成一条摘要，展开后逐个渲染原始 block
// ToolCallBlock 取自嵌套渲染器，本组件不自建递归渲染器，避免分组套分组时无限递归
// [权衡] childSummaries 按 childToolCalls 重算而不缓存进 context，代价是父层换数组就要重算，换来与子调用列表严格同源
// files 与 countText 都在本组件内派生，父层只负责传入 toolCallNode、主题与回调
// 运行态与完成态走两套摘要：运行态展示最新文件与动作，完成态展示文件总数与 chip 列表
// 折叠开关由 ToolLayout 承担，本组件只传 canToggle、forceOpen 与渲染内容
// [失败路径] office 模式下强制关闭折叠并隐藏 diffCount，避免内嵌视图出现两套展开控件
// 改错故障：office 模式下仍传 canToggle 时，内嵌文档里出现一个点了没反应的折叠箭头
export function ChangesGroupToolCallBlock(context: ToolCallBlockRenderContext) {
  const ToolCallBlock = context.nestedToolRenderer;
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const childSummaries = useMemo(
    () =>
      childToolCalls.map((child) => ({
        child,
        summaries: readRawToolCallFileSummaries(child.toolCall.raw, child.toolCall),
      })),
    [childToolCalls],
  );
  const files = useMemo(() => {
    const unique = new Map<string, ReturnType<typeof readRawToolCallFileSummaries>[number]>();
    for (const entry of childSummaries) {
      for (const summary of entry.summaries) {
        // 去重键：显示路径先经 getFileDisplayPath 转成相对工作区或绝对的展示形式，再统一分隔符
        // 只把反斜杠换成斜杠，不折叠大小写，也不解析上级目录与符号链接，保持与展示完全一致
        // [权衡] 用展示路径而非原始绝对路径做键，是为了与 chip 上看到的文字同源，代价是工作区变化时键会变
        // 因此在同一工作区的同一轮渲染里键稳定，跨工作区比较没有意义
        // 大小写敏感的文件系统上 Foo.ts 与 foo.ts 是两份文件，这里必须保持区分
        // [失败路径] 若在 Windows 上做小写折叠，会合并不应合并的两份文件，diff 统计少算一份
        // 改错故障：键里残留反斜杠时同一文件产生两个键，摘要里出现两枚同名 chip
        const fileKey = getFileDisplayPath(summary.path, context.workspacePath).replaceAll(
          "\\",
          "/",
        );
        if (!unique.has(fileKey)) unique.set(fileKey, summary);
      }
    }
    return [...unique.values()];
  }, [childSummaries, context.workspacePath]);
  const latest = childSummaries.findLast((entry) => entry.summaries.length > 0);
  const latestFile = latest?.summaries.at(-1);
  const hasResolvedFiles = files.length > 0;
  const count = hasResolvedFiles ? files.length : childToolCalls.length;
  // Write/Edit 的流式 JSON 可能先到 content、后到 file_path。
  // 路径尚不可解析时按已进入分组的 tool 计数，避免悬空分隔符和误导性的 0 files。
  const countText = intl.formatMessage(
    {
      id: hasResolvedFiles
        ? files.length === 1
          ? "chat.toolCall.changesGroup.file.one"
          : "chat.toolCall.changesGroup.file.other"
        : count === 1
          ? "chat.toolCall.changesGroup.tool.one"
          : "chat.toolCall.changesGroup.tool.other",
    },
    { count: String(count) },
  );
  const actionText = latest
    ? intl.formatMessage({
        id: getEditKindLabelMessageId(
          latest.summaries.map((summary) => summary.operationKind),
          latest.summaries.map((summary) => summary.actionLabel),
          true,
          latest.child.toolCall,
        ),
      })
    : null;
  const fileList = useMemo(
    () => (
      <ResponsiveFileChipList
        files={files}
        workspacePath={context.workspacePath}
        onOpenCodeViewer={context.onOpenCodeViewer}
      />
    ),
    [context.onOpenCodeViewer, context.workspacePath, files],
  );
  const completedSummary = useMemo(
    () =>
      files.length === 1 ? (
        fileList
      ) : (
        <span className="inline-flex min-w-0 max-w-full flex-1 items-center gap-2">
          <span className="shrink-0">{countText}</span>
          {files.length > 0 ? (
            <>
              <span>·</span>
              {fileList}
            </>
          ) : null}
        </span>
      ),
    [countText, fileList, files.length],
  );
  const runningPrimaryText = useMemo(
    () => <span className="shrink-0">{countText}</span>,
    [countText],
  );
  const runningSecondaryText = useMemo(
    () =>
      latestFile ? (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-foreground-subtlest">·</span>
          {actionText ? (
            <span className="shrink-0 text-foreground-subtle">{actionText}</span>
          ) : null}
          {renderFileChip({
            summary: latestFile,
            basePath: context.workspacePath,
          })}
          {renderFilePath(latestFile.filePath, context.workspacePath)}
        </span>
      ) : undefined,
    [actionText, context.workspacePath, latestFile],
  );
  // 运行态 diff 计数只针对最新文件，统计口径完全交给 renderDiffCount，本组件不自算
  // changeStat 是增删行的聚合结果，二进制文件没有行数概念，计数会退化为文件级提示
  // [权衡] animateInitial 打开是为了让流式增长的计数有动画，完成态不传，避免折叠时重复播放
  // diffCount 只在 isRunning 时挂到 ToolLayout 上，完成态改为在展开正文里逐文件展示
  // [失败路径] changeStat 缺失时 renderDiffCount 返回 null，摘要右侧不留空白占位
  // 改错故障：对同一份 changeStat 同时渲染运行态计数与展开正文，用户看到两份不同的数字
  const runningDiffCount = useMemo(
    () => renderDiffCount(latestFile?.changeStat, { animateInitial: true }),
    [latestFile?.changeStat],
  );
  const renderContent = useCallback(
    () => (
      <div className="ml-2 space-y-2 border-border border-l pl-3.5">
        {childToolCalls.map((child) => (
          <ToolCallBlock
            key={child.toolCall.toolId}
            toolCallNode={child}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            showIcon={false}
            animateDiffCountOnMount
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenAutomationsMain={context.onOpenAutomationsMain}
            onLoadFullToolCallFields={context.onLoadFullToolCallFields}
          />
        ))}
      </div>
    ),
    [
      childToolCalls,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.onOpenAutomationsMain,
      context.onLoadFullToolCallFields,
      context.theme,
      context.codePreviewSettings,
      context.workspacePath,
    ],
  );
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={CHANGES_GROUP_ICON}
      canToggle={!context.isOfficeMode && (context.canToggle ?? true)}
      forceOpen={!context.isOfficeMode && (context.forceOpen ?? false)}
      kindLabel={intl.formatMessage({ id: "chat.toolCall.changesGroup.label" })}
      primaryText={context.isRunning ? runningPrimaryText : completedSummary}
      secondaryText={context.isRunning ? runningSecondaryText : undefined}
      summaryContentSeparator="·"
      expandedPrimaryText={countText}
      expandedSecondaryText={null}
      diffCount={!context.isOfficeMode && context.isRunning ? runningDiffCount : undefined}
      hideDiffCountWhenOpen
      animateSummaryContent={context.isRunning}
      disableSummaryContentAnimation={context.disableSummaryContentAnimation}
      // 摘要内容的动画键：运行态由子调用标识、动作文案与最新文件三段拼成，任一变化都重放过渡
      // 完成态退化为文件路径集合的拼接，文件增减或改名都会换键，保证 chip 进出动画正确
      // [权衡] 键里放整段路径串会让长列表产生很长的字符串，换来的是无需额外比较即可判定内容变化
      // 运行态用最新子调用的标识而不是文件路径：同一文件被多次编辑时仍能触发过渡
      // [失败路径] latest 尚未产出时用固定占位符，避免键在首帧为空值而触发额外的重挂载
      // 改错故障：键不含动作文案时动作从写入变成编辑不重放动画，摘要看起来没有响应
      summaryContentKey={`changes:${toolCall.toolId}:${context.isRunning ? `${latest?.child.toolCall.toolId ?? "running"}:${actionText ?? "changing"}:${latestFile?.path ?? "file"}` : files.map((file) => file.path).join("|")}`}
      isRunning={context.isRunning}
      title={toolCall.title}
      renderContent={renderContent}
    />
  );
}
