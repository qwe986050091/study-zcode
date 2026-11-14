// INV-01 空摘要不渲染外壳：守住位置 长度判断；改错故障 轮尾出现空容器间隙。
// INV-02 设置轮提前返回单行：守住位置 早退分支；改错故障 设置轮还建整张卡。
// INV-03 打开详情要求回调与会话：守住位置 双条件；改错故障 缺会话时拼出空父标识。
// INV-04 恢复到要求可恢复标记：守住位置 双条件；改错故障 不可恢复的轮出现恢复按钮。
// INV-05 取消只对运行中显示：守住位置 状态比较；改错故障 已完成轮仍可取消。
// INV-06 药丸要求活投影：守住位置 三条件；改错故障 无投影时点击无处可去。
// INV-07 槽位缺失时静默返回：守住位置 空值判断；改错故障 打开占位标签页。
// INV-08 产物摘要按标识查找：守住位置 查找函数；改错故障 打开第一个同名产物。
// INV-09 可选字段按需展开：守住位置 条件展开；改错故障 未定义字段覆盖默认值。
// INV-10 配置入口要求回调且可配置：守住位置 双条件；改错故障 只读轮出现配置弹层。
// INV-11 关联检索按本轮会话：守住位置 会话标识；改错故障 跨会话串入他人产物。
// INV-12 名称缺失回退通用文案：守住位置 空值合并；改错故障 卡片标题显示空白。
// INV-13 设置轮行与卡片分属两种形态：守住位置 设置判断；改错故障 同一轮重复渲染。
// INV-14 卡片键取自轮内摘要：守住位置 键属性；改错故障 两个轮互相抢渲染。
// INV-15 测试标识带轮前缀：守住位置 模板拼接；改错故障 多轮测试选择器冲突。
// INV-16 子代理模型名由宿主查表：守住位置 钩子入参；改错故障 卡内直接读 store。
// INV-17 回调存在即门控：守住位置 条件构造；改错故障 无权限也渲染可点入口。
// INV-18 药丸与卡片共用同一打开路径：守住位置 工具调用标识；改错故障 两处打开不同标签页。
//
// 模块职责：轮尾工作流摘要卡与设置变更行的组装。
// 状态所有权：无状态；摘要与回调由宿主上下文提供。
// 阅读顺序：先看空值与设置轮早退，再看五类回调派生，最后看卡片与设置行组装。
import type { TimelinePill } from "@/components/workflow-timeline/timeline-model.js";
import { WorkflowRunDigest } from "@/components/workflow-timeline/WorkflowRunDigest.js";
import type { WorkflowRunSettingsHost } from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import { WorkflowSettingsChangeRow } from "@/components/workflow-timeline/WorkflowSettingsChangeRow.js";
import { isWorkflowRunConfigurable } from "@/components/workflow-timeline/workflowRunSettings.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { WorkflowTurnDigest } from "@/v4/workflowTurnDigests.js";
import { resolveWorkflowRunOpenToolCallId } from "@/v4/workflowRunCardJoin.js";

/**
 * 轮尾摘要的落位：把解析出的摘要接上
 * 宿主回调。回调的存在即门控（不变式 7）：打开详情要 `onOpenWorkflowRun` + sessionId；Resume 要
 * `onResumeWorkflowRun` + 联接摘要说可恢复；药丸要 `onOpenWorkflowActor` + 活投影。与
 * `ToolCallRowView` 给工具卡接线的路径一字不差——同一个 run 从两处打开的是同一个 tab。
 */
// digests.length === 0 时直接 return null。
// name 缺失时回落到 intl 的 workflow.fallbackName 文案。
// 子代理 provider 名由宿主经 useWorkflowSubagentModelProviderName 查表注入。
// 每条 digest 各自派生 onOpenRun 与 onResume 回调。
export function ConversationWorkflowDigests({
  context,
  digests,
  turnKey,
}: {
  digests: readonly WorkflowTurnDigest[];
  context: ConversationRowRenderContext;
  turnKey: string;
}) {
  const { intl } = useZCodeIntl();
  // 子代理模型名里的 provider 名从会话的模型清单来（卡本身不碰 store，宿主把查找函数递进去）。
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(
    context.workspacePath,
    context.workspaceIdentity,
  );
  if (digests.length === 0) return null;
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  return (
    <div className="flex flex-col gap-3" data-testid={`workflow-run-digests-${turnKey}`}>
      {digests.map((digest) => {
        const { runId, summary } = digest;
        const name = digest.name ?? fallbackName;
        const sessionId = context.sessionId;
        // 就地生效的设置轮（docs/dynamic-workflow/presentation.md「The settings turn」）：那一行就是
        // 全部呈现。提前返回，下面整套卡的接线（打开、Resume、Stop、药丸、「配置」）一条都不建——
        // 那些都是卡上的控件，而这一轮没有卡。
        if (digest.rowOnly && digest.settings !== undefined) {
          return (
            <WorkflowSettingsChangeRow
              amend={digest.settings.amend}
              key={digest.key}
              {...(digest.settings.at === undefined ? {} : { at: digest.settings.at })}
              {...(subagentModelProviderName === undefined
                ? {}
                : { providerName: subagentModelProviderName })}
            />
          );
        }
        // 「还有 n 个」那一行带落点（追记「五枚药丸与一扇门」）；⤢ 与问题芯片不带。
        // 打开详情要求 context.onOpenWorkflowRun 与 sessionId 同时存在。
        // Resume 要求 context.onResumeWorkflowRun 与 summary.resumable 同时成立。
        // 取消按钮只在运行中显示，终态不给 cancel。
        // 药丸要求 context.onOpenWorkflowActor 与活投影同时存在。
        const onOpenRun =
          context.onOpenWorkflowRun && sessionId
            ? (landing?: { phaseId: string }) =>
                context.onOpenWorkflowRun?.({
                  parentSessionId: sessionId,
                  toolCallId: resolveWorkflowRunOpenToolCallId(digest.toolCallId, summary),
                  runId,
                  workflowName: name,
                  ...(landing === undefined ? {} : { phaseId: landing.phaseId }),
                })
            : undefined;
        const onResume =
          context.onResumeWorkflowRun && summary?.resumable
            ? () => context.onResumeWorkflowRun?.(runId, name)
            : undefined;
        // 取消只有一条路径：详情页也走的 cancelBackgroundWork {workId ≡ runId}。
        const onCancel =
          context.onCancelBackgroundWork && summary?.status === "running"
            ? () => context.onCancelBackgroundWork?.(runId)
            : undefined;
        const onOpenPill =
          context.onOpenWorkflowActor && sessionId && summary?.run
            ? (pill: TimelinePill) => {
                // 槽位身份：会话 id 有则随行，没有就开占位 tab。
                const slot = pill.slot;
                if (slot === undefined) return;
                const actorSessionId = pill.instance?.sessionId;
                const actorName = pill.runtimeName ?? pill.lane.name;
                context.onOpenWorkflowActor?.({
                  parentSessionId: sessionId,
                  ordinal: slot.ordinal,
                  runId,
                  siteId: slot.siteId,
                  ...(actorSessionId === undefined ? {} : { actorSessionId }),
                  ...(actorName === undefined ? {} : { actorName }),
                });
              }
            : undefined;
        // 脚本药丸：与工具卡同一条路，开同一个 tab。
        const onOpenWorkspace =
          context.onOpenWorkflowWorkspace && sessionId && summary?.run
            ? (pill: TimelinePill) => {
                const phaseId = pill.workspace?.phaseId;
                if (phaseId === undefined) return;
                context.onOpenWorkflowWorkspace?.({
                  parentSessionId: sessionId,
                  toolCallId: resolveWorkflowRunOpenToolCallId(digest.toolCallId, summary),
                  runId,
                  workflowName: name,
                  phaseId,
                });
              }
            : undefined;
        const onOpenArtifact =
          context.onOpenWorkflowArtifact && sessionId
            ? (artifactId: string) => {
                // 活投影的产物摘要带最新版的 `contentType`，宿主据它把 html 产物直接开成浏览器
                // tab；`sourcePath` 那份摘要刻意不带（高频状态键），缺席时宿主自己查 journal。
                const artifact = summary?.run?.artifacts?.find(
                  (candidate) => candidate.id === artifactId,
                );
                context.onOpenWorkflowArtifact?.({
                  parentSessionId: sessionId,
                  runId,
                  artifactId,
                  ...(artifact?.title === undefined ? {} : { title: artifact.title }),
                  ...(artifact?.contentType === undefined
                    ? {}
                    : { contentType: artifact.contentType }),
                });
              }
            : undefined;
        const pendingQuestions = context.workflowRunPendingQuestionsByRunId?.get(runId)?.size ?? 0;
        // 「配置」：宿主回调在场（只读 /
        // 灰度两道门已在宿主裁过）且这条 run 能配置时才有。弹层的模型清单按本会话的作用域读。
        const amendSettings = context.onAmendWorkflowRunSettings;
        const settingsHost: WorkflowRunSettingsHost | undefined =
          amendSettings !== undefined && isWorkflowRunConfigurable(summary?.run)
            ? {
                workspacePath: context.workspacePath,
                ...(context.workspaceIdentity
                  ? { workspaceIdentity: context.workspaceIdentity }
                  : {}),
                ...(context.workspaceRemoteSessionId
                  ? { remoteSessionId: context.workspaceRemoteSessionId }
                  : {}),
                ...(context.workflowSessionModel === undefined
                  ? {}
                  : { sessionModel: context.workflowSessionModel }),
                apply: (change) => amendSettings(runId, change),
              }
            : undefined;
        // 卡片把 onOpenRun、onResume 等可选回调原样下传。
        // 可选字段用条件展开，undefined 时不写进 props。
        // 设置轮在卡片上方追加一行 settings 摘要。
        const card = (
          <WorkflowRunDigest
            graph={digest.graph}
            {...(digest.holeLabels === undefined ? {} : { holeLabels: digest.holeLabels })}
            key={digest.key}
            name={name}
            pendingQuestions={pendingQuestions}
            runId={runId}
            summary={summary}
            testIdKey={`${turnKey}-${digest.toolCallId}`}
            {...(subagentModelProviderName === undefined ? {} : { subagentModelProviderName })}
            {...(onOpenRun === undefined ? {} : { onOpenRun })}
            {...(onResume === undefined ? {} : { onResume })}
            {...(onCancel === undefined ? {} : { onCancel })}
            {...(onOpenPill === undefined ? {} : { onOpenPill })}
            {...(onOpenWorkspace === undefined ? {} : { onOpenWorkspace })}
            {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
            {...(settingsHost === undefined ? {} : { settingsHost })}
          />
        );
        // 设置轮：卡上方一行说改了什么。
        if (digest.settings === undefined) return card;
        return (
          <div className="flex flex-col gap-1.5" key={digest.key}>
            <WorkflowSettingsChangeRow
              amend={digest.settings.amend}
              {...(digest.settings.at === undefined ? {} : { at: digest.settings.at })}
              {...(subagentModelProviderName === undefined
                ? {}
                : { providerName: subagentModelProviderName })}
            />
            {card}
          </div>
        );
      })}
    </div>
  );
}
