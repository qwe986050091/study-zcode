// ===== ToolCallBlocks/renderers/edit.tsx —— Edit 工具调用块的展示投影 =====
// 职责边界：把 rawFileSummaries 描述的「这次 edit 改了哪些文件、每个文件多少增删」
// 投影成 ToolLayout 摘要行与展开区；单文件走内联 diff 预览，多文件拆成逐文件子块。
// 明确不做：不解析 patch 正文、不裁剪超大 diff、不计算真实行号、不发起文件读取、
// 不持有折叠状态、不写 store 与服务。patch 文本一律转交 EditInlineDiffContent 渲染。
// 输入契约：context 提供 toolCallNode、rawFileSummaries、isRunning、statusLabel、
// errorText、onOpenCodeViewer、workspacePath、theme、codePreviewSettings、displayModel。
// 输出契约：一个可折叠的 ToolLayout；多文件时子块数与 rawFileSummaries 长度逐一对应。
//
// INV 表（每条断言都是本文件对外承诺的可见行为，破坏即回归）：
// INV-01 断言：rawFileSummaries 为空时退回 ToolCallBody 全量渲染 —— 守住它的位置：renderContent 的首个三元分支 —— 改错故障：失败的 edit 变成空白卡片，输入与输出都看不到。
// INV-02 断言：有 patch 的单文件必须出现内联 diff —— 守住它的位置：buildEditInlinePreview 的 patch 判定 —— 改错故障：展开后只剩输入输出，看不到改了哪几行。
// INV-03 断言：单文件 patch 只被渲染一次 —— 守住它的位置：ToolCallBody 的 inlinePreviewOverride 传 none —— 改错故障：同一段 diff 在展开区出现两份。
// INV-04 断言：多文件时每个文件一个小块且顺序与摘要一致 —— 守住它的位置：renderContent 的多文件遍历分支 —— 改错故障：文件顺序跳变，用户对错文件。
// INV-05 断言：多文件子块的 key 由 path 加下标构成 —— 守住它的位置：EditFileSummaryBlock 调用处的 key 表达式 —— 改错故障：同 path 重复时子块被复用，diff 串台。
// INV-06 断言：多文件主块只显示总览并收起总 diff 计数 —— 守住它的位置：hideDiffCountWhenOpen 传 hasMultipleFiles —— 改错故障：总览与子块各报一次增删，数字被重复阅读。
// INV-07 断言：总增删为各文件累加，缺 changeStat 的文件按零计 —— 守住它的位置：totalChangeStat 的聚合 —— 改错故障：一个文件缺统计就让整卡计数变成 NaN。
// INV-08 断言：diff 计数动画只在首次挂载播放 —— 守住它的位置：animateDiffCountOnMount 透传给 renderDiffCount —— 改错故障：每次重渲染数字都在跳，消息流闪烁。
// INV-09 断言：失败状态取 toolCall.status、raw.status 与 errorText 三者之或 —— 守住它的位置：isFailed 的合并判断 —— 改错故障：子块已经报错而主块仍显示运行中。
// INV-10 断言：失败时状态文案与 tooltip 都切到失败语义 —— 守住它的位置：effectiveStatusLabel 与 statusTooltip —— 改错故障：红点旁边写着「运行中」，用户误判仍在执行。
// INV-11 断言：打开预览的路径必须用 path 而不是 filePath —— 守住它的位置：buildEditCodeViewerSource 的 patch 分支 —— 改错故障：side pane 按目录解析图标，diff 标签退回通用文件图标。
// INV-12 断言：没有 onOpenCodeViewer 时 chip 不可点 —— 守住它的位置：clickable 由 onOpenCodeViewer 求布尔 —— 改错故障：出现可点样式却点了没反应。
// INV-13 断言：单文件才显示二级路径，多文件不重复长路径 —— 守住它的位置：secondaryText 的长度判定 —— 改错故障：多文件摘要行被多条路径撑开换行。
// INV-14 断言：Office 模式下禁用折叠与 diff 计数 —— 守住它的位置：ToolLayout 的 canToggle 与 diffCount 覆写 —— 改错故障：办公面板里出现点了无效的折叠箭头。
// INV-15 断言：快照字段缺失时给出补载入口而不静默丢失 —— 守住它的位置：ToolSnapshotFieldNotice 的三处挂载 —— 改错故障：旧会话里的 edit 永远看不到完整字段。
//
// 阅读顺序：常量 → 失败判定 → 预览源构造 → 主块 EditToolCallBlock → 子块 EditFileSummaryBlock。
// 注释只描述现有行为，字段名以当前源码为准；改动逻辑时请同步订正对应 INV。
/* eslint-disable max-lines -- Edit 工具块同时维护单文件、多文件子块和 diff 预览引用稳定性；当前变更先保持同文件收口，避免为行数拆分引入展示回归。 */
import { PencilIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { getFileDisplayPath } from "@/lib/fileDisplay.js";
import type { ToolInlinePreview } from "@/lib/toolDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { EditInlineDiffContent } from "@/ToolCallBlocks/renderers/EditInlineDiffContent.js";
import {
  getEditKindLabelMessageId,
  renderDiffCount,
  renderFilePath,
  renderJoinedFileChips,
  renderFileChip,
  type EditKindSource,
} from "../shared.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// [契约] 图标与两套布局常量是纯静态值，不随 context 变化，放在模块顶层避免每次渲染新建对象。
// [权衡] 两套常量目前内容相同但语义不同：单文件布局将来可能开 autoOpen，子块必须保持手动态。
const EDIT_TOOL_ICON = <PencilIcon className="size-4 shrink-0 text-foreground-subtle" />;

// [契约] 单文件默认只允许折叠、不强制展开：完整 patch 可能很长，让用户自己决定是否铺开。
// [失败路径] 若把 forceOpen 改成 true，长 patch 会顶开整条消息流，用户失去滚动上下文。
const EDIT_SINGLE_LAYOUT = {
  canToggle: true,
  forceOpen: false,
} as const;

// [契约] 多文件子块必须可独立折叠：一次 edit 可能改十几个文件，全部展开会把消息流撑爆。
// [权衡] 子块不设 autoOpen，避免刚进入会话就连开多个 diff。
const EDIT_CHILD_LAYOUT = {
  canToggle: true,
  forceOpen: false,
} as const;

// [失败路径] 部分后端只在 toolCall.raw 里落 status，外层 status 仍是成功，这里补一次原始字段判定。
// [契约] 只认字符串 failed，其他形态一律视为未失败，避免脏历史数据把卡片染红。
// [边界] 数组也是 object，必须显式排除，否则数组上的 status 会被误读成失败标记。
function isRawToolCallFailed(raw: unknown) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }

  // [边界] 空值与数组已在上面挡掉，这里可以安全解构，解构出的 status 仍是 unknown。
  // [失败路径] 缺失 status 时返回假值，让外层继续用 toolCall.status 决定展示。
  const { status } = raw as { status?: unknown };
  return typeof status === "string" && status === "failed";
}

// [契约] 预览源构造的唯一入口：主块、单个文件 chip 与子块都走这里，保证 title 与 path 口径一致。
// [事务] 纯函数，无缓存无副作用，同一 summary 多次调用得到结构相等的结果。
// [权衡] title 用 fileName 而不是 filePath，只为让 tab 标题短，path 才是可打开的定位信息。
export function buildEditCodeViewerSource(
  summary: NonNullable<ToolCallBlockRenderContext["rawFileSummaries"]>[number],
): CodeViewerSource {
  // [失败路径] 空 patch 分支：没有 diff 正文时不能伪造 patch 源，否则 diff 面板会渲染出一片空行。
  // [契约] 降级为 file 类型但仍带真实 path，点击后按普通文件打开，至少能看到当前内容。
  // [边界] patch 为空串与缺失走同一分支，展示层不区分全删与无内容。
  if (!summary.patch) {
    return {
      type: "file",
      title: summary.fileName,
      path: summary.path,
    };
  }

  // [契约] patch 源的 title 与 path 必须直接取自 summary，不得拼接展示用路径。
  // [边界] 这里不再判断 patch 是否空白，上游空分支已经处理。
  return {
    type: "patch",
    title: summary.fileName,
    // summary.filePath 是 fileDisplay 生成的目录展示路径，不是可打开的文件路径。
    // 传给 side pane 后会按目录解析图标，导致 .ts/.tsx diff tab 退回通用文件图标。
    path: summary.path,
    patch: summary.patch,
  };
}

// [契约] 把单个文件摘要转成展开区使用的 diff 预览，多文件时由调用方传 null 并得到 undefined。
// [并发] 结果只由 summary.patch 决定，与运行状态、主题无关，可在渲染期中安全调用。
// [权衡] 不做 patch 截断：超大 diff 的截断与查看完整 diff 交由 EditInlineDiffContent 负责。
function buildEditInlinePreview(
  summary: NonNullable<ToolCallBlockRenderContext["rawFileSummaries"]>[number] | null,
): ToolInlinePreview | undefined {
  // [失败路径] 无摘要或无 patch 一律不产出预览，让 ToolCallBody 保持默认呈现。
  // [契约] 返回 undefined 是本函数唯一的否定出口，调用方以可选链判断。
  // [边界] 空串 patch 与缺失 patch 同档处理，避免出现空 diff 面板。
  if (!summary?.patch) {
    return undefined;
  }

  // edit 摘要层已经能从 rawFileSummaries 拿到单文件 patch，
  // 但展开区之前只认 displayModel.inlinePreview，导致卡片自动展开后看不到 diff preview。
  // 这里把当前文件的 patch 直接转成 content 里的 diff 块，避免 ToolCallBody 再次抢走这份预览。
  // [契约] 复用 buildEditCodeViewerSource，避免主块与展开区对 path 字段出现第二套理解。
  // [边界] 紧接着的类型判定是兜底：空 patch 时该函数只会给出 file 源。
  const source = buildEditCodeViewerSource(summary);
  // [失败路径] 类型收窄失败即放弃预览，宁可不显示也不把 file 源塞进 diff 组件。
  // [契约] 该判断同时为 TypeScript 收窄 source，下面的 patch 字段访问才成立。
  if (source.type !== "patch") {
    return undefined;
  }

  return {
    type: "patch",
    source,
  };
}

// [契约] 主块负责三件事：摘要行文案、失败状态合并、展开区内容选择。
// [契约] 展示数据全部由 context 与 rawFileSummaries 推导，组件内不建第二份业务状态。
// [并发] 折叠状态由 ToolLayout 内部持有，本组件重渲染不会重置用户已展开的块。
// [资源] 多个 useMemo 与 useCallback 依赖 rawFileSummaries 引用，上游需保持摘要数组稳定。
export function EditToolCallBlock(context: ToolCallBlockRenderContext) {
  // [契约] 所有用户可见文案都走 intl，包括失败状态与多文件数量，禁止硬编码中文。
  // [边界] intl 实例只在渲染期取用，不参与对外状态缓存。
  const { intl } = useZCodeIntl();
  const { toolCallNode, rawFileSummaries, isRunning, statusLabel, errorText, onOpenCodeViewer } =
    context;
  const { toolCall } = toolCallNode;
  // [契约] 文件数大于一才走多文件分支，等于一与等于零是两条完全不同的渲染路径。
  // [边界] 摘要为空不能当成单文件缺数据，否则会渲染出没有 patch 的空块。
  const hasMultipleFiles = rawFileSummaries.length > 1;
  // [失败路径] 三个来源合并：外层状态、原始字段、上游错误文案，任一命中即失败。
  // [契约] errorText 出现也算失败，因为能拿到错误文本说明这一轮已经终止。
  // [权衡] 失败不改变摘要内容，只改颜色、文案与 tooltip，避免历史信息丢失。
  const isFailed =
    toolCall.status === "failed" || isRawToolCallFailed(toolCall.raw) || Boolean(errorText);
  // [契约] 失败文案在此覆盖 statusLabel，而不是在 ToolLayout 里再做一次判断。
  // [边界] 未失败时原样透传 statusLabel，包括运行中与完成态。
  const effectiveStatusLabel = isFailed
    ? intl.formatMessage({ id: "chat.toolCall.status.failed" })
    : statusLabel;
  // [资源] 回调只依赖 onOpenCodeViewer，文件数不变时 chip 的点击处理保持同一引用。
  // [失败路径] 上游未提供打开能力时直接结束，不产出无效的预览请求。
  // [契约] 实际打开动作统一走 buildEditCodeViewerSource，保证 file 与 patch 两种源一致。
  const openFilePreview = useCallback(
    (summary: NonNullable<ToolCallBlockRenderContext["rawFileSummaries"]>[number]) => {
      // [失败路径] 缺少打开回调时静默结束，避免把空值传给下游造成运行时异常。
      // [契约] 该早退与 clickable 判定同源，保证看起来可点与点得动保持一致。
      if (!onOpenCodeViewer) {
        return;
      }

      onOpenCodeViewer(buildEditCodeViewerSource(summary));
    },
    [onOpenCodeViewer],
  );

  // [契约] 主文案：多个文件渲染为可点击 chip 列表，单个文件同样复用 chip 渲染工具。
  // [边界] 摘要为空时给 null 而不是空串，ToolLayout 才能退回默认标题。
  // [资源] 依赖里带上 workspacePath，切换工作区后相对路径展示会同步刷新。
  const primaryText = useMemo(
    () =>
      rawFileSummaries.length > 0
        ? renderJoinedFileChips(rawFileSummaries, {
            clickable: Boolean(onOpenCodeViewer),
            basePath: context.workspacePath,
            onClick: openFilePreview,
          })
        : null,
    [context.workspacePath, onOpenCodeViewer, openFilePreview, rawFileSummaries],
  );
  // [契约] 二级文案只在单文件时给出完整路径，多文件时保持 undefined 让位给总览。
  // [边界] 单个摘要的 filePath 可能缺失，由渲染工具负责回退。
  const secondaryText = useMemo(
    () =>
      rawFileSummaries.length === 1
        ? renderFilePath(rawFileSummaries[0]?.filePath, context.workspacePath)
        : undefined,
    [context.workspacePath, rawFileSummaries],
  );
  // [事务] 总增删是一次性聚合：遍历所有摘要，缺 changeStat 的文件按零计入，不做平均。
  // [失败路径] 直接累加可选字段会得到 NaN，因此必须逐项判断后再相加。
  // [契约] 初始值固定为零增零删，空列表也返回稳定对象，供 diff 计数渲染。
  const totalChangeStat = useMemo(
    () =>
      rawFileSummaries.reduce(
        (acc, summary) => {
          if (!summary.changeStat) {
            return acc;
          }

          return {
            added: acc.added + summary.changeStat.added,
            removed: acc.removed + summary.changeStat.removed,
          };
        },
        { added: 0, removed: 0 },
      ),
    [rawFileSummaries],
  );
  // [资源] 动画开关只在挂载时有效，重渲染不会重播数字滚动。
  // [权衡] 计数文案由共享渲染工具生成，保证与其它工具卡片的视觉一致。
  const diffCount = useMemo(
    () =>
      renderDiffCount(totalChangeStat, {
        animateInitial: context.animateDiffCountOnMount,
      }),
    [context.animateDiffCountOnMount, totalChangeStat],
  );
  // [契约] 动作标签由文件操作类型、动作文案与运行状态共同决定，单文件与多文件共用同一推导。
  // [边界] 这里额外把 toolCall 的 kind、title、input、output、raw 传给推导，用于兜底识别。
  // [失败路径] 推导落空时消息 id 仍会退到通用编辑文案，不至于整块不渲染。
  const kindLabel = intl.formatMessage({
    id: getEditKindLabelMessageId(
      rawFileSummaries.map((summary) => summary.operationKind),
      rawFileSummaries.map((summary) => summary.actionLabel),
      isRunning,
      {
        kind: toolCall.kind,
        title: toolCall.title,
        input: toolCall.input,
        output: toolCall.output,
        raw: toolCall.raw,
      } satisfies EditKindSource,
    ),
  });
  // [契约] 多文件固定 autoOpen 为假：一次改动多个文件时默认收起，避免首屏被 diff 淹没。
  // [并发] 折叠状态归 ToolLayout，本组件只给初始配置，重渲染不会强行改变已展开状态。
  // [权衡] 单文件复用顶层常量，减少每次渲染新建对象带来的引用抖动。
  // [边界] 多文件分支的对象字面量每次渲染都会新建，故只用于透传，不进入依赖数组。
  const layoutConfig = hasMultipleFiles
    ? {
        canToggle: true,
        forceOpen: false,
        autoOpen: false,
      }
    : EDIT_SINGLE_LAYOUT;
  // [契约] 多文件展开后把 chip 列表换成一句本地化的文件数量说明，避免长列表占满头部。
  // [边界] 单文件展开后仍显示原 chip，保持可点击打开的入口。
  const expandedPrimaryText = useMemo(
    () =>
      rawFileSummaries.length > 1 ? (
        <span>
          {intl.formatMessage(
            { id: "chat.toolCall.edit.multipleFiles" },
            { count: String(rawFileSummaries.length) },
          )}
        </span>
      ) : (
        primaryText
      ),
    [intl, primaryText, rawFileSummaries.length],
  );
  // [契约] 只有恰好一个文件时才构造内联预览，多文件的预览挂在各自的子块里。
  // [资源] 该结果是对象并进入 renderContent 的依赖数组，摘要不变时保持同一引用。
  // [边界] 零文件时显式传 null，与有文件但无 patch 区分开。
  const singleFileInlinePreview = buildEditInlinePreview(
    rawFileSummaries.length === 1 ? (rawFileSummaries[0] ?? null) : null,
  );
  // [契约] 快照补载入口由上层注入，本组件只负责把 toolId 绑定到回调。
  // [失败路径] 上游未提供时传 undefined，通知组件会隐藏补载按钮而不是报错。
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  // [契约] 展开区三段分支：零文件退回通用正文、多文件拆子块、单文件挂内联 diff。
  // [事务] 多文件分支只渲染一份总览与逐文件子块，子块 key 用 path 加下标，重排时仍能稳定复用。
  // [边界] 零文件分支同时保留快照补载通知，失败或旧会话里仍能看到字段缺失提示。
  // [权衡] 子块使用 toolId 加下标的展示 id，与主块区分，折叠状态互不干扰。
  const renderContent = useCallback(
    () =>
      rawFileSummaries.length === 0 ? (
        // Fallback for edit tools without raw file summaries (e.g., failed edits)
        <>
          <ToolCallBody
            childToolList={null}
            displayModel={context.displayModel}
            toolCall={toolCall}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
          <ToolSnapshotFieldNotice
            refs={toolCall.snapshotRefs ?? []}
            onLoadFullToolCallFields={
              handleLoadFullToolCallFields
                ? () => handleLoadFullToolCallFields(toolCall.toolId)
                : undefined
            }
          />
        </>
      ) : (
        <>
          {hasMultipleFiles ? (
            <div className="ml-2 space-y-2 border-border border-l pl-3.5 border-border">
              {/* 多文件 edit 的主体只展示一份总览，下面把每个文件拆成独立块，
              这样既能保留总 diff 预览，也能满足“每个文件一个 edit block”的展示。 */}
              {rawFileSummaries.map((summary, index) => (
                <EditFileSummaryBlock
                  key={`${summary.path}:${index}`}
                  summary={summary}
                  isRunning={isRunning}
                  statusLabel={effectiveStatusLabel}
                  errorText={errorText}
                  toolId={`${toolCall.toolId}:${index}`}
                  isFailed={isFailed}
                  onOpenCodeViewer={context.onOpenCodeViewer}
                  onOpenFileLink={context.onOpenFileLink}
                  onOpenBrowserUrl={context.onOpenBrowserUrl}
                  childToolList={null}
                  displayModel={context.displayModel}
                  toolCall={toolCall}
                  workspacePath={context.workspacePath}
                  theme={context.theme}
                  codePreviewSettings={context.codePreviewSettings}
                  animateDiffCountOnMount={context.animateDiffCountOnMount}
                  showIcon={false}
                  sourceLabel={context.sourceLabel}
                />
              ))}
              <ToolSnapshotFieldNotice
                refs={toolCall.snapshotRefs ?? []}
                onLoadFullToolCallFields={
                  handleLoadFullToolCallFields
                    ? () => handleLoadFullToolCallFields(toolCall.toolId)
                    : undefined
                }
              />
            </div>
          ) : (
            <div className="space-y-3">
              {singleFileInlinePreview?.type === "patch" ? (
                // edit 的 diff 预览需要直接挂在 content 里，避免 ToolCallBody 再次接管 inlinePreview
                // 后把单文件 patch 吃掉，导致展开后只剩输入/输出而看不到真正的变更内容。
                <EditInlineDiffContent
                  preview={singleFileInlinePreview.source}
                  theme={context.theme}
                  codePreviewSettings={context.codePreviewSettings}
                />
              ) : null}
              <ToolCallBody
                childToolList={context.childToolList}
                displayModel={context.displayModel}
                inlinePreviewOverride={
                  singleFileInlinePreview?.type === "patch" ? { type: "none" } : undefined
                }
                toolCall={toolCall}
                workspacePath={context.workspacePath}
                theme={context.theme}
                codePreviewSettings={context.codePreviewSettings}
                onOpenCodeViewer={context.onOpenCodeViewer}
                onOpenFileLink={context.onOpenFileLink}
                onOpenBrowserUrl={context.onOpenBrowserUrl}
              />
              <ToolSnapshotFieldNotice
                refs={toolCall.snapshotRefs ?? []}
                onLoadFullToolCallFields={
                  handleLoadFullToolCallFields
                    ? () => handleLoadFullToolCallFields(toolCall.toolId)
                    : undefined
                }
              />
            </div>
          )}
        </>
      ),
    [
      context.childToolList,
      context.codePreviewSettings,
      context.displayModel,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.sourceLabel,
      context.theme,
      context.workspacePath,
      effectiveStatusLabel,
      errorText,
      handleLoadFullToolCallFields,
      hasMultipleFiles,
      isFailed,
      isRunning,
      rawFileSummaries,
      singleFileInlinePreview,
      toolCall,
    ],
  );

  // [契约] 主块只做透传：图标、布局、文案、计数、状态与内容全部由上面推导好的值决定。
  // [边界] Office 模式下同时关掉折叠与 diff 计数，其它模式保持原行为。
  // [权衡] prioritizePrimaryText 让文件名优先占位，路径与计数在空间不足时先让位。
  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={EDIT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        // edit 的 diff 预览挂在 content 里；单文件和子文件如果不可展开，
        // 用户只能看到摘要行，无法在消息流里直接查看变更。
        {...layoutConfig}
        canToggle={!context.isOfficeMode && layoutConfig.canToggle}
        forceOpen={!context.isOfficeMode && layoutConfig.forceOpen}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        prioritizePrimaryText
        expandedPrimaryText={expandedPrimaryText}
        secondaryText={secondaryText}
        diffCount={context.isOfficeMode ? undefined : diffCount}
        hideDiffCountWhenOpen={hasMultipleFiles}
        statusLabel={effectiveStatusLabel}
        statusTooltip={isFailed ? errorText : undefined}
        showFailureStatus={isFailed}
        isRunning={isRunning}
        title={toolCall.title}
        renderContent={renderContent}
      />
      {/* <pre className="text-[8px]">{JSON.stringify(toolCall, null, 2)}</pre> */}
    </>
  );
}

// [契约] 子块是单文件视图：自带 kind 标签、路径、diff 计数与自己的一份展开内容。
// [并发] 每个子块的折叠状态独立，展开一个不会带动其它文件。
// [资源] 与主块共用同一个预览构造与 diff 渲染组件，避免出现两套 diff 外观。
// [边界] showIcon 与 animateDiffCountOnMount 都有默认值，多文件调用处按需覆盖。
function EditFileSummaryBlock({
  summary,
  isRunning,
  statusLabel,
  errorText,
  toolId,
  isFailed,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
  childToolList,
  displayModel,
  toolCall,
  workspacePath,
  theme,
  codePreviewSettings,
  showIcon = true,
  sourceLabel,
  animateDiffCountOnMount = false,
}: {
  summary: NonNullable<ToolCallBlockRenderContext["rawFileSummaries"]>[number];
  isRunning: boolean;
  statusLabel: string;
  errorText?: string;
  toolId: string;
  isFailed: boolean;
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
  childToolList: ToolCallBlockRenderContext["childToolList"];
  displayModel: ToolCallBlockRenderContext["displayModel"];
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"];
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  showIcon?: boolean;
  sourceLabel?: string;
  animateDiffCountOnMount?: boolean;
}) {
  // [契约] 子块的标签只按自身摘要推导，不带入同批其它文件的操作类型。
  // [边界] 子块除 isRunning 外不接收全局状态，失败与否由父级算好传入。
  const { intl } = useZCodeIntl();
  const kindLabel = intl.formatMessage({
    id: getEditKindLabelMessageId([summary.operationKind], [summary.actionLabel], isRunning),
  });
  // [契约] 子块的预览同样走统一构造，无 patch 时得到 undefined，正文退回通用渲染。
  // [资源] 该值直接进入内容回调依赖，摘要变化即重建内容。
  const inlinePreviewOverride = buildEditInlinePreview(summary);
  // [失败路径] 缺少打开回调时静默结束，子块 chip 的点击不会产生副作用。
  // [资源] 依赖 summary 与打开回调，摘要对象变化时重建。
  const openFilePreview = useCallback(() => {
    if (!onOpenCodeViewer) {
      return;
    }

    onOpenCodeViewer(buildEditCodeViewerSource(summary));
  }, [onOpenCodeViewer, summary]);
  // [契约] 子块主文案是单个文件 chip，与主块的多文件列表共用同一渲染工具。
  // [边界] 是否可点仍由打开回调是否存在决定。
  const primaryText = useMemo(
    () =>
      renderFileChip({
        summary,
        clickable: Boolean(onOpenCodeViewer),
        basePath: workspacePath,
        onClick: openFilePreview,
      }),
    [onOpenCodeViewer, openFilePreview, summary, workspacePath],
  );
  // [契约] 子块二级文案固定展示自己那一行的完整路径，不再按文件数收窄。
  // [边界] 与主块不同，子块限定了单个文件，因此多文件时才出现的省略逻辑在这里不适用。
  const secondaryText = useMemo(
    () => renderFilePath(summary.filePath, workspacePath),
    [summary.filePath, workspacePath],
  );
  const diffCount = useMemo(
    () =>
      renderDiffCount(summary.changeStat, {
        animateInitial: animateDiffCountOnMount,
      }),
    [animateDiffCountOnMount, summary.changeStat],
  );
  // [契约] 标题优先用 filePath，缺失时回退 path，再交给展示路径工具压缩层级。
  // [边界] 两条路径都缺失时展示工具会给出占位，而不是抛错。
  const title = useMemo(
    () => getFileDisplayPath(summary.filePath ?? summary.path, workspacePath),
    [summary.filePath, summary.path, workspacePath],
  );
  // [契约] 子块内容：先挂自己的 diff 预览，再渲染通用正文与输入输出。
  // [事务] 预览存在时把正文的内联预览覆盖为空，避免同一段 diff 渲染两次。
  // [边界] 无预览时不留占位容器，正文自然向上收拢。
  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {inlinePreviewOverride?.type === "patch" ? (
          <EditInlineDiffContent
            preview={inlinePreviewOverride.source}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
          />
        ) : null}
        <ToolCallBody
          childToolList={childToolList}
          displayModel={displayModel}
          inlinePreviewOverride={
            inlinePreviewOverride?.type === "patch" ? { type: "none" } : undefined
          }
          toolCall={toolCall}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
      </div>
    ),
    [
      childToolList,
      codePreviewSettings,
      displayModel,
      inlinePreviewOverride,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      theme,
      toolCall,
      workspacePath,
    ],
  );

  // [契约] 子块同样透传给 ToolLayout，仅工具 id、图标开关与文案来源与主块不同。
  // [并发] 展开状态由该层 ToolLayout 自行维护，与主块及兄弟子块互不影响。
  // [边界] 子块的 diff 计数不隐藏，收起时用总数帮助用户判断哪个文件改动最大。
  return (
    <>
      <ToolLayout
        toolId={toolId}
        icon={EDIT_TOOL_ICON}
        showIcon={showIcon !== false}
        // 多文件 edit 的每个子文件都有自己的 diff content，必须允许单独展开查看。
        {...EDIT_CHILD_LAYOUT}
        kindLabel={kindLabel}
        sourceLabel={sourceLabel}
        primaryText={primaryText}
        prioritizePrimaryText
        secondaryText={secondaryText}
        diffCount={diffCount}
        statusLabel={statusLabel}
        statusTooltip={isFailed ? errorText : undefined}
        showFailureStatus={isFailed}
        isRunning={isRunning}
        title={title}
        renderContent={renderContent}
      />
    </>
  );
}
