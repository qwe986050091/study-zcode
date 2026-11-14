// INV-01 工厂纯函数无状态：守住位置 返回三闭包；改错故障 每帧残留上一帧药丸。
// INV-02 命名优先运行时名：守住位置 空值合并；改错故障 用户改名被泳道名覆盖。
// INV-03 相位名缺失退回标识：守住位置 空值分支；改错故障 脚本入口显示空标签。
// INV-04 站点查找按标识：守住位置 查找比较；改错故障 相位名取到相邻站。
// INV-05 打开需回调与槽位同时具备：守住位置 双重判断；改错故障 点击无反应的药丸。
// INV-06 会话标识有则随行无则占位：守住位置 条件展开；改错故障 打开错误会话。
// INV-07 打开面板状态三态映射：守住位置 三元链；改错故障 失败被显示为等待。
// INV-08 运行时名可缺席：守住位置 条件展开；改错故障 面板标题出现未定义值。
// INV-09 打开语法二者择一：守住位置 三元链；改错故障 同一点击触发两种打开。
// INV-10 无打开能力时不挂打开属性：守住位置 空值返回；改错故障 药丸看似可点。
// INV-11 测试标识区分代理与脚本：守住位置 两个常量；改错故障 自动化无法区分入口。
// INV-12 模型标题仅在已知时追加：守住位置 空值判断；改错故障 标题出现空行。
// INV-13 活动计数只追加大于零项：守住位置 条件判断；改错故障 出现零任务零读取。
// INV-14 问题列表按实例聚合：守住位置 映射查找；改错故障 问题挂到别人行下。
// INV-15 问题归属缩进比行更深：守住位置 类名边距；改错故障 问题被读成新一行。
// INV-16 药丸以时间线键作 React 键：守住位置 键属性；改错故障 重排后状态串位。
// INV-17 尾槽同时给计数与模型名：守住位置 属性传递；改错故障 药丸缺少模型提示。
// INV-18 渲染不读取全局时钟：守住位置 入参当前时间；改错故障 同帧不同药丸时间不一致。
//
// 模块职责：把工作流时间线药丸接到脊线上，提供命名、属性与渲染三个闭包。
// 状态所有权：无状态；时间线模型、图数据与回调全部由调用方注入。
// 阅读顺序：先看接口与命名，再看打开动作，最后看属性合成与渲染。
import type { WorkflowRunPendingQuestion, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type {
  TimelinePill,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";
import { pillActivity } from "@/components/workflow-timeline/timeline-pill-activity.js";
import { pillInstanceKey } from "@/components/workflow-timeline/roster-model.js";
import {
  WorkflowAgentPill,
  type WorkflowAgentPillOpen,
} from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { WorkflowRunQuestionRow } from "@/app-shell/WorkflowRunQuestionRow.js";
import {
  SpinePillTrailer,
  type useWorkflowActorModelLabels,
} from "@/app-shell/WorkflowRunSpineParts.js";
import type { WorkflowActorInstance } from "@/app-shell/workflowRunPanel.js";

/**
 * 详情页脊线上药丸的接线（docs/dynamic-workflow/presentation.md「The spine」）。从
 * WorkflowRunPhaseList.tsx 拆出（max-lines 门）：那里只管节的开合、落点与留白，药丸怎么命名、怎么打开、
 * 尾槽写什么全在这里。纯函数工厂：清单每帧调用一次拿到三把闭包，没有自己的状态。
 */
type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

// phasePillRenderers() 返回 nameOf / pillProps / renderPill 三个闭包。
// 清单每帧调用一次 phasePillRenderers()，不复用旧闭包。
// 工厂内部不持有状态，全部依赖来自入参。
// nameOf 与 openActor 解耦，命名不需要槽位。
export interface PhasePillRenderers {
  nameOf: (pill: TimelinePill) => string;
  pillProps: (pill: TimelinePill) => Parameters<typeof WorkflowAgentPill>[0];
  renderPill: (pill: TimelinePill) => JSX.Element;
}

// nameOf 优先 pill.runtimeName，缺失才用 laneDisplayName()。
// phaseNameOf() 找不到 station 时直接回退 phaseId。
// 站点只在 model.stations 里查，不额外请求。
export function phasePillRenderers({
  actorModels,
  format,
  graph,
  model,
  now,
  onOpenActor,
  onOpenWorkspace,
  questionsByInstance,
  run,
}: {
  model: WorkflowTimelineModel;
  graph: WorkflowCausalityGraphData;
  run: WorkflowRunState | undefined;
  format: FormatMessage;
  actorModels: ReturnType<typeof useWorkflowActorModelLabels>;
  questionsByInstance: ReadonlyMap<string, WorkflowRunPendingQuestion[]>;
  now: number;
  onOpenActor?: (instance: WorkflowActorInstance) => void;
  onOpenWorkspace?: (phaseId: string) => void;
}): PhasePillRenderers {
  const pillKey = pillInstanceKey;
  const nameOf = (pill: TimelinePill) => pill.runtimeName ?? laneDisplayName(pill.lane, format);
  const phaseNameOf = (phaseId: string) => {
    const station = model.stations.find((candidate) => candidate.id === phaseId);
    return station === undefined ? phaseId : phaseDisplayName(station.naming, format);
  };

  // 行交出槽位身份：会话 id 有则随行，没有就开占位 tab。
  // onOpenActor 或 slot 缺失时 openActor() 直接 return。
  // sessionId 存在时随行透传，否则留空由宿主补占位。
  // running 原样保留；done 与 failed 归一为 completed，其余为 waiting。
  const openActor = (pill: TimelinePill) => {
    const slot = pill.slot;
    if (onOpenActor === undefined || slot === undefined) return;
    const sessionId = pill.instance?.sessionId;
    onOpenActor({
      ordinal: slot.ordinal,
      ...(sessionId === undefined ? {} : { sessionId }),
      siteId: slot.siteId,
      status:
        pill.status === "running"
          ? "running"
          : pill.status === "done" || pill.status === "failed"
            ? "completed"
            : "waiting",
      ...(pill.runtimeName === undefined ? {} : { name: pill.runtimeName }),
    });
  };

  /** 药丸的公共接线（名字、状态、可打开）；整行药丸与「列出全部」的密排药丸共用。 */
  const pillProps = (pill: TimelinePill) => {
    const label = nameOf(pill);
    const openable = onOpenActor !== undefined && pill.slot !== undefined;
    // 脚本行同一条打开语法：开整个 run 的脚本 transcript，落到这一站的第一张卡。
    const workspacePhaseId = onOpenWorkspace === undefined ? undefined : pill.workspace?.phaseId;
    const open: WorkflowAgentPillOpen | undefined = openable
      ? {
          data: {
            "data-agent-key": pillKey(pill) ?? "",
            "data-agent-session-id": pill.instance?.sessionId ?? "",
            "data-agent-status": pill.status ?? "pending",
          },
          label: format({ id: "chat.toolCall.workflow.timeline.openAgent" }, { name: label }),
          onOpen: () => openActor(pill),
          testId: "workflow-run-agent-open",
        }
      : workspacePhaseId !== undefined
        ? {
            data: { "data-phase-id": workspacePhaseId },
            label: format(
              { id: "chat.toolCall.workflow.timeline.openScript" },
              { phase: phaseNameOf(workspacePhaseId) },
            ),
            onOpen: () => onOpenWorkspace?.(workspacePhaseId),
            testId: "workflow-run-workspace-open",
          }
        : undefined;
    const actorModel = actorModels.get(pillKey(pill) ?? "");
    return {
      avatarIndex: pill.avatarIndex,
      laneClass: pill.laneClass,
      name: label,
      status: pill.status,
      title: actorModel === undefined ? label : `${label}\n${actorModel.canonical}`,
      ...(open === undefined ? {} : { open }),
    };
  };

  // activity.asks 与 activity.reads 为 0 时都不 push 计数。
  // questions 按 pillKey(pill) 从 questionsByInstance 取。
  // 外层 flex-col 让 <button> 药丸拉满列宽。
  const renderPill = (pill: TimelinePill) => {
    const activity = pillActivity(graph, run, pill);
    const key = pillKey(pill);
    const questions = key === undefined ? [] : (questionsByInstance.get(key) ?? []);
    const counts: string[] = [];
    if (activity.asks > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.tasks" }, { count: activity.asks }),
      );
    }
    if (activity.reads > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.reads" }, { count: activity.reads }),
      );
    }
    // 可打开的药丸是 <button>：块级父元素里它只包住内容，行宽会随名字长短参差。
    // 纵向 flex 容器让每一行拉满本列宽度（与卡上站下的药丸列同一机制）。
    return (
      <div className="flex min-w-0 flex-col" key={pill.key}>
        <WorkflowAgentPill {...pillProps(pill)}>
          <SpinePillTrailer counts={counts} modelName={actorModels.get(key ?? "")?.name} />
        </WorkflowAgentPill>
        {/* 问题挂在提问者下面，再退一步（26px）：它属于这一行，不属于这一站。 */}
        {questions.map((question) => (
          <WorkflowRunQuestionRow
            className="ml-[26px]"
            key={question.qid}
            now={now}
            question={question}
          />
        ))}
      </div>
    );
  };

  return { nameOf, pillProps, renderPill };
}
