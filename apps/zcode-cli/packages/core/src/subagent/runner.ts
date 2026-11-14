/* eslint-disable max-lines -- subagent runner 集中维护前台/后台生命周期、registry 与 notification 顺序，拆分前需要先稳定生命周期边界。 */
// ============================================================
// Subagent Runner
// ============================================================
//
// INV 不变量表（本文件维持/依赖；改这里之前先确认它们是否仍成立）
//
// INV-01：registry 里的 running 记录必须先出现、再写 metadata；写盘失败必须立刻 remove。
//         反过来（先写盘、后注册，或失败不回滚）会让父 runtime 看到一个永远不结束的
//         后台任务，turn 持续 defer，最终整条会话卡在“等待子代理”。
//         （守住它的位置：port.run / port.start 的 register → writeAgentMetadataFile → catch）
// INV-02：同一个 agentId 在 abortControllers 里至多一个 controller，且 dispose 只能删除
//         “仍指向自己”的那条。若无条件 delete，旧任务 dispose 会摘掉新任务的取消能力。
//         （守住它的位置：createSubagentTaskAbortController 的 dispose）
// INV-03：父 signal 只单向聚合进 task signal；detachParent 之后父级取消不得再影响已转后台
//         的 child。若忘记 detach，父 turn 结束会把仍在跑的后台 agent 一起 abort。
//         （守住它的位置：onParentAbort / detachParent / winner.kind === "backgrounded"）
// INV-04：借用了父 loop 生命周期的任务（modelOverride.background === "deny"）不得转后台，
//         其 agentId 记入 borrowedForegroundAgentIds，backgroundTask 必须直接返回现状。
//         （守住它的位置：hasForegroundModelOverride / borrowedForegroundAgentIds / backgroundTask）
// INV-05：readyGate 只会 settle 一次；SubagentSpawned 事件必须在 child session 持久化
//         之后才发。反序会让父会话先看到子代理、后看到子会话，projection 出现悬挂行。
//         （守住它的位置：createSubagentSessionReadyGate / onSessionReady）
// INV-06：completion、background request、auto-background timer 三路 Promise.race 只能有一个
//         winner；未被选中的 timer 必须 cancel，否则后台切换后仍会再触发一次 requestBackground。
//         （守住它的位置：port.run 的 Promise.race 与 finally）
// INV-07：转后台不是“放手不管”：原 completionPromise 仍要挂 then/catch 做 finalize，
//         并且通知只能 enqueue 一次（registry 的 notified 位）。重复通知会让父队列出现
//         同一 workId 的两条完成消息，模型会重复汇报。
//         （守住它的位置：finalizeBackgroundCompletion / enqueueBackgroundNotification）
// INV-08：终态任务不可二次 finalize。stop 与自然完成可能并发抵达，先到者写终态，
//         后到者在 isTerminalRuntimeTask 处早退；否则 completed 会被 failed/killed 覆盖。
//         （守住它的位置：finalizeBackgroundCompletion / finalizeBackgroundFailure / createBackgroundStoppedTask）
// INV-09：主动 stop 必须先推进 registry 为 killed、再 abort controller。反序时 abort 引发的
//         catch 会把任务写回 failed，覆盖用户可见的“已停止”。
//         （守住它的位置：stopTask → finalizeBackgroundStopped 的 onCommitted 回调）
// INV-10：terminal 任务被 SendMessage 唤醒时，新 lifecycle 复用原 childSessionId 与输出目录；
//         resume setup 失败要重新 registerPreviousTask，不能留下半新半旧的 running 记录。
//         （守住它的位置：resumeTerminalAgentInBackground）
// INV-11：SendMessage 面向运行中 agent 时，sink 抛错只是“此刻投递失败”，消息必须回落到
//         queue 并回 success/queued；把异常抛给模型会让它误判消息丢失。
//         （守住它的位置：deliverMessageToRunningAgent）
// INV-12：flush 待投递消息时，任意一条失败都要把“当前及之后”的全部消息重新入队，
//         保证 FIFO 与不丢消息；只丢当前条会让后续消息越过前者。
//         （守住它的位置：flushPendingMessages 的 catch）
// INV-13：活动看门狗只能因一次超时 abort 一次，reportActivity 需重置计时并重排；
//         否则长任务在固定时长后必被杀，表现为“大项目子代理总是莫名其妙失败”。
//         （守住它的位置：createSubagentActivityWatchdog 的 schedule / reportActivity）
// INV-14：外层必须自己监听 abort 来结束等待，不能只依赖 child promise settle。子运行时或
//         模型适配器在取消后可能永不 settle，外层会一直停在 running 直到用户手动 Stop。
//         （守住它的位置：guardSubagentPromiseWithAbort）
// INV-15：trace 必须逐层 createChildTraceContext（父 run → child session），不得复用同一
//         traceId 伪装层级；否则子代理的模型请求在 trace 树上挂到父 turn 上，无法归因。
//         （守住它的位置：createSubagentLifecycle / createSubagentLifecycleFromTask）
// INV-16：产物写入顺序固定为 output.txt/task.output → metadata.json；metadata 记录的是
//         “本次运行已完成的证据”，先写它会在 output 缺失时谎报成功。
//         （守住它的位置：writeCompletedAgentArtifacts / writeFailedAgentArtifacts）
// INV-17：usage 汇总只认 ModelComplete 与 model_request_failed 两类事件，其余事件里的
//         usage 字段可能是增量/重复投递，混入会重复计费。
//         （守住它的位置：aggregateModelUsage）
// INV-18：工具调用数优先取 TurnComplete 的 toolCallCount（运行时 loopState 的权威累计），
//         缺失时才退回数 ToolCallResult/ToolCallError 事件。
//         （守住它的位置：resolveSubagentToolUseCount）
// INV-19：子代理可用工具 = profile.tools（Explore 走 getAllowedTools/内置表）- disallowed，
//         且仅在未显式禁用时补上 Skill；不得让 disallowed 在合并方向被绕过。
//         （守住它的位置：resolveAllowedTools）
// INV-20：转后台时 enqueue 通知必须同步成功才提交 killed 终态；enqueue 缺失或抛错要回滚
//         旧 snapshot 并报错，否则用户既看不到任务也收不到停止通知。
//         （守住它的位置：finalizeBackgroundStopped）
//
// 标记约定：[并发] 取消/共享映射，[事务] 状态推进顺序，[资源] 定时器与文件，
// [失败路径] 异常如何向上传播，[权衡] 看似可简化处的取舍。

import type { GetAgentDefinitions } from "./definitions.js";
import {
  AgentErrorCode,
  CoreErrorType,
  DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  SessionEventType,
  createChildTraceContext,
  createCoreError,
  createSessionEvent,
  createSessionId,
  createTraceId,
  getModelUsageTotalTokens,
  hasModelUsage,
  isCoreError,
  traceContextToLogContext,
  type AgentBackgroundedOutput,
  type BackgroundResultOriginMeta,
  type AgentCompletedOutput,
  type AgentOutput,
  type Logger,
  type ModelUsage,
  type SessionEvent,
  type SessionId,
  type SubagentLaunchOptions,
  type SubagentLaunchRequest,
  type SubagentPort,
  type SubagentRunOptions,
  type SubagentRunRequest,
  type SubagentSendMessageOptions,
  type SubagentSendMessageRequest,
  type SubagentSendMessageResult,
  type SubagentStartOptions,
  type SubagentStartRequest,
  type SubagentStopOptions,
  type SubagentTaskSnapshot,
  type SubagentWaitOptions,
  type TraceContext,
} from "@zcode/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isBuiltInExploreAgentProfile,
  normalizeAgentProfiles,
  type AgentProfile,
} from "./profile.js";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "./explore-tools.js";
import { formatLocalAgentTaskNotification } from "./completion-notification.js";
import { filterSubagentChildToolNames } from "./tool-policy.js";
import {
  ErrorPayloadRole,
  selectExecutionErrorMessage,
  withErrorPayloadRole,
} from "../errors/error-payload.js";
import {
  InMemoryRuntimeTaskRegistry,
  isTerminalRuntimeTask,
  type RuntimeTaskMessageSink,
  type RuntimeTaskPendingMessage,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";

// 子代理执行请求是与具体 AgentRuntime 之间唯一的输入契约；子会话能看到的父上下文
// 全部来自这里显式列出的字段，任何“顺手带上父 runtime 引用”的做法都会让 child 依赖
// 父进程私有状态，后台化后立即失效。
export interface ExploreSubagentRuntimeRequest {
  agentId: string;
  agentType: string;
  // 已解析好的工具白名单，不是“请求的工具”。child 不得再做二次并集，
  // 否则 disallowedTools 的收紧会被白名单放大成放开。
  allowedTools: readonly string[];
  // 用 getter 而不是快照：镜像事件在 child tool 执行期间才读取它，
  // 那时任务可能已经由前台转后台（INV-03/04 的观测点）。
  /** 每次读取都返回 runtime task registry 的当前 foreground/background 状态。 */
  background: boolean;
  // 与 allowedTools 分开传，是为了让 child 在合并 Skill 等隐式工具后仍能过滤掉
  // 用户显式禁用的项，而不是只能做减法。
  disallowedTools?: readonly string[];
  sessionId: SessionId;
  description: string;
  // 轮数上限来自 profile，undefined 表示不额外限制（由 runtime 默认值兜底）；
  // runner 不在这里补默认值，避免与 runtime 的默认值形成双份真相。
  maxTurns?: number;
  /** child session 已持久化且可被 projection/query 读取后、首次模型执行前调用。 */
  onSessionReady?: () => Promise<void>;
  permissionMode?: AgentProfile["permissionMode"];
  prompt: string;
  profile: AgentProfile;
  // 回调而非返回 sink：runtime 在“现在可以接收输入”的时刻注册，runner 不知道
  // 这个时刻，只能被动接收。传函数而不是对象也避免了生命周期归属不清。
  registerMessageSink?: (sink: RuntimeTaskMessageSink) => void;
  // 任何真实活动（模型流、工具事件）都应调用；看门狗靠它区分“忙”与“卡死”。
  reportActivity?: () => void;
  // true 表示复用已存在的 child session（SendMessage 唤醒），runtime 应跳过
  // 新建会话，直接加载历史；false/undefined 则走全新会话。
  resumeFromStore?: boolean;
  systemPrompt?: string;
  workingDirectory: string;
  workspaceRoot: string;
  // child 级 trace：runtime 内的每次模型请求都应挂在它下面，而不是父 turn 的 trace。
  traceContext: TraceContext;
}

// runtime 的返回只保留三样东西：最终文本、本次 traceId、完整事件流。
// usage/工具数等派生数据一律由 runner 从事件流重算（INV-17/18），避免双份口径。
export interface ExploreSubagentRuntimeResult {
  response: string;
  traceId: TraceContext["traceId"];
  events: SessionEvent[];
}

// 投递给父 runtime 的“后台任务完成”命令。字段刻意扁平：父队列可能跨进程/
// 跨重启持久化，嵌套对象一旦改 shape 就会让旧队列反序列化失败。
// originMeta.workId 必须等于 taskId，父端据此把通知合并回同一个任务卡。
export interface ParentTaskNotificationCommand {
  originMeta: BackgroundResultOriginMeta;
  text: string;
  traceContext: TraceContext;
  taskId: string;
}

// 返回类型固定为 undefined（而不是 void/boolean）是刻意的类型级约束：
// 它让 `await enqueue(...)` 与 async 实现都无法通过编译，从源头保证“入队即刻生效”。
export type EnqueueParentTaskNotification = (
  notification: ParentTaskNotificationCommand,
) => undefined;

// Port 的依赖全部由外部注入：registry、输出目录、profile 表、模型选择覆盖、定时参数
// 与 logger。不在模块内 new 单例，是为了让同一进程里的多个 runtime（本地/远端/测试桩）
// 各持一份状态，避免跨会话串 task。
export interface ExploreSubagentPortOptions {
  // 真正的执行入口。runner 只负责生命周期，不解析模型、不直接读 SessionStore。
  runExploreAgent: (
    request: ExploreSubagentRuntimeRequest,
    options?: SubagentRunOptions,
  ) => Promise<ExploreSubagentRuntimeResult>;
  // 事件必须 await：事件存储写入失败要能冒泡到 finalize，不能静默丢事件后
  // 仍然把任务标记为完成（UI 会一直等一条永远不来的 SubagentStopped）。
  emitParentEvent: (event: SessionEvent, traceContext: TraceContext) => Promise<void>;
  // background completion 必须同步写入父 runtime command queue；
  // 返回 undefined 可让 TypeScript 拒绝 async enqueue，避免 fake-notified。
  enqueueParentTaskNotification?: EnqueueParentTaskNotification;
  outputRootDir?: string;
  // 静态 profile 表（启动时快照）；与 getAgentDefinitions 同时存在时，
  // 后者优先——前者只是“没有动态定义源”时的默认值。
  profiles?: readonly AgentProfile[];
  getAgentDefinitions?: GetAgentDefinitions;
  builtInModelSelectionOverrides?: Partial<
    Record<"general-purpose" | "Explore", import("@zcode/shared").ModelSelection>
  >;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  createAgentId?: () => string;
  getAllowedTools?: (profile: AgentProfile) => readonly string[];
  // 空闲超时（不是总时长）。默认取模型流空闲超时，保证长思考不被误杀。
  inactivityTimeoutMs?: number;
  // 前台任务自动转后台的等待时长；不配置则永不自动转，只能由外部
  // backgroundTask 或用户操作触发（INV-06 的第三个 race 分支因此缺席）。
  autoBackgroundMs?: number;
  logger?: Logger;
}

// Port 工厂：一个 port 实例对应一组“同源”子代理。所有跨调用状态（取消句柄、借出标记）
// 都闭包在这里，因此 port 被替换（测试、远端重连）时旧任务不会被新 port 误停。
export function createExploreSubagentPort(options: ExploreSubagentPortOptions): SubagentPort {
  // 允许注入 registry，是为了让父 runtime 与 subagent 共享同一张任务表；
  // 默认值只服务独立使用的场景（测试/单进程工具），生产必须由上层传入。
  const registry = options.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry();
  // 只存“仍在运行”的 controller，且 key 是 agentId（见 INV-02）。dispose 后立刻
  // 删除，长期运行下 map 不会随历史任务增长。
  const abortControllers = new Map<string, AbortController>();
  // 借用父 loop 的任务集合。它是“禁止转后台”的权威来源，必须与 registry 同寿命；
  // 任务终态时在 run 的成功/失败/转后台分支各删一次，避免只增不减。
  const borrowedForegroundAgentIds = new Set<string>();
  // 启动时归一化一次内置 profile（补默认模型/工具），之后 getProfiles 以它兜底。
  // 归一化放构造期而不是每次调用，是为了避免热路径上重复分配与覆盖语义漂移。
  const initialProfiles = normalizeAgentProfiles(options.profiles ?? [], {
    builtInModelSelectionOverrides: options.builtInModelSelectionOverrides,
  });
  // 动态定义源存在时每次现取，让用户新增/删除 agent 立即生效；返回的
  // activeAgents 是“当前可用集合”，禁用中的 agent 不会出现在这里。
  const getProfiles = () => options.getAgentDefinitions?.().activeAgents ?? initialProfiles;
  // 非法值（NaN/负数/过大）在这里收敛成 undefined，后续创建计时器的分支
  // 只需要判 truthy，不需要重复做有效性检查。
  const autoBackgroundMs = normalizeAutoBackgroundMs(options.autoBackgroundMs);

  // 类型上把 start 收窄为非可选：调用此 port 的代码可以放心 await start，
  // 且 port.start 与 port.run 共享同一份闭包状态（registry/abort/borrow）。
  const port: SubagentPort & { start: NonNullable<SubagentPort["start"]> } = {
    // launch 是 Agent 工具的统一入口：按 profile 与请求里的 runInBackground 决定走
    // 前台 run（阻塞到结果）还是后台 start（立即返回 async_launched）。调用方不需要
    // 预先知道 profile 是否声明了 background，避免工具层复制一份策略判断。
    async launch(
      rawRequest: SubagentLaunchRequest,
      launchOptions?: SubagentLaunchOptions,
    ): Promise<AgentOutput> {
      const { profile, request } = resolveAgentProfileForRequest(getProfiles(), rawRequest);
      // 在分支前就剥离 runInBackground：两条路径（run/start）都不应看到这个
      // launch 层字段，提前剥离可避免它们各自再写一遍解构。
      const executionRequest = toSubagentExecutionRequest(request);
      // 后台化有两个来源：本次调用显式要求，或 profile 默认即后台（如定时巡检类 agent）。
      // 二者取或而不是覆盖，保证“显式前台”不会因 profile 默认值被悄悄改回后台。
      const backgroundRequested =
        rawRequest.runInBackground === true || profile.background === true;
      if (backgroundRequested) {
        // 即时任务（idle-time）的模型/鉴权由父 loop 注入，且带生命周期绑定；
        // 这里必须在进入 start 前拒绝，而不是“先启动再停止”——后者会留下
        // 一个已 spawn 的 child session 和一条误导性的失败记录。
        if (launchOptions?.modelOverride?.background === "deny") {
          // 单次执行的模型与动态鉴权不能脱离父 loop 生命周期进入后台。
          throw createCoreError(
            CoreErrorType.ToolExecutionFailed,
            "Idle-time tasks do not support background agents. Run this agent in the foreground.",
            {
              context: {
                code: AgentErrorCode.BACKGROUND_UNAVAILABLE,
                agentType: rawRequest.agentType,
                parentToolCallId: rawRequest.parentToolCallId,
              },
              recoverable: true,
            },
          );
        }
        // 后台路径只透传取消信号与模型覆盖；父 loop 的 local/瞬时状态不进 start，
        // 否则父 turn 结束后后台任务会引用已释放的对象。
        return port.start(executionRequest, {
          signal: launchOptions?.signal,
          ...(launchOptions?.model ? { model: launchOptions.model } : {}),
          ...(launchOptions?.modelOverride ? { modelOverride: launchOptions.modelOverride } : {}),
        });
      }
      // 前台路径把整个 runOptions 原样交给 run：run 会自行拆出 signal/model/
      // modelOverride，前台额外用到的只是这些，多传字段不会被读取。
      return port.run(executionRequest, launchOptions);
    },

    // run 是前台生命周期：注册 → 写启动元数据 → 等 child ready → 等结果 → 写产物 → 发事件。
    // 任何一步抛错都要把 registry 里的 running 记录收尾，不能把“失败的启动”留在任务表里。
    async run(
      rawRequest: SubagentRunRequest,
      runOptions?: SubagentRunOptions,
    ): Promise<AgentOutput> {
      // profile 解析同时把 agentType 收敛成 canonical 名称；后续 toolset、事件与
      // metadata 都以返回的 request 为准，不能用调用方传入的原始字符串。
      const { profile, request } = resolveAgentProfileForRequest(getProfiles(), rawRequest);
      const lifecycle = createSubagentLifecycle(options, request, profile);
      const startedAt = new Date(lifecycle.startedAt);

      // INV-01：先注册后落盘。注册值里的 isBackgrounded=false 是“此刻”的事实，
      // 转后台时由 registry.requestBackground 单独推进，不靠重写 snapshot。
      registry.register(
        createRuntimeTaskSnapshot({
          isBackgrounded: false,
          lifecycle,
          request,
          startedAt,
          status: "running",
        }),
      );
      try {
        // 启动元数据是崩溃后排查“这个 agent 存在过”的唯一证据；进程被 kill 时
        // 只会留下 status=running 的文件，不会留下完成标记。
        await writeAgentMetadataFile(lifecycle, request, "running");
      } catch (error) {
        // 启动元数据写入失败时，child runtime 还没有开始执行；
        // 保留 running task 会让父 runtime 误以为仍有后台任务并持续 defer。
        registry.remove(lifecycle.agentId);
        throw error;
      }

      // 前台任务把父 signal 聚合成自己的 task signal；父取消与主动 stop 走同一个
      // AbortController，因此下游只看一个信号源，不需要判断“是谁取消的”。
      const taskAbort = createSubagentTaskAbortController(
        abortControllers,
        lifecycle.agentId,
        runOptions?.signal,
      );
      // INV-04：background=deny 说明本次模型/鉴权绑定父 loop，转后台会失去凭据来源，
      // 所以既不允许 auto-background，也不允许外部 backgroundTask 提升。
      const hasForegroundModelOverride = runOptions?.modelOverride?.background === "deny";
      if (hasForegroundModelOverride) {
        borrowedForegroundAgentIds.add(lifecycle.agentId);
      }
      // 看门狗盯的是“最后一次 reportActivity 到现在的时长”，而不是总运行时长；
      // 默认值复用模型流空闲超时，保证思考型长任务不会被固定 wall-clock 误杀。
      const activityWatchdog = createSubagentActivityWatchdog({
        abort: taskAbort.abort,
        lifecycle,
        logger: options.logger,
        request,
        signal: taskAbort.signal,
        timeoutMs: options.inactivityTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
      });
      // readyGate 把“child session 已持久化”与“可以开始算成功”解耦：spawned 事件
      // 由 onSessionReady 触发，而 run 本身可能在 ready 之前就失败，二者都需要被等待。
      const readyGate = createSubagentSessionReadyGate();
      // child persistence/resume 可能在 onSessionReady 前永久挂起；watchdog 和
      // abort guard 必须覆盖完整 setup，而不能把 Ready 当成取消能力的安装边界。
      activityWatchdog.start();
      const completionPromise = runAgentToCompletion(
        options,
        request,
        lifecycle,
        registry,
        {
          // 传 taskAbort.signal 而不是 runOptions.signal：前者已聚合父取消 +
          // 主动 stop + 看门狗超时三个来源，runtime 只需监听一个信号。
          signal: taskAbort.signal,
          ...(runOptions?.model ? { model: runOptions.model } : {}),
          ...(runOptions?.modelOverride ? { modelOverride: runOptions.modelOverride } : {}),
        },
        {
          // 只把 reportActivity 交给 runtime：child 的任何活动事件都应上报，
          // 但 runtime 不需要、也不应该拿到完整的看门狗对象（避免它 stop 别人）。
          reportActivity: activityWatchdog.reportActivity,
        },
        {
          onSessionReady: async () => {
            await emitSubagentEvent(
              options,
              SessionEventType.SubagentSpawned,
              request,
              lifecycle.runTraceContext,
              {
                agentId: lifecycle.agentId,
                agentType: request.agentType,
                childSessionId: lifecycle.childSessionId,
                description: request.description,
                prompt: request.prompt,
                parentToolCallId: request.parentToolCallId,
                status: "running",
                allowedTools: [...resolveAllowedTools(profile, options)],
                model: profile.modelSelection
                  ? `${profile.modelSelection.providerId}/${profile.modelSelection.modelId}`
                  : undefined,
              },
            );
            // 事件写完才放行。若 emit 抛错，readyGate 不会被 resolve，外层
            // 的 catch/guard 会把整个 run 判失败，而不是继续跑一个无事件的子代理。
            readyGate.resolve();
          },
        },
      );
      // completion 的失败也要能唤醒 readyGate：否则“还没 ready 就失败”的路径会
      // 一直等到看门狗超时，把一次快速失败拖成一次超时。
      void completionPromise.catch((error: unknown) => readyGate.reject(error));
      try {
        // 等待 ready 时同样受 abort 保护，避免 child 在 setup 阶段被取消后外层挂死。
        await guardSubagentPromiseWithAbort(
          readyGate.promise,
          request,
          lifecycle,
          taskAbort.signal,
        );
      } catch (error) {
        // ready 之前失败：没有任何对外可见的产物，直接回收看门狗、取消句柄与
        // registry 记录，让父 turn 看到的是一个“从未 spawn 成功”的错误。
        activityWatchdog.stop();
        taskAbort.abort(error);
        taskAbort.dispose();
        borrowedForegroundAgentIds.delete(lifecycle.agentId);
        registry.remove(lifecycle.agentId);
        throw error;
      }

      // spawned 日志只记录生命周期事实，不复制 prompt/输出内容，避免把用户数据写进日志。
      options.logger?.info("Explore subagent spawned", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        agentType: request.agentType,
        event: "subagent.spawned",
        module: "core.subagent",
        parentToolCallId: request.parentToolCallId,
        status: "started",
      });
      // INV-14：race 里必须用“可被 abort 结束”的副本，不能直接用 completionPromise；
      // 否则取消/转后台时 race 仍在等一个可能永远不 settle 的 child。
      const guardedCompletionPromise = guardSubagentPromiseWithAbort(
        completionPromise,
        request,
        lifecycle,
        taskAbort.signal,
      );

      // 自动转后台计时器只在“允许后台且配置了时长”时创建；undefined 表示这条路
      // 根本不会参与 race，省掉一个永不 resolve 的 promise 分支。
      let autoBackgroundTimer: AutoBackgroundTimer | undefined;
      try {
        autoBackgroundTimer =
          !hasForegroundModelOverride && autoBackgroundMs !== undefined
            ? createAutoBackgroundTimer(
                registry,
                lifecycle.agentId,
                autoBackgroundMs,
                taskAbort.signal,
              )
            : undefined;
        // 外部 backgroundTask 请求按 agentId 监听；registry 返回 undefined 说明任务
        // 已被移除（终态/清理），此时把结果映射成 ignored 而不是 backgrounded，
        // 避免 race 结束后去 detach 一个已经不存在的父信号。
        const backgroundRequestPromise = !hasForegroundModelOverride
          ? registry
              .waitForBackgroundRequest(lifecycle.agentId, { signal: taskAbort.signal })
              .then((task) => ({
                kind: task ? ("backgrounded" as const) : ("ignored" as const),
              }))
          : undefined;
        // INV-06：三路竞速的语义是“谁先决定这个任务的前台命运谁赢”，而不是
        // 把三者合并成一次等待。completed 携带结果，backgrounded 只切换状态，
        // auto 计时器与 background request 都映射为 backgrounded（由 registry 判定）。
        const winner = await Promise.race([
          guardedCompletionPromise.then((completed) => ({
            completed,
            kind: "completed" as const,
          })),
          ...(backgroundRequestPromise ? [backgroundRequestPromise] : []),
          ...(autoBackgroundTimer ? [autoBackgroundTimer.promise] : []),
        ]);

        // 转后台：先 detach 父 signal，父 turn 随后的取消不再传导到 child；
        // 然后停掉看门狗——后台任务不应因“无人观察活动”被杀。
        if (winner.kind === "backgrounded") {
          taskAbort.detachParent();
          activityWatchdog.stop();
          // INV-07：这里绝对不能 fire-and-forget。转后台只改变“谁在等”，
          // 完成仍要写产物、推进 registry、发 SubagentStopped 并通知父队列；
          // dispose 放进 finally，保证成功/失败两条路都会摘掉取消句柄。
          void completionPromise
            .then((completed) =>
              finalizeBackgroundCompletion(options, request, lifecycle, registry, completed),
            )
            .catch((error) =>
              finalizeBackgroundFailure(options, request, lifecycle, registry, error),
            )
            .finally(taskAbort.dispose);
          return createAgentBackgroundedOutput(request, lifecycle);
        }

        // 走到这里说明 winner 是 ignored（请求被撤销/任务已终态），此时不能把
        // ignored 当成“已完成”，必须继续等真正的 completion，否则会返回空结果。
        const completed =
          winner.kind === "completed" ? winner.completed : await guardedCompletionPromise;
        // INV-06：未获胜的自动计时器必须显式 cancel，它的 promise 之后不应再触发
        // requestBackground，否则同一个 agent 会在完成后又被标成后台。
        autoBackgroundTimer?.cancel();
        activityWatchdog.stop();
        taskAbort.dispose();
        borrowedForegroundAgentIds.delete(lifecycle.agentId);

        // INV-16：先写 output.txt 再写 metadata.json；metadata 是“产物已存在”的
        // 证据，顺序反了会在磁盘配额/权限失败时留下谎报成功的完成记录。
        await writeCompletedAgentArtifacts(lifecycle, request, completed.output);
        // 终态写回前先剥掉 runtimeMessageState：队列/流引用只属于运行期，持久化
        // 快照里保留它们会让后续 resume 复用已失效的 sink。
        registry.update(lifecycle.agentId, (task) => ({
          ...withoutRuntimeMessageState(task),
          status: "completed",
          completedAt: new Date(),
          output: completed.output,
          usage: {
            durationMs: completed.output.totalDurationMs,
            modelUsage: completed.output.usage,
            toolUseCount: completed.output.totalToolUseCount,
            totalTokens: completed.output.totalTokens,
          },
        }));

        // 终态事件在 registry 更新之后发：消费方收到 SubagentStopped 时去查任务表，
        // 必须已经能读到 completed 与 usage，否则 UI 会闪一帧“运行中”。
        await emitSubagentEvent(
          options,
          SessionEventType.SubagentStopped,
          request,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            childSessionId: lifecycle.childSessionId,
            parentToolCallId: request.parentToolCallId,
            status: "completed",
            totalDurationMs: completed.output.totalDurationMs,
            totalToolUseCount: completed.output.totalToolUseCount,
            totalTokens: completed.output.totalTokens,
          },
        );

        // 日志使用 runTraceContext（父 run → 本次 child 的子 context），保证同一次
        // 子代理执行的 spawn/complete 两条日志能按 traceId 串起来。
        options.logger?.info("Explore subagent completed", {
          ...traceContextToLogContext(lifecycle.runTraceContext),
          agentId: lifecycle.agentId,
          durationMs: completed.output.totalDurationMs,
          event: "subagent.completed",
          module: "core.subagent",
          status: "completed",
          totalToolUseCount: completed.output.totalToolUseCount,
          totalTokens: completed.output.totalTokens,
        });

        return completed.output;
      } catch (error) {
        // 失败回收顺序：先停定时器类资源，再释放取消句柄，最后清理 borrow 标记。
        // borrow 标记若残留，该 agentId 之后会被永久禁止转后台（只增不减）。
        activityWatchdog.stop();
        taskAbort.dispose();
        borrowedForegroundAgentIds.delete(lifecycle.agentId);
        // 用 wall-clock 差值而不是 child 自报时长：失败路径上 child 往往没有汇总。
        const totalDurationMs = Date.now() - lifecycle.startedAt;
        const errorMessage = error instanceof Error ? error.message : String(error);
        // 失败产物写失败不能再抛：原始错误才是主因，写盘异常若覆盖它，父模型
        // 只会看到“磁盘错误”，丢失真正的取消/鉴权/超时原因。
        await writeFailedAgentArtifacts(lifecycle, request, errorMessage);
        registry.update(lifecycle.agentId, (task) => ({
          ...withoutRuntimeMessageState(task),
          status: "failed",
          completedAt: new Date(),
          error: errorMessage,
          usage: {
            durationMs: totalDurationMs,
          },
        }));
        await emitSubagentEvent(
          options,
          SessionEventType.SubagentStopped,
          request,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            childSessionId: lifecycle.childSessionId,
            parentToolCallId: request.parentToolCallId,
            status: "failed",
            totalDurationMs,
            error: errorMessage,
          },
        );

        // 已是 CoreError 的原样上抛：再包一层会让错误码（例如 ABORTED）被
        // ToolExecutionFailed 覆盖，父层就无法把“用户取消”与“执行失败”区分开。
        if (isCoreError(error)) {
          throw error;
        }

        // INV-17 的配套约束：只有非 CoreError 才包装，并把真实原因放进 cause，
        // 让 UI/父模型既能拿到可读摘要，也能沿 cause 链取原始 provider 错误。
        throw createCoreError(CoreErrorType.ToolExecutionFailed, "Explore subagent failed", {
          cause: error instanceof Error ? error : undefined,
          // 这层只描述父 Agent toolcall 的生命周期失败；真实 provider/model
          // 错误在 cause 链里，应作为 UI hover 与父模型 tool result 的主摘要。
          context: withErrorPayloadRole(
            {
              code: AgentErrorCode.CHILD_RUNTIME_FAILED,
              agentId: lifecycle.agentId,
              agentType: request.agentType,
              parentToolCallId: request.parentToolCallId,
            },
            ErrorPayloadRole.Wrapper,
          ),
          recoverable: true,
        });
      } finally {
        // 这里是幂等兜底：成功/失败分支已各自停过一次，重复 stop/cancel 必须无副作用，
        // 因为 race 抛错（如 abort）时只会走到 finally。
        activityWatchdog.stop();
        autoBackgroundTimer?.cancel();
      }
    },

    // start 是“纯后台”入口：注册 isBackgrounded=true、立即返回句柄，真正的执行
    // 交给 runBackgroundAgent 的 detached promise。调用方拿到的是可展示的任务信息，
    // 不是结果；结果只能通过 registry/通知/产物文件获得。
    async start(
      rawRequest: SubagentStartRequest,
      startOptions?: SubagentStartOptions,
    ): Promise<AgentBackgroundedOutput> {
      // start 同样做完整 profile 解析：后台任务不能跳过类型校验，否则一个拼错的
      // subagent_type 会得到一个“已启动”但永远不会执行任何工具的句柄。
      const { profile, request } = resolveAgentProfileForRequest(getProfiles(), rawRequest);
      // 后台 lifecycle 的 childSessionId 在这里生成，随后由 runtime 持久化；
      // 返回体里的 childSessionId 与此一致，调用方可以立即用它查询会话。
      const lifecycle = createSubagentLifecycle(options, request, profile);
      const startedAt = new Date(lifecycle.startedAt);
      // 先构造返回体再注册：如果构造抛错（理论上不会），不会留下已注册但无句柄的任务。
      const output = createAgentBackgroundedOutput(request, lifecycle);

      // INV-01：后台任务的 register 与前台同序，唯一区别是 isBackgrounded 直接为 true，
      // 因此不需要再走一次 requestBackground 状态推进。
      registry.register(
        createRuntimeTaskSnapshot({
          isBackgrounded: true,
          lifecycle,
          request,
          startedAt,
          status: "running",
        }),
      );
      try {
        // 后台任务的 running 元数据先于 child 执行写入；它与前台的区别只在
        // isBackgrounded，故磁盘格式保持一致，恢复逻辑无需分支。
        await writeAgentMetadataFile(lifecycle, request, "running");
      } catch (error) {
        // setup 失败时移除 registry 记录，避免 fake running background task。
        registry.remove(lifecycle.agentId);
        throw error;
      }

      // start 不长期持有父 signal，只在创建时检查一次“是否已取消”。父 turn 结束后
      // 后台任务必须继续跑，所以这里刻意不 attach，只做一次性状态同步。
      const taskAbort = createSubagentTaskAbortController(abortControllers, lifecycle.agentId);
      if (startOptions?.signal?.aborted) {
        taskAbort.abort(startOptions.signal.reason);
      }
      // 后台执行是 detached promise：start 只等 readyGate（child session 建立），
      // 之后的失败由 runBackgroundAgent 内部 finalize；这里用 void 明确表示不等待结果。
      const readyGate = createSubagentSessionReadyGate();
      void runBackgroundAgent(
        options,
        request,
        lifecycle,
        registry,
        {
          signal: taskAbort.signal,
          ...(startOptions?.model ? { model: startOptions.model } : {}),
          ...(startOptions?.modelOverride ? { modelOverride: startOptions.modelOverride } : {}),
        },
        {
          // INV-05：后台路径的 SubagentSpawned 带 background:true 与 outputFile，
          // 让父会话在子会话尚未可查询时就知道“产物会写到哪里”。
          // 与前台一样，事件写完才 resolve gate。
          onSessionReady: async () => {
            await emitSubagentEvent(
              options,
              SessionEventType.SubagentSpawned,
              request,
              lifecycle.runTraceContext,
              {
                agentId: lifecycle.agentId,
                agentType: request.agentType,
                background: true,
                childSessionId: lifecycle.childSessionId,
                description: request.description,
                prompt: request.prompt,
                parentToolCallId: request.parentToolCallId,
                status: "running",
                allowedTools: [...resolveAllowedTools(profile, options)],
                outputFile: lifecycle.outputFile,
                model: profile.modelSelection
                  ? `${profile.modelSelection.providerId}/${profile.modelSelection.modelId}`
                  : undefined,
              },
            );
            readyGate.resolve();
          },
          // setup 失败直接 reject gate：start 会 await 到同一个错误并做清理，
          // 不需要 runBackgroundAgent 再 finalize 一个“从未 spawn”的任务。
          onSessionStartFailed: readyGate.reject,
        },
        // dispose 作为 onSettled 回调：无论后台执行成功/失败/抛错，都释放
        // controller 映射；它不会 abort（那是 stop 的职责）。
        taskAbort.dispose,
      );
      try {
        // start 必须等到 child session 真正建立才返回，否则调用方立刻发 SendMessage
        // 会命中“会话不存在”。ready 之后的生命周期完全由 runBackgroundAgent 接管。
        await readyGate.promise;
      } catch (error) {
        // setup 阶段失败：取消已创建的 controller、移除 running 记录，让 start
        // 表现为“没有启动成功”，而不是留下一个永不推进的后台任务。
        taskAbort.abort(error);
        registry.remove(lifecycle.agentId);
        throw error;
      }

      // 只在 ready 后记录 started；setup 失败已在上面的 catch 抛出，不会再走到这里。
      options.logger?.info("Explore subagent background task started", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        agentType: request.agentType,
        event: "subagent.background.started",
        module: "core.subagent",
        parentToolCallId: request.parentToolCallId,
        status: "started",
      });
      return output;
    },

    // 查询不做类型过滤：调用方需要看到“存在但不是 local_agent”的情况，
    // 由 stopTask 等写操作自行判断 type，读接口保持最薄。
    async getTask(taskId: string): Promise<SubagentTaskSnapshot | undefined> {
      return registry.get(taskId);
    },

    // 外部把前台任务提升为后台。这是“请求”而非“直接改状态”：真正的切换由 run 的
    // race 消费 requestBackground 后完成，因此这里返回的 snapshot 可能仍是 running。
    async backgroundTask(taskId: string): Promise<SubagentTaskSnapshot | undefined> {
      // INV-04：借用父 loop 的任务直接返回现状（不报错），调用方看到 isBackgrounded
      // 仍为 false 即可；抛错会打断“批量转后台”这类调用，且无法区分原因。
      if (borrowedForegroundAgentIds.has(taskId)) {
        return registry.get(taskId);
      }
      registry.requestBackground(taskId);
      return registry.get(taskId);
    },

    // 等待终态而不是轮询：registry 内部按 agentId 维护 waiter 集合，任务 finalize 时
    // 一次性唤醒。signal 用于父 turn 取消时退出等待，避免遗留 waiter 泄漏。
    async waitForTask(
      taskId: string,
      waitOptions?: SubagentWaitOptions,
    ): Promise<SubagentTaskSnapshot | undefined> {
      return registry.waitForTerminal(taskId, { signal: waitOptions?.signal });
    },

    // 用户显式 Stop：与后台自然完成共享 finalize 路径，区别只在于终态是 killed 且
    // 需要主动 abort controller。调用方可能在 stop 信号已取消时调用，先检查再动手。
    async stopTask(
      taskId: string,
      stopOptions?: SubagentStopOptions,
    ): Promise<SubagentTaskSnapshot | undefined> {
      // 已取消就直接按取消原因抛出：此时既不该 abort 别人，也不该写 killed，
      // 否则一次“未执行的停止意图”会改变任务终态。
      if (stopOptions?.signal?.aborted) {
        throw stopOptions.signal.reason ?? new Error("Subagent stop aborted");
      }
      const task = registry.get(taskId);
      if (!task || task.type !== "local_agent") return task;
      if (isTerminalRuntimeTask(task)) return task;

      // INV-09：stopped 只是“预写”的新 snapshot，真正提交发生在 finalizeBackgroundStopped
      // 的 onCommitted 回调——先推进 registry 为 killed，再 abort。反序会让 completion
      // 的 catch 抢先把任务写成 failed，用户看到的是“失败”而不是“已停止”。
      const stopped = createBackgroundStoppedTask(registry, task);
      if (!stopped) return undefined;
      return finalizeBackgroundStopped(options, registry, stopped, () => {
        abortControllers
          .get(taskId)
          ?.abort(new Error(`${BACKGROUND_AGENT_STOPPED_STATE.message}: ${taskId}`));
        // delete 放在 abort 之后：abort 同步触发下游 catch，其中可能还会读 controller。
        abortControllers.delete(taskId);
      });
    },

    // SendMessage 的三种结局（运行中投递成功 / 排队 / 唤醒终态任务）全部在
    // sendMessageToLocalAgent 内决策；port 层只做依赖注入，不复制状态判断。
    async sendMessage(
      request: SubagentSendMessageRequest,
      sendOptions?: SubagentSendMessageOptions,
    ): Promise<SubagentSendMessageResult> {
      return sendMessageToLocalAgent(
        options,
        getProfiles,
        registry,
        abortControllers,
        request,
        sendOptions,
      );
    },
  };

  return port;
}

// 生命周期快照：一次子代理执行内所有“不可变”的标识与路径。它不承载状态（状态在
// registry），因此在 finalize/resume 之间可以安全传递，不会出现两份互相矛盾的 status。
interface SubagentLifecycle {
  agentId: string;
  childSessionId: SessionId;
  metadataFile: string;
  outputFile: string;
  taskOutputFile: string;
  profile: AgentProfile;
  startedAt: number;
  runTraceContext: TraceContext;
  childTraceContext: TraceContext;
}

type AgentProfileResolution =
  | { kind: "matched"; profile: AgentProfile }
  | { availableAgentTypes: readonly string[]; kind: "not_found" }
  | {
      availableAgentTypes: readonly string[];
      kind: "ambiguous";
      matches: readonly string[];
    };

// 只暴露 cancel 与 promise：cancel 必须把 promise settle 成 ignored，否则 race
// 会继续挂在一个已经取消的计时器上，直到真正的 completion 才结束。
interface AutoBackgroundTimer {
  cancel(): void;
  promise: Promise<{ kind: "backgrounded" | "ignored" }>;
}

// 取消句柄把“父 signal 联动”“任务自身取消”“从映射中摘除”三件事打包，
// 调用方不需要知道父 signal 是否还存在，也避免每处都写 removeEventListener。
interface SubagentTaskAbortHandle {
  abort(reason?: unknown): void;
  detachParent(): void;
  dispose(): void;
  signal: AbortSignal;
}

// INV-02：agentId → controller 的映射是“当前正在跑的那一个”，不是历史集合。
// 同名 agentId 再次启动（resume）会覆盖旧条目，旧句柄的 dispose 通过身份比较
// 避免误删新条目——这一点在 SendMessage resume 后紧接着 stop 的竞态里尤其重要。
function createSubagentTaskAbortController(
  abortControllers: Map<string, AbortController>,
  agentId: string,
  parentSignal?: AbortSignal,
): SubagentTaskAbortHandle {
  const controller = new AbortController();
  abortControllers.set(agentId, controller);
  // 父 signal 已 abort 时不会触发事件，所以下面必须单独检查一次 aborted，
  // 否则“父已取消但仍调用 launch”会得到一个永远不会结束的子任务。
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason ?? new Error(`Subagent task aborted: ${agentId}`));
  };
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const detachParent = (): void => {
    parentSignal?.removeEventListener("abort", onParentAbort);
  };
  // dispose 不 abort：它表达的是“这个句柄不再被使用”，不是“取消任务”。
  // 身份比较是 INV-02 的核心——resume 场景下新 controller 已就位，旧句柄只该解绑。
  const dispose = (): void => {
    detachParent();
    if (abortControllers.get(agentId) === controller) {
      abortControllers.delete(agentId);
    }
  };

  return {
    abort: (reason?: unknown) => controller.abort(reason),
    detachParent,
    dispose,
    signal: controller.signal,
  };
}

function normalizeAutoBackgroundMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.trunc(value);
}

// 自动转后台计时器：到点只“请求”后台化，是否成功由 registry.requestBackground
// 的返回值决定。因此 timeout 并不意味着一定进了后台（任务可能已终态被拒）。
function createAutoBackgroundTimer(
  registry: RuntimeTaskRegistry,
  agentId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): AutoBackgroundTimer {
  // finished 是唯一闸门：timer 回调、abort、cancel 三处都可能调用 complete，
  // 必须保证 promise 只 resolve 一次且事件监听只移除一次。
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise!: (value: { kind: "backgrounded" | "ignored" }) => void;

  // 统一出口：清 timer、摘监听、settle。任何提前 return 都会留下悬挂的
  // setTimeout 或 abort 监听，前者在热重载/大量子代理时表现为内存增长。
  const complete = (value: { kind: "backgrounded" | "ignored" }): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    resolvePromise(value);
  };
  const onAbort = (): void => {
    complete({ kind: "ignored" });
  };
  const promise = new Promise<{ kind: "backgrounded" | "ignored" }>((resolve) => {
    resolvePromise = resolve;
    // 先把 resolve 存起来再判断 aborted：complete 内部会调用 resolvePromise，
    // 顺序反了会命中 TDZ/undefined，表现为计时器启动即抛错。
    if (signal?.aborted) {
      complete({ kind: "ignored" });
      return;
    }

    // timer 必须在 complete 之前赋值，否则此前的 abort 分支无法 clear 它。
    timer = setTimeout(() => {
      complete({
        kind: registry.requestBackground(agentId) ? "backgrounded" : "ignored",
      });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  return {
    cancel: () => complete({ kind: "ignored" }),
    promise,
  };
}

// 入口统一做“类型名收敛 + 未知类型报错”。放在这里而不是工具层，是为了让
// start/run/launch 三条路径共享同一套错误文案与 canonical 化结果。
function resolveAgentProfileForRequest(
  profiles: readonly AgentProfile[],
  request: SubagentRunRequest,
): { profile: AgentProfile; request: SubagentRunRequest } {
  const resolution = resolveAgentProfileByType(profiles, request.agentType);
  if (resolution.kind === "matched") {
    const { profile } = resolution;
    return {
      profile,
      request:
        profile.name === request.agentType
          ? request
          : {
              ...request,
              // 模型可能按大小写/分隔符近似写 subagent_type；后续
              // toolset、事件和 metadata 都依赖 canonical agentType，必须在入口统一收敛。
              agentType: profile.name,
            },
    };
  }

  // 歧义必须先于“未找到”处理：模糊匹配到多个时，availableAgentTypes 里其实
  // 包含用户想要的类型，若按 not_found 报错会把“写得不精确”误导成“不存在”。
  // 错误里同时给出候选名，父模型可以据此改写 subagent_type 后重试。
  if (resolution.kind === "ambiguous") {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      [
        `Agent type '${request.agentType}' is ambiguous`,
        `matches ${resolution.matches.join(", ")}`,
        `Use the exact name: ${resolution.matches.join(" or ")}`,
      ].join(" — "),
      {
        context: {
          code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
          agentType: request.agentType,
          matches: resolution.matches,
          parentToolCallId: request.parentToolCallId,
        },
        recoverable: true,
      },
    );
  }

  // recoverable=true：这是可纠正的调用错误，父模型读到 availableAgentTypes 后
  // 可以换一个合法类型重试；若标成不可恢复，Agent 工具会被整轮禁用。
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Agent type '${request.agentType}' not found. Available agents: ${resolution.availableAgentTypes.join(", ")}`,
    {
      context: {
        code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
        agentType: request.agentType,
        availableAgentTypes: resolution.availableAgentTypes,
        parentToolCallId: request.parentToolCallId,
      },
      recoverable: true,
    },
  );
}

// 解析优先级：精确名 > 归一化唯一匹配 > 歧义/未找到。精确匹配必须最先做，
// 否则两个仅大小写不同的 profile 会被归一化合并成“歧义”，把合法调用拒掉。
function resolveAgentProfileByType(
  profiles: readonly AgentProfile[],
  requestedAgentType: string,
): AgentProfileResolution {
  const exact = profiles.find((candidate) => candidate.name === requestedAgentType);
  if (exact) return { kind: "matched", profile: exact };

  const availableAgentTypes = profiles.map((profile) => profile.name);

  // 归一化后为空（纯空白/纯标点）直接 not_found：不要让空串去匹配任何 profile，
  // 否则 profiles 里恰好有空名时会把一次无效调用解析成一个真实 agent。
  const requestedNormalized = normalizeAgentTypeForMatch(requestedAgentType);
  if (!requestedNormalized) return { availableAgentTypes, kind: "not_found" };

  const normalizedMatches = profiles.filter(
    (candidate) => normalizeAgentTypeForMatch(candidate.name) === requestedNormalized,
  );
  if (normalizedMatches.length === 1) {
    return { kind: "matched", profile: normalizedMatches[0] };
  }
  if (normalizedMatches.length > 1) {
    return {
      availableAgentTypes,
      kind: "ambiguous",
      matches: normalizedMatches.map((profile) => profile.name),
    };
  }

  return { availableAgentTypes, kind: "not_found" };
}

// 归一化只抹掉“人类书写差异”（大小写、空白、连字符/下划线、全半角），
// 不做编辑距离等模糊匹配：那会把 "review" 与 "reviewer" 混为一谈，静默跑错 agent。
function normalizeAgentTypeForMatch(agentType: string): string | undefined {
  const normalized = agentType
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Pd}_]+/gu, "");
  return normalized.length > 0 ? normalized : undefined;
}

// 剥离 launch 层专有的 runInBackground，避免它随请求渗进 child session 的事件与
// metadata；其余字段原样透传，保证新旧字段不需要在这里逐个维护。
function toSubagentExecutionRequest(request: SubagentLaunchRequest): SubagentRunRequest {
  const { runInBackground: _runInBackground, ...executionRequest } = request;
  return executionRequest;
}

// 生命周期在这里一次性定型：id、child session、三个产物路径、两级 trace。
// 后续所有函数只读它，不再重新推导路径——重复 join 在 Windows 上会因分隔符
// 大小写不同而指向两个文件，元数据与产物就会分裂。
function createSubagentLifecycle(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  profile: AgentProfile,
): SubagentLifecycle {
  const agentId = options.createAgentId?.() ?? `agent_${crypto.randomUUID()}`;
  const childSessionId = createSessionId(`subagent_${agentId}`);
  const startedAt = Date.now();
  const agentOutputDir = join(
    options.outputRootDir ?? join(tmpdir(), "zcode-agents"),
    request.sessionId,
    agentId,
  );
  const metadataFile = join(agentOutputDir, "metadata.json");
  const outputFile = join(agentOutputDir, "output.txt");
  const taskOutputFile = join(agentOutputDir, "task.output");
  // INV-15：run 级 trace 描述“父 Agent 工具调用 → 本次子代理执行”，
  // child 级 trace 再往下挂到子会话；两级都带 parentToolCallId 以便 UI 归并。
  const runTraceContext = createChildTraceContext(request.trace, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentToolCallId: request.parentToolCallId,
    },
  });
  const childTraceContext = createChildTraceContext(runTraceContext, {
    sessionId: childSessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentSessionId: request.sessionId,
      parentToolCallId: request.parentToolCallId,
    },
  });

  return {
    agentId,
    childSessionId,
    metadataFile,
    outputFile,
    taskOutputFile,
    profile,
    startedAt,
    runTraceContext,
    childTraceContext,
  };
}

// resume 用的 lifecycle 构造：尽量复用原任务已有的 childSessionId 与输出目录，
// 使 SendMessage 唤醒后的第二轮运行继续写同一份会话/产物，而不是另起一个 agent_xxx。
function createSubagentLifecycleFromTask(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  profile: AgentProfile,
  task: RuntimeTaskSnapshot,
): SubagentLifecycle | undefined {
  // 没有 childSessionId 说明旧任务从未真正建立子会话（例如 setup 早期失败），
  // 无法 resume；返回 undefined 让调用方回落到“排队等待”的语义。
  if (!task.childSessionId) return undefined;
  const agentId = task.agentId;
  const childSessionId = task.childSessionId;
  const startedAt = Date.now();
  // 旧任务若有 outputFile 就以它的目录为准；否则按新请求重新推导。
  // 不能无条件重算，否则 outputRootDir 变更后 resume 会写到另一个目录，
  // 旧的 metadata/output 与新一轮产物各占一份，前端根据 taskId 只能看到其一。
  const agentOutputDir = task.outputFile
    ? dirname(task.outputFile)
    : join(options.outputRootDir ?? join(tmpdir(), "zcode-agents"), request.sessionId, agentId);
  const metadataFile = join(agentOutputDir, "metadata.json");
  const outputFile = join(agentOutputDir, "output.txt");
  const taskOutputFile = join(agentOutputDir, "task.output");
  const runTraceContext = createChildTraceContext(request.trace, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentToolCallId: request.parentToolCallId,
      resumed: true,
    },
  });
  // resumed: true 只加在 trace 属性上、不加到事件里：trace 需要区分“首跑/续跑”，
  // 而已有事件的 shape 被消费方依赖，不能因为 internal 标记而改协议。
  const childTraceContext = createChildTraceContext(runTraceContext, {
    sessionId: childSessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentSessionId: request.sessionId,
      parentToolCallId: request.parentToolCallId,
      resumed: true,
    },
  });

  return {
    agentId,
    childSessionId,
    metadataFile,
    outputFile,
    taskOutputFile,
    profile,
    startedAt,
    runTraceContext,
    childTraceContext,
  };
}

// SendMessage 的状态机入口。顺序固定：取消检查 → 目标存在性 → 运行中投递 → 终态唤醒。
// 顺序不能反：若先判断终态再检查取消，一个已取消的调用仍可能把任务 resume 起来。
async function sendMessageToLocalAgent(
  options: ExploreSubagentPortOptions,
  getProfiles: () => readonly AgentProfile[],
  registry: RuntimeTaskRegistry,
  abortControllers: Map<string, AbortController>,
  request: SubagentSendMessageRequest,
  sendOptions?: SubagentSendMessageOptions,
): Promise<SubagentSendMessageResult> {
  // 取消不是异常而是“未投递”的结果：返回 failure 让模型知道消息没进去，
  // 可以决定重试；抛错则会打断整轮工具调用。
  if (sendOptions?.signal?.aborted) {
    return createSendMessageFailure(request, `SendMessage was aborted for ${request.to}.`);
  }

  const task = registry.get(request.to);
  if (!task || task.type !== "local_agent") {
    return createSendMessageFailure(
      request,
      `No active local_agent task found for target ${request.to}.`,
    );
  }

  // 消息先构造成 pending message：它带 id/时间戳，运行中投递与 resume 后补投
  // 共用同一个对象，保证父队列与子会话看到的是同一条消息（可去重）。
  const message = createRuntimeTaskPendingMessage(request);
  // 运行中优先直投（低延迟）；投递失败由 deliver 内部降级为 queue。
  // 只有终态任务才走 resume，避免“每条消息都重启一次子代理”。
  if (!isTerminalRuntimeTask(task)) {
    return deliverMessageToRunningAgent(registry, task, message);
  }

  // 传 getProfiles() 的实时结果而不是闭包里的旧数组：profile 可能被用户设置
  // 动态修改，resume 时应使用最新的工具集/模型，而不是启动时的快照。
  return resumeTerminalAgentInBackground(
    options,
    getProfiles(),
    registry,
    abortControllers,
    task,
    request,
    message,
    sendOptions,
  );
}

// 运行中投递：成功走 sink，失败或没有 sink 一律回落到 registry 队列。
// 这里刻意不重试——重试会在模型侧产生重复输入；队列会由下一轮 flush 统一投递。
async function deliverMessageToRunningAgent(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  message: RuntimeTaskPendingMessage,
): Promise<SubagentSendMessageResult> {
  // messageSink 只在子会话可接收流式输入时存在；不存在不代表任务死了，
  // 只代表当前阶段（如工具执行中）不能插话，排到下一轮即可。
  if (task.messageSink) {
    try {
      const delivery = await task.messageSink.send(message);
      return createSendMessageSuccess(task, message, delivery);
    } catch {
      // INV-11：sink 抛错说明“这一轮投不进去”（子会话可能刚结束/正在切轮），
      // 但消息本身有效。吞掉异常转 queued，模型看到 success+queued 才不会重发。
      registry.queueMessage(task.taskId, message);
      return createSendMessageSuccess(task, message, "queued");
    }
  }

  registry.queueMessage(task.taskId, message);
  return createSendMessageSuccess(task, message, "queued");
}

// 唤醒终态任务：复用原 agentId/childSessionId 起一轮新的后台执行，并把这条
// SendMessage 作为新 turn 的 prompt。它是“续跑”，不是“新建 agent”。
async function resumeTerminalAgentInBackground(
  options: ExploreSubagentPortOptions,
  profiles: readonly AgentProfile[],
  registry: RuntimeTaskRegistry,
  abortControllers: Map<string, AbortController>,
  task: RuntimeTaskSnapshot,
  request: SubagentSendMessageRequest,
  message: RuntimeTaskPendingMessage,
  sendOptions?: SubagentSendMessageOptions,
): Promise<SubagentSendMessageResult> {
  // 用任务上记录的 agentType 反查 profile，而不是从 request 里拿：唤醒时调用方
  // 只指定目标 agentId，类型必须以任务自身为准，防止用错工具集/权限续跑。
  const profile = profiles.find((candidate) => candidate.name === task.agentType);
  if (!profile) {
    return createSendMessageFailure(
      request,
      `Cannot resume local agent ${task.agentId}: profile ${task.agentType} is unavailable.`,
    );
  }

  // INV-10：resumeRequest 携带父会话的 sessionId/turnId/trace（不是旧任务的），
  // 这样新一轮执行挂在“当前父 turn”下，通知与事件才能回到正在等待的父队列。
  const resumeRequest: SubagentRunRequest = {
    sessionId: request.sessionId,
    turnId: request.turnId,
    parentToolCallId: request.parentToolCallId,
    agentType: task.agentType,
    description: request.summary || task.description,
    prompt: request.message,
    workingDirectory: request.workingDirectory,
    workspaceRoot: request.workspaceRoot,
    trace: request.trace,
  };
  // 构造失败（缺 childSessionId）时返回失败而不是抛错：这是可向模型解释的
  // 业务结果（“这个任务无法续跑”），不是 runner 自身的异常。
  const lifecycle = createSubagentLifecycleFromTask(options, resumeRequest, profile, task);
  if (!lifecycle) {
    return createSendMessageFailure(
      request,
      `Cannot resume local agent ${task.agentId}: missing child session id.`,
    );
  }
  const startedAt = new Date(lifecycle.startedAt);
  // 保存旧 snapshot 是为了任何一步失败都能原样回滚；不能“补一个 failed”，
  // 那会把用户已经看到的 completed/killed 历史结果覆盖掉。
  const previousTask = task;
  registry.register(
    createRuntimeTaskSnapshot({
      isBackgrounded: true,
      lifecycle,
      request: resumeRequest,
      startedAt,
      status: "running",
    }),
  );
  try {
    // 元数据记录 resumedFromMessageId，便于从磁盘反查“是哪条消息唤醒了这次运行”。
    await writeAgentMetadataFile(lifecycle, resumeRequest, "running", {
      resumedAt: new Date().toISOString(),
      resumedFromMessageId: message.id,
    });
  } catch (error) {
    // SendMessage resume setup 失败不能覆盖原 terminal task；
    // 还原旧 snapshot，避免一个未启动的新 turn 卡成 running。
    registry.register(previousTask);
    throw error;
  }

  // resume 也走完整的后台执行链路（含 spawned 事件与 readyGate），因此前端看到的
  // 与首次后台启动一致，只是事件里多一个 resumed: true。
  const taskAbort = createSubagentTaskAbortController(abortControllers, lifecycle.agentId);
  const readyGate = createSubagentSessionReadyGate();
  // detached 执行：resume 的成功/失败都通过 runBackgroundAgent 内部 finalize
  // 落到 registry 与父通知，本函数只等 readyGate 证明“子会话真的活了”。
  void runBackgroundAgent(
    options,
    resumeRequest,
    lifecycle,
    registry,
    {
      signal: taskAbort.signal,
      model: sendOptions?.model,
      modelOverride: sendOptions?.modelOverride,
    },
    {
      resumeFromStore: true,
      onSessionReady: async () => {
        await emitSubagentEvent(
          options,
          SessionEventType.SubagentSpawned,
          resumeRequest,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: resumeRequest.agentType,
            background: true,
            childSessionId: lifecycle.childSessionId,
            description: resumeRequest.description,
            outputFile: lifecycle.outputFile,
            parentToolCallId: resumeRequest.parentToolCallId,
            prompt: resumeRequest.prompt,
            resumed: true,
            status: "running",
          },
        );
        readyGate.resolve();
      },
      onSessionStartFailed: readyGate.reject,
    },
    taskAbort.dispose,
  );
  try {
    await readyGate.promise;
  } catch (error) {
    // INV-10：ready 失败同样要回滚旧 snapshot，否则任务表里留下一个 running 的
    // 新 turn，而实际上根本没有子会话在跑，waitForTerminal 会永久挂起。
    taskAbort.abort(error);
    registry.register(previousTask);
    throw error;
  }
  // terminal 状态属于旧 snapshot，但 resume 输出路径属于新 lifecycle；
  // 旧 snapshot 的可选 outputFile 不能用于本次 provider-visible 结果。
  return createSendMessageSuccess(
    { ...task, outputFile: lifecycle.outputFile },
    message,
    "resumed_background",
  );
}

// pending message 的 id 在这里生成一次，运行中直投与队列补投共用，父/子两侧
// 都以它去重；isMeta 标记它来自协调者而非用户输入，UI 不应显示成用户消息。
function createRuntimeTaskPendingMessage(
  request: SubagentSendMessageRequest,
): RuntimeTaskPendingMessage {
  return {
    id: `msg_${crypto.randomUUID()}`,
    isMeta: true,
    message: request.message,
    origin: {
      kind: "coordinator",
      toolCallId: String(request.parentToolCallId),
    },
    queuedAt: new Date(),
    summary: request.summary,
    traceContext: request.trace,
  };
}

function createSendMessageSuccess(
  task: Pick<RuntimeTaskSnapshot, "agentId" | "outputFile" | "status" | "taskId">,
  message: RuntimeTaskPendingMessage,
  delivery: NonNullable<SubagentSendMessageResult["delivery"]>,
): SubagentSendMessageResult {
  // providerMessage 会被父模型直接读到，因此三种 delivery 必须给出可区分的
  // 后续指引（等待下一轮 / 已后台续跑 / 已进入活跃 turn），否则模型会重复发送。
  const providerMessage =
    delivery === "queued"
      ? `Message queued for delivery to ${task.agentId} at its next tool round.`
      : delivery === "resumed_background"
        ? `Agent "${task.agentId}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${task.outputFile}`
        : `Message ${message.id} was sent to its active turn for local agent ${task.agentId}.`;
  return {
    status: "success",
    messageId: message.id,
    delivery,
    agentId: task.agentId,
    taskId: task.taskId,
    outputFile: task.outputFile,
    message: providerMessage,
  };
}

// 失败也生成 messageId：父模型可能据此做幂等重试，空 id 会让重试无法关联原消息。
function createSendMessageFailure(
  request: SubagentSendMessageRequest,
  error: string,
): SubagentSendMessageResult {
  return {
    status: "failed",
    messageId: `msg_${crypto.randomUUID()}`,
    agentId: request.to,
    error,
    message: error,
  };
}

async function runAgentToCompletion(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  runOptions?: SubagentRunOptions,
  monitorOptions: { reportActivity?: () => void } = {},
  executionOptions: SubagentExecutionOptions = {},
): Promise<{ events: SessionEvent[]; output: AgentCompletedOutput }> {
  // sessionReady 是本地幂等位：真实 runtime 与下面的兼容回落可能都调用一次，
  // 必须保证 onSessionReady（进而 SubagentSpawned 事件）只发一次。
  let sessionReady = false;
  const notifySessionReady = async () => {
    if (sessionReady) return;
    await executionOptions.onSessionReady?.();
    sessionReady = true;
  };
  // INV-05：allowedTools 在调用前解析一次并固化；运行中即使用户改设置，本次
  // 子代理仍按启动时的工具集执行，避免中途权限边界发生变化。
  const childResult = await options.runExploreAgent(
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      allowedTools: resolveAllowedTools(lifecycle.profile, options),
      // 显式 background Agent 的 child tool 会被镜像到父会话；
      // 过去丢失这个来源会让父 turn 把仍在运行的 child tool 误当前台孤儿收口。这里必须
      // 保留 getter，foreground 后续转后台时，每条 mirror event 才会读取 registry 当前值，
      // 而不是继续携带 child 启动时的 false 快照。
      get background() {
        return registry.get(lifecycle.agentId)?.isBackgrounded === true;
      },
      // allowed 与 disallowed 同时下传，runtime 侧无需知道 runner 的合并规则；
      // 两个列表都来自启动时固化的 profile（INV-19）。
      disallowedTools: lifecycle.profile.disallowedTools,
      sessionId: lifecycle.childSessionId,
      description: request.description,
      // undefined 表示不覆盖 runtime 默认上限；这里不传 0，避免被解释成
      // “不允许任何轮次”而让子代理立刻结束。
      maxTurns: lifecycle.profile.maxTurns,
      onSessionReady: notifySessionReady,
      // 权限模式来自 profile 而不是父会话：子代理不应继承父的 bypass/ask 状态，
      // 否则一个只读 Explore agent 也会获得写权限。
      permissionMode: lifecycle.profile.permissionMode,
      prompt: request.prompt,
      profile: lifecycle.profile,
      // 注册器绑定本次 lifecycle/registry：即使同名 agentId 之后被 resume，
      // 旧 sink 回调写入的仍是旧任务条目（registry 会忽略已终态任务）。
      registerMessageSink: createMessageSinkRegistration(options, lifecycle, registry),
      reportActivity: monitorOptions.reportActivity,
      // 只有 SendMessage 唤醒路径会置 true；它决定 runtime 是“加载历史会话”
      // 还是“新建会话”，传错会把续跑变成一次全新的、无上下文的执行。
      resumeFromStore: executionOptions.resumeFromStore,
      // systemPrompt 已在 profile 归一化阶段合并过内置/用户覆盖，这里直接用，
      // 不再做二次拼接，避免同一段指令在 child 里出现两次。
      systemPrompt: lifecycle.profile.systemPrompt,
      workingDirectory: request.workingDirectory,
      workspaceRoot: request.workspaceRoot,
      // childTraceContext（而不是 runTraceContext）：runtime 产生的模型请求
      // 是 child span 的子节点，层级错了会导致 trace 树上父子关系倒挂。
      traceContext: lifecycle.childTraceContext,
    },
    runOptions,
  );
  // 测试桩和旧注入实现可能尚未主动调用 readiness hook；真实 AgentRuntime 会在
  // persist 后调用。回落只保证兼容，不改变生产链路的 persist-before-spawn 顺序。
  await notifySessionReady();

  // INV-17/18：usage 与工具数都从事件流重算，而不是信 child 自报的汇总字段；
  // 事件流是唯一在成功/失败/取消三条路径上都存在的数据源。
  const usage = aggregateModelUsage(childResult.events);
  const totalTokens = usage?.totalTokens;
  const totalToolUseCount = resolveSubagentToolUseCount(childResult.events);
  const totalDurationMs = Date.now() - lifecycle.startedAt;

  // 用条件展开而不是写 undefined：AgentCompletedOutput 的 totalTokens/usage
  // 是可选字段，显式 undefined 会覆盖掉下游的默认值/序列化行为。
  const output: AgentCompletedOutput = {
    status: "completed",
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    description: request.description,
    prompt: request.prompt,
    content: [
      {
        type: "text",
        text: childResult.response,
      },
    ],
    totalToolUseCount,
    totalDurationMs,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(usage === undefined ? {} : { usage }),
  };

  return { events: childResult.events, output };
}

// 活动看门狗：单次定时器模型。每次 reportActivity 都重排，因此它衡量的是
// “距离上次真实活动”的空闲时长；stop 之后不会再有回调，abort 只在超时时发生一次。
function createSubagentActivityWatchdog(options: {
  abort: (reason?: unknown) => void;
  lifecycle: SubagentLifecycle;
  logger?: Logger;
  request: SubagentRunRequest;
  signal: AbortSignal;
  timeoutMs: number;
}): {
  reportActivity: () => void;
  start: () => void;
  stop: () => void;
} {
  // 非法/非正超时退化为“永不超时”的空实现，而不是抛错：这是可选的保护机制，
  // 不应该因为配置成 0 就让所有子代理启动失败。
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return {
      reportActivity: () => {},
      start: () => {},
      stop: () => {},
    };
  }

  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  // 先 stop 再排：保证同一时刻最多一个 timer。signal 已取消则不再新排，
  // 否则取消后仍会在 timeoutMs 处 abort 一次，产生一条“取消后的超时”噪音事件。
  const schedule = () => {
    stop();
    if (options.signal.aborted) return;
    timer = setTimeout(() => {
      // 用实际 idleMs 而不是配置的 timeoutMs 上报：事件循环被阻塞时定时器会晚触发，
      // 两者可能相差很大，日志里的真实值才能解释“为什么现在才报超时”。
      const idleMs = Date.now() - lastActivityAt;
      const error = createCoreError(
        CoreErrorType.ToolTimeout,
        `Subagent was inactive for ${options.timeoutMs}ms`,
        {
          context: {
            code: AgentErrorCode.CHILD_RUNTIME_FAILED,
            agentId: options.lifecycle.agentId,
            agentType: options.request.agentType,
            idleMs,
            parentToolCallId: options.request.parentToolCallId,
            timeoutMs: options.timeoutMs,
          },
          recoverable: true,
          retryable: true,
        },
      );
      options.logger?.warn("Explore subagent activity watchdog fired", {
        ...traceContextToLogContext(options.lifecycle.runTraceContext),
        agentId: options.lifecycle.agentId,
        agentType: options.request.agentType,
        event: "subagent.activity_timeout",
        idleMs,
        module: "core.subagent",
        parentToolCallId: options.request.parentToolCallId,
        status: "failed",
        timeoutMs: options.timeoutMs,
      });
      // abort 使用 ToolTimeout 作为 reason；下游 guard 会把 CoreError 原样上抛，
      // 因此父模型看到的是“子代理空闲超时”，而不是泛化的 ToolExecutionFailed。
      options.abort(error);
    }, options.timeoutMs);
  };

  // 任何 child 活动都算“活着”：重置时间戳并重排 timer，因此长任务的每个
  // 模型流/tool 事件都会把超时点往后推。
  const reportActivity = () => {
    lastActivityAt = Date.now();
    schedule();
  };

  return {
    reportActivity,
    start: reportActivity,
    stop,
  };
}

// INV-14：给任意 child promise 套一层“取消可赢”的竞速。没有 signal 时直接返回
// 原 promise（零开销），有 signal 时无论 child 是否 settle，外层都能被 abort 唤醒。
function guardSubagentPromiseWithAbort<T>(
  promise: Promise<T>,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;

  // 子运行时或模型适配器在 abort 后可能永不 settle；外层 Agent 必须自己监听
  // 父 signal，否则 `Agent` 工具会一直停在 running，直到用户手动 Stop。
  return new Promise<T>((resolve, reject) => {
    // settled 同时防两件事：promise 与 abort 的竞态双 resolve，以及
    // listener 被重复移除。缺了它会出现 “resolve after reject” 的静默丢弃。
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abortHandler);
      callback();
    };

    // 若 reason 已是 CoreError（看门狗超时 / 显式 stop），直接上抛以保留
    // 错误码与 context；否则统一包装成 ToolCancelled，并保留原始 reason 作 cause。
    const abortHandler = () => {
      if (isCoreError(signal.reason)) {
        settle(() => reject(signal.reason));
        return;
      }
      settle(() =>
        reject(
          createCoreError(
            CoreErrorType.ToolCancelled,
            "Agent was cancelled before the subagent returned findings or background launch completed",
            {
              cause: signal.reason instanceof Error ? signal.reason : undefined,
              context: {
                code: AgentErrorCode.CHILD_RUNTIME_FAILED,
                agentId: lifecycle.agentId,
                agentType: request.agentType,
                parentToolCallId: request.parentToolCallId,
              },
              recoverable: true,
            },
          ),
        ),
      );
    };

    promise.then(
      (completed) => settle(() => resolve(completed)),
      (error: unknown) => settle(() => reject(error)),
    );

    // 先挂 then 再检查 aborted：反序时若 abort 恰好发生在 addEventListener 之前，
    // 事件已经错过，promise 会永久悬挂。这里补一次同步检查作为兜底。
    if (signal.aborted) {
      abortHandler();
      return;
    }
    // once: true 让正常 settle 之外的路径也能自动摘除监听，避免长任务累积 listener。
    signal.addEventListener("abort", abortHandler, { once: true });
  });
}

// 后台执行的唯一收口：启动前再查一次终态（可能已被 stop），执行成功后 finalize。
// onSettled 只负责释放句柄，不参与状态推进，避免资源清理与状态机耦合。
async function runBackgroundAgent(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  runOptions?: SubagentRunOptions,
  executionOptions: SubagentExecutionOptions = {},
  onSettled?: () => void,
): Promise<void> {
  let sessionReady = false;
  try {
    // 竞态兜底：start 已 register 之后、这里真正开跑之前，用户可能已经 Stop。
    // 此时直接返回，不能把 killed 任务重新跑起来。status:"lost" 代表任务已被移除。
    if (isTerminalRuntimeTask(registry.get(lifecycle.agentId) ?? { status: "lost" })) {
      return;
    }
    // monitorOptions 传空对象：后台任务没有前台观察者，活动上报由 child 自己
    // 通过 reportActivity 驱动；看门狗已在 start/run 的转后台分支停掉。
    const completed = await runAgentToCompletion(
      options,
      request,
      lifecycle,
      registry,
      runOptions,
      {},
      {
        ...executionOptions,
        onSessionReady: async () => {
          await executionOptions.onSessionReady?.();
          sessionReady = true;
        },
      },
    );
    await finalizeBackgroundCompletion(options, request, lifecycle, registry, completed);
  } catch (error) {
    // ready 之前失败没有“可见任务”可收尾：交给 onSessionStartFailed（start 的
    // readyGate.reject）处理，绝不能再 finalize 一次，否则会把 setup 失败写成
    // 一个用户可查询的 failed 后台任务。
    if (!sessionReady) {
      executionOptions.onSessionStartFailed?.(error);
      return;
    }
    // ready 之后失败必须走 finalize：产物、registry、通知、事件四件事一个都不能少。
    await finalizeBackgroundFailure(options, request, lifecycle, registry, error);
  } finally {
    onSettled?.();
  }
}

// 执行期回调只服务“ready / setup 失败”两个边界；把两者分开是因为它们的收尾
// 语义完全不同：ready 后失败要 finalize，ready 前失败只唤醒 gate 即可。
interface SubagentExecutionOptions {
  resumeFromStore?: boolean;
  onSessionReady?: () => Promise<void>;
  onSessionStartFailed?: (error: unknown) => void;
}

// INV-05：显式 gate 而不是直接复用 child promise。原因是 gate 的 resolve/reject
// 由“会话已持久化”驱动，而 child 的完成由“模型跑完”驱动，二者时序没有任何保证。
function createSubagentSessionReadyGate(): {
  promise: Promise<void>;
  reject(error: unknown): void;
  resolve(): void;
} {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // settled 把 resolve/reject 合并成一次性闸门：晚到的 onSessionStartFailed
  // 不能把已经 resolve 的 gate 再 reject（Promise 会忽略，但会产生 unhandled 噪音）。
  let settled = false;
  return {
    promise,
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}

// 子会话在“可接收输入”时注册 sink。注册动作必须同步写进 registry，
// 这样并发的 SendMessage 立刻能看到 messageSink 并直投，而不是排进队列再等下一轮。
function createMessageSinkRegistration(
  options: ExploreSubagentPortOptions,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
): (sink: RuntimeTaskMessageSink) => void {
  return (sink) => {
    registry.update(lifecycle.agentId, (task) => ({
      ...task,
      messageSink: sink,
    }));
    // flush 不 await：注册发生在 child 的执行栈里，若在这里等待逐条投递，
    // 会把 sink 注册本身变成一次隐式阻塞。失败由 flush 自己重新入队并记日志。
    void flushPendingMessages(options, lifecycle, registry, sink);
  };
}

// INV-12：按索引顺序串行投递，失败时把 pending.slice(index) 整体重新入队。
// 不能只重排失败那条——后续消息已经 drain 出来，若不回队，它们会永久丢失。
async function flushPendingMessages(
  options: ExploreSubagentPortOptions,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  sink: RuntimeTaskMessageSink,
): Promise<void> {
  // drain 是原子取走：取走期间新入队的消息留在 registry，下一轮 flush 再取，
  // 不会与本次遍历交叉，从而保持相对顺序。
  const pending = registry.drainMessages(lifecycle.agentId);
  for (let index = 0; index < pending.length; index++) {
    const message = pending[index];
    if (!message) continue;
    try {
      await sink.send(message);
    } catch (error) {
      // 含当前失败条在内全部回队：sink 的失败通常是整轮不可用（会话切轮/关闭），
      // 继续尝试后续消息只会制造更多失败，且会打乱顺序。
      for (const undelivered of pending.slice(index)) {
        registry.queueMessage(lifecycle.agentId, undelivered);
      }
      options.logger?.warn("Failed to flush pending subagent message", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "subagent.message.flush.failed",
        module: "core.subagent",
        status: "failed",
      });
      return;
    }
  }
}

// registry/projection 使用的对外快照。taskId 与 agentId 故意取同一个值：工具层
// 与 UI 用不同名字称呼同一实体，统一后可避免“按 taskId 查不到、按 agentId 查得到”。
// 注意这里不携带 messageSink/pendingMessages，运行期字段由 registry 单独 attach。
function createRuntimeTaskSnapshot(input: {
  isBackgrounded: boolean;
  lifecycle: SubagentLifecycle;
  request: SubagentRunRequest;
  startedAt: Date;
  status: RuntimeTaskSnapshot["status"];
}): RuntimeTaskSnapshot {
  return {
    taskId: input.lifecycle.agentId,
    agentId: input.lifecycle.agentId,
    agentType: input.request.agentType,
    childSessionId: input.lifecycle.childSessionId,
    description: input.request.description,
    isBackgrounded: input.isBackgrounded,
    outputFile: input.lifecycle.outputFile,
    parentToolCallId: input.request.parentToolCallId,
    parentSessionId: input.request.sessionId,
    prompt: input.request.prompt,
    startedAt: input.startedAt,
    status: input.status,
    taskType: "local_agent",
    traceContext: input.lifecycle.runTraceContext,
    type: "local_agent",
    turnId: input.request.turnId,
  };
}

// 运行期字段剥离器。为什么单独抽出来：终态写回、stop 预写、通知快照三处都必须
// 剥掉 sink/queue，任何一处漏掉都会让“已完成”的快照仍持有可写通道。
function withoutRuntimeMessageState(task: RuntimeTaskSnapshot): RuntimeTaskSnapshot {
  const { messageSink: _messageSink, pendingMessages: _pendingMessages, ...snapshot } = task;
  return snapshot;
}

// 工具层看到的 async_launched 载荷。canReadOutputFile 必须由调用方显式传入，
// 默认 false：父模型不能因为猜测路径就去读一个可能无权访问的文件。
function createAgentBackgroundedOutput(
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
): AgentBackgroundedOutput {
  return {
    status: "async_launched",
    isAsync: true,
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    description: request.description,
    prompt: request.prompt,
    childSessionId: lifecycle.childSessionId,
    backgroundTaskId: lifecycle.agentId,
    outputFile: lifecycle.outputFile,
    canReadOutputFile: request.callerCanReadOutputFile === true,
  };
}

// 后台自然完成：与前台成功路径写同样的产物与 usage，但额外产生一条“父任务通知”
// 和 BackgroundTaskCompleted 事件。所有副作用按“先落盘、再推进状态、再通知”排序。
async function finalizeBackgroundCompletion(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  completed: { output: AgentCompletedOutput },
): Promise<void> {
  // INV-08：先查终态再写盘。若 stop 已把任务写成 killed，这里必须 early return，
  // 否则会把已停止的任务改回 completed，并重复写一份成功元数据。
  const current = registry.get(lifecycle.agentId);
  if (current && isTerminalRuntimeTask(current)) return;

  // 产物写盘放在状态推进之前：写失败会抛给 runBackgroundAgent 的 catch，
  // 由 finalizeBackgroundFailure 把任务标成 failed，而不是“completed 但无文件”。
  await writeCompletedAgentArtifacts(lifecycle, request, completed.output);
  // 通知正文用 content 拼接而不是 response 字段：content 是结构化结果，
  // 多块文本（思考摘要 + 结论）都需要完整传给父模型。
  const notification = formatLocalAgentTaskNotification({
    agentId: completed.output.agentId,
    agentType: completed.output.agentType,
    description: completed.output.description,
    outputFile: lifecycle.outputFile,
    parentToolCallId: String(request.parentToolCallId),
    result: completed.output.content.map((block) => block.text).join("\n\n"),
    status: "completed",
    totalDurationMs: completed.output.totalDurationMs,
    totalTokens: completed.output.totalTokens,
    totalToolUseCount: completed.output.totalToolUseCount,
    usage: completed.output.usage,
  });
  // completedAt 在 update 之前取，保证 registry 快照与通知里的时间基准一致。
  const completedAt = new Date();
  const task = registry.update(lifecycle.agentId, (current) => ({
    ...withoutRuntimeMessageState(current),
    status: "completed",
    completedAt,
    output: completed.output,
    usage: {
      durationMs: completed.output.totalDurationMs,
      modelUsage: completed.output.usage,
      toolUseCount: completed.output.totalToolUseCount,
      totalTokens: completed.output.totalTokens,
    },
  }));
  // INV-07：通知幂等由 registry 的 notified 位保证，这里只调用一次；
  // 返回 false（已通知/已移除）不视为错误——完成通知不是 stop 那种硬约束。
  enqueueBackgroundNotification(
    options,
    registry,
    lifecycle.agentId,
    notification,
    lifecycle.runTraceContext,
  );
  // task 为 undefined 表示 update 时任务已被移除（用户刚好清理），此时跳过
  // BackgroundTaskCompleted，但仍要发下面的 SubagentStopped，保持事件成对。
  if (task) {
    await emitBackgroundTaskCompletedEvent(options, request, lifecycle.runTraceContext, task);
  }

  // background:true 是这条事件与前台完成的唯一区分，UI 据此决定是否把它
  // 归入“后台任务”分组而不是当前 turn 的 inline 结果。
  await emitSubagentEvent(
    options,
    SessionEventType.SubagentStopped,
    request,
    lifecycle.runTraceContext,
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      background: true,
      childSessionId: lifecycle.childSessionId,
      parentToolCallId: request.parentToolCallId,
      status: "completed",
      outputFile: lifecycle.outputFile,
      totalDurationMs: completed.output.totalDurationMs,
      totalToolUseCount: completed.output.totalToolUseCount,
      totalTokens: completed.output.totalTokens,
    },
  );

  options.logger?.info("Subagent background task completed", {
    ...traceContextToLogContext(lifecycle.runTraceContext),
    agentId: lifecycle.agentId,
    durationMs: completed.output.totalDurationMs,
    event: "subagent.background.completed",
    module: "core.subagent",
    status: "completed",
    totalToolUseCount: completed.output.totalToolUseCount,
    totalTokens: completed.output.totalTokens,
  });
}

// 后台失败：与完成同构，但只写 failed 产物、不带 usage 明细。终态检查同样是
// INV-08 的一部分——用户先 Stop 时不能被随后到达的 provider 错误覆盖成 failed。
async function finalizeBackgroundFailure(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  error: unknown,
): Promise<void> {
  const current = registry.get(lifecycle.agentId);
  if (current && isTerminalRuntimeTask(current)) return;

  // background runner 收到的通常是 Turn failure wrapper，直接读 message
  // 会把 provider 的 429 原文替换成通用的 “Turn execution failed”；这里只选择
  // wrapper 下的根因 message，不压缩空白或截断 provider 原文。
  const errorMessage = error instanceof Error ? selectExecutionErrorMessage(error) : String(error);
  const completedAt = new Date();
  const totalDurationMs = Date.now() - lifecycle.startedAt;
  // 失败产物必须写，否则用户点开 outputFile 只能看到上一轮的旧内容。
  await writeFailedAgentArtifacts(lifecycle, request, errorMessage);
  const notification = formatLocalAgentTaskNotification({
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    description: request.description,
    error: errorMessage,
    outputFile: lifecycle.outputFile,
    parentToolCallId: String(request.parentToolCallId),
    status: "failed",
    totalDurationMs,
  });
  const task = registry.update(lifecycle.agentId, (current) => ({
    ...withoutRuntimeMessageState(current),
    status: "failed",
    completedAt,
    error: errorMessage,
    usage: {
      durationMs: totalDurationMs,
    },
  }));
  enqueueBackgroundNotification(
    options,
    registry,
    lifecycle.agentId,
    notification,
    lifecycle.runTraceContext,
  );
  if (task) {
    await emitBackgroundTaskCompletedEvent(options, request, lifecycle.runTraceContext, task);
  }

  await emitSubagentEvent(
    options,
    SessionEventType.SubagentStopped,
    request,
    lifecycle.runTraceContext,
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      background: true,
      childSessionId: lifecycle.childSessionId,
      parentToolCallId: request.parentToolCallId,
      status: "failed",
      outputFile: lifecycle.outputFile,
      totalDurationMs,
      error: errorMessage,
    },
  );

  options.logger?.warn("Subagent background task failed", {
    ...traceContextToLogContext(lifecycle.runTraceContext),
    agentId: lifecycle.agentId,
    errorMessage,
    event: "subagent.background.failed",
    module: "core.subagent",
    status: "failed",
  });
}

// stop 的“预写”结果。必须同时携带 previousTask：通知入队失败时要回滚到它，
// 否则任务会停在 killed 但用户从未收到停止通知，等效于“静默丢失”。
interface StoppedBackgroundAgentTask {
  previousTask: RuntimeTaskSnapshot;
  task: RuntimeTaskSnapshot;
  totalDurationMs: number;
  traceContext: TraceContext;
}

// 四种消费方各自的状态词汇表（registry / notification / subagent event /
// background event）集中在一处，避免同一个“已停止”在四处写成不同字符串。
const BACKGROUND_AGENT_STOPPED_STATE = {
  backgroundEventStatus: "cancelled",
  message: "Background agent task stopped.",
  notificationStatus: "stopped",
  registryStatus: "killed",
  subagentEventStatus: "stopped",
} as const;

// 构造 killed 快照但不提交：调用方拿到对象后再由 finalizeBackgroundStopped 决定
// 是否真的提交。这样“通知无法入队”时可以完整回滚，而不是先改表再补救。
// 传入的 task 只用于定位 taskId，实际状态一律以 registry 里的 current 为准。
function createBackgroundStoppedTask(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
): StoppedBackgroundAgentTask | undefined {
  const current = registry.get(task.taskId);
  if (!current || isTerminalRuntimeTask(current)) return undefined;

  // Math.max(0, ...) 兜住时钟回拨：系统时间被校准后 elapsed 可能为负，
  // 负的 durationMs 会让 UI 显示 -1s，也会污染 usage 统计。
  const completedAt = new Date();
  const totalDurationMs = Math.max(0, completedAt.getTime() - current.startedAt.getTime());
  const stopped: RuntimeTaskSnapshot = {
    ...withoutRuntimeMessageState(current),
    status: BACKGROUND_AGENT_STOPPED_STATE.registryStatus,
    completedAt,
    error: BACKGROUND_AGENT_STOPPED_STATE.message,
    usage: {
      durationMs: totalDurationMs,
    },
  };

  // trace 从快照恢复而不是新建：stop 事件必须挂在原任务的 trace 下，
  // 否则 UI 里“已停止”会变成一条孤立记录。
  const traceContext = traceContextFromRuntimeTask(stopped);
  return { previousTask: current, task: stopped, totalDurationMs, traceContext };
}

// INV-20：提交顺序 = 写停止产物 → 写入 killed 快照 → 入队通知 → 提交回调(abort)。
// 通知失败要回滚到 previousTask 并抛错，让调用方知道“停止没有真正完成”；
// 若把 abort 提前，completion 的 catch 会抢先写成 failed（见 INV-09）。
async function finalizeBackgroundStopped(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  stopped: StoppedBackgroundAgentTask,
  onCommitted?: () => void,
): Promise<RuntimeTaskSnapshot | undefined> {
  // 通知文案在写盘前生成：它只依赖快照字段，不依赖 registry 的最新状态，
  // 提前生成可避免写盘后再次读表拿到被并发修改的值。
  const notification = formatLocalAgentTaskNotification({
    agentId: stopped.task.agentId,
    agentType: stopped.task.agentType,
    description: stopped.task.description,
    outputFile: stopped.task.outputFile ?? "",
    parentToolCallId: String(stopped.task.parentToolCallId ?? stopped.task.taskId),
    status: BACKGROUND_AGENT_STOPPED_STATE.notificationStatus,
    totalDurationMs: stopped.totalDurationMs,
  });
  // 停止产物先落盘：即使后面通知入队失败并回滚 registry，磁盘上仍留有
  // “这次停止尝试”的证据，便于排查；metadata 的语义是日志而非状态。
  await writeStoppedAgentArtifacts(stopped.task);
  // 保留 current.notified：预写快照时不知道是否已通知过，直接覆盖成 false
  // 会让 enqueue 误判为未通知而重复投递。
  registry.update(stopped.task.taskId, (current) => ({
    ...stopped.task,
    notified: current.notified,
  }));
  // INV-07/20：通知必须同步入队成功才继续。enqueue 返回 false 说明父队列
  // 不可用或已通知过，前者需要回滚，后者属于幂等重复，需区分（此处按失败处理）。
  const enqueued = enqueueBackgroundNotification(
    options,
    registry,
    stopped.task.taskId,
    notification,
    stopped.traceContext,
  );
  if (!enqueued) {
    // 回滚用的是整份 previousTask（register 覆盖），而不是局部 patch：
    // 这样 messageSink/pendingMessages 也能恢复，任务可以继续接收消息。
    registry.register(stopped.previousTask);
    throw new Error(
      `Background agent task stopped notification was not enqueued: ${stopped.task.taskId}`,
    );
  }

  // 重新读一次而不是用 stopped.task：入队期间可能有并发 update（例如工具事件），
  // 提交给事件系统/调用方的应是最新快照。
  const committed = registry.get(stopped.task.taskId);
  if (!committed) return undefined;
  // onCommitted 现在才 abort：顺序是“状态已 killed 且通知已入队”，此时取消
  // 引发的后续 catch 会因终态检查而安全早退。
  onCommitted?.();

  // 两个事件都基于 committed（而不是 stopped.task）：如果入队期间发生了
  // 并发更新，事件里的状态应与 registry 一致，而不是预写时的旧对象。
  await emitRuntimeTaskBackgroundCompletedEvent(options, committed, stopped.traceContext);
  await emitRuntimeTaskSubagentStoppedEvent(
    options,
    committed,
    stopped.traceContext,
    stopped.totalDurationMs,
  );
  // 日志放在事件之后：事件投递失败会抛错，此时不应该留下一条“已停止”的
  // 成功日志，否则排障时会误以为 stop 完整走完。
  options.logger?.info("Subagent background task stopped", {
    ...traceContextToLogContext(stopped.traceContext),
    agentId: stopped.task.agentId,
    event: "subagent.background.stopped",
    module: "core.subagent",
    status: BACKGROUND_AGENT_STOPPED_STATE.backgroundEventStatus,
  });
  return committed;
}

// 该事件只服务“有 request 的具体一次执行”（前台转后台/后台自然结束），
// 与下面基于 RuntimeTaskSnapshot 的通用版本区别在于 turnId 来源不同。
async function emitBackgroundTaskCompletedEvent(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  traceContext: TraceContext,
  task: RuntimeTaskSnapshot,
): Promise<void> {
  // 非终态不发：BackgroundTaskCompleted 的语义是“已经有结论”，
  // 运行中发出去会让消费方以为任务结束并从列表移除。
  if (!isTerminalRuntimeTask(task)) return;
  await emitSubagentEvent(
    options,
    SessionEventType.BackgroundTaskCompleted,
    request,
    traceContext,
    {
      taskId: task.taskId,
      toolCallId: String(request.parentToolCallId),
      toolName: "Agent",
      // taskKind 固定为 subagent：投影层据此走子代理的渲染分支，
      // 与 shell/后台命令等其他 runtime task 区分（它们的 taskKind 不同）。
      taskKind: "subagent",
      childSessionId: task.childSessionId,
      // 事件发生即终态，因此不可再取消。若误标 true，UI 会显示一个点击无效
      // 的停止按钮，用户会反复尝试。
      cancellable: false,
      description: task.description,
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt ?? new Date(),
      outputPath: task.outputFile,
      // terminalId 供 UI 把事件绑定到具体任务卡；与 taskId 同值，
      // 但语义是“该任务的终态标识”，未来若支持多终态可独立演进。
      terminalId: task.taskId,
    },
  );
}

// 通用版：只靠快照发事件，供 stop 等没有 SubagentRunRequest 的路径使用。
// parentSessionId 缺失说明该任务不是从某个父会话派生的，无处投递，直接跳过。
async function emitRuntimeTaskBackgroundCompletedEvent(
  options: ExploreSubagentPortOptions,
  task: RuntimeTaskSnapshot,
  traceContext: TraceContext,
): Promise<void> {
  if (!task.parentSessionId) return;
  const event = createSessionEvent(
    SessionEventType.BackgroundTaskCompleted,
    task.parentSessionId,
    {
      taskId: task.taskId,
      toolCallId: String(task.parentToolCallId ?? task.taskId),
      toolName: "Agent",
      // taskKind 固定为 subagent：投影层据此走子代理的渲染分支，
      // 与 shell/后台命令等其他 runtime task 区分（它们的 taskKind 不同）。
      taskKind: "subagent",
      childSessionId: task.childSessionId,
      // 事件发生即终态，因此不可再取消。若误标 true，UI 会显示一个点击无效
      // 的停止按钮，用户会反复尝试。
      cancellable: false,
      description: task.description,
      status: BACKGROUND_AGENT_STOPPED_STATE.backgroundEventStatus,
      startedAt: task.startedAt,
      completedAt: task.completedAt ?? new Date(),
      outputPath: task.outputFile,
      // terminalId 供 UI 把事件绑定到具体任务卡；与 taskId 同值，
      // 但语义是“该任务的终态标识”，未来若支持多终态可独立演进。
      terminalId: task.taskId,
    },
    {
      turnId: task.turnId,
      traceId: traceContext.traceId,
    },
  );
  await options.emitParentEvent(event, traceContext);
}

// stop 场景的 SubagentStopped：status 固定取词汇表里的 stopped，
// 不读 task.status（那里是 registry 的 killed），两者面向的消费方不同。
async function emitRuntimeTaskSubagentStoppedEvent(
  options: ExploreSubagentPortOptions,
  task: RuntimeTaskSnapshot,
  traceContext: TraceContext,
  totalDurationMs: number,
): Promise<void> {
  if (!task.parentSessionId) return;
  const event = createSessionEvent(
    SessionEventType.SubagentStopped,
    task.parentSessionId,
    {
      agentId: task.agentId,
      agentType: task.agentType,
      background: true,
      childSessionId: task.childSessionId,
      parentToolCallId: task.parentToolCallId,
      status: BACKGROUND_AGENT_STOPPED_STATE.subagentEventStatus,
      outputFile: task.outputFile,
      totalDurationMs,
      error: task.error,
    },
    {
      turnId: task.turnId,
      traceId: traceContext.traceId,
    },
  );
  await options.emitParentEvent(event, traceContext);
}

// INV-07：通知的唯一投递点。返回 boolean 而不是抛错，因为调用方对失败的
// 处理不同：自然完成可以继续，stop 必须回滚。notified 位在入队成功后才置位，
// 保证“入队失败 → 未被标记 → 可重试”这一顺序不被破坏。
function enqueueBackgroundNotification(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  taskId: string,
  message: string,
  traceContext: TraceContext,
): boolean {
  // 没有父队列（独立 CLI/测试）时不报警失败，只记 warn 并返回 false；
  // 这是配置性缺失，不是任务失败。
  if (!options.enqueueParentTaskNotification) {
    options.logger?.warn("Skipped subagent background notification without parent queue", {
      ...traceContextToLogContext(traceContext),
      event: "subagent.background.notification.skipped",
      module: "core.subagent",
      taskId,
    });
    return false;
  }

  // 先查 notified 再入队，是幂等的第一道闸；第二道是入队成功后的 update。
  // 二者配合即使两个 finalize 并发抵达，也只有一个能真正写入父队列。
  const task = registry.get(taskId);
  if (!task || task.notified) {
    options.logger?.debug("Skipped duplicate subagent background notification", {
      ...traceContextToLogContext(traceContext),
      event: "subagent.background.notification.duplicate",
      module: "core.subagent",
      reason: task ? "already_notified" : "task_missing",
      taskId,
    });
    return false;
  }

  // 同步调用（非 await）：enqueueParentTaskNotification 的类型被约束为返回
  // undefined，正是为了避免“看起来入队了其实还在异步路上”的假成功。
  try {
    options.enqueueParentTaskNotification({
      // workId 与 taskId 必须相同：父端用它把通知归并到已有的任务卡；
      // 不一致会显示成两条独立记录（一条空占位 + 一条结果）。
      originMeta: {
        backgroundSource: "subagent",
        title: task.description.trim() || taskId,
        workId: taskId,
      },
      taskId,
      text: message,
      traceContext,
    });
  } catch (error) {
    // 入队失败不置 notified，调用方（stop）会据此回滚；日志保留原始 message，
    // 便于区分“队列已关闭”与“序列化失败”等不同原因。
    options.logger?.warn("Failed to enqueue subagent background notification", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.background.notification.failed",
      module: "core.subagent",
      taskId,
    });
    return false;
  }

  // 条件更新而不是无条件写 true：若并发路径已经置位，保持原对象引用，
  // 避免触发不必要的订阅通知（registry.update 可能广播）。
  registry.update(taskId, (current) =>
    current.notified
      ? current
      : {
          ...current,
          notified: true,
        },
  );
  // 成功日志用 info，且允许 logger 不实现 info（可选链）：这个事件是观测点，
  // 不能因为测试 logger 缺方法而让通知路径抛错。
  options.logger?.info?.("Subagent background notification enqueued", {
    ...traceContextToLogContext(traceContext),
    event: "subagent.background.notification.enqueued",
    module: "core.subagent",
    taskId,
  });
  return true;
}

// 任务快照里通常已有 traceContext；只有从磁盘恢复/旧版本快照才会缺失。
// 兜底用 taskId 作为 spanId，保证同一任务多次 fallback 得到稳定（可关联）的 id，
// 而不是每次随机一个新 trace 导致事件无法归并。
function traceContextFromRuntimeTask(task: RuntimeTaskSnapshot): TraceContext {
  return (
    task.traceContext ?? {
      traceId: createTraceId(),
      spanId: `span_${task.taskId}`,
      sessionId: task.parentSessionId,
      turnId: task.turnId,
    }
  );
}

// 统一事件出口：sessionId/turnId 来自请求，traceId 来自 traceContext。
// 两者不能混用——request.turnId 是父 turn，traceId 可能已指向 child span。
async function emitSubagentEvent(
  options: ExploreSubagentPortOptions,
  type: SessionEventType,
  request: SubagentRunRequest,
  traceContext: TraceContext,
  payload: Record<string, unknown>,
): Promise<void> {
  // turnId 取 request.turnId（父 turn），traceId 取 traceContext：事件归到父会话
  // 的当前 turn 下，但 trace 仍指向子 span，二者各司其职。
  const event = createSessionEvent(type, request.sessionId, payload, {
    turnId: request.turnId,
    traceId: traceContext.traceId,
  });
  // await 而不是 void：事件写失败必须让 finalize 失败，避免“状态已完成但 UI
  // 永远收不到结束事件”；调用方（run/start）已按失败路径处理。
  await options.emitParentEvent(event, traceContext);
}

// INV-16 的成功分支。content 块以空行拼接：保持多段结果可读，同时不引入
// Markdown 分隔符（父模型可能把 output.txt 当纯文本引用）。
async function writeCompletedAgentArtifacts(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  output: AgentCompletedOutput,
): Promise<void> {
  // 只取 text 块：非文本块（图片/工具结果）没有可读的线性表示，
  // 强行 JSON 化会让 output.txt 变成不可读的结构，元数据里另有完整 output。
  const text = output.content.map((block) => block.text).join("\n\n");
  await writeAgentOutputFiles(lifecycle, text);
  // 子 agent 事件已由 session event store 持久化，不再重复写入 transcript sidecar。
  await writeAgentMetadataFile(lifecycle, request, "completed", {
    completedAt: new Date().toISOString(),
    totalDurationMs: output.totalDurationMs,
    totalTokens: output.totalTokens,
    totalToolUseCount: output.totalToolUseCount,
    usage: output.usage,
  });
}

// 失败时 output.txt 写错误信息而不是留空：用户/父模型读取该文件时，
// 至少能看到“为什么没有结果”，而不是误判为任务仍在运行。
async function writeFailedAgentArtifacts(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  errorMessage: string,
): Promise<void> {
  // 复用同一写入函数，保证失败时 output.txt 与 task.output 内容一致，
  // 父 runtime 无论读哪个都能拿到错误原因。
  await writeAgentOutputFiles(lifecycle, errorMessage);
  await writeAgentMetadataFile(lifecycle, request, "failed", {
    completedAt: new Date().toISOString(),
    error: errorMessage,
  });
}

// stop 的产物是三份：output.txt / task.output / metadata.json。前者给用户，
// 中间给父 runtime 读取，后者是可重建的状态证据；三者内容同源但用途不同。
async function writeStoppedAgentArtifacts(task: RuntimeTaskSnapshot): Promise<void> {
  // 没有 outputFile 说明任务从未真正落盘（setup 早期就失败），此时写不了任何
  // 文件；静默返回，不能因此让 stop 抛错——用户仍应看到“已停止”。
  if (!task.outputFile) return;
  const outputDir = dirname(task.outputFile);
  // 末尾保留换行，便于用户直接在终端 cat 时与 shell 提示符分开；
  // 内容使用统一词汇表里的 message，保证 UI/文件/事件三处文案一致。
  const content = `${BACKGROUND_AGENT_STOPPED_STATE.message}\n`;
  await writeTextFile(task.outputFile, content);
  await writeTextFile(join(outputDir, "task.output"), content);
  await writeTextFile(
    join(outputDir, "metadata.json"),
    `${JSON.stringify(
      {
        agentId: task.agentId,
        childSessionId: task.childSessionId,
        // 停止元数据用 ISO 字符串而不是毫秒数：它是给人看的审计文件，
        // 与 running/completed 的字段类型保持一致，便于脚本统一解析。
        completedAt: new Date().toISOString(),
        description: task.description,
        outputFile: task.outputFile,
        parentSessionId: task.parentSessionId,
        parentToolUseId: task.parentToolCallId,
        profileId: task.agentType,
        prompt: task.prompt,
        status: BACKGROUND_AGENT_STOPPED_STATE.subagentEventStatus,
        taskOutputFile: join(outputDir, "task.output"),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

// output.txt 与 task.output 必须写同一份内容：前者面向用户/CLI 打开，
// 后者面向父 runtime 的异步读取协议；内容分叉会让两侧看到不同结果。
async function writeAgentOutputFiles(
  lifecycle: Pick<SubagentLifecycle, "outputFile" | "taskOutputFile">,
  content: string,
): Promise<void> {
  await writeTextFile(lifecycle.outputFile, content);
  await writeTextFile(lifecycle.taskOutputFile, content);
}

// metadata.json 是“可读的审计记录”，不是状态机：它可能落后于 registry，
// 也可能因崩溃停在 running。读取方必须以 registry/事件为准，磁盘只作证据。
async function writeAgentMetadataFile(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  status: "running" | "completed" | "failed" | "stopped",
  extra: Record<string, unknown> = {},
): Promise<void> {
  // profileSnapshot 整份落盘：用户之后修改/删除 profile 时，仍能还原本次执行
  // 实际使用的工具集、模型与权限，这对复盘“为什么它能写文件”至关重要。
  await writeTextFile(
    lifecycle.metadataFile,
    `${JSON.stringify(
      {
        agentId: lifecycle.agentId,
        childSessionId: lifecycle.childSessionId,
        createdAt: new Date(lifecycle.startedAt).toISOString(),
        cwd: request.workingDirectory,
        description: request.description,
        metadataFile: lifecycle.metadataFile,
        outputFile: lifecycle.outputFile,
        parentSessionId: request.sessionId,
        parentToolUseId: request.parentToolCallId,
        profileId: request.agentType,
        profileSnapshot: lifecycle.profile,
        prompt: request.prompt,
        status,
        taskOutputFile: lifecycle.taskOutputFile,
        updatedAt: new Date().toISOString(),
        workspaceRoot: request.workspaceRoot,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

// INV-17：只累加 ModelComplete 与 model_request_failed 的 usage。其它事件里
// 即使带 usage（流式增量、重试片段）也不能并入，否则 token 会被重复计数。
function aggregateModelUsage(events: SessionEvent[]): ModelUsage | undefined {
  // 惰性初始化：没有任何有效 usage 时返回 undefined，而不是全零对象，
  // 以便上层区分“没消耗”与“没有数据”。
  let usage: ModelUsage | undefined;

  // 遍历完整事件流而不是只看最后一个 ModelComplete：取消/失败可能发生在
  // 多次模型请求之后，只取最后一条会漏掉前面已经产生的 token 消耗。
  for (const event of events) {
    const payload = event.payload;
    // 与主 turn 共用失败事件的用量事实，不增加独立汇总状态。
    if (
      event.type !== SessionEventType.ModelComplete &&
      !(
        event.type === SessionEventType.ModelNetworkStatus &&
        isRecord(payload) &&
        payload.type === "model_request_failed"
      )
    )
      continue;
    if (!isRecord(payload) || !isRecord(payload.usage)) {
      continue;
    }

    // 类型断言只在这道 hasModelUsage 检查之后才可信；直接使用未校验的
    // usage 会把缺字段/全零的对象混进累加，产出 NaN 或虚高 token。
    const modelUsage = payload.usage as ModelUsage;
    if (!hasModelUsage(modelUsage)) continue;
    usage ??= {};
    addUsage(usage, modelUsage);
  }

  return usage;
}

// INV-18：优先使用 TurnComplete.toolCallCount 的累计值。注意“存在权威值但为 0”
// 与“从未见过权威值”必须区分，因此用 sawTurnCompleteToolCallCount 而不是判 0。
function resolveSubagentToolUseCount(events: SessionEvent[]): number {
  let turnCompleteToolCallCount = 0;
  let sawTurnCompleteToolCallCount = false;

  // TurnComplete 的 toolCallCount 是 loopState 的权威累计值；payload 不是
  // record 或字段类型不对时跳过，而不是强转，避免 NaN 污染最终统计。
  for (const event of events) {
    if (event.type !== SessionEventType.TurnComplete || !isRecord(event.payload)) {
      continue;
    }
    const toolCallCount = event.payload.toolCallCount;
    if (typeof toolCallCount !== "number" || !Number.isFinite(toolCallCount)) {
      continue;
    }
    sawTurnCompleteToolCallCount = true;
    turnCompleteToolCallCount += toolCallCount;
  }

  // 多个 TurnComplete（多轮 turn）累加，而不是取最后一个：子代理可能跑多轮，
  // 每轮各带自己的计数，取最后一个会低估总调用数。
  if (sawTurnCompleteToolCallCount) {
    return turnCompleteToolCallCount;
  }

  // ToolCallResult/ToolCallError 会直接 append 到 event store，
  // 不一定回填进 child TurnResult.events；child TurnComplete 里的 toolCallCount
  // 才是运行时 loopState 累计出的权威子 agent 工具调用数。
  return events.filter(
    (event) =>
      event.type === SessionEventType.ToolCallResult ||
      event.type === SessionEventType.ToolCallError,
  ).length;
}

// 逐字段累加，缺失字段保持 undefined（由 addOptionalUsageNumber 跳过），
// 因此不会把“provider 没报 cacheRead”误算成 0 并覆盖历史值。
function addUsage(target: ModelUsage, next: ModelUsage): void {
  addOptionalUsageNumber(target, "inputTokens", next.inputTokens);
  addOptionalUsageNumber(target, "outputTokens", next.outputTokens);
  addOptionalUsageNumber(target, "totalTokens", resolveTotalTokens(next));
  addOptionalUsageNumber(target, "cacheReadTokens", next.cacheReadTokens);
  addOptionalUsageNumber(target, "cacheWriteTokens", next.cacheWriteTokens);
  addOptionalUsageNumber(target, "reasoningTokens", next.reasoningTokens);
  // serverToolUse 只在确实有请求时才创建对象：无条件的 ??= {} 会让每条 usage
  // 都带上空 serverToolUse，下游“是否有服务端工具调用”的判断会全部失真。
  const webSearchRequests = next.serverToolUse?.webSearchRequests ?? 0;
  const webFetchRequests = next.serverToolUse?.webFetchRequests ?? 0;
  if (webSearchRequests > 0 || webFetchRequests > 0) {
    target.serverToolUse ??= {};
    target.serverToolUse.webSearchRequests =
      (target.serverToolUse.webSearchRequests ?? 0) + webSearchRequests;
    target.serverToolUse.webFetchRequests =
      (target.serverToolUse.webFetchRequests ?? 0) + webFetchRequests;
  }
}

// 唯一的数字累加入口。undefined 直接跳过而不是当 0，保留“数据缺失”的语义。
function addOptionalUsageNumber(
  target: ModelUsage,
  key: keyof Pick<
    ModelUsage,
    | "inputTokens"
    | "outputTokens"
    | "totalTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "reasoningTokens"
  >,
  value: number | undefined,
): void {
  if (value === undefined) return;
  target[key] = (target[key] ?? 0) + value;
}

// provider 优先给 totalTokens 时直接用；否则由 input/output/cache 推导。
// 四个分量全缺失时返回 undefined——推导只会得到 0，那会把“未上报”伪装成“零消耗”。
function resolveTotalTokens(usage: ModelUsage): number | undefined {
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  return getModelUsageTotalTokens(usage);
}

// 排除数组：Array.isArray 的对象在 TS 里也满足 object，若不排除，
// 把 events 数组误当 payload 读字段会得到 undefined 而不是编译错误。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// INV-19：内置 Explore profile 允许宿主注入动态工具表（getAllowedTools），
// 其余 profile 只认静态 profile.tools。注入是“替换”而非“追加”，避免宿主
// 无法收回某个默认工具。
function resolveAllowedTools(
  profile: AgentProfile,
  options: ExploreSubagentPortOptions,
): readonly string[] {
  const profileTools = isBuiltInExploreAgentProfile(profile)
    ? (options.getAllowedTools?.(profile) ?? EXPLORE_AGENT_ALLOWED_TOOLS)
    : profile.tools;
  // 复制一份再改：profile.tools 可能被多个并发子代理共享，原地 push 会让
  // Skill 泄漏到不需要它的 agent 上。
  const baseTools = [...(profileTools ?? [])];
  const disallowed = new Set(profile.disallowedTools ?? []);
  // Skill 是“隐式附加工具”，只有在 profile 声明了 skills、且未被显式禁用时才加。
  // 显式 disallowed 优先于隐式附加，保证用户能真正关掉 Skill。
  if (profile.skills && profile.skills.length > 0 && !disallowed.has("Skill")) {
    baseTools.push("Skill");
  }
  return filterSubagentChildToolNames(baseTools, profile.disallowedTools);
}

// 所有产物写入的唯一底层实现：先递归建目录再整文件覆盖。递归 mkdir 让
// outputRootDir 不存在时也能工作；不追加写（"w" 语义）保证每次运行是完整快照，
// 不会把上一轮结果残留到这一轮。
async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
