/**
 * ============================================================================
 * turn-loop.ts —— Agent 主循环(一个用户 turn 内的"模型请求 ↔ 工具执行"循环)
 * ============================================================================
 *
 * 【整体位置】
 *   turn.ts executeTurnCommand
 *     └─ runRegularTurnLoop(本文件)        ← 每轮迭代 = 一次 provider 往返
 *           ├─ 准备阶段:补输入 / compact / MCP / 工具 / 各类 reminder / ToolSearch 公告
 *           ├─ runModelBackedTurnStep      ← 发一次模型请求(+ 可能的工具执行)
 *           └─ 返回 "continue"/"output_continuation" 则进入下一轮;
 *              "break" 则退出循环,回到 turn.ts 做收尾。
 *
 * 【一轮迭代做什么】
 *   1. 检查取消,必要时刷新闲时任务接管状态;
 *   2. 消费上一轮工具批次之后到达的输入(steer / 运行时命令 / 项目记忆 recall);
 *   3. microcompact(纯本地裁剪)→ autoCompact(必要时调模型生成摘要);
 *   4. 初始化 MCP、刷新工具,追加 agent 列表 / 计划模式 / todo / 输出风格等 reminder;
 *   5. 重建 ToolSearch 公告,构造 provider 请求(cache control 在投影之后统一设置);
 *   6. 交给 runModelBackedTurnStep 执行这一次模型调用;
 *   7. 根据模型步返回值决定继续循环还是结束 turn。
 *
 * 【为什么循环不设"最大轮次"硬上限】
 *   遵循仓库的长程任务约定:资源与安全边界由 token/context limit(自动 compact)、
 *   用户取消、权限拒绝、工具超时、输出截断、provider retry 上限等明确条件承担,
 *   而不是用 tool call 次数或固定迭代数硬停止。
 *
 * 【状态归属】
 *   循环只操作 state(RegularTurnLoopState);持久化、事件发送、诊断都通过 this
 *   (AgentRuntimeInternal)提供的办法完成,循环本身不直接写 SessionStore。
 * ============================================================================
 */
import { getTurnTools } from "./turn-tool-visibility.js";
import { refreshOffPeakTurnAfterTakeover } from "../off-peak/turn.js";
import { appendRuntimeAgentListing } from "../helpers/agent-listing.js";
import { beginLocalTurnPreparation } from "@zcode/contracts";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import {
  CompactPhase,
  CompactReason,
  createMessageId,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import {
  buildRuntimeModeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildRuntimeProviderRequestMessages,
  prepareRuntimeProviderRequest,
  createCompactRapidRefillError,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import { persistRuntimeReminderMessage } from "./runtime-reminder-persistence.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import {
  evaluateRapidRefill,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { consumeSettledProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { consumePendingProjectMemoryUpdate } from "../helpers/project-memory-dream.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import {
  appendTurnRequestEntries,
  commitTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";

/**
 * Agent 主循环入口:持续执行"准备请求 → 调模型 →(可能执行工具)"直到 turn 结束。
 *
 * 调用方:turn.ts executeTurnCommand,在构造好 RegularTurnLoopState 后调用一次;
 * 本方法返回即代表这一轮用户输入的模型侧流程结束(成功或抛出错误),
 * 之后的 TurnComplete / 失败收尾由 turn.ts 负责。
 *
 * @param state 本轮 turn 的全部可变状态:模型、turn-local 历史(turnRequestState)、
 *              事件数组、取消信号、turn machine、compact/重复调用等各类计数。
 */
export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  while (true) {
    // 每轮迭代都先检查取消:用户 Stop 后,任何后续的 I/O/模型调用都不应再发生。
    throwIfTurnAborted(state.turnAbortSignal);
    // 闲时任务(off-peak)可能在本轮执行期间被用户接管(用户重新输入);
    // 这里按最新状态刷新 state.model 等执行事实,保证后续请求用正确的模型。
    refreshOffPeakTurnAfterTakeover(this, state);
    // 输出 token 续写模式:上一次模型因 max output 被截断,正在追加"继续"请求。
    // 续写期间不应再注入一次性 reminder(见下方各处 !outputTokenRecoveryActive 判断),
    // 否则同一提醒会被重复塞进多次请求。
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
    // guide 只允许由完整 tool result batch 设置这个一次性诊断；普通 queue 不在
    // model roundtrip 起点消费，避免把未来 turn 错并入当前 product turn。
    // drainedSteerForNextRequest 由 turn-guide-drain 在上一个合法边界写入,
    // 这里只是"取出并清空",随后透传给 model step 用于日志归因。
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    // 首轮请求前不消费队列:本轮输入本身才刚进入历史;
    // 从第二次迭代(工具轮之后)开始,才把期间到达的 steer/queue/后台结果并入请求。
    if (state.modelStepCount > 0 && !outputTokenRecoveryActive) {
      // 同一个 drain 入口统一处理 steer 输入、排队消息、后台子代理/工作流结果。
      // 返回的 runtimeEntries 是"可直接进入本轮历史"的条目(含用户可见/模型可见语义);
      // 失败处理:消费失败会抛出——队列语义被破坏时不能继续,必须让 turn 收口。
      // 两个 consumed 标记保证后台结果只被本 turn 消费一次,恢复链路据此判断是否已读。
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      // 新输入可能改变模型行为:把"重复工具调用"的检测计数归零,避免误判循环调用。
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
      }
    }

    // 完整工具批次结束后,补上此前异步检索完成的项目记忆 recall 结果。
    // 只在真实工具批次之后消费:纯文本轮次没有"检索等待窗口",不应注入回忆内容。
    if (state.completedRealToolResultBatch && !outputTokenRecoveryActive) {
      state.completedRealToolResultBatch = false;
      const recallEntry = consumeSettledProjectMemoryRecall(
        this,
        ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
      );
      appendTurnRequestEntries(state.turnRequestState, recallEntry ? [recallEntry] : []);
    }

    // 压缩阶段:本轮第一个请求之前算 PreRequest,工具轮之间的再压缩算 MidTurn;
    // 该值会进入时间线/日志,用于区分"请求前压缩"和"执行中途压缩"。
    const compactPhase =
      state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
    // 第一层:microcompact 纯本地清理(旧工具结果等),不调用模型、成本为零。
    await this.microcompactIfNeeded(state.turnTraceContext, state.events, state.turnAbortSignal, {
      model: state.model,
      modelStepIndex: state.modelStepCount,
      phase: compactPhase,
      turnRequestState: state.turnRequestState,
    });
    throwIfTurnAborted(state.turnAbortSignal);

    // auto compact 的熔断判定:连续 RAPID_REFILL 次数达到上限就阻止继续压缩。
    // evaluateRapidRefill 依据"距离上次压缩经过了多少个工具轮"(toolTurnsSinceCompact)计算,
    // 压缩后马上又满 → consecutiveRapidRefills 递增;经历了足够工具轮则归零。
    const rapidRefill = evaluateRapidRefill(state.compactTracking);
    // autoCompactIfNeeded 失败/跳过时返回非 "compacted" 字符串;只有 "compacted" 才算成功。
    // 失败处理:compact 失败不抛错(由 autoCompactIfNeeded 内部降级),继续用未压缩的历史请求。
    const autoCompactOutcome = await this.autoCompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        getAgentListingTools: () => getTurnTools(this, state),
        compactReason: CompactReason.ContextLimit,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        rapidRefill,
        model: state.model,
        turnRequestState: state.turnRequestState,
        getContinuationTools: () => getTurnTools(this, state),
      },
    );
    // 熔断:连续多次压缩后很快又满,继续压缩也无法支撑正常推进 → 直接让本轮失败。
    // 维护不变量:不能陷入"压缩↔超窗"死循环,必须用 rapid-refill breaker 兜底终止。
    if (autoCompactOutcome === "rapid_refill_blocked") {
      throw createCompactRapidRefillError({
        consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
        toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
        toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      });
    }
    // 压缩成功:重置"快速回填"计数,并把这个 summary 计入历史轮次(统计口径)。
    if (autoCompactOutcome === "compacted") {
      recordCompactSuccess(state, rapidRefill);
      recordCompactHistoryRound(state);
    }
    throwIfTurnAborted(state.turnAbortSignal);

    // MCP 初始化:建立客户端连接并拉取工具清单;必须在"确定工具集"之前完成。
    // refreshMcpToolsIfChanged 只在收到 tools/list_changed 时更新 registry,
    // 冻结"本轮工具集"直到下一次迭代,避免执行中途工具 schema 漂移。
    const finishMcp = beginLocalTurnPreparation(state.turnTraceContext, "mcp");
    await this.initializeMcp(state.turnTraceContext);
    // tools/list_changed 只在回合开始前生效。
    await this.refreshMcpToolsIfChanged(state.turnTraceContext);
    finishMcp();
    throwIfTurnAborted(state.turnAbortSignal);
    // getTurnTools 会做 turn-scoped 过滤(automation/off-peak denylist、ToolSearch 可见性),
    // 拿到的是"本轮真正可以暴露给模型"的工具集,后续 reminder/公告/请求都用它。
    const finishTools = beginLocalTurnPreparation(state.turnTraceContext, "tools");
    const tools = getTurnTools(this, state);
    finishTools();
    // 可用子代理列表作为 attachment 注入;appendRuntimeAgentListing 会计算
    // "相对历史新增的子代理",避免每轮重复注入整张列表。
    if (!outputTokenRecoveryActive) {
      await appendRuntimeAgentListing(this, state.turnRequestState, tools, state.turnTraceContext);
    }
    // 计划模式退出提醒:一次性提醒,消费后立即清标记,保证只出现一次。
    if (!outputTokenRecoveryActive && this.needsPlanModeExitReminder) {
      this.needsPlanModeExitReminder = false;
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody()),
      ]);
    }
    // 运行时模式提醒(当前 mode / plan 开关):buildRuntimeModeReminderBody 会先从
    // 已有历史里找"上一次已注入的模式",只有模式确实变化时才返回正文。
    const runtimeModeReminderBody = outputTokenRecoveryActive
      ? null
      : buildRuntimeModeReminderBody(
          state.turnRequestState.entries,
          this.getMode(),
          this.getPlanEnabled(),
        );
    if (runtimeModeReminderBody) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody),
      ]);
    }
    // todo 提醒:只有本轮工具集中存在 TodoWrite、且历史里确有未完成/过期的 todo 时才注入;
    // 同时把提醒持久化为 synthetic user notice,确保冷恢复后 UI 仍能看到这条系统提示。
    if (
      !outputTokenRecoveryActive &&
      tools.some((tool) => tool.name === "TodoWrite") &&
      shouldBuildTodoReminder(state.turnRequestState.entries)
    ) {
      const currentTodos = await this.readSessionTodosForContext(state.turnTraceContext);
      const reminderBody = buildTodoReminderBody(currentTodos);
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("todo_reminder", reminderBody),
      ]);
      // 除注入历史外,还落一条 model-only 的 synthetic user notice:
      // 冷恢复时 UI 仍能看到"系统提醒过 todo",且不会渲染成用户气泡。
      await this.persistSyntheticUserNoticeForSession({
        messageID: createMessageId(),
        metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
        sessionId: this.sessionId,
        source: "todo_reminder",
        text: reminderBody,
        traceContext: state.turnTraceContext,
      });
    }
    // 输出风格提醒只在首个模型请求注入:它描述的是本轮 turn 的输出风格,
    // 后续工具轮已经看过,重复注入只会占用上下文。
    const outputStyleReminderBody =
      state.modelStepCount === 0
        ? buildRuntimeOutputStyleReminderBody(state.turnOutputStyle)
        : null;
    if (outputStyleReminderBody) {
      // output_style 是 provider-visible 的当前 turn runtime attachment，
      // 需要进入内存历史参与后续 request 的增量轨迹；但不把它落 session。
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("output_style", outputStyleReminderBody),
      ]);
    }
    // ToolSearch 公告:告诉模型"哪些延迟工具可以按需搜索加载"。
    // 必须在请求前重建,因为工具集/ToolSearch 模式可能随 MCP 刷新而变化;
    // 公告要"先落盘再进内存历史",否则 fork/resume 会把已公告的工具重新当成首次出现。
    if (!outputTokenRecoveryActive) {
      const announcement = buildToolSearchAnnouncement({
        model: state.model,
        mode: this.config.toolSearch?.mode,
        tools,
        registry: this.getToolRegistry(),
        entries: state.turnRequestState.entries,
      });
      if (announcement) {
        // 公告正文和增量事实必须先一起落盘；否则 fork/resume 会把已公告工具重新当成首次出现。
        // 失败处理:persistRuntimeReminderMessage 失败会抛出——公告是 durable 事实,落库失败不能继续。
        const messageId = await persistRuntimeReminderMessage.call(
          this,
          announcement,
          state.turnTraceContext,
          {
            model: state.model,
            anchor: buildProjectionAnchor(state.turnTraceContext, "synthetic"),
          },
        );
        // latestConversationMessageId 是投影锚点:公告落盘后立即更新,保证后续消息挂靠正确。
        // 维护不变量#7:latest 指针在落库后更新,冷恢复时不会把后续消息挂到已删除的消息上。
        if (messageId) this.latestConversationMessageId = messageId;
        commitTurnRequestEntries(this, state.turnRequestState, [announcement]);
      }
    }
    // （2026-09-12）：原"回合开始注入 plugin_ui_state reminder"已删除，插件给模型的信息
    // 一律走 ui/update-model-context。
    // 构造本次请求的条目集合:先拷贝 turn-local 历史(避免后续 provider 投影改到源数组),
    // 再单独追加可能刚完成的项目记忆更新。
    const providerEntries = [...state.turnRequestState.entries];
    // Dream 可能在同一 turn 的首个模型请求期间完成；每次 attachment collection 都检查，
    // 才能把一次性更新放进紧随其后的模型请求，而不是延迟到下一次用户输入。
    const memoryUpdate = outputTokenRecoveryActive
      ? undefined
      : consumePendingProjectMemoryUpdate(this);
    const requestEntries = memoryUpdate ? [...providerEntries, memoryUpdate] : providerEntries;
    // 统一 provider 请求准备:按模型能力投影消息、决定工具暴露(ToolSearch/常驻/禁用)、
    // 设置 cache control。所有请求(含 compact)都走这条管线,保证行为一致。
    const prepared = prepareRuntimeProviderRequest(this, {
      model: state.model,
      tools,
      registry: this.getToolRegistry(),
      entries: requestEntries,
      applyCacheControl: true,
    });
    this.logger?.debug("ToolSearch request exposure", {
      event: "tool.search.exposure",
      enabled: prepared.toolSearch.enabled,
      mode: prepared.toolSearch.mode,
      reason: prepared.reason,
      catalogSize: prepared.toolSearch.catalog.length,
      schemaCount: prepared.request.tools.length,
    });
    // 修复原因：provider-visible user ordering projection 会改变最终 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    // providerProjection.sourceEntries 记录"每条投影消息来自哪个原始 entry",
    // 供 token 估算与 usage 归属反查。
    const providerProjection = prepared.projection;
    const { messages } = prepared.request;
    // "可记录"条目:剔除 query-local 的输出续写(Continue)提示。
    // 它们只属于某一次请求,不能进入持久化轨迹,否则恢复/forks 会看到伪历史。
    // 若确实被剔除,需要基于过滤后的条目重新渲染一份消息数组,与真实请求结构对应。
    const recordableEntries = filterOutputTokenContinuationEntries(prepared.entries);
    const recordableProjection =
      recordableEntries === prepared.entries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            loadedToolCallIds: prepared.loadedToolCallIds,
            applyCacheControl: true,
            model: state.model,
          });
    // 推进 turn 状态机:进入"模型请求中"阶段,并记录本次请求使用的模型与可记录消息。
    // TurnMachine 是纯状态对象,不做 I/O;失败由状态机自身校验抛出(phase 迁移非法)。
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(
        `${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages,
      ),
    );

    // 生产包需要知道 Turn 是否已经跨过 provider 边界；这里只记录请求元数据，
    // 不记录 prompt、消息内容或 streaming chunk，避免泄露内容并控制日志量。
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    });

    // 执行"单次模型步":发请求、流式接收、必要时执行工具。
    // 传参区分三套消息:provider 实际请求(messages)/ 事件记录用(recordedMessages)/
    // 本轮源头条目(sourceEntries,用于 usage 归属与 token 估算)。
    // 失败处理:runModelBackedTurnStep 内部处理恢复(selection fallback/stream recovery/
    // off-peak/reactive compact),无法恢复时抛出,由主循环的 catch(turn.ts)收口。
    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
      messages,
      sourceEntries: providerProjection.sourceEntries,
      requestEntries,
      recordedMessages: recordableProjection.messages,
      tools: prepared.request.tools,
      toolSearch: prepared.toolSearch,
    });

    // "break" = 模型没有可执行工具,且 guide / Stop hook 都不再续跑 → 结束整个 turn;
    // 其余情况(工具已执行 / 流恢复 / 输出续写 / reactive compact 等)继续下一轮迭代。
    if (result === "break") {
      break;
    }
  }
}
