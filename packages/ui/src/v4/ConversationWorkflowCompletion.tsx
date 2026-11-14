// INV-01 回调存在即门控：守住位置 可选属性判断；改错故障 无宿主时出现死按钮。
// INV-02 打开运行需三段齐备：守住位置 三条件与运算；改错故障 缺工具调用标识仍可点。
// INV-03 打开产物只需会话与回调：守住位置 双条件；改错故障 冷态卡没有产物入口。
// INV-04 产物清单以通知载荷为底：守住位置 合并入参顺序；改错故障 交付物被挤出首位。
// INV-05 载荷被裁时补尾部产物：守住位置 剩余映射遍历；改错故障 journal 产物整批丢失。
// INV-06 保留标识删除已合并项：守住位置 映射删除；改错故障 同一产物出现两次。
// INV-07 版本取两源较大值：守住位置 最大值比较；改错故障 旧载荷版本覆盖新版本。
// INV-08 缺席可选字段不写键：守住位置 条件展开；改错故障 出现未定义属性。
// INV-09 交付物旗子单独提升：守住位置 布尔判断；改错故障 主交付物退化为普通行。
// INV-10 清单完整时作废裁剪旗：守住位置 完整判断；改错故障 已知数量仍显示省略号。
// INV-11 无会话上下文退回冷态：守住位置 早退分支；改错故障 静态渲染访问会话服务。
// INV-12 保存槽位缺席时不写键：守住位置 空值判断；改错故障 卡头出现空占位。
// INV-13 页脚数字按需组装：守住位置 条件展开；改错故障 卡片出现零值格。
// INV-14 阶段数仅在有标记时给出：守住位置 非空判断；改错故障 无阶段脚本显示零。
// INV-15 预览只挂画出的框：守住位置 编号集合判断；改错故障 不可见产物触发字节读取。
// INV-16 打开请求按当时清单构造：守住位置 工厂参数；改错故障 补全字段点开时丢失。
// INV-17 产物补全再重建回调：守住位置 调用顺序；改错故障 点开缺少来源路径。
// INV-18 保存能力取回调在场：守住位置 布尔字段；改错故障 无回调仍显示保存按钮。
//
// 模块职责：把工作流完成事实接上打开、产物取数与保存槽位。
// 状态所有权：完成事实来自通知载荷，活投影只做补充。
// 阅读顺序：先看门控与冷态，再看清单合并，最后看带数据版本。
import { useMemo } from "react";
import type { WorkflowRunArtifactSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  WorkflowCompletionCard,
  type WorkflowCompletionFigures,
} from "@/components/workflow-timeline/WorkflowCompletionCard.js";
import {
  completionArtifactLayout,
  completionPreviewIds,
} from "@/components/workflow-timeline/WorkflowCompletionArtifacts.js";
import type { WorkflowCompletionArtifact } from "@/components/workflow-timeline/WorkflowArtifactTile.js";
import {
  useWorkflowRunArtifacts,
  type WorkflowRunArtifactView,
} from "@/hooks/useWorkflowRunArtifacts.js";
import {
  WorkflowRunSaveSlotsBoundary,
  type WorkflowRunSaveSlots,
  type WorkflowRunSaveSlotsHost,
} from "@/project-workflow/WorkflowRunSaveControls.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { WorkflowArtifactTilePreview } from "@/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.js";
import { useHasV4Conversation } from "@/v4/V4ConversationContext.js";
import type { WorkflowTurnCompletion } from "@/v4/workflowTurnCompletion.js";

/**
 * 完成卡的落位：把解析出的完成事实接上
 * 宿主回调与产物取数。回调的存在即门控（照 `ConversationWorkflowDigests`）：⤢ 要
 * `onOpenWorkflowRun` + sessionId + 联接到的 `toolCallId`；瓦片与药丸要 `onOpenWorkflowArtifact`
 * + sessionId（不需要 toolCallId，与通知行同一条门）。
 *
 * 产物清单**以通知载荷为底**（随通知持久化，冷恢复也在），会话在场时再经既有的产物 hook 补
 * 字节数 / 出处 / 看板 spec / 交付物旗子，并给交付物的框挂预览。没有会话上下文的宿主（静态渲染、
 * 回放）画的是只有字形的冷态卡——同一张卡，少一层。
 */
// completion.summary 是通知载荷给出的完成事实。
// context.onOpenWorkflowRun 与 onOpenWorkflowArtifact 是否存在决定卡片能力。
// hasConversation 为假或 sessionId 缺失时退回 WorkflowCompletionCard 冷态。
export function ConversationWorkflowCompletion({
  completion,
  context,
  turnKey,
}: {
  completion: WorkflowTurnCompletion;
  context: ConversationRowRenderContext;
  turnKey: string;
}) {
  const hasConversation = useHasV4Conversation();
  const sessionId = context.sessionId ?? undefined;
  const { summary } = completion;
  const run = summary?.run;
  const candidates = context.workflowSaveCandidatesByRunId?.get(completion.runId);

  const figures: WorkflowCompletionFigures = {
    ...(completion.durationMs === undefined ? {} : { durationMs: completion.durationMs }),
    ...(run === undefined
      ? {}
      : {
          tokens: run.usage.spentTokens,
          subagents: run.actors.length,
          // 卡上不说「步」：第四格是进过的阶段数；无标记脚本没有它，格写 `—`。
          ...(run.phases !== undefined && run.phases.length > 0
            ? { phases: run.phases.length }
            : {}),
        }),
  };
  const onOpenRun =
    context.onOpenWorkflowRun && sessionId && summary?.toolCallId
      ? () =>
          context.onOpenWorkflowRun?.({
            parentSessionId: sessionId,
            toolCallId: summary.toolCallId!,
            runId: completion.runId,
            workflowName: completion.name,
          })
      : undefined;
  // 打开请求按**当时手上那份清单**构造，所以是一个按清单取参的工厂而不是一个闭死的回调：
  // 冷态只有通知载荷（有 `contentType`，没有 `sourcePath`），活路径下
  // `WorkflowCompletionWithData` 拿补齐过的那份再造一次，出处才带得上。宿主据 `contentType`
  // 决定 html 产物直接开浏览器 tab。
  const openArtifactFrom =
    context.onOpenWorkflowArtifact && sessionId
      ? (artifacts: readonly WorkflowCompletionArtifact[]) => (artifactId: string) => {
          const artifact = artifacts.find((candidate) => candidate.id === artifactId);
          context.onOpenWorkflowArtifact?.({
            parentSessionId: sessionId,
            runId: completion.runId,
            artifactId,
            ...(artifact?.title === undefined ? {} : { title: artifact.title }),
            ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
            ...(artifact?.sourcePath === undefined ? {} : { sourcePath: artifact.sourcePath }),
          });
        }
      : undefined;
  const onOpenArtifact = openArtifactFrom?.(completion.artifacts);

  // 表头那一对控件（docs/dynamic-workflow/transcript-and-notifications.md「Saving the run,
  // and running it again」）。两道门在 `onSendWorkflowSaveRequest` 的供给点上，与 Resume 同一处；
  // 芯片不受门的影响——它说的是磁盘上有没有那份文件，不是这张卡能不能动它。
  const saveHost: WorkflowRunSaveSlotsHost = {
    sessionId: sessionId ?? undefined,
    workspacePath: context.workspacePath,
    ...(context.workspaceIdentity === undefined
      ? {}
      : { workspaceIdentity: context.workspaceIdentity }),
    ...(context.workspaceRemoteSessionId === undefined
      ? {}
      : { remoteSessionId: context.workspaceRemoteSessionId }),
    runId: completion.runId,
    runName: completion.name,
    ...(candidates === undefined ? {} : { candidates }),
    canSave: context.onSendWorkflowSaveRequest !== undefined,
    ...(context.onSendWorkflowSaveRequest === undefined
      ? {}
      : { sendLead: context.onSendWorkflowSaveRequest }),
  };

  const shared = {
    artifactsTruncated: completion.artifactsTruncated,
    figures,
    name: completion.name,
    testIdKey: turnKey,
    ...(onOpenRun === undefined ? {} : { onOpenRun }),
    ...(onOpenArtifact === undefined ? {} : { onOpenArtifact }),
  };

  // 没有会话上下文（静态渲染、回放）：就是原来那张卡，一个控件都没有（spec「Gates」）。
  if (!hasConversation || sessionId === undefined) {
    return <WorkflowCompletionCard {...shared} artifacts={completion.artifacts} />;
  }
  return (
    <WorkflowRunSaveSlotsBoundary host={saveHost}>
      {(slots) => (
        <WorkflowCompletionWithData
          completion={completion}
          live={run?.artifacts}
          sessionId={sessionId}
          shared={withSaveSlots(shared, slots)}
          theme={context.theme}
          {...(openArtifactFrom === undefined ? {} : { openArtifactFrom })}
        />
      )}
    </WorkflowRunSaveSlotsBoundary>
  );
}

/** 把两个槽位并进卡的公共 props；缺席的槽位不写键（exactOptionalPropertyTypes）。 */
// withSaveSlots() 在 slots 为 null 时原样返回 shared。
// headerLeading 与 headerTrailing 两个槽位各自合并。
// 槽位为 null 时不写键，满足 exactOptionalPropertyTypes。
function withSaveSlots<T extends object>(shared: T, slots: WorkflowRunSaveSlots | null): T {
  if (slots === null) return shared;
  return {
    ...shared,
    ...(slots.leading === null ? {} : { headerLeading: slots.leading }),
    ...(slots.trailing === null ? {} : { headerTrailing: slots.trailing }),
  };
}

/**
 * 通知载荷的清单 + hook 视图的补充。顺序与身份归载荷（它是通知那一刻的事实，且交付物已在最前）；
 * 载荷被砍过（超 8）时 journal 里多出来的产物追加在末尾，进索引或「还有 N 个」。旗子与说明两个来源
 * 任一带上即算（老载荷没有这两个键，hook 从 journal 补回来）。
 */
// mergeCompletionArtifacts() 以 base 的顺序与身份为准。
// byId.delete() 保证已合并项不再追加。
// 剩余 byId.values() 追加到 merged 末尾。
function mergeCompletionArtifacts(
  base: readonly WorkflowCompletionArtifact[],
  views: readonly WorkflowRunArtifactView[],
): WorkflowCompletionArtifact[] {
  const byId = new Map(views.map((view) => [view.id, view] as const));
  const merged = base.map((artifact) => {
    const view = byId.get(artifact.id);
    if (view === undefined) return artifact;
    byId.delete(artifact.id);
    return {
      ...artifact,
      version: Math.max(artifact.version ?? 1, view.version),
      ...(view.contentType === undefined ? {} : { contentType: view.contentType }),
      ...(view.bytes === undefined ? {} : { bytes: view.bytes }),
      ...(view.sourcePath === undefined ? {} : { sourcePath: view.sourcePath }),
      ...(view.spec === undefined ? {} : { spec: view.spec }),
      ...(view.description === undefined ? {} : { description: view.description }),
      ...(view.primary === true ? { primary: true as const } : {}),
      itemCount: view.itemCount,
    } satisfies WorkflowCompletionArtifact;
  });
  for (const view of byId.values()) {
    merged.push({
      id: view.id,
      kind: view.kind,
      version: view.version,
      itemCount: view.itemCount,
      ...(view.title === undefined ? {} : { title: view.title }),
      ...(view.contentType === undefined ? {} : { contentType: view.contentType }),
      ...(view.bytes === undefined ? {} : { bytes: view.bytes }),
      ...(view.sourcePath === undefined ? {} : { sourcePath: view.sourcePath }),
      ...(view.spec === undefined ? {} : { spec: view.spec }),
      ...(view.description === undefined ? {} : { description: view.description }),
      ...(view.primary === true ? { primary: true as const } : {}),
    });
  }
  return merged;
}

function WorkflowCompletionWithData({
  completion,
  live,
  openArtifactFrom,
  sessionId,
  shared,
  theme,
}: {
  completion: WorkflowTurnCompletion;
  live: readonly WorkflowRunArtifactSummary[] | undefined;
  /** 打开请求的工厂；缺席即宿主没给打开能力（门与 `shared.onOpenArtifact` 同一条）。 */
  openArtifactFrom?: (
    artifacts: readonly WorkflowCompletionArtifact[],
  ) => (artifactId: string) => void;
  sessionId: string;
  shared: Omit<Parameters<typeof WorkflowCompletionCard>[0], "artifacts" | "renderPreview">;
  theme: ConversationRowRenderContext["theme"];
}) {
  // useWorkflowRunArtifacts() 的活投影只补 bytes 与 sourcePath。
  // version 取 Math.max(artifact.version ?? 1, view.version)。
  // state.complete 为真时 artifactsTruncated 强制为 false。
  // renderPreview 只挂 completionPreviewIds 命中的框。
  const state = useWorkflowRunArtifacts({
    sessionId,
    runId: completion.runId,
    ...(live === undefined ? {} : { live }),
  });
  const artifacts = useMemo(
    () => mergeCompletionArtifacts(completion.artifacts, state.artifacts),
    [completion.artifacts, state.artifacts],
  );
  // `artifactsTruncated` 说的是**通知载荷**被砍在 8 件，而这里画的清单已经由活投影 /
  // journal 补齐（产物多的 run 是常态），`+N` 与「还有 N 个」却仍按载荷的旗子写成省略号——用户看到的
  // 是「还有 … 个」，而数字明明已经知道。清单完整时旗子作废；只有老 CLI（查不到 journal）或还没
  // 答上来时才仍是省略号，那时数字确实不可知。
  const artifactsTruncated = shared.artifactsTruncated === true && !state.complete;
  const renderPreview = (artifact: WorkflowCompletionArtifact) => (
    <WorkflowArtifactTilePreview
      artifact={artifact}
      key={`${artifact.id}:${artifact.version ?? 1}`}
      runId={completion.runId}
      sessionId={sessionId}
      theme={theme}
    />
  );
  // 只有画出来的框挂预览——今天只有交付物行有框；索引行与「还有 N 个」不读字节。
  const previewIds = useMemo(
    () => completionPreviewIds(completionArtifactLayout(artifacts, artifactsTruncated)),
    [artifacts, artifactsTruncated],
  );
  // 补齐过的清单重造一次回调：载荷上没有的 `sourcePath`、老载荷上没有的 `contentType`
  // 都从 journal / 活投影补回来，点开的那一下才带得全。
  const onOpenArtifact = openArtifactFrom?.(artifacts);
  return (
    <WorkflowCompletionCard
      {...shared}
      {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
      artifactsTruncated={artifactsTruncated}
      artifacts={artifacts}
      renderPreview={(artifact) =>
        previewIds.has(artifact.id) ? renderPreview(artifact) : undefined
      }
    />
  );
}
