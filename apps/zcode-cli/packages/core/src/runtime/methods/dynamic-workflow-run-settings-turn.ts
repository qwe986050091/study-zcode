// ============================================================
// GUI「配置」的设置轮：怎么记、记成什么话
// ============================================================
// docs/dynamic-workflow/launch.md「The settings turn」。从 dynamic-workflow-run-settings.ts 拆出
// （400 行纪律）：那边是决策与副作用的顺序，这里是「这件事怎么讲给模型和会话听」——入队、
// 两项设置的 from/to、以及两条规范句（修订出了新 run / 就地生效还是同一个 run）。

import type { TraceContext, WorkflowSettingsAmendMeta } from "@zcode/contracts";
import type { DynamicWorkflowRunSnapshot } from "@zcode/contracts";
import { uuidv7 } from "@zcode/shared";
import { createRuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { boundWorkflowLaunchMeta } from "@zcode/contracts";

/** 本 run 的两项设置的归一形：缺席即默认（会话模型 / 默认并发）。 */
export interface RunSettings {
  subagentModel?: string;
  maxConcurrency?: number;
}

/**
 * 设置轮不在命令处理里直接落：主代理可能正在一轮里，user 消息插不进去。排进运行时队列，空闲时
 * 立即跑、忙时等当前轮结束；与通知同优先级，因而先于新 run 的任何通知（docs/dynamic-workflow/
 * launch.md「The settings turn」）。
 */
export function enqueueSettingsTurn(
  this: AgentRuntimeInternal,
  turn: {
    text: string;
    meta: ReturnType<typeof boundWorkflowLaunchMeta>;
    titleInput: string;
    traceContext: TraceContext;
  },
): void {
  // 入队而非直接执行：command 队列是唯一串行点，保证设置轮不与在跑 turn 交错。
  this.enqueueRuntimeCommand({
    // 冻结当前分支代际；若 drain 前发生 rewind，这条命令会因代际不符被丢弃（不变量 #6）。
    branchGeneration: this.branchGeneration,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    // inputId 是消息/账本关联键；uuidv7 带时间序，同一毫秒内的命令也可稳定排序。
    inputId: uuidv7(),
    // control-only-turn 只投递一句规范话，不产生工具调用，也不改变 run 状态。
    mode: "control-only-turn",
    // next 与后台通知同级；设置轮先于新 run 的通知，模型先读到「设置已改」再看到进展。
    priority: "next",
    text: turn.text,
    titleInput: turn.titleInput,
    traceContext: turn.traceContext,
    workflowLaunch: turn.meta,
  });
}

export function fromTo<T>(from: T | undefined, to: T | undefined): { from?: T; to?: T } {
  // 两侧都缺席即「这项没改」；条件展开避免把 undefined 写成键，null 才是明确的「恢复默认」。
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/**
 * 设置轮的模型面规范句（英文，不本地化——它进 provider transcript）。只说改过的设置；两个 `null`
 * 各有一句话。末句劝阻模型再动这个 run：它已经在跑，进展以通知回来。
 *
 * 两种结局在这里分岔，判据就是 `amend.predecessorRunId` 在不在场（缺席即就地生效，与元数据同
 * 一条读法）：修订出了一个新 run，就地调并发则还是同一个 run——照修订那句话写下去，模型会去找
 * 一个根本不存在的 run B。
 */
export function buildSettingsMessageText(input: {
  name?: string;
  previous: string;
  runId: string;
  superseded: boolean;
  amend: WorkflowSettingsAmendMeta;
}): string {
  // predecessorRunId 缺席 = 就地调并发（同一个 run）；有值 = 修订产出了新 run。
  // 判据与元数据构造共用同一读法，避免两边对「有没有新 run」得出不同结论。
  const inPlace = input.amend.predecessorRunId === undefined;
  // 这句进 provider transcript，因此固定英文；name 只在该 run 有展示名时出现。
  const lead = `Changed the settings of workflow run ${input.previous}${input.name === undefined ? "" : ` ("${input.name}")`} from the GUI: ${settingsChangeClauses(input.amend, inPlace).join("; ")}.`;
  const closing =
    "Progress and results arrive as background notifications; do not amend, resume or restart it.";
  if (inPlace) {
    // 就地生效时没有新 run，文案必须明确「没有停止、也没有启动新 run」，否则模型会去找 run B。
    const kept =
      input.amend.maxConcurrency?.to === undefined
        // to 缺席表示恢复默认（无上限），不是「改成 undefined 值」。
        ? `Run ${input.previous} keeps running with no limit`
        : `Run ${input.previous} keeps running under the new limit`;
    return [lead, `${kept}; nothing was stopped and no new run was started.`, closing].join(" ");
  }
  // 修订出的新 run 有两种关系：旧 run 已停（supersedes）或从旧 run 接管（takes over from）。
  // 接管时旧 run 已完成的产物会作为缓存导入，文案要写出来，模型才不会重跑。
  const relation = input.superseded ? "supersedes" : "takes over from";
  return [
    lead,
    `The same script continues as run ${input.runId}, which ${relation} run ${input.previous} and imports everything run ${input.previous} finished as cache.`,
    closing,
  ].join(" ");
}

/**
 * 「改了什么」的分句。就地生效那一条要把主语说全（「at most n of **its subagents**」）：那条路上
 * 没有模型分句在前，一句「at most n of them」就没有了指代对象。
 */
function settingsChangeClauses(amend: WorkflowSettingsAmendMeta, inPlace: boolean): string[] {
  const changes: string[] = [];
  const model = amend.subagentModel;
  if (model !== undefined) {
    // 没携带 model 分句说明这项没改；to 缺席则是回到会话模型，而不是空字符串。
    changes.push(
      model.to === undefined
        ? "its subagents are back on the session model"
        : `its subagents now run on ${model.to}`,
    );
  }
  const bound = amend.maxConcurrency;
  if (bound !== undefined) {
    // 并发界同样用 to 缺席表示恢复默认；措辞差异见下。
    changes.push(
      bound.to === undefined
        ? "the limit on subagents at once is back to the default"
        : inPlace
          // 就地生效时前面没有「run X」，必须写全 its subagents，否则 them 没有指代对象。
          ? `at most ${bound.to} of its subagents run at once`
          // 修订场景前文已给出 run 名，用 them 指代同一批子代理。
          : `at most ${bound.to} of them run at once`,
    );
  }
  return changes;
}

/**
 * 快照上的两项设置。两者都「无则缺席」：没指定过模型 = 会话模型，界等于默认并发 = 没有自己的界，
 * 所以缺席就是默认，与 {@link RunSettings} 同一个读法。
 */
export function runSettingsOfSnapshot(snapshot: DynamicWorkflowRunSnapshot): RunSettings {
  // 快照字段缺席 = 用默认；条件展开保持「缺席」语义，不能写成值为 undefined 的键。
  return {
    ...(snapshot.subagentModel === undefined ? {} : { subagentModel: snapshot.subagentModel }),
    ...(snapshot.maxConcurrency === undefined ? {} : { maxConcurrency: snapshot.maxConcurrency }),
  };
}
