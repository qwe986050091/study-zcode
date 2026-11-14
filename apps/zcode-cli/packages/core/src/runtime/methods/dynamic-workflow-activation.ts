// ============================================================
// 动态工作流工具面的按需激活（docs/dynamic-workflow/launch.md「On demand: activation」）
// ============================================================
// 灰度 mode 为 `onDemand` 的会话出生时不注册十个工作流工具（Agent / Task 描述里也没有那行
// CreateWorkflow），直到本会话第一次真的要用到它们：用户敲 `/workflow`、GUI 对本会话的 run 按下
// Resume / 配置、从中枢直接启动一个保存的工作流，或恢复一条记录里已有工作流的会话。激活只加不减：
// 会话里一旦有了 run，模型此后一直需要 GetWorkflowRun 等工具去接通知——compaction 不关它
// （对比技能门：那个问的是「模型此刻还看得见吗」，这个问的是「本会话有没有过工作流」）。
//
// 状态 owner 是 runtime（dynamicWorkflowToolsActivated），不是 config：AgentRuntime 构造时把
// config 拷了一份，装配层闭包里那个 runtimeConfig 对象看不到运行期的翻转。

import {
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import { isDynamicWorkflowToolName } from "../../tool/index.js";
import { refreshBranchAwareBuiltInTools } from "./embedded-search-branch.js";

/** 激活的来源，落进 session entry 供排查；行为上四者等价。 */
export type DynamicWorkflowActivationSource =
  | "command"
  | "run_control"
  | "resume_entry"
  | "resume_history";

export interface DynamicWorkflowActivationEntryData {
  activated: true;
  source: DynamicWorkflowActivationSource;
}

/**
 * 内置 `/workflow` 命令名（bootstrap/src/builtin-workflow-command.ts 的 BUILTIN_WORKFLOW_COMMAND_NAME）。
 * core 不依赖 bootstrap，这里按保留字表里的字面量写；用户消息持久化的是 `displayInput`——命令原文。
 */
const WORKFLOW_COMMAND_TEXT_PATTERN = /^\/workflow(?:\s|$)/i;

/** 出生即激活的会话：非 onDemand（alwaysOn、TUI / headless / 子代理未设该字段）。 */
export function resolveInitialDynamicWorkflowToolsActivated(config: AgentRuntimeConfig): boolean {
  return config.dynamicWorkflowToolsOnDemand !== true;
}

/**
 * 激活本会话的工作流工具面。已激活（含出生即激活）时是 no-op 并返回 false。
 * 顺序：先翻状态、再重注册（两处注册入口共用的门读的就是这个状态）、再落 entry——重注册同步完成，
 * 所以调用方在它返回后发出的第一个模型请求必然带着十个工具。
 */
export async function activateDynamicWorkflowTools(
  this: AgentRuntimeInternal,
  input: { source: DynamicWorkflowActivationSource; traceContext?: TraceContext },
): Promise<boolean> {
  // 已激活即返回 false：激活是单向的，重复来源（命令/Resume/恢复扫描）不能再次重注册，
  // 否则每次都要清 cachedTools，工具面会多出一次不必要的收敛窗口。
  if (this.dynamicWorkflowToolsActivated) return false;
  // 先翻内存状态再重注册：两处注册入口的门读的就是这两个字段，顺序反过来会先按旧门注册一次。
  markDynamicWorkflowToolsActivated(this, input.source);
  // entry 写失败只记 warn、不向上抛。原因：过去抛出会让 `/workflow` / Resume 报错，而工具面已经
  // 激活（只加不减），此后的调用因已激活直接 no-op，形成「操作失败但状态已生效」。entry 只是冷恢复
  // 历史扫描的捷径——每个激活来源都会在记录里留下 `/workflow` 或 CreateWorkflow 调用，
  // restoreDynamicWorkflowActivationOnResume 缺 entry 时按历史判出激活并补写。
  try {
    await persistDynamicWorkflowActivation(this);
  } catch (error) {
    this.logger?.warn("Dynamic workflow activation entry write failed", {
      ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.activation_entry_write_failed",
      module: "core.runtime",
      sessionId: this.sessionId,
    });
  }
  // 日志放在状态+entry 之后：字段顺序本身就能区分「已激活但 entry 缺失」这种可恢复状态。
  this.logger?.info("Dynamic workflow tools activated", {
    ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
    event: "dynamic_workflow.tools_activated",
    module: "core.runtime",
    sessionId: this.sessionId,
    source: input.source,
  });
  return true;
}

/**
 * 冷恢复：按 entry 或历史判定本会话有没有过工作流（launch.md「What activates」第三行）。
 * 历史判据兜住两类会话：出生在 alwaysOn、后来 Host 翻成 onDemand 的；以及本规则之前落盘的。
 * 只在 runtime 尚未激活时有事可做；messages 是 session store 里的全部持久化消息（含 rewind 前的——
 * 「有没有过」不随分支变化）。
 */
export async function restoreDynamicWorkflowActivationOnResume(
  this: AgentRuntimeInternal,
  messages: readonly MessageWithParts[],
): Promise<void> {
  // 已激活就不再读 store：冷恢复可能逐轮调用，重复扫描全量消息会放大恢复成本。
  if (this.dynamicWorkflowToolsActivated) return;
  // 先查专用 entry（一次索引查询）；store 缺席时结果是 undefined，直接落到历史判据。
  const entries = await this.sessionStore?.sessionEntries?.({
    sessionID: this.sessionId,
    type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  });
  const source: DynamicWorkflowActivationSource | undefined =
    entries !== undefined && entries.length > 0
      ? "resume_entry"
      : persistedMessagesShowDynamicWorkflow(messages)
        ? "resume_history"
        : undefined;
  // 两处都没有证据才保持未激活：不能凭配置猜，否则 onDemand 会话会在首次请求前被提前扩面。
  if (source === undefined) return;
  // 命中 entry 或历史后同样先翻状态，后续重注册与 entry 补写都以该状态为准。
  markDynamicWorkflowToolsActivated(this, source);
  // entry 已在场时不重写；从历史判出来的补一条，下次恢复不必再扫。直接写而不经
  // persistDynamicWorkflowActivation：resume 里 sessionPersisted 要到收尾才置位，而恢复中的会话
  // 在 store 里必然已经存在。
  if (source === "resume_history") await writeDynamicWorkflowActivationEntryIfActivated(this);
}

/** 持久化的消息里有没有一次 `/workflow` 命令，或十个工具中任一次调用。 */
export function persistedMessagesShowDynamicWorkflow(
  messages: readonly MessageWithParts[],
): boolean {
  // 线性扫一遍持久化消息：命中即返回；这里判「有没有过」，不看 branchGeneration，
  // 因此 rewind 掉的分支同样算数（与 entry 的会话级语义一致）。
  for (const message of messages) {
    const role = message.info.role;
    for (const part of message.parts) {
      // 用户消息持久化的是 displayInput，命令原文可能带参数或大小写差异，
      // 所以用保留字表同款正则，而不是精确字符串比较。
      if (
        role === "user" &&
        part.type === "text" &&
        WORKFLOW_COMMAND_TEXT_PATTERN.test(part.text.trim())
      )
        return true;
      // 十个工作流工具中任一次调用都证明工具面已经暴露给模型，此后 compaction 也不能收回。
      if (role === "assistant" && part.type === "tool" && isDynamicWorkflowToolName(part.tool))
        return true;
    }
  }
  // 全量扫完无命中：本会话从未有过工作流，保持未激活。
  return false;
}

/**
 * 首次持久化时（events.ts 的 ensureSessionPersisted）补写 entry：`/workflow` 作为会话首轮到来时，
 * 激活先于会话落盘，那一刻 persistDynamicWorkflowActivation 无处可写。
 */
export async function writeDynamicWorkflowActivationEntryIfActivated(
  runtime: AgentRuntimeInternal,
): Promise<void> {
  // 只有 onDemand 会话需要 entry：alwaysOn 出生即激活，冷恢复时由初始配置重新算出 true。
  if (runtime.config.dynamicWorkflowToolsOnDemand !== true) return;
  // 两个条件缺一不可：未激活却写 entry 会在冷恢复时凭空激活；没有来源则 data.source 无法落库。
  if (
    !runtime.dynamicWorkflowToolsActivated ||
    runtime.dynamicWorkflowActivationSource === undefined
  )
    return;
  // saveSessionEntry 是外部 store 调用；entry 的 id 固定，重复补写是同 id 覆盖而非新增。
  await runtime.sessionStore?.saveSessionEntry?.(
    buildDynamicWorkflowActivationEntry(runtime.sessionId, runtime.dynamicWorkflowActivationSource),
  );
}

export function buildDynamicWorkflowActivationEntry(
  sessionId: SessionId,
  source: DynamicWorkflowActivationSource,
): SessionEntryInfo {
  // id 只由 sessionId 派生（每个会话一条），配合 store 的覆盖语义保证重复写入不产生多条 entry。
  const timestamp = Date.now();
  const data: DynamicWorkflowActivationEntryData = { activated: true, source };
  return {
    id: `${sessionId}:runtime-dynamic-workflow-activation`,
    sessionID: sessionId,
    type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
    // touchSession=false：激活是 runtime 元数据，不应刷新会话的「最近活动」时间。
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data,
  };
}

function markDynamicWorkflowToolsActivated(
  runtime: AgentRuntimeInternal,
  source: DynamicWorkflowActivationSource,
): void {
  // 两个状态字段一起写：只写 activated 会让冷恢复补 entry 时丢失来源，source 是 data 的必填字段。
  runtime.dynamicWorkflowToolsActivated = true;
  runtime.dynamicWorkflowActivationSource = source;
  // 与分支刷新同一个入口：它已经会按共用的门重注册全部内置工具（Agent / Task 描述随之换回带
  // CreateWorkflow 的那版）并清 cachedTools。
  refreshBranchAwareBuiltInTools(runtime);
}

async function persistDynamicWorkflowActivation(runtime: AgentRuntimeInternal): Promise<void> {
  // 会话尚未落库时把 entry 留给 ensureSessionPersisted 补写：此刻 store 里还没有 session，
  // 提前写入会造出孤立的 session entry。
  if (!runtime.sessionPersisted) return;
  // 写入口与首次落盘后的补写共用同一函数，幂等 id 保证两条路径并发时也只是覆盖。
  await writeDynamicWorkflowActivationEntryIfActivated(runtime);
}
