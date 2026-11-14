//
// 文件职责：E2E 兼容驱动。把统一的 parity 场景逐项翻译成旧版 telemetry 调用，
// 经由旧 production builder / reporter 发到最终上报出口，供当前实现逐字段对照。
// 职责边界：只做「场景 -> 旧链路调用」的翻译与断言采集；不拥有聚合状态、不驱动 UI、
// 不直接上报（所有出口必须经过 reportAppTelemetryEvent 与 ARMS reporter）。
//
// 不变量（INV）：
// INV-01 断言：仅 desktop 且 bridge 被授权时才写 window 桥，否则返回空卸载函数。
//        位置：installLegacyConversationTelemetryParityE2EBridge 的 isDesktop / shouldExposeE2EStoreBridge 分支；故障：生产 Web 暴露可重放后门。
// INV-02 断言：卸载只在 window 上仍是自己这一份 bridge 时才 delete。
//        位置：返回闭包内的 window.__zcodeConversationTelemetryParityE2E === bridge 判断；故障：卸载旧实例时误删新实例。
// INV-03 断言：每个 case 开始前必须重置 message telemetry。
//        位置：runLegacyScenario 首行的 resetMessageTelemetryForTest；故障：跨 case 串数据，TTFT 与用量断言随机漂移。
// INV-04 断言：scope 按名字惰性创建且只创建一次，now 只由带 now 的操作推进。
//        位置：getScope 的 scopes.get / scopes.set 与 applyLegacyOperation 的 "now" in operation；故障：同 scope 出现两份计数，前台判定失真。
// INV-05 断言：seed 以 commandId 幂等，重复 seed 不得重复发送 send_btn。
//        位置：case "seed" 的 acceptedCommands.has 早退；故障：重放场景时报表条数翻倍。
// INV-06 断言：eventId 全局幂等，任何事件只能被消费一次。
//        位置：remember(scope.eventIds, ...)；故障：chunk/tool 重复累计，步骤与用量翻倍。
// INV-07 断言：terminal 去重键由 sessionId + commandId + message_completion 组成。
//        位置：case "terminal" 的 terminalKeys；故障：同轮多个终端事件导出两条完成报表。
// INV-08 断言：只有 active 的 lifecycle 才能承接 chunk / tool / permission / usage / terminal。
//        位置：activeLifecycle 的 lifecycle?.active 过滤；故障：turn.started 之前的事件污染统计。
// INV-09 断言：前台判定使用引用计数，同一 owner 重复 attach 不重复加一。
//        位置：case "foreground.attach" 的 previous === sessionId 早退与 foregroundCounts；故障：重复 attach 后 detach 一次仍判前台。
// INV-10 断言：detach 必须先删 owner 再减计数，并清理该 session 的 stall 跟踪。
//        位置：case "foreground.detach" 的 owners.delete / decrementForeground / clearStreamStallTracking；故障：残留定时器导致后续轮次误报卡顿。
// INV-11 断言：首个前台 token 时间只写一次，后续 chunk/tool 不再覆盖。
//        位置：foregroundFirstTokenAt === null 判断；故障：TTFT 被最后一帧拉长。
// INV-12 断言：工具首次出现且非终态才能构造 tool_call，其余一律 tool_call_update。
//        位置：case "tool" 的 started / terminal 组合；故障：补发启动事件，工具计数虚高。
// INV-13 断言：terminal 的 success 才携带累计 usage，失败或中断不得挂用量。
//        位置：finalizePromptTelemetry 的 usage: status === "success" ? terminalUsage : undefined；故障：失败轮次被计入 token 统计。
// INV-14 断言：visible.error 的 errorKey 只上报一次，suppressed 直接丢弃。
//        位置：case "visible.error" 的 suppressed / visibleErrorKeys；故障：错误横幅重复曝光。
// INV-15 断言：compaction 必须同时通过 eventId 与 session+operationId 双重去重，且只在前台上报。
//        位置：case "compaction" 的 remember(compactionKeys) 与 isForeground；故障：后台会话产生脏报表。
// INV-16 断言：web.noop 分支使用 noop platform，且结束后恢复真实 ARMS reporter。
//        位置：runLegacyWebNoopOperations 的 setUiPerfArmsReporter(null) / finally；故障：污染真实 ARMS 或永久丢失 reporter。
// INV-17 断言：上报一律串行 await，顺序必须与场景操作顺序一致。
//        位置：reportLegacyEvent / reportFinalizedSteps 的 for-await；故障：报表乱序，parity 对比误判。
// INV-18 断言：数值字段只在有限数时才进入 ARMS 明细。
//        位置：finite 的 Number.isFinite；故障：NaN 进入报表被静默丢弃或写成字符串。
//
/* eslint-disable max-lines -- 旧版临时驱动必须逐项翻译统一场景，并通过旧 production builder/reporter 发到最终出口。 */
import {
  type IPlatformService,
  type ZCodeContextCompactionTimelineMeta,
  type ZCodeProvider,
  type ZCodeStreamEvent,
  type ZCodeUsage,
} from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { reportChatErrorBannerTelemetry } from "@/lib/chatErrorBannerTelemetry.js";
import {
  getConversationTelemetryParityScenario,
  type ConversationTelemetryParityOperation,
} from "@/lib/conversationTelemetryParityScenarioDefinitions.js";
import {
  runRequestVerificationParityAssertions,
  runQuotaParityStateAssertions,
} from "@/lib/conversationTelemetryParityStateE2E.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import {
  activatePromptTelemetry,
  buildCompactionTelemetryExtraDetail,
  finalizePromptTelemetry,
  getActivePromptMessageId,
  getActivePromptModelName,
  queuePromptTelemetry,
  recordAgentStepTelemetryEvent,
  recordComposerFocus,
  recordComposerTextChange,
  recordPromptModelRequestStarted,
  recordPromptPermissionRequest,
  recordPromptPermissionResponse,
  recordPromptTokenUsageDelta,
  resetMessageTelemetryForTest,
} from "@/lib/messageTelemetry.js";
import {
  reportPlanUsageModelRequestStartedToArms,
  reportPlanUsageTtftToArms,
} from "@/lib/planUsageArmsTelemetry.js";
import {
  clearStreamStallTracking,
  recordStreamChunkArrival,
  reportUiFirstToken,
  reportUiMessageComplete,
  reportUiToolCallDetail,
  reportUiTurnBreakdown,
  setUiPerfArmsReporter,
} from "@/lib/uiPerfArmsTelemetry.js";

interface LegacyLifecycle {
  sessionId: string;
  commandId: string;
  taskKey: string;
  sendTime: number;
  foregroundFirstTokenAt: number | null;
  legacyFirstTokenObserved: boolean;
  active: boolean;
  turnId?: string;
  startedTools: Set<string>;
  terminalUsage?: ZCodeUsage;
  lastErrorMessage?: string;
}

interface LegacyScope {
  name: string;
  now: number;
  acceptedCommands: Set<string>;
  eventIds: Set<string>;
  terminalKeys: Set<string>;
  compactionKeys: Set<string>;
  owners: Map<string, string>;
  foregroundCounts: Map<string, number>;
  lifecycles: Map<string, LegacyLifecycle>;
}

interface LegacyScenarioResult {
  caseId: string;
  minimumArmsInventory: Record<string, number>;
  minimumReportInventory: Record<string, number>;
  operationCount: number;
  proof: string[];
  stateAssertions: string[];
}

declare global {
  interface Window {
    __zcodeConversationTelemetryParityE2E?: {
      variant: "current" | "legacy";
      run(caseId: string): Promise<LegacyScenarioResult>;
    };
  }
}

// [契约] 这是 E2E 专用桥：production 路径不得调用；variant 固定为 legacy，
// 让上层 runner 明确区分「旧链路重放」与「当前实现」，避免两边结果互相覆盖。
// [权衡] 卸载函数返回 noop 而不是 undefined，调用方无需判空即可统一 cleanup。
export function installLegacyConversationTelemetryParityE2EBridge(input: {
  platform: IPlatformService;
  isDesktop: boolean;
}): () => void {
  // [契约] 双重闸门：非 desktop 或 E2E store bridge 未开放时，连全局键都不注册。
  // 只返回空函数，调用方仍可无条件执行清理，不会踩到 undefined。
  if (!input.isDesktop || !shouldExposeE2EStoreBridge()) return () => undefined;
  const bridge = {
    variant: "legacy" as const,
    run: (caseId: string) => runLegacyScenario(input.platform, caseId),
  };
  // `window.__zcodeConversationTelemetryParityE2E` 是单槽位：后挂载实例覆盖前一个，卸载函数靠身份比较避免误删新实例。
  // 因此这里不能改成数组或追加式注册，否则 window 上会残留多份可重放入口。
  window.__zcodeConversationTelemetryParityE2E = bridge;
  return () => {
    if (window.__zcodeConversationTelemetryParityE2E === bridge) {
      delete window.__zcodeConversationTelemetryParityE2E;
    }
  };
}

// [事务] 一次 case 是一个完整事务：重置 telemetry -> 顺序执行全部操作 -> 汇总断言。
// 任一步抛错都会中断，不做部分回滚；parity runner 依赖异常本身判定该 case 失败。
// scope 只在本次调用内可见，跨 case 不共享，避免状态泄漏。
async function runLegacyScenario(
  platform: IPlatformService,
  caseId: string,
): Promise<LegacyScenarioResult> {
  const scenario = getConversationTelemetryParityScenario(caseId);
  // [资源] 必须在任何操作之前清空 message telemetry 的模块级状态，
  // 否则上一 case 的 active prompt 与累计 usage 会串进本 case 的首个事件。
  resetMessageTelemetryForTest();
  // [契约] scope 注册表是本次 case 的局部变量，不能提升为模块级单例；
  // 提升会让两个 case 共享 owner 与计数，前台语义互相串扰。
  // [资源] case 结束后随函数返回释放，无需显式清理。
  // web.noop 分支另有自己的 scopes，二者不能混用。
  const scopes = new Map<string, LegacyScope>();
  // [契约] 可见错误去重按 case 级别维护，跨 case 必须重新开始；
  // 否则同名 errorKey 在第二个 case 中被静默吞掉，导致断言缺样本。
  // 该集合只由 visible.error 分支写入，其他分支不得读写。
  const visibleErrorKeys = new Set<string>();
  // [契约] stateAssertions 是本次 case 的输出，只允许追加、不允许中途清空；
  // 顺序即断言执行顺序，下游按数组逐项比对。
  // 与 scenario.proof 分开保存：前者是运行期结论，后者是场景声明的预期。
  const stateAssertions: string[] = [];
  // [契约] scope 名字缺省为 default，同一名字必须复用同一个对象：
  // 计数、owner、lifecycle 都以对象身份为准，重建会丢掉前台与去重状态。
  const getScope = (name = "default"): LegacyScope => {
    // [契约] 命中已存在的 scope 必须原样返回，不能做克隆或浅拷贝；
    // 调用方持有的是可变引用，拷贝会让后续写入落在副本上。
    // [并发] 该读取与下方 set 之间没有 await，天然原子。
    // 若未来改为异步创建，必须补并发合流，否则会创建两份。
    const existing = scopes.get(name);
    if (existing) return existing;
    // [事务] 新建 scope 时一次性初始化全部容器，避免分支里出现半初始化对象；
    // now 从 0 开始，必须由带 now 的操作推进，不能在这里取墙钟时间。
    // [权衡] 计数与 owner 都用独立 Map，便于按 session 粒度清理。
    const created: LegacyScope = {
      name,
      now: 0,
      acceptedCommands: new Set(),
      eventIds: new Set(),
      terminalKeys: new Set(),
      compactionKeys: new Set(),
      owners: new Map(),
      foregroundCounts: new Map(),
      lifecycles: new Map(),
    };
    scopes.set(name, created);
    return created;
  };

  // [并发] 这里用 for-await 串行等待，不能改成 Promise.all：
  // 操作之间存在因果（先 seed 后 chunk），并行会打乱上报顺序并让幂等判断失效。
  for (const operation of scenario.operations) {
    await applyLegacyOperation({
      caseId,
      getScope,
      operation,
      platform,
      stateAssertions,
      visibleErrorKeys,
    });
  }
  return {
    caseId,
    // [契约] 清单类字段原样回传，不在驱动层做补齐或过滤；
    // 若在此处增删条目，runner 的「最小集合」比较会失去意义。
    // [权衡] 返回场景自身的对象引用而非深拷贝，调用方只读。
    minimumArmsInventory: scenario.minimumArmsInventory,
    minimumReportInventory: scenario.minimumReportInventory,
    operationCount: scenario.operations.length,
    proof: scenario.proof,
    stateAssertions,
  };
}

// [契约] 每个 operation 都携带完整上下文，函数本身不持有跨调用的可变状态；
// 这样同一 operation 可在不同 scope 上重放，便于对照两种实现的产物。
// 返回 Promise 是为了让上报链路可被 await，保证顺序与背压。
async function applyLegacyOperation(input: {
  caseId: string;
  getScope(name?: string): LegacyScope;
  operation: ConversationTelemetryParityOperation;
  platform: IPlatformService;
  stateAssertions: string[];
  visibleErrorKeys: Set<string>;
}): Promise<void> {
  // [契约] 先解构再分支，保证后续所有读取都锚定同一个 operation 快照；
  // 不能在分支内重新取 input.operation，避免重放过程中上下文被替换。
  // input 的其余字段按需读取，不做整体展开以免误带 scope。
  const { operation } = input;
  // [失败路径] web.noop 走独立子流程并立即返回，不进入下方 switch；
  // 它的操作集合是「Web 端不应产生任何真实上报」的对照实验，提前返回可避免
  // 被后续 scope/now 处理污染。
  if (operation.kind === "web.noop") {
    await runLegacyWebNoopOperations(input, operation.operations);
    rememberStateAssertion(input.stateAssertions, "web:no-final-output");
    return;
  }
  // [契约] quota 断言只读取已有 telemetry 状态并追加断言文本，不产生任何上报。
  // 放在 switch 之前是为了不依赖 scope，也不需要 active lifecycle。
  if (operation.kind === "quota.assert") {
    input.stateAssertions.push(...runQuotaParityStateAssertions());
    return;
  }
  // [契约] verification 同理是只读断言；顺序敏感，必须严格晚于它依赖的操作，
  // 因此这里不能延迟到 case 结束再统一执行。
  if (operation.kind === "verification.assert") {
    input.stateAssertions.push(...runRequestVerificationParityAssertions());
    return;
  }
  // [契约] 只有进入具体操作后才解析 scope；web.noop 与两类 assert 不碰 scope，
  // 避免为纯断言操作创建空对象，干扰「按 scope 统计对象数量」的校验。
  const scope = input.getScope(operation.scope);
  if ("now" in operation) scope.now = operation.now;

  switch (operation.kind) {
    // [契约] focus/text 只更新输入侧指标，不创建 lifecycle，也不受 eventId 去重约束；
    // 它们模拟用户连续输入，重复出现本身就是有效样本。
    case "focus":
      recordComposerFocus(scopeKey(input.caseId, scope), scope.now);
      return;
    // [权衡] 输入内容原样透传，不做裁剪或脱敏：parity 断言比较的是同一份文本
    // 在两条链路上是否产生相同指标，任何预处理都会引入不可比因素。
    case "text":
      recordComposerTextChange(scopeKey(input.caseId, scope), operation.value, scope.now);
      return;
    // [事务] seed 是整轮对话的起点：写 acceptedCommands、建 lifecycle、发 send_btn。
    // 三步必须在同一分支内完成，不能拆到异步回调里，否则 chunk 可能先于 lifecycle 到达。
    // detail 里的 ask_mode/model 缺省为空串，保持旧 builder 的字段契约。
    case "seed": {
      // [并发] 幂等闸门必须同步判断并立即写入，中间不能 await；
      // 一旦让出事件循环，并发重放会出现两次 send_btn。
      if (scope.acceptedCommands.has(operation.commandId)) return;
      scope.acceptedCommands.add(operation.commandId);
      // [契约] taskKey 由 caseId + scope 名 + sessionId 三段组成，必须全局唯一；
      // seed 写入与后续事件读取使用同一函数生成，禁止手写拼接。
      // [失败路径] 若改成只用 sessionId，不同 case 的同一会话会互相覆盖。
      const taskKey = taskKeyFor(input.caseId, scope, operation.sessionId);
      // [契约] queue 阶段只暂存，最终上报由 terminal 的 finalize 触发；
      // 这里不能顺手调用上报函数，否则会提前产生一条没有时长与用量的半成品报表。
      const detail = queuePromptTelemetry({
        workspacePath: scopeKey(input.caseId, scope),
        taskId: taskKey,
        messageId: operation.commandId,
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
      // [事务] lifecycle 在 seed 时一次性建好全部字段，后续只改值不补字段；
      // 提前初始化 startedTools 等容器，可避免分支里出现 undefined 判断。
      // active 初始为 false，必须等 turn.started 才能被事件命中。
      scope.lifecycles.set(operation.commandId, {
        sessionId: operation.sessionId,
        commandId: operation.commandId,
        taskKey,
        sendTime: operation.now,
        foregroundFirstTokenAt: null,
        legacyFirstTokenObserved: false,
        active: false,
        startedTools: new Set(),
      });
      await reportLegacyEvent(
        input.platform,
        "send_btn",
        "ck",
        detail,
        operation.sessionId,
        operation.commandId,
      );
      return;
    }
    // [并发] attach 是引用计数语义：同一 owner 重复挂到同一 session 必须早退，
    // 否则计数虚高，detach 一次后仍被判为前台，TTFT 与 TurnBreakdown 会重复上报。
    // 切换 owner 时先减旧 session 计数，再写新映射，顺序不能反。
    case "foreground.attach": {
      const previous = scope.owners.get(operation.owner);
      if (previous === operation.sessionId) return;
      // [失败路径] 旧 owner 存在但计数已为 0 时，decrementForeground 内部会删除键；
      // 这里不额外校验，保证「映射存在即有计数」由单一函数维护。
      if (previous) decrementForeground(scope, previous);
      // [并发] owner 到 session 的映射是单值覆盖：一个展示位同时只能挂一个会话；
      // 覆盖前必须已对旧 session 减计数，这里不能再做二次减，否则会重复扣减。
      // 映射与计数必须同向更新，不存在只写其一的合法路径。
      scope.owners.set(operation.owner, operation.sessionId);
      scope.foregroundCounts.set(
        operation.sessionId,
        (scope.foregroundCounts.get(operation.sessionId) ?? 0) + 1,
      );
      return;
    }
    // [资源] detach 同时承担三件事：删 owner 映射、减引用计数、清理流式卡顿跟踪。
    // 三者必须一起做；只删映射会留下负计数，只清跟踪会让 owner 永远占位。
    // 没有 owner 时直接返回，重复 detach 视为无害。
    case "foreground.detach": {
      const previous = scope.owners.get(operation.owner);
      // [失败路径] 未知 owner 的 detach 静默忽略：场景可能只回放「离开」而省略「进入」，
      // 这里报错会让对照实验因无关噪声失败。
      if (!previous) return;
      // [资源] 先删映射再接减计数，保证任何中间态都不会出现「owner 还在但计数已减」；
      // 删除后同一 owner 的重复 detach 会走 !previous 早退。
      // 不要在此处顺手删 lifecycles：会话可能仍有其他 owner 挂着。
      scope.owners.delete(operation.owner);
      decrementForeground(scope, previous);
      clearStreamStallTracking(previous);
      return;
    }
    // [事务] turn.started 是 lifecycle 从「已 seed」转为「可承接事件」的唯一入口。
    // eventId 去重在前、lifecycle 查找在后：未 seed 的 commandId 直接丢弃，
    // 不补建 lifecycle，避免出现没有 send_btn 的孤儿报表。
    case "turn.started": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = scope.lifecycles.get(operation.commandId);
      if (!lifecycle) return;
      // [事务] active 一旦置 true，本生命周期即可承接后续全部事件；
      // 该赋值必须发生在 turnId 写入之后，保证首个 chunk 看到完整上下文。
      // [失败路径] 把它放到 activatePromptTelemetry 之后会短暂留下不可承接窗口。
      lifecycle.active = true;
      lifecycle.turnId = operation.turnId;
      activatePromptTelemetry(lifecycle.taskKey, lifecycle.commandId);
      return;
    }
    // [契约] model.status 无论 lifecycle 是否 active 都要上报 ARMS 的模型请求开始事件，
    // 因为它描述网络层事实；只有 prompt 侧记录才要求 active。
    // 失败状态额外把 reason 落到 lifecycle，供 terminal 兜底错误文案。
    case "model.status": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      // [契约] 网络事件只构造一次并同时喂给 ARMS 与 prompt 记录，避免两处字段不一致；
      // 转换函数保持纯函数语义，不读取 scope，也不产生副作用。
      // 若在此处直接上报而不复用 networkEvent，eventKey 会漂移。
      const networkEvent = toNetworkEvent(operation);
      // [契约] 计划用量侧的模型请求事件与 lifecycle 无关，必须无条件上报；
      // 它描述的是网络请求开始，而不是 prompt 生命周期。
      // [权衡] 因此该调用放在 active 判断之前，顺序不可后移。
      reportPlanUsageModelRequestStartedToArms(input.platform, networkEvent);
      const lifecycle = operation.commandId ? scope.lifecycles.get(operation.commandId) : undefined;
      if (lifecycle?.active) {
        recordPromptModelRequestStarted(lifecycle.taskKey, networkEvent, lifecycle.commandId);
        // [失败路径] 只记录首个失败原因，后续重试失败不覆盖；
        // terminal 优先使用 operation.errorMessage，其次才回落到这里。
        if (operation.status === "model_request_failed") {
          lifecycle.lastErrorMessage = operation.reason;
        }
      }
      return;
    }
    // [契约] chunk 必须先过 eventId、再解析 active lifecycle、最后才写首 token 时间。
    // channel 决定事件类型（thought/message），parentToolCallId 只在存在时注入，
    // 保持旧事件对象「缺字段」而非「字段为 undefined」的形状。
    case "chunk": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = activeLifecycle(scope, operation.commandId);
      if (!lifecycle) return;
      lifecycle.legacyFirstTokenObserved = true;
      const foreground = isForeground(scope, operation.sessionId);
      // [并发] 前台首 token 只记第一次；判定使用当前计数而非 lifecycle 创建时的快照，
      // 因为用户可能在流式过程中才切回前台。
      if (foreground && lifecycle.foregroundFirstTokenAt === null) {
        lifecycle.foregroundFirstTokenAt = operation.now;
      }
      const event = {
        type: operation.channel === "thought" ? "agent_thought_chunk" : "agent_message_chunk",
        taskId: operation.sessionId,
        traceId: operation.eventId,
        inputId: operation.commandId,
        content: "",
        ...(operation.parentToolCallId ? { parentToolUseId: operation.parentToolCallId } : {}),
      } as Extract<ZCodeStreamEvent, { type: "agent_thought_chunk" | "agent_message_chunk" }>;
      await reportFinalizedSteps(
        input.platform,
        lifecycle,
        recordAgentStepTelemetryEvent({
          taskId: lifecycle.taskKey,
          event,
          activeInputId: lifecycle.commandId,
          clientMode: "desktop-continuous",
          now: operation.now,
        }),
      );
      // [契约] 只有前台 chunk 才驱动 UI 侧 stall 跟踪；
      // 后台会话的到达时间不得影响前台卡顿判定。
      if (foreground) {
        recordStreamChunkArrival(operation.sessionId, {
          now: operation.now,
          talkId: operation.sessionId,
          waitingTool: false,
          model: getActivePromptModelName(lifecycle.taskKey),
          messageId: operation.channel === "text" ? `${operation.commandId}-assistant` : undefined,
          chunkType: operation.channel === "thought" ? "thought" : "message",
        });
      }
      return;
    }
    // [契约] 权限请求与响应共用同一 lifecycle，按 phase 分流；
    // requestId 原样透传，旧链路依赖它配对，不能在此重新生成。
    case "permission": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = activeLifecycle(scope, operation.commandId);
      if (!lifecycle) return;
      if (operation.phase === "requested") {
        // [契约] 权限请求必须携带 taskId、requestId、toolCallId 三要素；
        // taskId 用 lifecycle.taskKey 而非 sessionId，保持与 prompt 侧键空间一致。
        // requestId 原样传入，后续 response 依赖它配对，不能重写。
        recordPromptPermissionRequest({
          taskId: lifecycle.taskKey,
          requestId: operation.requestId,
          toolCallId: operation.toolCallId,
          now: operation.now,
        });
      } else {
        recordPromptPermissionResponse({
          taskId: lifecycle.taskKey,
          requestId: operation.requestId,
          now: operation.now,
        });
      }
      return;
    }
    // [契约] tool 分支同时维护 startedTools 与首 token 时间：
    // 工具启动也被旧实现视为「已产生可见输出」，因此要标记 legacyFirstTokenObserved。
    // clearStreamStallTracking 先做，避免工具期间的静默被误判为卡顿。
    case "tool": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = activeLifecycle(scope, operation.commandId);
      if (!lifecycle) return;
      lifecycle.legacyFirstTokenObserved = true;
      const foreground = isForeground(scope, operation.sessionId);
      if (foreground && lifecycle.foregroundFirstTokenAt === null) {
        lifecycle.foregroundFirstTokenAt = operation.now;
      }
      clearStreamStallTracking(operation.sessionId);
      // [事务] started/terminal 必须基于「加入集合之前」的快照计算，
      // 之后再把 toolCallId 写入集合；顺序颠倒会让首个 tool_call 退化为 update。
      const started = lifecycle.startedTools.has(operation.toolCallId);
      // [契约] 只有 completed/failed 被视为终态，其余 phase 一律按进行中处理；
      // started 需要在事件构造前计算，写入 startedTools 之后再算就会恒为 true。
      // [权衡] 终态重复到达由 started/terminal 组合吸收，不额外维护结束集合。
      const terminal = operation.phase === "completed" || operation.phase === "failed";
      // [事务] 写入集合的时机在事件类型决策之后，保证首个 tool_call 不被自己污染；
      // 集合只增不删，用于识别「首次出现」，不表示当前仍在运行。
      // 若要表达运行中状态，必须另建集合，不能复用 startedTools。
      lifecycle.startedTools.add(operation.toolCallId);
      const event =
        !started && !terminal
          ? ({
              type: "tool_call",
              taskId: operation.sessionId,
              traceId: operation.eventId,
              inputId: operation.commandId,
              toolId: operation.toolCallId,
              parentToolUseId: operation.parentToolCallId,
              input: {},
              toolName: operation.toolName,
              kind: operation.toolName,
              title: "",
              raw: {},
            } as Extract<ZCodeStreamEvent, { type: "tool_call" }>)
          : ({
              type: "tool_call_update",
              taskId: operation.sessionId,
              traceId: operation.eventId,
              inputId: operation.commandId,
              toolId: operation.toolCallId,
              parentToolUseId: operation.parentToolCallId,
              status:
                operation.phase === "completed"
                  ? "completed"
                  : operation.phase === "failed"
                    ? "failed"
                    : "in_progress",
              toolName: operation.toolName,
              kind: operation.toolName,
              error: operation.errorMessage,
              raw: {},
            } as Extract<ZCodeStreamEvent, { type: "tool_call_update" }>);
      await reportFinalizedSteps(
        input.platform,
        lifecycle,
        recordAgentStepTelemetryEvent({
          taskId: lifecycle.taskKey,
          event,
          activeInputId: lifecycle.commandId,
          clientMode: "desktop-continuous",
          now: operation.now,
        }),
      );
      // [失败路径] 工具失败信息进入 lifecycle 兜底，terminal 未显式给 errorMessage 时使用；
      // 成功工具不得清空已有错误，否则会掩盖同轮更早的失败。
      if (operation.errorMessage) lifecycle.lastErrorMessage = operation.errorMessage;
      if (foreground && terminal && operation.performance) {
        reportUiToolCallDetail({
          toolName: operation.toolName,
          status: operation.phase === "completed" ? "completed" : "failed",
          talkId: operation.sessionId,
          messageId: getActivePromptMessageId(lifecycle.taskKey),
          toolCallId: operation.toolCallId,
          parentToolCallId: operation.parentToolCallId,
          totalMs: operation.performance.totalMs,
          permissionWaitMs: operation.performance.permissionWaitMs,
          commandRunMs: operation.performance.commandRunMs,
          exitCode: operation.performance.exitCode,
          timedOut: operation.performance.timedOut,
          outputBytes: operation.performance.outputBytes,
          commandCategory: operation.performance.commandCategory,
          commandName: operation.performance.commandName,
          commandCount: operation.performance.commandCount,
          commandStatus: operation.performance.commandStatus,
          workspaceKind: operation.performance.workspaceKind,
        });
      }
      return;
    }
    // [事务] usage 每次到达先记录增量，再累加到 lifecycle.terminalUsage；
    // 两处必须是同一份数字，否则最终 completion 与逐步统计会对不上。
    case "usage": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = activeLifecycle(scope, operation.commandId);
      if (!lifecycle) return;
      // [事务] 每次 usage 都以 eventKey 作为去重键，重复到达不得二次累加；
      // totalTokens 在此显式计算为输入加输出，不能信任上游传入的总量。
      // 可选字段用 ?? 0 归一，避免 undefined 参与算术产生 NaN。
      recordPromptTokenUsageDelta({
        taskId: lifecycle.taskKey,
        eventKey: operation.eventId,
        usage: {
          inputTokens: operation.inputTokens,
          outputTokens: operation.outputTokens,
          totalTokens: operation.inputTokens + operation.outputTokens,
          reasoningTokens: operation.reasoningTokens ?? 0,
          cachedInputTokens: operation.cacheReadTokens ?? 0,
          cachedWriteInputTokens: operation.cacheWriteTokens ?? 0,
        },
      });
      lifecycle.terminalUsage = mergeUsage(lifecycle.terminalUsage, {
        inputTokens: operation.inputTokens,
        outputTokens: operation.outputTokens,
        totalTokens: operation.inputTokens + operation.outputTokens,
        reasoningTokens: operation.reasoningTokens ?? 0,
        cachedInputTokens: operation.cacheReadTokens ?? 0,
        cachedWriteInputTokens: operation.cacheWriteTokens ?? 0,
      });
      return;
    }
    // [事务] terminal 是收尾事务：构造完成/错误事件、上报 finalized steps、
    // finalize 生成 completion 报表、清 stall、删除 lifecycle。
    // 顺序不可调换：finalize 之后再上报 steps 会丢掉最后一步的归属。
    // 无论成功失败都必须走到删除 lifecycle，失败分支不得提前 return。
    case "terminal": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = activeLifecycle(scope, operation.commandId);
      if (!lifecycle) return;
      const terminalKey = `${operation.sessionId}\u0000${operation.commandId}\u0000message_completion`;
      // [并发] 终态去重独立于 eventId：同一 commandId 可能收到不同 eventId 的完成事件；
      // 复合键保证「一轮只完成一次」，早退时不得清理 lifecycle。
      // [失败路径] 若把该判断放到 finalize 之后，重复事件会先产生第二条报表。
      if (!remember(scope.terminalKeys, terminalKey)) return;
      const terminalEvent =
        operation.status === "success"
          ? ({
              type: "task_complete",
              taskId: operation.sessionId,
              traceId: operation.eventId,
              inputId: operation.commandId,
              stopReason: "complete",
            } as Extract<ZCodeStreamEvent, { type: "task_complete" }>)
          : ({
              type: "task_error",
              taskId: operation.sessionId,
              traceId: operation.eventId,
              inputId: operation.commandId,
              error:
                operation.errorMessage ?? lifecycle.lastErrorMessage ?? operation.errorCode ?? "",
              code: operation.errorCode,
            } as Extract<ZCodeStreamEvent, { type: "task_error" }>);
      await reportFinalizedSteps(
        input.platform,
        lifecycle,
        recordAgentStepTelemetryEvent({
          taskId: lifecycle.taskKey,
          event: terminalEvent,
          activeInputId: lifecycle.commandId,
          clientMode: "desktop-continuous",
          now: operation.now,
        }),
      );
      // [契约] 三态映射固定：success -> success，interrupted -> user_interrupt，其余 -> fail；
      // 该字符串直接进入报表枚举，不能新增或改写，否则下游统计口径断裂。
      // [权衡] 未知状态一律归为 fail，宁可少算成功也不虚增。
      const status =
        operation.status === "success"
          ? "success"
          : operation.status === "interrupted"
            ? "user_interrupt"
            : "fail";
      // [契约] finalize 可能返回 null（例如缺少必要字段），此时只做清理，
      // 不产生 completion 报表，也不能把空对象当成功上报。
      const completion = finalizePromptTelemetry({
        taskId: lifecycle.taskKey,
        status,
        finishedAt: operation.now,
        usage: operation.status === "success" ? lifecycle.terminalUsage : undefined,
        errorType: operation.errorCode,
        errorMsg: operation.errorMessage ?? lifecycle.lastErrorMessage,
      });
      if (completion) {
        await reportLegacyEvent(
          input.platform,
          "message_completion",
          "agent_trace",
          completion.eventExtraDetail,
          operation.sessionId,
          operation.commandId,
        );
        // [契约] completion 的 ARMS 明细只在前台产生，但完成报表本身无论前后台都要上报；
        // 因此 isForeground 只能包住 reportCompletionArms。
        // [并发] 前台判定读取当前计数，与首 token 记录时的判定可能不同，属于预期。
        if (isForeground(scope, operation.sessionId)) {
          reportCompletionArms(input.platform, lifecycle, completion.eventExtraDetail);
        }
      }
      clearStreamStallTracking(operation.sessionId);
      // [资源] 删除 lifecycle 释放该轮全部引用；漏删会让后续同 commandId 的
      // 迟到事件命中旧对象，产生「已完成仍在累计」的幽灵数据。
      scope.lifecycles.delete(operation.commandId);
      return;
    }
    // [契约] compaction 使用 session+operationId 复合键去重，且只在前台上报；
    // 后台压缩不应出现在用户可见时间线，也就不应产生对应报表。
    // timeline 固定 version 1 / attempt 1，保持与旧 builder 的字段形状一致。
    case "compaction": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const dedupeKey = `${operation.sessionId}\u0000${operation.operationId}\u0000context_compaction`;
      if (!remember(scope.compactionKeys, dedupeKey) || !isForeground(scope, operation.sessionId))
        return;
      const timeline: ZCodeContextCompactionTimelineMeta = {
        version: 1,
        kind: "synthetic",
        type: "context_compaction",
        operationId: operation.operationId,
        status: operation.status,
        trigger: operation.trigger,
        display: "separator",
        reason: operation.reason,
        summaryMessageId: operation.summaryMessageId,
        preCompactTokenCount: operation.preCompactTokenCount,
        postCompactTokenCount: operation.postCompactTokenCount,
        truePostCompactTokenCount: operation.truePostCompactTokenCount,
        attempt: 1,
        startedAt: operation.startedAt,
        endedAt: operation.endedAt,
      };
      const detail = buildCompactionTelemetryExtraDetail({
        timeline,
        provider: "glm" as ZCodeProvider,
        modelName: operation.modelName,
      });
      if (detail) {
        await reportLegacyEvent(
          input.platform,
          "context_compaction",
          "agent_trace",
          detail,
          operation.sessionId,
          operation.summaryMessageId ?? operation.operationId,
        );
      }
      return;
    }
    // [失败路径] suppressed 的错误完全跳过（连 key 都不占位），
    // 其余按 errorKey 去重：同一错误在一次 case 中只曝光一次。
    case "visible.error":
      if (operation.suppressed || input.visibleErrorKeys.has(operation.errorKey)) return;
      input.visibleErrorKeys.add(operation.errorKey);
      await reportChatErrorBannerTelemetry(input.platform, {
        errorKey: operation.errorKey,
        displayMessage: operation.displayMessage,
        error: {
          code: operation.code,
          message: operation.displayMessage,
          traceId: operation.traceId,
          taskId: operation.sessionId,
          detail: operation.detail,
        },
        providerBusinessRecoveryAction: null,
      });
      return;
    // [契约] feedback 不做去重：用户可以对同一条消息多次反馈，每次都视为独立样本；
    // eventRegion 显式传 chat，以区分应用级事件。
    case "feedback":
      await reportLegacyEvent(
        input.platform,
        "assistant_message_feedback",
        "ck",
        { reaction: operation.reaction },
        operation.sessionId,
        operation.messageId,
        "chat",
      );
      return;
    // [契约] scope.dispose 目前是空实现，保留分支是为了让场景显式声明生命周期结束；
    // 未来若引入 scope 级资源清理，应在此释放而不是依赖 GC。
    case "scope.dispose":
      return;
  }
}

// [失败路径] web.noop 用假 platform 吞掉所有上报，模拟 Web 端「不产生真实数据」的期望。
// 它复用同一套 applyLegacyOperation 逻辑，保证除出口之外行为完全一致，
// 因此差异只能体现在 platform，不能在操作翻译上分叉。
async function runLegacyWebNoopOperations(
  input: Parameters<typeof applyLegacyOperation>[0],
  operations: ConversationTelemetryParityOperation[],
): Promise<void> {
  // [契约] 假 platform 只实现被旧链路实际调用的两个上报方法，其余通过断言转型补齐；
  // 这是刻意的窄实现：若新增上报方法，必须显式补在这里，否则会在运行时抛错。
  // [失败路径] 不能复用真实 platform 再做空实现包装，否则容易漏掉某个出口。
  const noopPlatform = {
    reportTelemetryEvent: async () => undefined,
    reportArmsCustomEvent: async () => undefined,
  } as unknown as IPlatformService;
  const scopes = new Map<string, LegacyScope>();
  const getScope = (name = "web"): LegacyScope => {
    const existing = scopes.get(name);
    if (existing) return existing;
    const created: LegacyScope = {
      name: `web-${name}`,
      now: 0,
      acceptedCommands: new Set(),
      eventIds: new Set(),
      terminalKeys: new Set(),
      compactionKeys: new Set(),
      owners: new Map(),
      foregroundCounts: new Map(),
      lifecycles: new Map(),
    };
    scopes.set(name, created);
    return created;
  };

  // [资源] 进入前摘掉真实 ARMS reporter，避免 noop 场景的 UI 性能事件漏到真实通道；
  // 必须在 try/finally 中恢复，异常路径同样要还原。
  setUiPerfArmsReporter(null);
  try {
    for (const operation of operations) {
      await applyLegacyOperation({
        ...input,
        getScope,
        operation,
        platform: noopPlatform,
      });
    }
  } finally {
    setUiPerfArmsReporter(input.platform);
  }
}

// [契约] 断言标签按出现顺序去重，保证同一标签只出现一次且首次位置稳定；
// 下游按数组顺序对比，不能改成 Set 后再展开。
function rememberStateAssertion(assertions: string[], label: string): void {
  // [契约] 采用线性包含判断而非 Set，是为了保留插入顺序且避免额外结构；
  // 断言数量很小，O(n^2) 可接受，换取输出稳定。
  // [权衡] 若断言规模增长，应改为 Set + 数组双写，但不能改变输出顺序。
  if (!assertions.includes(label)) assertions.push(label);
}

// [契约] finalized steps 必须逐步 await 上报，不能聚合后一次性发送：
// 旧 reporter 的字段来自单步事件，聚合会改变 messageId 与顺序。
async function reportFinalizedSteps(
  platform: IPlatformService,
  lifecycle: LegacyLifecycle,
  finalized: Array<{ eventExtraDetail: Record<string, string> }>,
): Promise<void> {
  for (const step of finalized) {
    await reportLegacyEvent(
      platform,
      "agent_step",
      "agent_trace",
      step.eventExtraDetail,
      lifecycle.sessionId,
      lifecycle.commandId,
    );
  }
}

// [契约] completion 的 ARMS 明细只在「前台且拿到 completion」时产生。
// TTFT 三态：有首 token 时间则取差值；看到过 token 但无前台时间则 undefined（不报）；
// 完全没看到 token 则 -1（显式标记异常）。三者语义不同，不能合并。
// duration 缺失时直接停止后续上报，避免产生零时长样本。
function reportCompletionArms(
  platform: IPlatformService,
  lifecycle: LegacyLifecycle,
  detail: Record<string, string>,
): void {
  // [契约] ttft 的三元嵌套是有意为之：undefined 表示「不适用」，-1 表示「缺失」，
  // 不能用 0 代替，否则 ARMS 会把缺失样本算成极快。
  const ttft =
    lifecycle.foregroundFirstTokenAt === null
      ? lifecycle.legacyFirstTokenObserved
        ? undefined
        : -1
      : lifecycle.foregroundFirstTokenAt - lifecycle.sendTime;
  if (ttft !== undefined) {
    reportUiFirstToken({
      ttftMs: ttft,
      model: detail.model_name || undefined,
      talkId: lifecycle.sessionId,
      messageId: lifecycle.commandId,
    });
    reportPlanUsageTtftToArms(platform, {
      providerId: detail.model_provider,
      modelName: detail.model_name,
      askMode: detail.ask_mode,
      ttftMs: ttft,
    });
  }
  const duration = finite(detail.duration_ms);
  if (duration === undefined) return;
  reportUiMessageComplete({
    durationMs: duration,
    result: detail.status ?? "",
    model: detail.model_name || undefined,
    talkId: lifecycle.sessionId,
    messageId: lifecycle.commandId,
  });
  reportUiTurnBreakdown({
    durationMs: duration,
    result: detail.status ?? "",
    model: detail.model_name || undefined,
    talkId: lifecycle.sessionId,
    messageId: lifecycle.commandId,
    ttftMs: ttft,
    waitingMs: finite(detail.waiting_ms),
    toolCallTotal: finite(detail.tool_call_total),
    toolCallFailed: finite(detail.tool_call_failed),
    agentStepCount: finite(detail.agent_step_cnt),
    retryCount: finite(detail.retry_cnt),
    fileChangeCount: finite(detail.file_change_cnt),
    generatedCodeLines: finite(detail.generated_code_lines),
  });
}

// [契约] 所有旧链路事件都从这里出口，统一走 reportAppTelemetryEvent 并带固定 source；
// 不得绕过此函数直接调用平台上报，否则 source 与字段补齐会不一致。
async function reportLegacyEvent(
  platform: IPlatformService,
  elementName: string,
  eventType: string,
  detail: Record<string, string>,
  talkId: string,
  messageId: string,
  eventRegion = "app",
): Promise<void> {
  await reportAppTelemetryEvent(
    platform,
    {
      elementName,
      eventRegion,
      eventType,
      eventExtraDetail: detail,
      talkId,
      messageId,
    },
    "conversation-telemetry-legacy-parity-e2e",
  );
}

// [契约] model.status 需要转换成 network debug 事件才能喂给旧 builder；
// queryId 由 requestId 派生，baseURL 只在有 hostname 时合成，保持字段可缺省。
function toNetworkEvent(
  operation: Extract<ConversationTelemetryParityOperation, { kind: "model.status" }>,
): Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }> {
  return {
    type: "task_network_debug_status",
    taskId: operation.sessionId,
    traceId: operation.eventId,
    eventKey: operation.eventId,
    inputId: operation.commandId,
    queryId: `${operation.requestId}-query`,
    requestId: operation.requestId,
    statusType: operation.status,
    providerId: operation.providerId,
    modelId: operation.modelId,
    baseURL: operation.providerHostname ? `https://${operation.providerHostname}` : undefined,
    transport: "fetch",
    querySource: "main_turn",
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
  } as Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }>;
}

// [契约] active 是事件可被承接的唯一开关；已 seed 但 turn 未开始的生命周期
// 必须被所有分支忽略，否则会出现「有 send 无 turn」的残影。
function activeLifecycle(scope: LegacyScope, commandId: string): LegacyLifecycle | undefined {
  // [契约] activeLifecycle 只做查找与 active 过滤，不负责创建或复活；
  // 缺失时返回 undefined，调用方必须早退而不是补建。
  // [失败路径] 若在此处补建，事件会绕过 seed 产生没有 send_btn 的报表。
  const lifecycle = scope.lifecycles.get(commandId);
  return lifecycle?.active ? lifecycle : undefined;
}

function scopeKey(caseId: string, scope: LegacyScope): string {
  return `telemetry-parity\u0000${caseId}\u0000${scope.name}`;
}

function taskKeyFor(caseId: string, scope: LegacyScope, sessionId: string): string {
  return `${scopeKey(caseId, scope)}\u0000${sessionId}`;
}

// [并发] 前台判定只读计数、不改状态；计数归零时键被删除，因此缺省 0 即后台。
function isForeground(scope: LegacyScope, sessionId: string): boolean {
  return (scope.foregroundCounts.get(sessionId) ?? 0) > 0;
}

// [资源] 计数减到 0 必须删除键，避免 Map 无界增长；
// 缺省按 1 起算是兼容「映射存在但计数缺失」的异常输入。
function decrementForeground(scope: LegacyScope, sessionId: string): void {
  const next = (scope.foregroundCounts.get(sessionId) ?? 1) - 1;
  if (next > 0) scope.foregroundCounts.set(sessionId, next);
  else scope.foregroundCounts.delete(sessionId);
}

// [契约] remember 是全局去重的唯一实现：已存在返回 false 且不重复写入，
// 调用方必须据此早退，否则去重形同虚设。
function remember(set: Set<string>, key: string): boolean {
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

// [事务] 用量累加必须逐字段相加，缺失字段按 0 处理；
// 不能整体替换，否则后到的增量会覆盖先前累计。
function mergeUsage(left: ZCodeUsage | undefined, right: ZCodeUsage): ZCodeUsage {
  if (!left) return right;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cachedWriteInputTokens:
      (left.cachedWriteInputTokens ?? 0) + (right.cachedWriteInputTokens ?? 0),
  };
}

// [失败路径] 非有限数字（NaN/Infinity/空串）统一返回 undefined，
// 让上层用「字段缺省」表达无效，而不是把 NaN 写进报表。
function finite(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
