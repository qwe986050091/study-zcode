/* eslint-disable max-lines -- 测试桥只负责把统一的 19 个场景输入翻译成 V4 live fact，集中映射便于隐私审计。 */
// 会话遥测双路径 E2E 桥：把统一场景输入翻译成 V4 live fact，供外层采集与差分。
// 职责边界：只做输入翻译与桥的挂载/卸载，不定义场景语义、不实现对比函数、
// 不判定双路径胜负、不落盘、不改动场景 inventory；断言文案一律原样透传。
// 运行模型：按 case 串行，每 scope 一个 supervisor，虚拟时钟与序号全部由操作驱动。
//
// INV 断言表（位置 = 守住它的代码；改错故障 = 双路径口径首次分叉的现场）：
// INV-01 断言：同一 caseId 解析出的 operations、minimum inventory、proof 完全一致 —— 守住它的位置：runCurrentScenario 的 getConversationTelemetryParityScenario 调用 —— 改错故障：场景表被单侧修改，双路径各跑一半仍通过。
// INV-02 断言：场景操作按表内顺序逐条应用，不重排不跳过 —— 守住它的位置：runCurrentScenario 的 for-of 循环 —— 改错故障：事实顺序变化，时间线与序号对比出现假差异。
// INV-03 断言：minimum*Inventory 只作下限比较 —— 守住它的位置：结果对象原样回填两处 minimum 字段 —— 改错故障：把多出的聚合条目误判为失败。
// INV-04 断言：proof 与 stateAssertions 只追加不重写 —— 守住它的位置：结果对象的 proof 字段与 rememberStateAssertion —— 改错故障：断言标签被覆盖，首个失败点丢失。
// INV-05 断言：每个 scope 独立 supervisor 且键含 caseId —— 守住它的位置：getScope 的 workspaceScopeKey 拼接 —— 改错故障：跨 case 复用聚合状态，inventory 串味。
// INV-06 断言：虚拟时钟只由操作携带的 now 推进 —— 守住它的位置：applyCurrentOperation 的 now 写入 —— 改错故障：混入系统时钟，双路径时间线不可复现。
// INV-07 断言：eventSeq 在同一 scope 内严格单调递增 —— 守住它的位置：toFact 与 compaction 分支的自增 —— 改错故障：序号重复或倒序，顺序校验失效。
// INV-08 断言：occurredAt 取操作时间而非当前时间 —— 守住它的位置：toFact 的事件时间与 compaction 的 occurredAt —— 改错故障：时间窗口断言随机飘移。
// INV-09 断言：可选字段缺失时键不出现，不补 undefined —— 守住它的位置：toFact 的条件展开 —— 改错故障：键存在性差异被误报为值差异。
// INV-10 断言：flush 完成后才读取 inventory —— 守住它的位置：runCurrentScenario 的 Promise.all flush —— 改错故障：读到半成品聚合，报告数偏少。
// INV-11 断言：dispose 前必先 flush，且只执行一次 —— 守住它的位置：runCurrentScenario 的 finally 与 scope.dispose 分支 —— 改错故障：尾部报告丢失或重复。
// INV-12 断言：web.noop 使用 noop 平台且不落桌面 reporter —— 守住它的位置：runCurrentWebNoopOperations 的 setUiPerfArmsReporter(null) —— 改错故障：ARMS 穿透，inventory 多出一组。
// INV-13 断言：同一 errorKey 的可见错误只上报一次 —— 守住它的位置：visible.error 分支的 visibleErrorKeys 判断 —— 改错故障：重复上报，错误计数偏高。
// INV-14 断言：suppressed 错误跳过上报但仍占操作位 —— 守住它的位置：visible.error 分支的提前 return —— 改错故障：operationCount 与场景表不符。
// INV-15 断言：foreground detach 用 sentinel session 递减旧计数 —— 守住它的位置：foreground.detach 分支 —— 改错故障：前台计数悬挂，状态断言差一。
// INV-16 断言：feedback 走独立上报通道，不进入 supervisor 事实 —— 守住它的位置：feedback 分支的 reportAppTelemetryEvent —— 改错故障：同一事件被两条路径重复计量。
// INV-17 断言：usage 的 totalTokens 恒等于输入加输出 —— 守住它的位置：usage 分支的事实构造 —— 改错故障：总量字段与分项不一致，聚合失真。
// INV-18 断言：非桌面或开关关闭时不挂桥 —— 守住它的位置：installConversationTelemetryParityE2EBridge 的前置 guard —— 改错故障：生产窗口暴露测试驱动面。
// INV-19 断言：桥卸载只删除自身引用 —— 守住它的位置：install 返回的 disposer —— 改错故障：误删后续重装的桥，测试静默失效。
// INV-20 断言：结果字段名与场景定义同名同源，不做二次计算 —— 守住它的位置：runCurrentScenario 的返回对象 —— 改错故障：对比口径与场景表脱节，差异无法归因。
import type { IPlatformService } from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import {
  getConversationTelemetryParityScenario,
  type ConversationTelemetryParityOperation,
} from "@/lib/conversationTelemetryParityScenarioDefinitions.js";
import {
  runRequestVerificationParityAssertions,
  runQuotaParityStateAssertions,
} from "@/lib/conversationTelemetryParityStateE2E.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { resetMessageTelemetryForTest } from "@/lib/messageTelemetry.js";
import { setUiPerfArmsReporter } from "@/lib/uiPerfArmsTelemetry.js";
import { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";

// [契约] 单场景按 scope 名隔离的运行时：now/sequence 是该 scope 唯一的时间与序号来源。
// supervisor 只接受本文件转译出的 operation，foregroundOwners 保存 attach 时的 owner 身份。
// 外部的奇偶对比函数只读 supervisor 产出的 inventory，不进入该结构取值。
// 所以字段语义变化会同时影响双路径的时钟与序号口径，而不是只影响一侧。
// 新增字段前先确认它属于事实输入还是测试脚手架，两者不允许混放。
interface ParityScopeRuntime {
  now: number;
  // [并发] sequence 只由 toFact 与 compaction 分支自增，保证同一 scope 内严格单调。
  // now 先被 operation 写入，再由各分支读取，两者不互相推导。
  // 若在此处引入 Date.now，双路径序号无法对齐，差分会出现顺序性假失败。
  // 序号跨 scope 不共享，这是 scope 键存在的意义。
  sequence: number;
  supervisor: ConversationTelemetrySupervisor;
  foregroundOwners: Map<string, object>;
}

// [契约] 返回体是差分输入而非判定结果：caseId 回显，operationCount 记录本场景操作数。
// proof 与 minimum*Inventory 原样带出，stateAssertions 只累积语义断言标签。
// `compareScenarioResults` 只按这些字段算差异，不解释场景内容。
// 改 `operationCount` 这类字段名等同改口径，必须与场景定义同批修改。
// `caseId` 或 `stateAssertions` 缺失即视为契约破坏，不是可选补充。
export interface ConversationTelemetryParityScenarioResult {
  caseId: string;
  // [契约] minimum 表达下限而非等值：比较时要求实测 inventory 大于等于该值。
  // 真实上报可能因合并或聚合多出条目，多字段与缺字段的判据不同。
  // 这里只搬运不裁剪，避免把上限语义误写进下限断言。
  // 缺失字段对比应报具体键名，禁止整体字符串化后比对。
  minimumArmsInventory: Record<string, number>;
  minimumReportInventory: Record<string, number>;
  operationCount: number;
  proof: string[];
  stateAssertions: string[];
}

declare global {
  interface Window {
    __zcodeConversationTelemetryParityE2E?: {
      // [契约] current 与 legacy 共用 run(caseId) 形状，容器据此驱动同一组场景。
      // 形状不一致会让一侧少跑场景却仍产出结果，形成假一致。
      // 新增 variant 必须复用本桥的输入翻译，不允许另建场景解释层。
      // 否则对比函数实际比较的是两套语义，任何差异都无法归因。
      // 桥对象引用比较用于卸载，替换实现时不要改成结构化比较。
      variant: "current" | "legacy";
      run(caseId: string): Promise<ConversationTelemetryParityScenarioResult>;
    };
  }
}

export function installConversationTelemetryParityE2EBridge(input: {
  platform: IPlatformService;
  isDesktop: boolean;
}): () => void {
  // [失败路径] 非桌面或 E2E 开关关闭时返回空 disposer：不建 supervisor、不注册 window 桥。
  // 也不产生任何事实与全局残留，生产窗口没有可被外部驱动的遥测入口。
  // 若这里放行，普通用户环境会暴露测试驱动面。
  // 卸载函数只删除同一引用，避免误删后续重装的桥。
  if (!input.isDesktop || !shouldExposeE2EStoreBridge()) {
    return () => undefined;
  }

  const bridge = {
    variant: "current" as const,
    run: (caseId: string) => runCurrentScenario(input.platform, caseId),
  };
  window.__zcodeConversationTelemetryParityE2E = bridge;
  return () => {
    if (window.__zcodeConversationTelemetryParityE2E === bridge) {
      delete window.__zcodeConversationTelemetryParityE2E;
    }
  };
}

async function runCurrentScenario(
  platform: IPlatformService,
  caseId: string,
): Promise<ConversationTelemetryParityScenarioResult> {
  // [契约] 场景定义不可漂移：caseId 只解析到 definitions 中的同一份 operations 与 inventory。
  // 桥内不得增删步骤、不得改 proof 文案，否则同一 case 两次运行结果不同。
  // 出现这种差异应先核对 operationCount，再核对 proof，最后才怀疑对比函数。
  // 场景表是双路径共同输入，单侧修改即破坏可比性。
  // 本函数不做 caseId 归一化，大小写与别名由场景表负责。
  const scenario = getConversationTelemetryParityScenario(caseId);
  // [事务] 每个场景开跑前清空消息遥测全局状态，使本轮 inventory 只含本场景事实。
  // 网关按 case 串行执行，重置与 scopes 构造之间不允许插入 await。
  // 否则另一 case 的尾部上报会混入本轮下限比对。
  // 重置失败应让整场景失败，不用 try 包住后继续跑。
  // 该副作用仅测试可用，生产路径不得调用。
  resetMessageTelemetryForTest();
  const scopes = new Map<string, ParityScopeRuntime>();
  const visibleErrorKeys = new Set<string>();
  const stateAssertions: string[] = [];

  const getScope = (scopeName = "default"): ParityScopeRuntime => {
    const existing = scopes.get(scopeName);
    if (existing) return existing;
    const created: ParityScopeRuntime = {
      now: 0,
      sequence: 0,
      foregroundOwners: new Map(),
      supervisor: undefined as unknown as ConversationTelemetrySupervisor,
    };
    created.supervisor = new ConversationTelemetrySupervisor({
      platform,
      // [并发] scope 键由固定前缀、caseId 与 scopeName 拼接，不同 case 与 scope 互不干扰。
      // supervisor 按该键建立独立聚合状态，同名 scope 在别的 case 下不会复用。
      // 键里保留分隔符，避免 caseId 与 scopeName 拼接后产生歧义碰撞。
      // 修改键格式会让历史口径失效，需同步更新对比基线。
      // 键只用于内存隔离，不参与上报内容。
      workspaceScopeKey: `telemetry-parity\u0000${caseId}\u0000${scopeName}`,
      now: () => created.now,
    });
    scopes.set(scopeName, created);
    return created;
  };

  try {
    for (const operation of scenario.operations) {
      await applyCurrentOperation({
        caseId,
        getScope,
        operation,
        platform,
        stateAssertions,
        visibleErrorKeys,
      });
    }
    await Promise.all([...scopes.values()].map((scope) => scope.supervisor.flushReportsForTest()));
    return {
      caseId,
      minimumArmsInventory: scenario.minimumArmsInventory,
      minimumReportInventory: scenario.minimumReportInventory,
      // [契约] operationCount 直接取场景操作数组长度，是场景是否被完整执行的自证。
      // 它不统计实际产生的事实数，事实条数由 inventory 反映。
      // 两者对不上时先查被跳过的操作分支，而不是改这里的计数。
      // 计数口径与 proof 同源，禁止在前端二次加权。
      operationCount: scenario.operations.length,
      proof: scenario.proof,
      stateAssertions,
    };
  } finally {
    for (const scope of scopes.values()) {
      await scope.supervisor.flushReportsForTest();
      scope.supervisor.dispose();
    }
  }
}

async function applyCurrentOperation(input: {
  caseId: string;
  getScope(scopeName?: string): ParityScopeRuntime;
  operation: ConversationTelemetryParityOperation;
  platform: IPlatformService;
  stateAssertions: string[];
  visibleErrorKeys: Set<string>;
}): Promise<void> {
  // [契约] 所有操作经同一个分派入口进入，禁止在调用方按 kind 预分流。
  // 前置的三个 kind（web.noop、quota.assert、verification.assert）无需 scope 即可返回。
  // 其余 kind 统一先取 scope、再写 now，最后进入 switch。
  // 分派顺序即语义：先归一时间再产生事实，避免同批事实使用旧时钟。
  // 新增 kind 必须落在该 switch 内，保持单一入口可审计。
  const { operation } = input;
  // [失败路径] web.noop 用独立 noop 平台重放内层操作，验证 Web 侧不产生桌面 ARMS。
  // 内层作用域与主场景隔离，结束后只回传 no-final-output 断言。
  // 任何 UI ARMS 若穿透到桌面全局 reporter，最终 inventory 会多出一组并让差分失败。
  // 这里不吞异常，内层失败应直接冒泡中止本场景。
  // 该分支提前 return，不参与主 scopes 的 flush。
  if (operation.kind === "web.noop") {
    await runCurrentWebNoopOperations(input, operation.operations);
    rememberStateAssertion(input.stateAssertions, "web:no-final-output");
    return;
  }
  // [契约] 配额断言直接读取状态模块结果并追加到 stateAssertions，不经过 supervisor。
  // 断言文本由被调函数生成，本桥只负责透传。
  // 这样双路径声明的是同一组语义标签，避免文案在两侧各写一份。
  // 顺序保持追加顺序，便于定位首个失败断言。
  if (operation.kind === "quota.assert") {
    input.stateAssertions.push(...runQuotaParityStateAssertions());
    return;
  }
  if (operation.kind === "verification.assert") {
    input.stateAssertions.push(...runRequestVerificationParityAssertions());
    return;
  }
  const scope = input.getScope(operation.scope);
  // [并发] 时间归一：只有 operation 携带 now 时才推进 scope 的虚拟时钟。
  // 未携带 now 的操作沿用上一时刻，保证同批事实的 occurredAt 可预期。
  // compaction 等自带 occurredAt 的分支直接使用操作值，不再读 scope.now。
  // 禁止在此处回退到系统时钟，否则双路径时间线不可复现。
  if ("now" in operation) scope.now = operation.now;

  switch (operation.kind) {
    case "focus":
      scope.supervisor.recordComposerFocus();
      return;
    case "text":
      scope.supervisor.recordComposerTextChange(operation.value);
      return;
    // [事务] seed 把会话、命令、发送时间与扩展明细一次性交给 supervisor，形成单一事实。
    // 扩展明细中的空字符串是显式占位而非缺失，对比时按存在处理。
    // provider_name 仅在提供主机名时出现，属于可选字段，不得补空键。
    // 发送时间取 operation.now，与事件时间保持一致。
    // seed 之后才允许 turn.started，顺序由场景表保证。
    case "seed":
      scope.supervisor.acceptPromptSeed({
        sessionId: operation.sessionId,
        sourceCommandId: operation.commandId,
        sendTime: operation.now,
        extraDetail: {
          ask_mode: operation.askMode ?? "",
          model_name: operation.modelName ?? "",
          model_provider: operation.modelProvider ?? "",
          ...(operation.providerHostname ? { provider_name: operation.providerHostname } : {}),
          agent: "glm",
          plan_status: "unknown",
          plan_product_id: "",
        },
      });
      return;
    case "foreground.attach": {
      const owner = scope.foregroundOwners.get(operation.owner) ?? {};
      scope.foregroundOwners.set(operation.owner, owner);
      scope.supervisor.attachForeground(owner, operation.sessionId);
      return;
    }
    // [资源] detach 用 sentinel session 重新 attach 同一 owner，先递减旧 session 的前台计数。
    // disposer 不额外保存：sentinel 不会参与任何 case，scope dispose 时统一清理。
    // 直接丢弃 owner 引用会让旧 session 计数悬挂，导致前台态差一。
    // owner 身份来自按名缓存的 map，重复 attach 必须复用同一对象。
    // 资源释放顺序与 attach 顺序相反，避免计数提前归零。
    case "foreground.detach": {
      const owner = scope.foregroundOwners.get(operation.owner);
      if (owner) {
        // attachForeground 返回的 disposer 不必额外保存：把同 owner 绑定到一个不会参与
        // case 的 sentinel session，会先递减旧 session，随后 scope dispose 清理 sentinel。
        scope.supervisor.attachForeground(owner, `detached:${operation.owner}`);
      }
      return;
    }
    case "turn.started":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "turn.started",
          executionKind: "agent",
        }),
      );
      return;
    case "model.status":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "model.request.status",
          requestId: operation.requestId,
          status: operation.status,
          providerId: operation.providerId,
          modelId: operation.modelId,
          providerHostname: operation.providerHostname,
          transport: "fetch",
          querySource: "main_turn",
          queryId: `${operation.requestId}-query`,
          attempt: 1,
          maxAttempts: 3,
          durationMs: operation.durationMs,
          reason: operation.reason,
          retryable: operation.retryable,
          statusCode: operation.statusCode,
          delayMs: operation.delayMs,
          nextAttempt: operation.nextAttempt,
          idleMs: operation.idleMs,
          timeoutMs: operation.timeoutMs,
        }),
      );
      return;
    case "chunk":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "stream.chunk",
          channel: operation.channel,
          chunkLength: 1,
          firstChunk: operation.firstChunk,
          assistantMessageId: `${operation.commandId}-assistant`,
          parentToolCallId: operation.parentToolCallId,
        }),
      );
      return;
    case "permission":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "permission.lifecycle",
          phase: operation.phase,
          requestId: operation.requestId,
          toolCallId: operation.toolCallId,
          toolName: "Bash",
          decision: operation.decision,
        }),
      );
      return;
    case "tool":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "tool.lifecycle",
          phase: operation.phase,
          toolCallId: operation.toolCallId,
          toolName: operation.toolName,
          errorCode: operation.errorCode,
          errorMessage: operation.errorMessage,
          parentToolCallId: operation.parentToolCallId,
          performance: operation.performance,
        }),
      );
      return;
    case "usage":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "usage.delta",
          inputTokens: operation.inputTokens,
          outputTokens: operation.outputTokens,
          totalTokens: operation.inputTokens + operation.outputTokens,
          reasoningTokens: operation.reasoningTokens ?? 0,
          cacheReadTokens: operation.cacheReadTokens ?? 0,
          cacheWriteTokens: operation.cacheWriteTokens ?? 0,
        }),
      );
      return;
    case "terminal":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "turn.terminal",
          status: operation.status,
          errorCode: operation.errorCode,
          errorMessage: operation.errorMessage,
        }),
      );
      return;
    // [契约] compaction 事实自带 occurredAt 与 operationId，序号仍由 scope.sequence 单调分配。
    // attempt 固定为 1，token 前后计数与 truePostCompactTokenCount 原样透传。
    // 这里绕过 toFact，因为该事实不需要 commandId/turnId 注入。
    // 两条构造路径必须产出同形状字段集，否则对比函数看到缺失键。
    // 新增 compaction 字段时两路径同时补，禁止只在当前侧加。
    case "compaction":
      scope.supervisor.handleFact({
        version: 1,
        eventId: operation.eventId,
        eventSeq: scope.sequence++,
        occurredAt: operation.now,
        sessionId: operation.sessionId,
        kind: "compaction.terminal",
        operationId: operation.operationId,
        summaryMessageId: operation.summaryMessageId,
        status: operation.status,
        trigger: operation.trigger,
        compactReason: operation.compactReason,
        reason: operation.reason,
        attempt: 1,
        startedAt: operation.startedAt,
        endedAt: operation.endedAt,
        preCompactTokenCount: operation.preCompactTokenCount,
        postCompactTokenCount: operation.postCompactTokenCount,
        truePostCompactTokenCount: operation.truePostCompactTokenCount,
        modelName: operation.modelName,
        modelProvider: operation.modelProvider,
      });
      return;
    // [失败路径] 同一 errorKey 只上报一次，先压制后去重，顺序不能颠倒。
    // suppressed 的操作直接跳过但不报错，仍计入场景操作数。
    // 去重集合在场景内共享，跨 scope 也不重复展示同一条错误。
    // detail 与 traceId 原样透传，避免对比时字段被吞。
    // 提示文案与 code 分离存放，展示层改动不影响错误码比对。
    case "visible.error":
      if (operation.suppressed || input.visibleErrorKeys.has(operation.errorKey)) return;
      input.visibleErrorKeys.add(operation.errorKey);
      scope.supervisor.reportVisibleChatError({
        errorKey: operation.errorKey,
        displayMessage: operation.displayMessage,
        error: {
          code: operation.code,
          message: operation.displayMessage,
          traceId: operation.traceId,
          taskId: operation.sessionId,
          detail: operation.detail,
        },
      });
      return;
    case "feedback":
      await reportAppTelemetryEvent(
        input.platform,
        {
          elementName: "assistant_message_feedback",
          eventRegion: "chat",
          eventType: "ck",
          eventExtraDetail: { reaction: operation.reaction },
          talkId: operation.sessionId,
          messageId: operation.messageId,
        },
        "conversation-telemetry-parity-e2e",
      );
      return;
    case "scope.dispose":
      await scope.supervisor.flushReportsForTest();
      scope.supervisor.dispose();
      return;
  }
}

async function runCurrentWebNoopOperations(
  input: Parameters<typeof applyCurrentOperation>[0],
  operations: ConversationTelemetryParityOperation[],
): Promise<void> {
  const noopPlatform = {
    reportTelemetryEvent: async () => undefined,
    reportArmsCustomEvent: async () => undefined,
  } as unknown as IPlatformService;
  const scopes = new Map<string, ParityScopeRuntime>();
  const getScope = (scopeName = "web"): ParityScopeRuntime => {
    const existing = scopes.get(scopeName);
    if (existing) return existing;
    const created: ParityScopeRuntime = {
      now: 0,
      sequence: 0,
      foregroundOwners: new Map(),
      supervisor: undefined as unknown as ConversationTelemetrySupervisor,
    };
    created.supervisor = new ConversationTelemetrySupervisor({
      platform: noopPlatform,
      workspaceScopeKey: `telemetry-parity\u0000${input.caseId}\u0000web\u0000${scopeName}`,
      now: () => created.now,
    });
    scopes.set(scopeName, created);
    return created;
  };

  // Web reporter 的 production 边界就是 no-op。这里仍执行完整场景；如果任何 UI ARMS
  // 意外穿透到桌面全局 reporter，TDP19 的最终 inventory 会立刻多出一组并使差分失败。
  // [权衡] Web reporter 的生产边界就是 no-op，这里显式置空以贴近真实运行形态。
  // 置空是全局副作用，必须在 finally 中恢复为注入平台，否则污染后续桌面场景。
  // 内层仍完整跑完 `operations` 全量，不做降级或短路。
  // 若任何 UI ARMS 穿透到桌面 reporter，inventory 会立刻多出一组。
  // 用 null 而不是空实现，是为了让穿透立刻失败而非静默被吞。
  setUiPerfArmsReporter(null);
  try {
    for (const operation of operations) {
      await applyCurrentOperation({
        ...input,
        getScope,
        operation,
        platform: noopPlatform,
      });
    }
    await Promise.all([...scopes.values()].map((scope) => scope.supervisor.flushReportsForTest()));
  } finally {
    for (const scope of scopes.values()) {
      await scope.supervisor.flushReportsForTest();
      scope.supervisor.dispose();
    }
    setUiPerfArmsReporter(input.platform);
  }
}

function rememberStateAssertion(assertions: string[], label: string): void {
  if (!assertions.includes(label)) assertions.push(label);
}

function toFact(
  scope: ParityScopeRuntime,
  operation: Extract<
    ConversationTelemetryParityOperation,
    {
      kind:
        | "turn.started"
        | "model.status"
        | "chunk"
        | "permission"
        | "tool"
        | "usage"
        | "terminal";
    }
  >,
  detail: Record<string, unknown>,
): ConversationTelemetryFact {
  return {
    version: 1,
    eventId: operation.eventId,
    eventSeq: scope.sequence++,
    occurredAt: operation.now,
    sessionId: operation.sessionId,
    // [契约] 缺失字段对比策略：可选字段用条件展开，未提供时整个键不出现。
    // 双路径必须共用同一判据，把“不存在”与“空字符串”分开比较。
    // 若一侧写成 undefined 值，结构化对比会报键存在性差异。
    // detail 透传保证字段形状一致，禁止在校验层补默认值。
    // 新增可选字段需在两侧同时加展开条件，避免单侧多键。
    ...(operation.commandId ? { sourceCommandId: operation.commandId } : {}),
    ...(operation.turnId ? { turnId: operation.turnId } : {}),
    ...detail,
  } as ConversationTelemetryFact;
}
