// ============================================================
// Dynamic Workflow Run Port - 留白（hole）的读面与补全面
// ============================================================
// 从 dynamic-workflow-run.port.ts 拆出（oxlint max-lines 400 行门），照 retune 的先例
// （dynamic-workflow-run-retune.port.ts）：快照上的留白条目、`fillHole` 的请求与结果住在这里，端口
// 方法本身仍在 DynamicWorkflowRunPort 上；公开名一个不改，主端口文件 `export type *` 再导出。
// spec：docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」；
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Holes」。
//
// 【持久性分工】留白的**事实**在 journal：`hole-reached` 记「到过」，`hole-filled` 记「补过」
// （携有效脚本的哈希与草稿路径），两者都是追加事件、永不改写。留白的**当下**（还有没有人在等）
// 只在提问进程的内存停驻表里——进程亡故后没有 promise 在等，单靠事件会把一个没人问的留白
// 报成在等。所以本文件的 `state` 必须由两者合成，且 `waiting` 永远以引擎为准。
//
// 【原子性】补全对一个 run 是**串行**的（服务侧按 runId 排队），幂等键是 `siteId`：一处留白
// 补过之后编译产物里它就不再是 open，第二次调用只能拿到 `hole_not_waiting`。拒绝即零副作用。

import type { SessionId, ToolCallId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

/**
 * 【契约坐标】`(siteId, ordinal)` 仍是实例坐标：siteId 是编译期名字键（`fillHole` 只认它），
 * ordinal 是同一站在循环里的第几次到达；`state` / `since` / `filledAt` 是**合成结果**而非持久
 * 字段——`filled` 读事件、`waiting` 读引擎的停驻表。生产者：`runHolesOf`；消费者：快照的
 * `holes`、详情、留白通知的发射器与 `FillWorkflowHole` 的 resolveInput。零条时整字段缺席（≤32）。
 *
 * 一处留白在快照上的投影（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「The run snapshot」）：
 * 由 `hole-reached` / `hole-filled` 事件加引擎内存里的停驻表投影——**`waiting` 只在引擎说它在等时**
 * 成立（进程亡故后没有 promise 在等，单靠事件会把一个没人问的留白报成在等），`filled` 来自事件。
 * 零条时整字段缺席，≤32。
 *
 * `line` / `before` / `after` 是留白通知（core 的进度发射器）要念的三样：留白调用在草稿里的行、
 * 它前后的阶段名，都来自编译产物；读不到时缺席，通知随之省略那一句。草稿路径不在这里——它就是
 * 快照的 `scriptPath`。
 */
export interface DynamicWorkflowRunHole {
  /** 留白的站点 id（`hole#21b40fca`，名字键）；`fillHole` 只认它。 */
  siteId: string;
  /** 这一处的序号（同一站点在循环里可以到达多次）。 */
  ordinal: number;
  /** 留白的字面名。 */
  name: string;
  /** 类型实参原文（`Verdict`），照脚本写法。 */
  type: string;
  state: "waiting" | "filled";
  /** 到达时刻（epoch ms）；`waiting` 时在场。 */
  since?: number;
  /** 补全时刻（epoch ms）；`filled` 时在场。 */
  filledAt?: number;
  /** 补全它的会话（`fillHole` 请求的 `parentSessionId`）。 */
  filledBy?: string;
  /** 留白调用在 run 草稿里的行号（1 起）。 */
  line?: number;
  /** 留白之前的阶段名。 */
  before?: string;
  /** 留白之后的阶段名。 */
  after?: string;
}

/**
 * 【契约坐标】生产者：core 的 `FillWorkflowHole` handler（`body` 取自模型或 fill 文件，`path`
 * 修订时逐字节）；消费者：bootstrap 的 `fillDynamicWorkflowHole`。`holeId` 是唯一的定位键与
 * 幂等键——请求里没有 ordinal，因为一处留白只补一次；同一 run 的多次补全在服务侧按 runId
 * 串行排队，避免两次调用拿同一份旧脚本互相覆盖。`parentSessionId` / `toolCallId` 只是记账
 * （落 `hole-filled`），不参与授权判定。
 *
 * {@link DynamicWorkflowRunPort.fillHole} 的请求（docs/dynamic-workflow/launch.md「The `FillWorkflowHole`
 * tool」；引擎文档「The fill service's checks」）。`body` 是留白函数体的**语句**，逐字节；拼接、编译、
 * 站点稳定性检查与草稿改写都在端口实现侧。
 */
export interface DynamicWorkflowRunFillHoleRequest {
  runId: string;
  /** 留白的站点 id（`hole#21b40fca`，名字键）。 */
  holeId: string;
  body: string;
  /** 补全的会话，落进 `hole-filled.filledBy`。 */
  parentSessionId?: SessionId | string;
  /** 发起这次补全的 FillWorkflowHole 工具调用。 */
  toolCallId?: ToolCallId | string;
  trace: TraceContext;
}

/**
 * 【契约坐标】四个判别键由 `fillDynamicWorkflowHole` 的五个检查点产出（找 run → 找开放站点 →
 * 整份脚本重编译 → 站点稳定性 → 引擎 `fillHole`），消费者是 `FillWorkflowHole` handler 的下一步
 * 文案。`fill_ids_unstable` 是**宿主故障**而非模型的错（编译器的编号规则被打破），所以它的
 * 文案不该让模型去改脚本。所有拒绝都发生在引擎接单之前，因此 journal 与草稿都没有被动过。
 *
 * 补全被拒的结构化理由。四者对模型是四个不同的下一步：换 run id / 看 run 的状态（停了就先
 * ResumeWorkflowRun）/ 改 fill 文件再交 `path` / 什么都别改，这是宿主的故障。
 */
export type DynamicWorkflowRunFillHoleRefusalReason =
  /** journal 里没有这个 run。 */
  | "run_not_found"
  /** run 不在飞，或这个留白不是它正在等的（已补过、还没到、未知 id）；message 说明是哪一种。 */
  | "hole_not_waiting"
  /** 有效脚本编不过；`diagnostics` 在场。什么都没拼、没记、留白照旧在等。 */
  | "compile_failed"
  /** 编好的有效脚本给某个既有站点换了号：分析器的编号规则被打破，是宿主故障而非模型的错；留白照旧在等。 */
  | "fill_ids_unstable";

/**
 * 【契约坐标】`inFill` 是**坐标系判别位**而不是分类位：真时 `line` / `column` 相对拼进去的那段
 * 函数体，假时相对整份脚本。生产者：`mapFillDiagnostics`（把分析器的诊断按落点切开）；
 * 消费者：`FillWorkflowHole` handler（据此把诊断锚到 fill 文件还是 run 的草稿）。行号 1 起，
 * 编码是编译器的稳定数字码，文案可能随版本变，判别请用 `code`。
 *
 * 一条补全诊断。`inFill` 为真时 `line` / `column` 是**函数体内**的坐标（拼进去的那一段），否则是
 * 脚本坐标——工具层据此把它锚到 fill 文件或 run 的草稿。
 */
export interface DynamicWorkflowRunFillHoleDiagnostic {
  line: number;
  column: number;
  message: string;
  code: number;
  inFill: boolean;
}

/**
 * 【契约坐标】成功时三样东西已经**落地**：journal 的 `hole-filled`（引擎在同一个同步步骤写回
 * run 行、记事件、放行停驻分支）、注册表条目里的有效脚本、草稿文件的新内容。`scriptText` /
 * `scriptPath` 是有效脚本与草稿，`phasesAdded` 是函数体新引入的阶段名（侧栏轨道要用）。
 * 唯一的顺序例外：无草稿的 run 会先铸一份新草稿（它的路径要随事件进 journal），引擎随后拒绝
 * 时把这份刚铸的文件删掉——「什么都不删」说的是模型编辑过的草稿，不是本次调用独占创建的文件。
 *
 * `fillHole` 的结构化结果。成功时 `scriptText` 是**有效脚本**（已拼入函数体、已落库的那一份），
 * 工具层据它铸 display；`scriptPath` 是 run 的草稿（已被就地改写成有效脚本；run 原本没有草稿时
 * 由实现侧铸一份）；`phasesAdded` 是函数体带来的阶段名。
 */
export type FillWorkflowHoleResult =
  | { ok: true; phasesAdded: string[]; scriptPath?: string; scriptText: string }
  | {
      ok: false;
      reason: DynamicWorkflowRunFillHoleRefusalReason;
      message: string;
      diagnostics?: DynamicWorkflowRunFillHoleDiagnostic[];
    };
