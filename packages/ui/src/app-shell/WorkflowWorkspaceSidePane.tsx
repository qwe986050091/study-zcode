// ============================================================
// 脚本 transcript 面板。
// ============================================================
// 一个 run 的 `files.*` / `git.*` / `world.run` 调用，按执行顺序回放成一本日志簿：阶段是章
// （章头 = 名字 · ⟳n · 横线 · 步数与时长），每一步是两行的条目 + 时间标尺，命令露出输出的尾巴。
// 与 actor transcript 面板同一逻辑层级：run 详情页保留它唯一的那条时间线，这里**不是第二条
// 时间线**——没有轨道、没有灯。
//
// 数据两条路：清单（轻行，`lastEventSequence` 抬升即重查）+ 正文（滚进视口 / 展开时才取，
// 按 tab 缓存）。状态以 journal 为准，活投影只叠 `cached`。

// 模块定位：run 详情侧栏的脚本 transcript，按阶段分章回放 files、git、world.run 三类调用。
// 数据流：tab 定位目标 run → 租约取投影 → 图与工作区行合成卡片 → 章节与摘要渲染。
// 租约生命周期随组件挂载建立并于卸载释放，滚动落点由 `WorkflowWorkspaceContent` 在每次打开时重置一次。
// 设计权衡：正文懒取加首批错位动画换首屏速度，截断提示换掉完整性的隐形丢失。
// INV-01 不变量：本面板只是 run 详情页时间线的投影，不建立第二条时间线或轨道；守住位置：WorkflowWorkspaceContent 的渲染结构；改错故障：用户看到两份互相漂移的执行顺序。
// INV-02 不变量：清单以 lastEventSequence 为刷新信号，正文按视口与展开懒取；守住位置：useWorkflowRunWorkspace 的 refreshSignal 入参；改错故障：新事件到达后列表停在旧序列，步骤数不再增长。
// INV-03 不变量：journal 是唯一事实源，cached 只作叠加展示；守住位置：snapshot 取 run 与卡片组装；改错故障：活投影覆盖已落库状态，重开面板内容回退。
// INV-04 不变量：run 选择只认 tab.runId，不从会话里猜当前 run；守住位置：按 runId 在 snapshot 的 runs 中查找；改错故障：多 run 并发时面板展示别人的执行。
// INV-05 不变量：脚本图优先取最新补全行，缺失才回落到 toolCallId 图；守住位置：buildWorkflowFillGraphByRunId 的回退链；改错故障：站落点指向补全前的旧表，卡片整体错位。
// INV-06 不变量：父会话租约在渲染期同步建立，卸载时恰好释放一次；守住位置：acquire 的 useMemo 与 release 的清理函数；改错故障：租约泄漏或提前释放，面板首帧没有投影。
// INV-07 不变量：面板可见性由 pane 布局决定，focused 只表达焦点归属不改数据；守住位置：WorkflowWorkspaceSidePane 的 props 透传；改错故障：切走再切回时数据被重置或重复拉取。
// INV-08 不变量：宽度不在此处声明，列宽由 pane scope 与容器 flex 分配；守住位置：外框的 min-h-0 与列表的 overflow 类；改错故障：窄栏被内容撑破，出现横向滚动条。
// INV-09 不变量：空态只在清单到齐且零卡片时出现，加载中不得先闪空态；守住位置：body 链上的 loaded 与长度判定；改错故障：首屏先显示尚未开始再跳成列表。
// INV-10 不变量：unavailable 与 error 优先于空态，错误不伪装成没有数据；守住位置：body 的 if 与 else 顺序；改错故障：取数失败被读成未开始，用户无从重试。
// INV-11 不变量：落点每次打开重算，openedAt 一变即视为新一次打开；守住位置：landingKey 的拼接；改错故障：二次打开停在上次位置，用户找不到目标阶段。
// INV-12 不变量：落点滚动必须等清单到齐，且同一 landingKey 只执行一次；守住位置：landedOnceRef 与 effect 早退；改错故障：在空容器上滚到底，落点彻底丢失。
// INV-13 不变量：目标卡未命中时退化为滚到底部，而不是原地不动；守住位置：scrollIntoView 与 scrollTo 的分支；改错故障：打开尚未到达的阶段后停在顶部。
// INV-14 不变量：prefers-reduced-motion 下滚动改 auto，不强制平滑动画；守住位置：behavior 的计算；改错故障：前庭敏感用户被强制动画，无障碍回归。
// INV-15 不变量：入场错位只作用于首批卡片，后续追加零延迟；守住位置：initialCountRef 冻结的首批长度；改错故障：流式新增卡逐张延迟，列表持续抖动。
// INV-16 不变量：错位总延迟封顶 360ms，长清单不按条数线性等待；守住位置：Math.min 对 24ms 的截断；改错故障：上百步执行要等十几秒才可读。
// INV-17 不变量：秒表只在存在 running 卡片时推进，静止面板不每秒重渲染；守住位置：runningCount 作为时钟 hook 的入参；改错故障：空闲面板持续渲染，CPU 占用升高。
// INV-18 不变量：与主视图的选中同步只由 focusPhaseId 单项驱动；守住位置：landedIndex 的 useMemo 依赖；改错故障：主视图换阶段后侧栏仍停在旧章。
// INV-19 不变量：truncated 提示必须显示，截断不得被当作完整清单；守住位置：workspace.truncated 的尾部渲染；改错故障：用户以为执行只有这些步，漏看后续。
import { Fragment, memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import { HourglassIcon, Repeat2Icon, TerminalIcon, TriangleAlertIcon } from "lucide-react";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import { WorkflowRunStatus } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { useRunningBackgroundTaskElapsedClock } from "@/hooks/useRunningBackgroundTaskElapsedClock.js";
import { useWorkflowRunWorkspace } from "@/hooks/useWorkflowRunWorkspace.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkflowWorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import {
  buildWorkflowFillGraphByRunId,
  buildWorkflowGraphByToolCallId,
} from "@/v4/workflowRunCardJoin.js";
import { WorkflowWorkspaceCard } from "@/app-shell/WorkflowWorkspaceCard.js";
import {
  buildWorkspaceChapters,
  transcriptOrigin,
  transcriptSummary,
  type WorkspaceChapter,
} from "@/app-shell/workflowWorkspaceLogbook.js";
import {
  buildWorkspaceCards,
  firstCardIndexOfPhase,
  formatWorkspaceDuration,
} from "@/app-shell/workflowWorkspaceTranscript.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/** 条目到场的错位：每个 24 ms，封顶 360 ms——第 16 个之后一起落地，长清单不该等半秒。 */
// 设计权衡：24ms 的错位让首批卡片有到场节奏，肉眼可辨又不拖慢阅读。
// 不变量：错位只加在动画延迟上，不改变卡片顺序与 key 的稳定性。
const CARD_STAGGER_MS = 24;
const CARD_STAGGER_CAP_MS = 360;

// 不变量：tab 携带 runId 与 parentSessionId，是面板唯一的定位输入，不做二次推断。
// 不变量：focused 只表达焦点归属，不参与取数，切换焦点不触发重新查询。
// 失败路径：onOpenCodeViewer 缺省时代码跳转整体降级，卡片仍可读但不可点开。
interface WorkflowWorkspaceSidePaneProps {
  tab: WorkflowWorkspaceSidePaneTab;
  focused: boolean;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}

/** 整个 run 还没碰过工作区：占位（与 actor 的「尚未启动」同一形态，措辞换成工作区的）。 */
// 不变量：零卡片且清单已到齐才渲染此占位，加载中一律不显示。
// 设计权衡：与 actor 面板同形态换措辞，用一致性换掉一套新视觉。
function WorkspaceNotStarted() {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="wf-arrive flex h-full flex-col items-center justify-center gap-1.5 px-8 py-16 text-center"
      data-testid="workflow-workspace-not-started"
    >
      <span className="mb-2.5 flex size-14 items-center justify-center rounded-full bg-surface text-foreground-subtlest">
        <HourglassIcon className="size-6" />
      </span>
      <p className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "chat.toolCall.workflow.script.notStarted.title" })}
      </p>
      <p className="max-w-[260px] text-ui-sm leading-normal text-foreground-subtle">
        {intl.formatMessage({ id: "chat.toolCall.workflow.script.notStarted.body" })}
      </p>
    </div>
  );
}

// 不变量：错误与不可用共用同一视觉壳，只靠 text 与 testId 区分。
// 失败路径：文案由调用方传入，缺翻译时露出 id 而不是空白屏。
function WorkspaceNotice({ text, testId }: { text: string; testId: string }) {
  return (
    <div
      className="wf-arrive flex h-full flex-col items-center justify-center px-6 text-center"
      data-testid={testId}
    >
      <TriangleAlertIcon className="size-8 text-foreground-subtlest" />
      <p className="mt-3 text-ui-base text-foreground-subtle">{text}</p>
    </div>
  );
}

/** `1 step` / `3 steps`——词典没有复数语法，单数另配一条。 */
// 不变量：单数走 one 词条，其余带 count 参数，复数形态不靠字符串拼接。
// 失败路径：noun 只允许 steps 与 phases，越界 id 直接抛错而不静默回退。
function countLabel(
  format: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  noun: "steps" | "phases",
  count: number,
): string {
  return count === 1
    ? format({ id: `chat.toolCall.workflow.script.summary.${noun}.one` })
    : format({ id: `chat.toolCall.workflow.script.summary.${noun}` }, { count: String(count) });
}

/** 章头：阶段名 · ⟳n · 横线 · `3 steps · 2m 06s`。没有阶段的章不画头。 */
// 不变量：无阶段的章不画头，直接渲染空，不占垂直间距。
// 不变量：章时长取 endedAt 减 startedAt，不读当前时钟，历史章不随时间变化。
// 设计权衡：轮次徽标只在 round 大于 1 时出现，用条件渲染换掉冗余的第 1 轮。
function ChapterHeader({ chapter }: { chapter: WorkspaceChapter }) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  if (chapter.phase === undefined) return null;
  return (
    <div
      className="wf-arrive mx-2 mb-2 mt-[22px] flex min-w-0 items-center gap-2.5 first:mt-2.5"
      data-phase-id={chapter.phase.id}
      data-round={chapter.round}
      data-testid="workflow-workspace-chapter"
    >
      <span className="whitespace-nowrap text-ui-base font-semibold tracking-[-0.005em] text-foreground">
        {phaseDisplayName(chapter.phase, format)}
      </span>
      {chapter.round > 1 ? (
        <span className="inline-flex h-4 items-center gap-0.5 rounded bg-surface-hover px-1.5 font-mono text-[10.5px] font-medium text-foreground-subtle">
          <Repeat2Icon className="size-2.5" />
          {chapter.round}
        </span>
      ) : null}
      <span aria-hidden className="wf-ws-rule h-0 flex-1 border-t border-border" />
      <span className="whitespace-nowrap font-mono text-ui-xs tabular-nums text-foreground-subtlest">
        {countLabel(format, "steps", chapter.cards.length)}
        {" · "}
        {formatWorkspaceDuration(chapter.endedAt - chapter.startedAt)}
      </span>
    </div>
  );
}

// 不变量：内容组件只读 tab 的两个定位字段，取数全部下沉到 hook 与 memo。
// 并发：memo 化让父级重渲染不重算卡片，但 tab 换 run 时依赖必须整体失效。
// 失败路径：父级传错 runId 时面板落到空态而不是崩溃，错误留在数据层暴露。
const WorkflowWorkspaceContent = memo(function WorkflowWorkspaceContent({
  tab,
  onOpenCodeViewer,
}: WorkflowWorkspaceSidePaneProps) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const { layer } = useV4Conversation();

  // 父会话租约走渲染期同步建连（同 actor 面板）：首帧就要有投影，落点与状态叠加都读它。
  // 资源：租约在渲染期同步建立，保证首次投影就有数据可读。
  // 生命周期：清理函数与 useMemo 依赖同源，parentSessionId 变化即先释放旧的。
  // 并发：同一会话的租约按引用计数共享，重复挂载不会产生第二条订阅。
  const lease = useMemo(() => layer.acquire(tab.parentSessionId), [layer, tab.parentSessionId]);
  useEffect(() => () => lease.release(), [lease]);
  const snapshot = useConversationProjection(lease).snapshot;

  // 不变量：按 runId 精确匹配，找不到即视为未知 run，不回落到列表首项。
  // 失败路径：run 缺失时状态灯与刷新信号一起省略，已有卡片仍照常显示。
  const run = useMemo(
    () => snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [snapshot?.workflowRuns, tab.runId],
  );
  // 补全过的 run 取最新补全行的有效脚本图（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：
  // 脚本 transcript 的落点按站，站必须是补全之后的那一张表。
  // 不变量：补全行优先，补全图缺失才回落到 toolCallId 图，两者不合并。
  // 失败路径：两张图都缺时卡片退化为无站信息，绝不抛错阻断渲染。
  const graph = useMemo(
    () =>
      buildWorkflowFillGraphByRunId(snapshot?.rows.window).get(tab.runId)?.graph ??
      buildWorkflowGraphByToolCallId(snapshot?.rows.window).get(tab.toolCallId),
    [snapshot?.rows.window, tab.runId, tab.toolCallId],
  );

  // 不变量：refreshSignal 只在 run 存在时传入，未知 run 不发多余查询。
  // 资源：订阅与取消由 hook 内部负责，组件不持有任何查询句柄。
  const workspace = useWorkflowRunWorkspace({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(run === undefined ? {} : { refreshSignal: run.lastEventSequence }),
  });
  // 不变量：卡片由工作区行与脚本图联合构建，任一侧缺失都要降级成可读条目。
  // 失败路径：图为 undefined 时按无站卡片处理，顺序仍保持执行序不变。
  const cards = useMemo(
    () => buildWorkspaceCards(workspace.nodes, graph),
    [graph, workspace.nodes],
  );
  const chapters = useMemo(() => buildWorkspaceChapters(cards), [cards]);
  const origin = useMemo(() => transcriptOrigin(cards), [cards]);
  // 跑着的条目「开始于多久前」与表头的总时长每秒推进；没有在跑的就不走钟。
  // 不变量：只有 running 节点参与秒表推进，终态卡片冻结在结束时刻。
  // 设计权衡：每帧重算计数而非缓存，用一次线性扫描换掉易失效的缓存状态。
  const runningCount = cards.filter((card) => card.node.status === "running").length;
  const now = useRunningBackgroundTaskElapsedClock(runningCount);
  const summary = useMemo(() => transcriptSummary(cards, now), [cards, now]);

  // 落点（每次打开都重落：`openedAt` 随打开刷新）：那一站的第一张卡；还没到的站落到末尾。
  // 等清单到齐再滚，否则滚的是一个空容器。
  const listRef = useRef<HTMLDivElement>(null);
  // 不变量：落点键由阶段 id 与 openedAt 组成，同一次打开内保持不变。
  // 失败路径：无 focusPhaseId 时不滚到任意卡片，保持在列表顶部。
  const landingKey =
    tab.focusPhaseId === undefined ? undefined : `${tab.focusPhaseId}@${tab.openedAt}`;
  // 不变量：阶段索引取该阶段第一张卡，未命中返回负一表示不计落点。
  // 失败路径：阶段在本次执行中缺席时落点键为空，退化为滚到底部。
  const landedIndex = useMemo(
    () => (tab.focusPhaseId === undefined ? -1 : firstCardIndexOfPhase(cards, tab.focusPhaseId)),
    [cards, tab.focusPhaseId],
  );
  const landedKey = landedIndex < 0 ? undefined : cards[landedIndex]?.key;
  const landedOnceRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (landingKey === undefined || !workspace.loaded) return;
    if (landedOnceRef.current === landingKey) return;
    landedOnceRef.current = landingKey;
    const list = listRef.current;
    if (list === null) return;
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
    const target =
      landedKey === undefined
        ? null
        : (list.querySelector<HTMLElement>(`[data-card-key="${landedKey}"]`) ?? null);
    if (target !== null && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior, block: "start" });
    } else if (typeof list.scrollTo === "function") {
      list.scrollTo({ top: list.scrollHeight, behavior });
    }
  }, [landedKey, landingKey, workspace.loaded]);

  // 首批到场按下标错位；之后追加的卡各自立刻到场（wf-arrive 无延迟）。
  // 不变量：首批长度只在加载完成后冻结一次，之后追加不改变阈值。
  // 失败路径：首帧未加载完成时保持空值，避免把空清单误记为 0 张。
  const initialCountRef = useRef<number | null>(null);
  if (initialCountRef.current === null && workspace.loaded) initialCountRef.current = cards.length;
  const initialCount = initialCountRef.current ?? 0;

  const title = tab.workflowName?.trim() || intl.formatMessage({ id: "sidePane.workflowScript" });

  // 不变量：四态互斥且按不可用、失败、空、有内容顺序判定，先命中先返回。
  // 失败路径：error 在已加载后不覆盖内容，避免一次抖动清空整本日志簿。
  // 设计权衡：分支内直接构造 JSX，用可读性换掉一层状态机抽象。
  let body: ReactNode;
  // 不变量：unavailable 是终态，优先级高于 error 与空态，先判先出。
  // 失败路径：此分支不提供重试按钮，恢复依赖外层重新打开面板。
  if (workspace.unavailable) {
    body = (
      <WorkspaceNotice
        testId="workflow-workspace-unavailable"
        text={format({ id: "chat.toolCall.workflow.script.unavailable" })}
      />
    );
  // 不变量：仅在未加载完成时报错占位，已加载的旧内容不被错误页顶掉。
  // 失败路径：错误文案内联具体原因，用户可据此判断是权限还是网络。
  } else if (workspace.error !== null && !workspace.loaded) {
    body = (
      <WorkspaceNotice
        testId="workflow-workspace-error"
        text={format(
          { id: "chat.toolCall.workflow.script.loadFailed" },
          { error: workspace.error },
        )}
      />
    );
  // 不变量：已加载且零卡片才算空态，二者缺一都不得渲染占位。
  // 失败路径：后续事件带来卡片后同一分支自动失效，无需手动刷新。
  } else if (workspace.loaded && cards.length === 0) {
    body = <WorkspaceNotStarted />;
  } else {
    let index = 0;
    body = (
      <div
        className="wf-motion flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-7 pt-1.5"
        data-testid="workflow-workspace-list"
        ref={listRef}
      >
        {chapters.map((chapter) => (
          <Fragment key={chapter.key}>
            <ChapterHeader chapter={chapter} />
            {chapter.cards.map((card) => {
              const position = index;
              index += 1;
              return (
                <WorkflowWorkspaceCard
                  card={card}
                  enterDelayMs={
                    position < initialCount
                      ? Math.min(CARD_STAGGER_MS * position, CARD_STAGGER_CAP_MS)
                      : 0
                  }
                  key={card.key}
                  landed={card.key === landedKey && landingKey !== undefined}
                  now={card.node.status === "running" ? now : 0}
                  onOpenCodeViewer={onOpenCodeViewer}
                  origin={origin}
                  run={run}
                  runId={tab.runId}
                  sessionId={tab.parentSessionId}
                  workspacePath={tab.workspacePath}
                />
              );
            })}
          </Fragment>
        ))}
        {workspace.truncated ? (
          <p
            className="px-2 pt-3 text-center text-ui-xs text-foreground-subtlest"
            data-testid="workflow-workspace-truncated"
          >
            {format(
              { id: "chat.toolCall.workflow.script.listTruncated" },
              { count: String(cards.length) },
            )}
          </p>
        ) : null}
      </div>
    );
  }

  // 表头第二行：`3 phases · 9 steps · 4m 12s`——清单到齐且非空才说。
  // 不变量：只有已加载且非空才产出摘要，空清单不留一个孤立的零。
  // 不变量：phases 为零时省略该段，steps 与总时长始终保留。
  // 设计权衡：摘要用数组拼装，分隔点由渲染层插入，避免文案写死分隔符。
  const summaryParts: string[] = [];
  if (workspace.loaded && cards.length > 0) {
    if (summary.phases > 0) summaryParts.push(countLabel(format, "phases", summary.phases));
    summaryParts.push(countLabel(format, "steps", summary.steps));
    summaryParts.push(formatWorkspaceDuration(summary.durationMs));
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="workflow-workspace-pane"
      data-workflow-run-id={tab.runId}
    >
      {/* 表头：终端瓦片 · WORKSPACE 眉题 + run 名 · run 灯与词；第二行是整本日志簿的三个数。 */}
      <div className="wf-motion flex shrink-0 flex-col gap-3 border-b border-border px-5 pb-3.5 pt-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="wf-arrive flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-surface-hover text-foreground-subtle"
          >
            <TerminalIcon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-ui-xs font-medium uppercase tracking-[0.08em] text-foreground-subtlest">
              {format({ id: "chat.toolCall.workflow.script.title" })}
            </span>
            <span
              className="truncate text-ui-lg font-medium leading-tight text-foreground"
              data-testid="workflow-workspace-title"
            >
              {title}
            </span>
          </div>
          {run ? (
            <WorkflowRunStatus
              className="font-medium"
              run={run}
              testId="workflow-workspace-run-status"
            />
          ) : null}
        </div>
        {summaryParts.length === 0 ? null : (
          <div
            className="flex items-center gap-1.5 pl-[46px] text-ui-sm text-foreground-subtle"
            data-testid="workflow-workspace-summary"
          >
            {summaryParts.map((part, position) => (
              <Fragment key={position}>
                {position > 0 ? (
                  <span aria-hidden className="size-[3px] rounded-full bg-foreground-subtlest" />
                ) : null}
                <span
                  className={position === summaryParts.length - 1 ? "font-mono tabular-nums" : ""}
                >
                  {part}
                </span>
              </Fragment>
            ))}
          </div>
        )}
      </div>
      {body}
    </div>
  );
});

/**
 * 一个 workflow run 的脚本 transcript tab。组合方式照 `WorkflowActorSessionSidePane`：pane scope
 * + 内容；内容自己取数（两条 journal 查询），不嵌 SessionPane——工作区没有会话。
 */
// 不变量：外层只负责 pane scope 与 Provider 包裹，不触碰任何业务数据。
// 生命周期：scope 随三个身份字段变化重建，Provider 因此换到新的租约域。
// 失败路径：workspaceIdentity 与 remoteSessionId 缺省时不写入键，保持本地语义。
export const WorkflowWorkspaceSidePane = memo(function WorkflowWorkspaceSidePane({
  tab,
  focused,
  onOpenCodeViewer,
}: WorkflowWorkspaceSidePaneProps) {
  // 不变量：scope 只声明身份三元组，缺省字段被省略而非置空。
  // 并发：字段变化时换新对象，旧 Provider 子树整体重挂并释放旧租约。
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowWorkspaceContent tab={tab} focused={focused} onOpenCodeViewer={onOpenCodeViewer} />
    </V4PaneConversationProvider>
  );
});
