// ============================================================
// Dynamic Workflow Run Port：工作区 transcript 的读面类型
// ============================================================
// docs/dynamic-workflow/transcript-and-notifications.md。与情势截面
// （dynamic-workflow-run-roster.port.ts）、retune（dynamic-workflow-run-retune.port.ts）同一条
// 拆分理由：dynamic-workflow-run.port.ts 顶到 oxlint max-lines 上限（400 行），而这六个类型
// 自成一组（一次 `files.*` / `git.*` / `world.run` 调用的清单行与正文）。公开面不变——那边
// 原样再导出，`@zcode/contracts` 的导入路径一字不改。
//
// 【持久性 / 读面授权】清单与正文的唯一家是 journal 的 `dwf_node` world 行（`input_json` 与
// `result_json`），端口不缓存：热条目只影响留白与子代理名册，工作区两读面始终回库。两条读面
// 都先过授权链（run 行存在 ∧ `parent_session_id` == 本服务父会话），三种拒绝归一成
// `undefined`；`parent_session_id` 为 NULL 的老行按拒绝处理。因此这里的类型只描述**回库后
// 的形状**，跨进程可重放，不随 run 死活变化。
//
// 【节点行坐标】一行的身份是 `(siteId, ordinal)`：`siteId` 是编译期站点的稳定 id，`ordinal`
// 是该站在循环里的第几次到达，两者共同定位 `dwf_node` 主键。`kind` 只有 world 两值；`op` /
// `args` 是 admission 时写下的调用清单（不是结果），正文必须另走 `readWorkspaceNodeResult`。
// `summary` 是存储层在 SQLite 内算好的派生数，不是落库列；正文读面按 `maxBytes` 保形截断，
// 截断只发生在读时，journal 里的 `result_json` 永远是原样。

// 结构化失败的形状留在主文件上（本组的两个字段引用它），所以这里反向 import 一个类型：
// 纯类型、无运行时边，两个文件各自只描述自己那一组。
import type { DynamicWorkflowRunError } from "./dynamic-workflow-run.port.js";

/**
 * 【契约坐标】封闭二值，等于 journal `dwf_node.kind` 的两个 world 值；`input_json` 的 op 决定
 * 具体是 `files.*` / `git.*`（world-read）还是 `world.run`（world-run）。生产者：引擎 facade
 * 的 admission；消费者：清单投影与 UI 卡片图标。它不是运行时可扩展的标签——新增 kind 必须
 * 同时改 journal 写入与投影映射。
 */
/** 工作区节点的种类：journal `dwf_node.kind` 的两个 world 值。 */
export type DynamicWorkflowRunWorkspaceNodeKind = "world-read" | "world-run";

/**
 * 【契约坐标】三值与 journal 的 `NodeRecordStatus` 逐字对应，是 `dwf_node.status` 的读时镜像。
 * `running` 只在热 run 上出现（冷恢复后同一行会被 resume 重新推进）；`completed` / `failed`
 * 是终态且不会互相改写。生产者：引擎结算；消费者：清单行与正文读面的分支。缺席不是状态——
 * 行存在就必然有一个值。
 */
/** 节点行的状态，= journal 的 `NodeRecordStatus`（刻意在这里重申，理由同 lifecycle status）。 */
export type DynamicWorkflowRunWorkspaceNodeStatus = "running" | "completed" | "failed";

/**
 * 【契约坐标】这些数**不是落库列**：生产者是存储层的 `listWorldNodes`，用 SQLite JSON 函数
 * 直接从 `result_json` 抽出，避免把正文搬进宿主内存；消费者是清单 UI 的角标。字段集合随 op
 * 变化（数组正文出 `resultCount`、`world.run` 出 `exitCode` + 两路字节、字符串正文只有
 * `resultBytes`），缺席即「这一类没有这个数」，不是 0。`resultBytes` 是序列化后的 UTF-8 长度，
 * 与正文读面的 `totalBytes` 同口径。
 *
 * 清单上一行的**摘要**：不把正文解出来就能报的那几个数。由存储层用 SQLite 的 JSON 函数在
 * 查询里算出（`resultBytes` / `resultCount` / `exitCode` / `stdoutBytes` / `stderrBytes`），
 * 端口原样透传。哪个字段在场取决于 op：数组正文（glob / grep / changedFiles）有 `resultCount`，
 * `world.run` 有 exitCode 与两路输出的字节数，字符串正文只有 `resultBytes`。
 */
export interface DynamicWorkflowRunWorkspaceNodeSummary {
  /** 正文序列化后的 UTF-8 字节数。 */
  resultBytes: number;
  resultCount?: number;
  exitCode?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
}

/**
 * 【契约坐标】一行 = `dwf_node` 的一条 world 记录，身份 `(siteId, ordinal)`，只含清单所需、
 * **不含正文**。生产者：`toWorkspaceNode`（存储层行 → 端口形状）；消费者：v4 的工作区
 * transcript 与冷恢复回放。`op` / `args` 来自迁移 0030 的 `input_json`（admission 时写、≤4 KB），
 * 老行缺席时 UI 退回静态步标签；`inputTruncated` 表示 args 是逐项预览而非原值。`createdAt` /
 * `updatedAt` 是 journal 行的建立与最近更新时刻（epoch ms），差值即这一步耗时，不读宿主时钟。
 *
 * 工作区 transcript 的一行：一次 `files.*` / `git.*` / `world.run` 调用，**不带正文**。
 *
 * `op` / `args` 来自迁移 0030 加的 `input_json`（admission 时写下、≤ 4 KB）；升级前的历史行
 * 两者缺席，UI 退回静态图上的步标签。`inputTruncated` 表示 args 是逐项字符串预览而不是原值。
 */
export interface DynamicWorkflowRunWorkspaceNode {
  /** 编译期站点 id（`collectSites` 分配）；与 `ordinal` 共同构成 `dwf_node` 的定位键。 */
  siteId: string;
  /** 该站在循环 / 回边里的第几次到达（1 起）；同一 siteId 下的不同时机靠它区分。 */
  ordinal: number;
  kind: DynamicWorkflowRunWorkspaceNodeKind;
  op?: string;
  args?: readonly unknown[];
  inputTruncated?: true;
  status: DynamicWorkflowRunWorkspaceNodeStatus;
  /** failed 行的结构化失败（journal `error_json` 的 code + message；其余字段不出端口）。 */
  error?: DynamicWorkflowRunError;
  /** 结算成功的行才有。 */
  summary?: DynamicWorkflowRunWorkspaceNodeSummary;
  /** journal 行的建立 / 最近更新时刻（epoch 毫秒）；二者之差就是这一步的耗时。 */
  createdAt: number;
  updatedAt: number;
}

/**
 * 【契约坐标】唯一的界是调用方给的 `maxBytes`，端口按它**有界化而不是拒绝**：这是审计面，
 * 一张卡片要「跑了什么、前几百行是什么」，而不是脚本的取数面。生产者：v4 的正文展开；
 * 消费者：`readWorkspaceNodeResult` 的 `boundWorkspaceResult`。界只影响本次返回，不改写
 * journal；同一节点按不同 `maxBytes` 读会得到不同长度的前缀，`totalBytes` 说出原长。
 */
/** {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.readWorkspaceNodeResult} 的分页袋：正文的字节上限。 */
export interface DynamicWorkflowRunWorkspaceNodeResultQuery {
  /** 必填；端口按它**有界化**正文（截断而不是拒绝——这是审计面，不是脚本的取数面）。 */
  maxBytes: number;
}

/**
 * 【契约坐标】正文是 `dwf_node.result_json` 的读时投影，按形状保形截断：字符串切尾、数组去尾、
 * `world.run` 的 stdout / stderr 分别切尾且 `exitCode` 恒保留；`truncated` 说明发生过截断，
 * `totalBytes` 是截断前序列化字节数。running 行没有正文；failed 行只有 `error`（message 截到
 * 2000 字）；completed 行才有 `result`。生产者：`readWorkspaceNodeResultFrom`；消费者：展开的
 * 工具卡片。截断永不回写——journal 里仍是原样正文。
 *
 * 一个工作区节点的正文：按形状有界化过的 `result`。
 *
 * 截断是**保形**的：字符串切尾、数组去尾、`world.run` 的 stdout / stderr 各自切尾，
 * `truncated` 说明发生过截断，`totalBytes` 是截断前的字节数。running 行没有正文；failed 行
 * 只有 `error`。
 */
export interface DynamicWorkflowRunWorkspaceNodeResult {
  status: DynamicWorkflowRunWorkspaceNodeStatus;
  result?: unknown;
  error?: DynamicWorkflowRunError;
  truncated: boolean;
  totalBytes: number;
}
