// INV-01 父会话订阅：守住位置 获取父会话租约；改错故障：详情页读自己会话，运行态永远空。
// INV-02 租约必还：守住位置 订阅 effect 的清理；改错故障：关闭面板后会话引用泄漏。
// INV-03 空引用稳定：守住位置 两个空列表常量；改错故障：每次渲染都触发下游重查。
// INV-04 图按发起行取：守住位置 resolveWorkflowRunGraphForRun；改错故障：补全后仍画旧图。
// INV-05 图可缺省：守住位置 graph 未定义分支；改错故障：老对话翻不到发起行时整页空白。
// INV-06 后继要行号：守住位置 successor 判定；改错故障：打开后继落到历史里没有这张图。
// INV-07 作用域透传：守住位置 tabScope 展开；改错故障：跨工作区打开 tab 时身份丢失。
// INV-08 取消只一条路：守住位置 cancelBackgroundWork；改错故障：另开取消通道导致状态不一致。
// INV-09 恢复带名称：守住位置 resumeWorkflowRun 的 name；改错故障：恢复后通知标题为空。
// INV-10 恢复灰度：守住位置 dynamicWorkflowEnabled；改错故障：灰度关闭仍能起引擎。
// INV-11 拒绝提示随状态清：守住位置 runStatus 的 effect；改错故障：状态绕回后旧提示复现。
// INV-12 拒绝要落日志：守住位置 recordAck 的告警；改错故障：命令被拒无迹可查。
// INV-13 落点带时间：守住位置 landing 的键；改错故障：同一站再点不重新落位。
// INV-14 产物双读：守住位置 useWorkflowRunArtifacts；改错故障：冷恢复后产物清单为空。
// INV-15 产物不带版本：守住位置 handleOpenArtifact；改错故障：打开旧版本而非最新。
// INV-16 配置入口同门：守住位置 settings 的 enabled；改错故障：灰度关闭仍能改配置。
// INV-17 标题有兜底：守住位置 runTitle；改错故障：无名称时标题为空串。
// INV-18 展示不含技术细节：守住位置 三节撤走后的布局；改错故障：report 与事件日志回流面板。
//
// 模块职责：workflow run 的侧边详情页，呈现状态头、阶段清单、来源与产物。
// 状态所有权：运行态来自父会话投影，产物读 journal，动作通过 v4 命令下发。
// 阅读顺序：空引用常量 → 内容组件 → 投影订阅 → 图解析 → 动作 → 产物 → 外层包装。
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowRunArtifactSummary,
  WorkflowRunPendingQuestion,
} from "@zcode/shared/zcode-protocol-v4";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowSubagentModelCardLabel } from "@/components/workflow-timeline/subagent-model-label.js";
import { workflowSummaryParts } from "@/components/workflow-timeline/timeline-summary.js";
import { WorkflowRunArtifactsSection } from "@/app-shell/WorkflowRunArtifactsSection.js";
import { WorkflowRunPhaseList } from "@/app-shell/WorkflowRunPhaseList.js";
import { WorkflowRunProvenance } from "@/app-shell/WorkflowRunProvenance.js";
import {
  WorkflowRunResultSections,
  WorkflowRunStatusHeader,
} from "@/app-shell/WorkflowRunSidePaneSections.js";
import {
  useWorkflowRunPaneSettings,
  workflowRunTabScope,
} from "@/app-shell/useWorkflowRunPaneSettings.js";
import { WorkflowRunSettingsPopover } from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import { WorkflowRunPaneSaveSlots } from "@/project-workflow/WorkflowRunPaneSaveSlots.js";
import { resolveWorkflowLaunchProvenance } from "@/app-shell/workflowRunLaunchProvenance.js";
import {
  describeWorkflowRunActionRejection,
  workflowRunActionRejectionMessageId,
  type WorkflowRunAction,
  type WorkflowRunActionRejection,
} from "@/app-shell/workflowRunActionRejection.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  WorkflowRunSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  isWorkflowRunCancellable,
  isWorkflowRunResumable,
  workflowRunResultView,
  type WorkflowActorInstance,
} from "@/app-shell/workflowRunPanel.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useWorkflowRunArtifacts } from "@/hooks/useWorkflowRunArtifacts.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  buildWorkflowFillGraphByRunId,
  buildWorkflowGraphByToolCallId,
  resolveWorkflowRunGraphForRun,
} from "@/v4/workflowRunCardJoin.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/**
 * 稳定引用的空列表：pendingQuestions 键会**来回**进出（问题一被作答就整键消失），
 * 空引用要稳定，否则 memo 化的子组件每次渲染都白重渲染一遍。
 */
// pendingQuestions 键会反复进出，EMPTY_QUESTIONS 引用必须稳定。
// artifacts 键在零产物时缺席，EMPTY_ARTIFACTS 同样要稳定空值。
// 两个常量只声明为 readonly，下游不得 push 或改写引用。
// 稳定引用让 memo 化的子组件只在真有变化时重渲染。
const EMPTY_QUESTIONS: readonly WorkflowRunPendingQuestion[] = [];
/** 同理。`artifacts` 键在零产物时缺席，而它是产物 hook 重查 journal 的依赖之一。 */
const EMPTY_ARTIFACTS: readonly WorkflowRunArtifactSummary[] = [];

// 内容组件以 tab 为唯一输入，内部再取投影与命令通道。
// 四个打开回调都可缺省，缺省即对应行不可点。
// 回调只接收补齐了 PaneWorkspaceScope 的请求，调用方不关心作用域。
// memo 包裹避免父级无关更新引起整页重渲染。
// WorkflowRunContent 不持有运行态，全部读 useConversationProjection()。
// 展示层只面向用户，技术细节由 projection 侧消化，不回传到 WorkflowRunContent。
const WorkflowRunContent = memo(function WorkflowRunContent({
  tab,
  onOpenWorkflowActorSession,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenWorkflowWorkspace,
}: {
  tab: WorkflowRunSidePaneTab;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** 「已被 run X 替代」→ 后继 run 的详情 tab。 */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** 脊线上的脚本行 → 脚本 transcript tab，落到那一站。 */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer, sendCommand } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);

  // 详情页重新订阅**父会话**的投影（照 PlanDetailSidePane）：运行态是父会话的权威投影，
  // 不是这个面板的本地查询缓存。
  useEffect(() => {
    // 详情页订阅父会话，而不是自己的会话。
    // 获取租约后必须在卸载时释放。
    // effect 依赖层与父会话标识，切换即重订阅。
    // 投影未就绪时后续读取全部走可选链。
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  // 打开请求里的 workspace 作用域（actor / 脚本 / 产物 / 后继 tab 都带同一份）。
  const { remoteSessionId, workspaceIdentity, workspacePath } = tab;
  const tabScope = useMemo(
    () => workflowRunTabScope({ remoteSessionId, workspaceIdentity, workspacePath }),
    [remoteSessionId, workspaceIdentity, workspacePath],
  );

  const run = useMemo(
    () => snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [snapshot?.workflowRuns, tab.runId],
  );
  // 后继（`run.supersededBy`）要在投影里、且带自己的发起行 id 才开得了：打开请求的 toolCallId 是
  // 详情页找图的钥匙，填错会让后继的详情页落「历史里没有这张图」。
  const successor = useMemo(() => {
    const supersededBy = run?.supersededBy;
    if (supersededBy === undefined) return undefined;
    const candidate = snapshot?.workflowRuns?.runs.find((item) => item.runId === supersededBy);
    return candidate?.toolCallId === undefined ? undefined : candidate;
  }, [run?.supersededBy, snapshot?.workflowRuns]);
  const handleOpenSuccessor = useCallback(() => {
    if (successor?.toolCallId === undefined) return;
    onOpenWorkflowRun?.({
      ...tabScope,
      parentSessionId: tab.parentSessionId,
      toolCallId: successor.toolCallId,
      runId: successor.runId,
      ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
    });
  }, [onOpenWorkflowRun, successor, tab.parentSessionId, tab.workflowName, tabScope]);

  // 静态图按**发起 toolCallId** 取：与轮尾 run 卡、
  // 脚本 transcript 同一张表——CreateWorkflow 工具行或直接启动轮的元数据，谁挂着图都一样。行窗口是
  // 有界的，老对话里翻不到发起行是正常情况，不是错误——此时没有图可给。
  // 「配置」修订出来的 run 在设置轮落地之前借前驱的图（规则与理由见 resolveWorkflowRunGraph）。
  // 补全过的 run 取最新补全行的有效脚本图（docs/dynamic-workflow/presentation.md「Holes on the timeline」）。
  // 静态图由 buildWorkflowGraphByToolCallId() 按发起工具行取，与轮尾卡片同一张表。
  // 补全过的 run 优先取补全后的脚本图。
  // 行窗口有界，翻不到发起行时图缺省。
  // 行窗口有界，get() 取不到时 graph 缺省；此时界面给出图不可用提示。
  const { graph, holeLabels } = useMemo(() => {
    const fills = buildWorkflowFillGraphByRunId(snapshot?.rows.window);
    const graphs = buildWorkflowGraphByToolCallId(snapshot?.rows.window);
    const runs = snapshot?.workflowRuns?.runs;
    return {
      graph: resolveWorkflowRunGraphForRun(graphs, fills, tab.toolCallId, tab.runId, runs),
      holeLabels: fills.get(tab.runId)?.holeLabels,
    };
  }, [snapshot?.rows.window, snapshot?.workflowRuns, tab.runId, tab.toolCallId]);

  // 直接启动的来龙去脉：作用域、说明、实参与
  // 「由你从工作流中枢启动」。只对中枢启动的 run 在场；工具路径发起的 run 没有这一节。
  const provenance = useMemo(
    () => resolveWorkflowLaunchProvenance(snapshot?.rows.window, tab.toolCallId),
    [snapshot?.rows.window, tab.toolCallId],
  );

  // 一个模型，三处消费：清单与摘要行都从它出发。
  const model = useMemo(
    () => (graph === undefined ? undefined : buildWorkflowTimeline(graph, run, holeLabels)),
    [graph, holeLabels, run],
  );
  // 子代理模型：状态头第一行不再摆芯片，
  // 模型名成了摘要行的第一段——这一行本来就是「这条 run 的几个数」。强度与规范串进 tooltip。
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(
    tab.workspacePath,
    tab.workspaceIdentity,
  );
  const subagentModel = useMemo(
    () =>
      workflowSubagentModelCardLabel(run?.subagentModel, {
        formatMessage: intl.formatMessage.bind(intl),
        ...(subagentModelProviderName === undefined
          ? {}
          : { providerName: subagentModelProviderName }),
      }),
    [intl, run?.subagentModel, subagentModelProviderName],
  );
  const summaryParts = useMemo(
    () =>
      model === undefined || run === undefined
        ? undefined
        : workflowSummaryParts(
            intl.formatMessage.bind(intl),
            model,
            run,
            subagentModel === undefined ? {} : { subagentModelName: subagentModel.name },
          ),
    [intl, model, run, subagentModel],
  );

  const cancellable = isWorkflowRunCancellable(run);
  // 最近一次被拒的 Cancel / Resume。run 状态
  // 一变（真取消了 / 真恢复了 / 冷回放补上了结算）提示就不再适用，随状态变化清掉——是「变化」而不是
  // 「与当时不同」：状态绕一圈回到原值时，旧提示也不该再冒出来。
  const [rejection, setRejection] = useState<WorkflowRunActionRejection | undefined>(undefined);
  const runStatus = run?.status;
  useEffect(() => {
    setRejection(undefined);
  }, [runStatus]);
  const recordAck = useCallback(
    (action: WorkflowRunAction, ack: Parameters<typeof describeWorkflowRunActionRejection>[1]) => {
      const next = describeWorkflowRunActionRejection(action, ack);
      setRejection(next);
      if (next !== undefined) {
        logger.warn(`[workflow-run] ${action} 被拒绝`, {
          reasonCode: ack.reasonCode,
          runId: tab.runId,
          status: ack.status,
        });
      }
    },
    [tab.runId],
  );
  const rejectionView = useMemo(() => {
    if (rejection === undefined) return undefined;
    return {
      text: intl.formatMessage(
        { id: workflowRunActionRejectionMessageId(rejection) },
        { code: rejection.code },
      ),
      ...(rejection.message === undefined ? {} : { detail: rejection.message }),
    };
  }, [intl, rejection]);

  const handleCancel = useCallback(() => {
    // 取消只有一条路径：既有的 v4 cancelBackgroundWork {workId ≡ runId}。
    void sendCommand(
      createCommandEnvelope({
        type: "cancelBackgroundWork",
        payload: { workId: tab.runId },
        sessionId: tab.parentSessionId,
      }),
    ).then((ack) => recordAck("cancel", ack));
  }, [recordAck, sendCommand, tab.parentSessionId, tab.runId]);

  // Resume 可用性只读投影的 `resumable` 状态位：
  // 重启后投影由 CLI 冷回放补齐，这里不再另查 journal 摘要。
  //
  // 再叠一道灰度门：已有的 run 照常渲染
  // ——状态头、时间线、产物一件不少——唯独 Resume 收起来，因为按下去会真的起一台引擎。
  // 快照未就绪时 enabled 为 false，按未命中处理：宁可按钮晚半拍出现，也不给一个随时会消失的按钮。
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();
  const resumable = isWorkflowRunResumable(run) && dynamicWorkflowEnabled;
  // 「配置」：与 Resume 同一道灰度门；
  // 被接受后面板跟着工作流走到新 run（useWorkflowRunPaneSettings）。
  // 恢复与配置共用同一道灰度门。
  // 未启用时按不可用处理，按钮延后出现。
  // 配置被接受后面板跟随到新的 run。
  // 会话配置只在父会话匹配时注入。
  // onOpenWorkflowRun 可选，缺省时 useWorkflowRunPaneSettings() 不暴露后继入口。
  const settings = useWorkflowRunPaneSettings({
    enabled: dynamicWorkflowEnabled,
    run,
    runs: snapshot?.workflowRuns?.runs,
    sendCommand,
    sessionConfig: snapshot?.sessionId === tab.parentSessionId ? snapshot?.config : undefined,
    tab,
    ...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun }),
  });
  const handleResume = useCallback(() => {
    // resume 是新 v4 命令（不携 baseRevision，与 cancel 同类）；workId ≡ runId。
    // `name` 喂恢复后完成通知的主题——重启后原工具 input 不可得，tab 上的展示名是仅存来源。
    void sendCommand(
      createCommandEnvelope({
        type: "resumeWorkflowRun",
        payload: {
          workId: tab.runId,
          ...(tab.workflowName?.trim() ? { name: tab.workflowName.trim() } : {}),
        },
        sessionId: tab.parentSessionId,
      }),
    ).then((ack) => {
      recordAck("resume", ack);
      // 接受后活投影会以 run-started 翻回 running，reducer 随之剥掉 resumable，按钮自然收起。
    });
  }, [recordAck, sendCommand, tab.parentSessionId, tab.runId, tab.workflowName]);

  const handleOpenActor = useCallback(
    (instance: WorkflowActorInstance) => {
      onOpenWorkflowActorSession?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        runId: tab.runId,
        ...(instance.sessionId ? { actorSessionId: instance.sessionId } : {}),
        siteId: instance.siteId,
        ordinal: instance.ordinal,
        ...(instance.name ? { actorName: instance.name } : {}),
      });
    },
    [onOpenWorkflowActorSession, tab.parentSessionId, tab.runId, tabScope],
  );

  // 脚本 transcript：与 actor 同构，行只交出阶段 id，scope 与 run 身份在这里补。
  const handleOpenWorkspace = useCallback(
    (phaseId: string) => {
      onOpenWorkflowWorkspace?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        toolCallId: tab.toolCallId,
        runId: tab.runId,
        ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
        phaseId,
      });
    },
    [
      onOpenWorkflowWorkspace,
      tab.parentSessionId,
      tab.runId,
      tab.toolCallId,
      tab.workflowName,
      tabScope,
    ],
  );

  // 落点：每次打开都重落——`openedAt` 随打开刷新，所以同一站再点一次
  // 键也变、清单再落一次。
  // landing.key 由 focusPhaseId 与 openedAt 拼成，保证每次打开都重新落位。
  // focusPhaseId 为 undefined 时 landing 直接为 undefined。
  // key 变化由 useEffect 触发清单滚动一次。
  // openedAt 刷新使同一阶段重复点击也产生新 key。
  const landing = useMemo(
    () =>
      tab.focusPhaseId === undefined
        ? undefined
        : { key: `${tab.focusPhaseId}@${tab.openedAt ?? 0}`, phaseId: tab.focusPhaseId },
    [tab.focusPhaseId, tab.openedAt],
  );

  // 产物。活投影只带最新版的元数据，spec 与版本历史在
  // journal 里，所以 hook 两边都读——`run` 不在投影里（冷恢复 / 被 8-run 上限淘汰）时
  // `live` 缺席，整份清单走 journal。
  // 产物元数据来自活投影，版本历史在 journal。
  // run 不在投影时整份清单走 journal。
  // handleOpenArtifact() 调用时不带版本号，由上层默认取最新。
  // 标题、内容类型与源路径按需透传，缺省不占键。
  const { artifacts } = useWorkflowRunArtifacts({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(run === undefined ? {} : { live: run.artifacts ?? EMPTY_ARTIFACTS }),
  });
  const handleOpenArtifact = useCallback(
    (artifactId: string) => {
      // 卡片只发意图（哪个产物），会话与 workspace 身份由这里补齐——与 actor transcript
      // 同一条论证：卡片不感知 scope。**不带版本号**：打开即最新版。
      //
      // 这份清单是活投影 + journal 的合并视图，所以 `contentType` 与 `sourcePath` 两个键都在：
      // 前者让宿主把 html 产物直接开成浏览器 tab，后者省掉宿主再查一次 journal
      const artifact = artifacts.find((candidate) => candidate.id === artifactId);
      onOpenWorkflowArtifact?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        runId: tab.runId,
        artifactId,
        ...(artifact?.title === undefined ? {} : { title: artifact.title }),
        ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
        ...(artifact?.sourcePath === undefined ? {} : { sourcePath: artifact.sourcePath }),
      });
    },
    [artifacts, onOpenWorkflowArtifact, tab.parentSessionId, tab.runId, tabScope],
  );

  const result = workflowRunResultView(run);
  const pendingQuestions = run?.pendingQuestions ?? EMPTY_QUESTIONS;
  const runTitle = tab.workflowName?.trim() || intl.formatMessage({ id: "sidePane.workflowRun" });

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-workflow-run-id={tab.runId}
      data-workflow-run-status={run?.status ?? "absent"}
    >
      {/* 「保存 / 再次运行」（docs/dynamic-workflow/transcript-and-notifications.md「Saving the run,
          and running it again」）：与完成卡同一个控制器，因此同一个 run 在两处说同一句话。 */}
      <WorkflowRunPaneSaveSlots rows={snapshot?.rows.window} run={run} tab={tab}>
        {(slots) => (
          <WorkflowRunStatusHeader
            cancellable={cancellable}
            configureOpen={settings.popover.open}
            onCancel={handleCancel}
            {...(settings.configurable ? { onConfigureFrom: settings.popover.toggleFrom } : {})}
            {...(onOpenWorkflowRun === undefined || successor === undefined
              ? {}
              : { onOpenSuccessor: handleOpenSuccessor })}
            onResume={handleResume}
            {...(rejectionView === undefined ? {} : { rejection: rejectionView })}
            resumable={resumable}
            run={run}
            saveSlots={slots}
            {...(subagentModel === undefined ? {} : { subagentModel })}
            summaryParts={summaryParts}
            title={runTitle}
            usage={run?.usage}
          />
        )}
      </WorkflowRunPaneSaveSlots>

      {run === undefined || !settings.configurable ? null : (
        <WorkflowRunSettingsPopover
          anchorRef={settings.popover.anchorRef}
          host={settings.host}
          onAccepted={settings.onAccepted}
          onOpenChange={settings.popover.setOpen}
          open={settings.popover.open}
          run={run}
        />
      )}

      {provenance === undefined ? null : (
        <WorkflowRunProvenance
          meta={provenance.meta}
          {...(subagentModelProviderName === undefined
            ? {}
            : { providerName: subagentModelProviderName })}
          {...(provenance.startedAt === undefined ? {} : { startedAt: provenance.startedAt })}
        />
      )}

      <WorkflowRunResultSections result={result} />

      {/*
       * 阶段清单：时间线读作一份纵向清单，
       *           升级问题挂在提问者那一行下面。图不可得（老对话翻不到发起行）时念一句「图不可用」。
       */}
      {graph !== undefined && model !== undefined ? (
        <WorkflowRunPhaseList
          graph={graph}
          model={model}
          pendingQuestions={pendingQuestions}
          run={run}
          {...(onOpenWorkflowActorSession === undefined ? {} : { onOpenActor: handleOpenActor })}
          {...(onOpenWorkflowWorkspace === undefined
            ? {}
            : { onOpenWorkspace: handleOpenWorkspace })}
          {...(landing === undefined ? {} : { landing })}
          {...(subagentModelProviderName === undefined ? {} : { subagentModelProviderName })}
        />
      ) : (
        <p
          className="flex-1 px-4 py-3 text-ui-xs text-foreground-subtle"
          data-testid="workflow-run-graph-unavailable"
        >
          {intl.formatMessage({ id: "chat.toolCall.workflow.run.graph.unavailable" })}
        </p>
      )}

      {/*
       * Artifacts 区：脚本用 `artifact.*` 交付给**用户**的产出。面板的最后一节、默认展开——它是
       *           这次运行的交付物，也是用户打开这块面板最常见的目的。零件时整区缺席；失败与取消的
       *           run 一样渲染（一个死在第 12 步的 run 仍然可能已经交付了一份 pdf）。`report` 条目、
       *           事件日志与脚本原文三节已撤走：技术细节，读者是模型与 CLI。
       */}
      {artifacts.length === 0 ? null : (
        <WorkflowRunArtifactsSection
          artifacts={artifacts}
          runId={tab.runId}
          sessionId={tab.parentSessionId}
          {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenArtifact: handleOpenArtifact })}
        />
      )}
    </div>
  );
});

/**
 * workflow run 的详情页。
 *
 * 详情页承担用量、控制与交付物；图本身回到了聊天区的工具卡上，这里画的是同一个时间线模型的
 * 纵向清单。它**不复刻**卡片的有界 display——图之外的一切都读 `workflowRuns` 的权威投影，
 * 产物清单则直接读 journal。
 *
 * 面板只呈现**用户**要看的东西。`report` 条目、事件日志与脚本原文
 * 三节已经撤走——它们是技术细节，读者是模型与 CLI，不是坐在这块面板前的人。
 * journal 的读面一个没动（事件查询、report 行仍在），撤掉的只是它们在这里的显示。
 */
export const WorkflowRunSidePane = memo(function WorkflowRunSidePane({
  tab,
  onOpenWorkflowActorSession,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenWorkflowWorkspace,
}: {
  tab: WorkflowRunSidePaneTab;
  /** 子代理行 → actor transcript tab。缺省即行不可点。 */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** 产物卡片 → 全尺寸查看 tab。缺省即卡片不可点。 */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** 「已被 run X 替代」→ 后继 run 的详情 tab。缺省即那一行是静态文字。 */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** 脚本行 → 脚本 transcript tab，落到那一站。缺省即行不可点。 */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
}) {
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
      <WorkflowRunContent
        tab={tab}
        {...(onOpenWorkflowActorSession === undefined ? {} : { onOpenWorkflowActorSession })}
        {...(onOpenWorkflowWorkspace === undefined ? {} : { onOpenWorkflowWorkspace })}
        {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenWorkflowArtifact })}
        {...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun })}
      />
    </V4PaneConversationProvider>
  );
});
