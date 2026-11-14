/**
 * ============================================================================
 * runtime/methods/subagent.ts —— 子代理（child runtime）的创建与首轮执行
 * ============================================================================
 *
 * 【定位】Agent 工具/Explore 端口最终落到这里：为每次子代理派生一个独立
 *   AgentRuntime，跑一轮 executeTurn，把结果回给父会话。
 *
 * 【三条身份边界（最容易被改坏的部分）】
 *   1) 持久化身份 = childSessionId：child 的事件、消息、trace 都写自己的 session；
 *   2) 交互身份 = parentSessionId：权限弹窗、AskUserQuestion、provider 请求头
 *      必须路由回父会话（桌面 UI 只认识父 task）。收敛在 deriveChildClientPorts；
 *   3) 可见性身份 = 父 timeline 只镜像摘要/工具活动（mirrorSubagentToolEvent），
 *      raw child 正文不得污染父 timeline，但外部 sinks 仍要收到 child 原始事件
 *      （否则 UI 订阅 child topic 后只能拿到打开时的 hydration）。
 *
 * 【继承策略】
 *   - 权限：Explore 用独立只读配置；general-purpose/自定义 agent 继承父 PermissionService；
 *     具体 mode 由 resolveSubagentPermissionMode 决定（只能收紧，不能凭 profile 提权）；
 *   - 模型：profile selection > 父模型继承 > override（Core Server override 最高），
 *     但都收敛成标准 ModelSelection；
 *   - MCP：child 不拥有连接生命周期，只借用父启动快照（borrowed-mcp-port）；
 *   - 工具面：allowlist = 父可见工具 ∩ profile allowedTools − disallow rules
 *     （+ 协调响应工具，子代理总是要能回话）。
 *
 * 【生命周期收尾（finally 内）】
 *   sealBackgroundTaskNotifications 先封口，再（仅取消时）取消子会话的后台任务，
 *   最后清理浏览器会话登记。顺序不能反：先取消会让尚未封口的通知漏进父会话。
 * ============================================================================
 */

/* eslint-disable max-lines -- subagent runtime wiring 集中衔接 child runtime、tool pool、权限、MCP 与 activity watchdog，拆分需单独迁移。 */
// INV-01 child 的持久化身份恒为 request.sessionId，任何写入事件的路径都不得替换成父 sessionId；守住位置：onSessionEvent 里 notifyEventSinks 的 sessionId 覆盖；改错故障：子代理正文与工具记录写进父 transcript，父会话历史被污染且无法回滚
// INV-02 对外阻塞交互（权限弹窗、AskUserQuestion、provider 请求头）必须携带父 sessionId；守住位置：deriveChildClientPorts 的第二个入参；改错故障：桌面 UI 找不到对应父 task，权限请求悬空直到子代理超时被杀
// INV-03 父 timeline 只接受 mirror 产生的摘要事件，raw child 事件不得进入父 sink 的 sessionId；守住位置：mirroredEvent 为空时提前返回；改错故障：父列表出现与摘要重复的整段子代理正文，用户以为消息发了两遍
// INV-04 同一条 child 事件必须先通知外部 sinks 再镜像给父，顺序不可交换；守住位置：onSessionEvent 内两处 notifyEventSinks 的先后；改错故障：父端先收到摘要后收到正文，UI 出现摘要被正文覆盖又弹回的抖动
// INV-05 同一次 child 工具调用只能在父 timeline 镜像一次，映射表只在镜像成功后写入；守住位置：mirroredToolNameByChildToolCallId 的读写点；改错故障：一个工具调用在父会话出现两条活动记录，状态机按重复 id 报错
// INV-06 子代理结果只通过 executeTurn 的返回值交给父一次，finally 段禁止再回写结果；守住位置：runExploreAgent 的 return 与 finally；改错故障：父会话收到两次完成通知，任务的完成计数翻倍
// INV-07 父的 abortSignal 必须原样传给 child 首轮 executeTurn，且 finally 无论成功失败都要跑；守住位置：executeTurn 的 abortSignal 与 finally 块；改错故障：父已取消而子代理继续调用模型，继续烧 token 并写入孤儿消息
// INV-08 收尾必须先 sealBackgroundTaskNotifications 再取消后台任务，顺序颠倒即漏通知；守住位置：finally 内两个调用点的先后；改错故障：子代理已结束，父会话仍突然收到它的后台命令结果
// INV-09 只有取消路径才取消子会话的后台任务，正常终态必须保留已完成的通知；守住位置：finally 里的 cancelled 判断；改错故障：正常结束的后台命令结果被丢弃，用户看不到已经跑完的输出
// INV-10 off-peak child binding 必须在最外层 finally 释放，任何抛错都不能跳过；守住位置：runExploreAgent 末尾的 childBinding 释放；改错故障：绑定槽位泄漏，后续子代理无法加入 off-peak 任务并退回全价计费
// INV-11 浏览器会话收尾只撤销登记不关闭 tab，清理失败只记录 warn 不得向上抛；守住位置：childBrowserControlPort 的 closeSession 调用与 catch；改错故障：子代理结束把用户在面板里正在看的 tab 关掉
// INV-12 child runtime 的 subagents.enabled 恒为 false，递归派生在这一层被截断；守住位置：childRuntime 配置里的 subagents 字段；改错故障：子代理再派生子代理，层级与并发失控直到预算烧穿
// INV-13 工具白名单必须剔除 subagent dispatch 工具并补上 RESPOND_TO_COORDINATOR；守住位置：resolveSubagentToolAllowlist 的两处过滤；改错故障：子代理拿到派生工具形成递归，或没有回话通道而卡到超时
// INV-14 子代理权限只能在父模式上收紧，profile 不得凭 permissionMode 提权；守住位置：resolveSubagentPermissionMode 的每个分支；改错故障：profile 写 bypassPermissions 就绕过父会话审批直接执行写操作
// INV-15 child 不拥有 MCP 连接生命周期，只能借用父启动快照，不得自行 connect；守住位置：resolveSubagentMcpAccess 的借用分支；改错故障：子代理收尾时把父会话仍在使用的 MCP 连接一起断开
// INV-16 profile 显式要求的 MCP server 或 tool 拿不到时必须抛 ConfigurationError，禁止静默降级；守住位置：validateSubagentMcpRequirements 的三段校验；改错故障：子代理少了关键工具却继续运行，产出看似成功但结论错误的结果
// INV-17 resume 必须已存在持久化消息，否则抛 SessionNotFound 让调用方走新建；守住位置：persistedMessages 的空数组判断；改错故障：凭空创建一个空 session，子代理复活但没有历史而重复劳动
// INV-18 新建 child 必须在父发布 SubagentSpawned 之前落库；守住位置：ensureSessionPersistedForExternalActivity 调用；改错故障：并发派生时目录查询少一个 child，前端列表与实际运行数不一致
// INV-19 token 与成本必须归属 child 自己的 session 与 span，前台用 child 因果、后台用 linked_root；守住位置：agentTelemetryCausationMode 与 traceContext 的传递；改错故障：成本记到父会话，父子报表重复计费且单次子代理成本不可见
import {
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  SESSION_ENTRY_MODEL_SELECTION,
  parseModelSelectionValue,
} from "@zcode/contracts";
import type { SubagentRunOptions } from "@zcode/contracts";
import { inheritPermissionMode } from "@zcode/contracts";
import {
  defaultScheduler,
  PermissionService,
  defaultPermissionConfig,
  buildExploreAllowedTools,
  buildExploreAgentPrompt,
  createExploreSubagentPort,
  createCoreError,
  CoreErrorType,
} from "../deps.js";
import type {
  ExploreSubagentRuntimeRequest,
  McpConnectionSnapshot,
  McpPort,
  Model,
  ModelSelection,
  SkillContent,
  SkillLoadOutcome,
  SkillOperationOptions,
  SkillPort,
  SubagentPort,
} from "../deps.js";
import { AgentRuntime } from "../agent-runtime.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { resolveSubagentSelection } from "../helpers/subagent-selection.js";
import type { AgentRuntimeDeps } from "../types.js";
import { toMcpToolName } from "../../mcp/index.js";
import { createBorrowedSubagentMcpAccess } from "../../subagent/borrowed-mcp-port.js";
import { createSubagentMessageSink } from "../../subagent/message-steering.js";
import {
  extractRequiredMcpServerNames,
  matchesRequiredMcpServer,
} from "../../subagent/mcp-config.js";
import { mirrorSubagentToolEvent } from "../../subagent/tool-event-mirror.js";
import { isBuiltInExploreAgentProfile } from "../../subagent/profile.js";
import {
  buildSubagentChildDisallowRules,
  filterSubagentChildToolNames,
} from "../../subagent/tool-policy.js";
import { isSubagentDispatchToolName } from "../../tool/compat.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import { getSessionShellEnvironment } from "./session-shell-environment.js";
import { deriveChildClientPorts } from "../helpers/child-client-ports.js";
import { createCoordinatorResponsePort } from "../../subagent/coordinator-response.js";
import { isStaleBranchRuntimeTaskEvent } from "./runtime-command-generation.js";
import { loadPersistentAgentMemory } from "../../subagent/persistent-memory.js";
import {
  createOfficialCuaPolicy,
  SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
  SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
  type OfficialCuaPolicy,
} from "../../subagent/computer-use-policy.js";
import { computeOfficialCuaServerNames } from "./mcp.js";
import { persistRuntimeModelSelection, sameModelSelection } from "./turn-model.js";
import { getOffPeakExecution, markTemporaryRuntimeSelection } from "../off-peak/runtime.js";
import { getOffPeakModelBinding } from "../off-peak/model-binding.js";

/**
 * 创建默认子代理端口（subagents.enabled === false 时返回 undefined，表示禁用）。
 *
 * 返回的端口把 createExploreSubagentPort 的策略层与本 runtime 的能力层缝合：
 *   - emitParentEvent：过滤 stale branch 后写入父事件流；
 *   - enqueueParentTaskNotification：把子任务通知并入父的后台通知队列；
 *   - runExploreAgent：真正创建 child runtime（见文件头三条身份边界）。
 *
 * offPeak 分支：若父 runtime 处于 off-peak 执行期，子代理也绑定同一 off-peak
 * 任务；用户已接管（ownedByUser）时改用会话模型，而不是 off-peak 临时选择。
 */
export function createDefaultSubagentPort(
  this: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): SubagentPort | undefined {
  // 开关只认显式的 false，undefined 视为启用，与 config 里其他可选字段的默认语义保持一致
  // 返回 undefined 而不是空实现端口，调用方据此彻底隐藏 Agent 与 Explore 两个入口
  // 提前返回后不再执行任何初始化，off-peak 绑定与 MCP 快照都不会被子代理路径触碰
  // [权衡] 若返回一个空端口，入口仍会渲染，用户点了只得到一次无响应的失败调用
  // 关闭状态在端口构造期定型，运行中改配置不会影响已经交给调用方的那份端口
  // 判断放在函数最前，禁用时不存在任何可抛错的代码路径
  // 超时、自动转后台与输出目录仍由 config.subagents 分支逐项读取，本开关不改变这些默认值
  if (this.config.subagents?.enabled === false) {
    return undefined;
  }

  return createExploreSubagentPort({
    logger: this.logger,
    inactivityTimeoutMs: this.config.subagents?.inactivityTimeoutMs,
    autoBackgroundMs: this.config.subagents?.autoBackgroundMs,
    outputRootDir: this.config.subagents?.outputRootDir,
    getAgentDefinitions: this.getAgentDefinitions,
    builtInModelSelectionOverrides: this.config.subagents?.builtInModelSelectionOverrides,
    runtimeTaskRegistry: this.runtimeTaskRegistry,
    emitParentEvent: async (event, traceContext) => {
      // 不变量 6：子代理的事件可能在 rewind 后到达，必须先校验 branchGeneration。
      // 旧分支的事件直接丢弃，不写入父事件流，避免污染当前分支的投影。
      if (isStaleBranchRuntimeTaskEvent(this, event)) return;
      await this.appendEvent(event, traceContext);
    },
    enqueueParentTaskNotification: (notification) => {
      this.enqueueBackgroundTaskNotification({
        originMeta: notification.originMeta,
        taskId: notification.taskId,
        text: notification.text,
        traceContext: notification.traceContext,
      });
      return undefined;
    },
    getAllowedTools: () => {
      return buildExploreAllowedTools({
        embeddedSearchEnabled: resolveSubagentEmbeddedSearchEnabled(),
      });
    },
    // 每次子代理派生都从这一行进入，父 runtime 只在这里创建 child，不存在第二条派生入口
    // off-peak 绑定在此刻生成，绑定对象必须活到首轮执行结束并在最外层 finally 释放
    // [并发] 多个 Agent 工具调用会并发进入本函数，父 runtime 的字段只读，child 状态全部是局部变量
    // options 在 off-peak 分支会被整体重新赋值，因此后面的读取必须发生在赋值之后
    // [失败路径] 进入 try 之前的抛错不会触发后续收尾块，所以可能抛错的准备都放进 try 内
    // request.reportActivity 是父侧 watchdog 的心跳，准备阶段再长也要先打一次
    // 子代理的并发上限与排队在 createExploreSubagentPort 更外层控制，本函数只负责单个 child
    // 子代理被禁用时端口根本不会构造，本函数也就不会被调用
    runExploreAgent: async (request, options) => {
      const offPeak = getOffPeakExecution(this);
      const childBinding = offPeak?.createChildBinding();
      if (offPeak && !offPeak.lifecycle.terminal) {
        const selection = offPeak.lifecycle.ownedByUser
          ? this.getSessionModelSelection()
          : offPeak.selection;
        if (selection)
          options = {
            ...options,
            modelOverride: {
              selection,
              requestDependencies: childBinding?.requestDependencies,
              background: "allow",
            },
          };
      }
      try {
        request.reportActivity?.();
        const builtInExplore = isBuiltInExploreAgentProfile(request.profile);
        const agentsMdInstructions =
          request.profile.injectAgentsMd !== false
            ? this.contextSourceSnapshot?.userInstructions
            : undefined;
        // 模型优先级在此一次收敛：off-peak override 高于 profile 选择，profile 高于父模型继承
        // hasConcreteModel 表示 profile 给出了具体模型，此时不允许再用父模型覆盖
        // [权衡] 不拿完整 effective options 做比较，只比稀疏 Selection，否则默认值会让复用判断永远失败
        // 父模型继承只在既没有 override 也没有具体 profile 模型时才生效
        // Core Server 的 override 最终仍被折成标准 Selection，不保留第二套模型事实
        // [失败路径] 解析结果可能对应未注册模型，要到创建 model factory 时才抛 ConfigurationError
        // child 的上下文预算与搜索策略都按这个 selection 塑形，选错会让子代理预算与父不一致
        const { selection: profileChildSelection, hasConcreteModel } = resolveSubagentSelection({
          profileSelection: request.profile.modelSelection,
          parentSelection: this.getSessionModelSelection(),
          overrideSelection: options?.modelOverride?.selection,
          resolveSelection: deps.resolveEffectiveModelSelection,
        });
        const modelOverride = options?.modelOverride;
        const inheritedModel = !modelOverride && !hasConcreteModel ? options?.model : undefined;
        // Core Server override 优先于持久化 profile 与父模型继承，但仍只是标准 Selection。
        const childSelection = inheritedModel
          ? modelSelectionFromActiveModel(inheritedModel)
          : profileChildSelection;
        const embeddedSearchEnabled = resolveSubagentEmbeddedSearchEnabled();
        const baseChildEnvInfo = this.contextSourceSnapshot?.envInfo ??
          this.config.envInfo ?? {
            cwd: request.workingDirectory,
            platform: "unknown",
            shell: "unknown",
            osVersion: "unknown",
            nodeVersion: "unknown",
          };
        const shellEnvironment = getSessionShellEnvironment(this);
        const bashShellSelection = shellEnvironment?.selection;
        const childEnvInfo = {
          ...baseChildEnvInfo,
          ...(shellEnvironment ? { shell: shellEnvironment.promptShell } : {}),
        };
        const baseAgentPrompt =
          builtInExplore && request.systemPrompt?.trim() === ""
            ? buildExploreAgentPrompt({ embeddedSearchEnabled })
            : request.systemPrompt?.trim();
        const persistentMemory = await loadPersistentAgentMemory({
          fileSystemPort: deps.fileSystemPort,
          logger: this.logger,
          memory: this.config.memory,
          profile: request.profile,
          traceContext: request.traceContext,
          workspaceRoot: request.workspaceRoot,
        });
        // 空 agent prompt 不是一个语义段；先硬拼 `\n\n` 会把缺失段的边界
        // 泄漏到 persistent Memory 开头。这里只组合非空正文，block 左边界由 builder 统一添加。
        const agentPrompt = [baseAgentPrompt, persistentMemory?.prompt]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n\n");
        const childRuntimeEnvInfo = {
          ...childEnvInfo,

          cwd: request.workingDirectory,
        };
        const officialCuaServerNames = computeOfficialCuaServerNames(
          this.config.mcp?.servers ?? {},
          new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
        );
        const preflightCuaPolicy = createOfficialCuaPolicy(
          officialCuaServerNames,
          [],
          this.config.pluginReferenceCatalog,
        );
        await validateSubagentComputerUseConfiguration(request, preflightCuaPolicy, this.skillPort);
        const childMcpAccess = await resolveSubagentMcpAccess.call(
          this,
          request,
          officialCuaServerNames,
        );
        const childToolAllowlist = resolveSubagentToolAllowlist.call(
          this,
          request,
          childMcpAccess.snapshot?.tools.map((descriptor) => toMcpToolName(descriptor)) ?? [],
        );
        validateSubagentMcpRequirements(request, childToolAllowlist, childMcpAccess);
        // 父 mode 先按 plan 语义折算：planEnabled 为真时视作 plan，避免子代理在 plan 会话里拿到执行权限
        // 第二个入参是 profile 声明的 permissionMode，只能用来收紧，不能用来提权
        // builtInExplore 决定默认值：内建 Explore 默认 yolo（本身只读），其他 agent 继承父 mode
        // [失败路径] 未知枚举回退父 mode，新增枚举不会因为不认识而被当成更宽松的那一档
        // 该结果同时决定 child 的 mode 与 planEnabled，两者必须由同一来源推导
        // [并发] 权限模式在 child 构造期固定，父会话运行中切 mode 不会回溯修改已派生的子代理
        // 若直接采用 profile 的 bypassPermissions，父的整条审批链会被整体绕过
        const childMode = resolveSubagentPermissionMode(
          this.getPlanEnabled() ? "plan" : this.config.mode,
          request.permissionMode,
          builtInExplore,
        );
        const childCuaPolicy = createOfficialCuaPolicy(
          officialCuaServerNames,
          childMcpAccess.parentSnapshot?.tools ?? childMcpAccess.snapshot?.tools ?? [],
          this.config.pluginReferenceCatalog,
        );
        await validateSubagentComputerUseConfiguration(request, childCuaPolicy, this.skillPort);
        const childSkillPort = resolveSubagentSkillPort(
          this.skillPort,
          request.profile.skills,
          childCuaPolicy,
        );
        const baseChildModelFactory = modelOverride
          ? createSubagentOverrideModelFactory(modelOverride, this.modelFactory)
          : inheritedModel
            ? createInheritedSubagentModelFactory(childSelection, inheritedModel, this.modelFactory)
            : this.modelFactory;
        if (!baseChildModelFactory) {
          throw createCoreError(
            CoreErrorType.ConfigurationError,
            `Subagent model factory cannot resolve ${childSelection.providerId}/${childSelection.modelId}`,
            { recoverable: true },
          );
        }
        const childModel = baseChildModelFactory({ selection: childSelection });
        const childModelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]> = (target) =>
          target.selection.providerId === childSelection.providerId &&
          target.selection.modelId === childSelection.modelId &&
          target.selection.options?.reasoningLevel === childSelection.options?.reasoningLevel
            ? childModel
            : baseChildModelFactory(target);
        // 这条 id 是父子两次工具调用之间唯一的关联键，镜像事件、协调响应与权限路由都靠它
        // [权衡] 通过 trace attributes 传递而不是新增构造参数，避免子代理端口再多一个必填字段
        // 取不到时保持 undefined，下游按无关联处理，不得编造一个占位 id
        // 父子身份的三个 id 分工不同：childSessionId 落库、parentSessionId 路由交互、此 id 关联单次调用
        // deriveChildClientPorts 一次派生全部交互端口，避免各处自行拼装导致身份漂移
        // parentTurnId 同样来自 traceContext，缺失时不写入，而不是写成空字符串
        // [失败路径] 若把父 sessionId 误传成 request.sessionId，权限弹窗会注册到不存在的 UI task
        // 该 id 随后还要交给协调响应端口与事件镜像，两处必须使用同一个值
        const parentToolCallId = traceStringAttribute(request.traceContext, "parentToolCallId");
        // 对外交互端口（permission broker + provider runtime headers）：与 dwf actor、legacy
        // workflow child 共用同一条派生，路由身份统一落到本 runtime 的会话。
        const childClientPorts = deriveChildClientPorts(
          {
            permissionBroker: this.permissionBroker,
            ...(this.providerRuntimeHeadersPort === undefined
              ? {}
              : { providerRuntimeHeadersPort: this.providerRuntimeHeadersPort }),
          },
          {
            agentId: request.agentId,
            agentType: request.agentType,
            childSessionId: request.sessionId,
            description: request.description,
            parentSessionId: this.sessionId,
            parentToolCallId,
            ...(request.traceContext.turnId === undefined
              ? {}
              : { parentTurnId: request.traceContext.turnId }),
          },
        );
        // Browser Use：子代理与当前对话共用 tab（tabOwner: "parent"），用户能在面板里看到它开的 tab，
        // 它也能看到对话里已有的 tab；workspace / clientMode 经 forChildSession 登记回父会话解析。
        // 子代理结束只撤销登记，不关 tab。端口没有 forChildSession（CLI headless）时退回子会话自己的 scope。
        const childBrowserControlPort =
          this.browserControlPort?.forChildSession?.({
            childSessionId: request.sessionId,
            parentSessionId: this.sessionId,
            tabOwner: "parent",
          }) ?? this.browserControlPort;
        // 这张表记录 child 工具调用 id 到工具名的映射，只在单次子代理生命周期内存在
        // mirrorSubagentToolEvent 依赖它补全工具调用配对，开始与结束事件必须落到同一项
        // [并发] child 事件可能并发到达 sink，表是唯一共享可变状态，读写都在同一事件循环内串行
        // 若在镜像之前写入映射，镜像失败会留下无人消费的条目，后续同名调用就会配错
        // [失败路径] 结束事件找不到映射时镜像层降级为无名称活动，不能整条丢弃
        // child 正文事件同样走这个 sink，但只有工具事件产生映射，正文不占用条目
        // 子代理结束后表随闭包释放，无需显式清理，也不能跨派生复用
        // [权衡] 不做跨子代理复用缓存：映射量等于单次工具调用数，复用收益抵不上陈旧数据风险
        const mirroredToolNameByChildToolCallId = new Map<string, string>();
        let sessionReadyNotified = false;
        const notifySessionReady = async () => {
          if (sessionReadyNotified) return;
          await request.onSessionReady?.();
          sessionReadyNotified = true;
        };
        this.logger?.debug("Starting subagent child runtime", {
          parentSessionId: this.sessionId,
          childSessionId: request.sessionId,
          agentType: request.agentType,
        });
        const childRuntime = new AgentRuntime(
          request.sessionId,
          {
            // 旧 plan 枚举不包含基础权限；拆分后继承完整状态，避免被构造器回退成 build。
            mode: childMode === "plan" ? this.config.mode : childMode,
            planEnabled: childMode === "plan",
            // 模型选择的影响不只在最终 request.model：MCS、内建搜索与 token/media 预算会在
            // child runtime 内按 default model 预先塑形。同步 child 因此必须把整套执行
            // 配置都指向父 turn 快照；runner 禁止它转后台，provider registry 则由父 turn
            // finally 清理，快照不会成为可恢复的 session 配置。
            modelSelection: cloneModelSelection(childSelection),
            modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
            workingDirectory: request.workingDirectory,
            // 执行模型只由 child Active Model 投影进 Context；envInfo 不保存第二份模型事实。
            envInfo: childRuntimeEnvInfo,
            // Explore 子运行时之前没有继承主会话的流式配置，Protocol 桌面端虽已默认
            // 开启 modelStreaming，子请求仍会退回 generateText。部分 OpenAI-compatible 端点在
            // 非流式请求里也返回 SSE `data:` 帧，generateText 会按普通 JSON 解析并报
            // Invalid JSON response；继承父配置可让子 agent 与主链路走同一 streamText 语义。
            modelStreaming: this.config.modelStreaming,
            bashTimeoutPolicy: this.config.bashTimeoutPolicy,
            midConversationSystem: this.config.midConversationSystem,
            toolSearch: this.config.toolSearch,
            bashShellSelection,
            // child 只复用父 runtime 已解析的 instructions snapshot；Project Context 仍不继承。
            currentDate: this.contextSourceSnapshot?.currentDate ?? this.config.currentDate,
            subagentContext: {
              agentPrompt: agentPrompt ?? "",
              ...(agentsMdInstructions ? { userInstructions: agentsMdInstructions } : {}),
            },
            agentName: `zcode-${request.agentType}`,
            maxTurns: request.maxTurns ?? this.config.subagents?.maxTurns ?? 4,
            parentSessionId: this.sessionId,
            taskType: "subagent_child",
            // 动态工作流灰度门必须结构性继承：
            // 父会话关着而子代理开着，等于 Agent 工具变成绕过灰度的后门。默认路径（child 继承
            // 父 registry 可见的工具名）本来就够，但**自定义 agent profile 显式写
            // `allowedTools: ["CreateWorkflow"]` 时会跳过那次交集**，只剩这一道能挡住。
            dynamicWorkflowEnabled: this.config.dynamicWorkflowEnabled,
            // launch.md「On demand: activation」Children 段：子代理继承父会话**此刻**的工具面——
            // 父未激活则子也按需（子会话里没有 `/workflow` 入口，实际等于没有工作流工具）；
            // 父已激活则子出生即注册。
            dynamicWorkflowToolsOnDemand:
              this.config.dynamicWorkflowToolsOnDemand === true &&
              !this.dynamicWorkflowToolsActivated,
            // 修复原因：默认 subagent 已从 Explore 调整为 general-purpose。
            // toolset 不能再依赖 DEFAULT_SUBAGENT_TYPE，否则默认通用 agent 会被误降级为只读搜索工具面。
            toolset: builtInExplore ? "explore" : "main",
            toolAllowlist: childToolAllowlist,
            toolDisallowlist: this.config.toolDisallowlist,
            embeddedSearchBackend: this.config.embeddedSearchBackend,
            nativeSearchEnhancementsEnabled: this.config.nativeSearchEnhancementsEnabled,
            subagents: {
              backgroundBashMaxMs: this.config.subagents?.backgroundBashMaxMs,
              enabled: false,
            },
            mcp: childMcpAccess.config,
          },
          {
            agentTelemetry: this.agentTelemetry.port,
            agentTelemetryCausation: this.agentTelemetry.captureCausation(),
            // 前台 child 的生命周期被父 Agent Tool await，使用真实父子 Span；后台 child
            // 可能晚于父 Tool/Turn 结束，只能作为独立 Trace 用 Link 保留因果关系。
            agentTelemetryCausationMode: request.background ? "linked_root" : "child",
            eventStore: this.eventStore,
            sessionStore: deps.sessionStore,
            // 子 runtime 继承父的模型请求准入端口：subagent 的请求 provider 同样看得见，
            // 它们该与父一样喂治理器信号（父是 observer 则子也是 observer）。
            modelRequestAdmission: this.modelRequestAdmission,
            modelFactory: childModelFactory,
            resolveEffectiveModelSelection: deps.resolveEffectiveModelSelection,
            // 子 runtime 自己仍使用 request.sessionId 做事件持久化和 trace 归档；对外阻塞交互
            // （permission / AskUserQuestion / provider runtime headers）一律路由回父 session——
            // 桌面 UI 只认识父 task 的 sessionId。派生收敛在 deriveChildClientPorts 一处，
            // dwf actor 与 legacy workflow child 走同一条。
            ...childClientPorts,
            ...(childBrowserControlPort === undefined
              ? {}
              : { browserControlPort: childBrowserControlPort }),
            coordinatorResponsePort: createCoordinatorResponsePort({
              agentId: request.agentId,
              agentType: request.agentType,
              childSessionId: request.sessionId,
              parentToolCallId,
              enqueue: (input) => this.enqueueSubagentMessage(input),
            }),
            // Explore 使用独立只读权限配置；general-purpose 和自定义 agent 继承父权限服务。
            permissionService: builtInExplore
              ? new PermissionService(defaultPermissionConfig)
              : this.permissionService,
            toolScheduler: deps.toolScheduler ?? defaultScheduler,
            executionPort: deps.executionPort,
            fileSystemPort: deps.fileSystemPort,
            // Explore 子运行时会暴露 WebFetch，但之前没有继承主 runtime 的
            // HTTP client port，导致工具在真正发请求前抛出配置错误，而不是网络请求失败。
            httpClientPort: deps.httpClientPort,
            imageProcessorPort: deps.imageProcessorPort,
            pdfDocumentPort: deps.pdfDocumentPort,
            memoryRoot: persistentMemory?.rootDir,
            mcpPort: childMcpAccess.port,
            skillPort: childSkillPort,
            artifactStore: deps.artifactStore,
            appVersion: this.appVersion,
            eventSink: {
              onSessionEvent: async (event) => {
                request.reportActivity?.();
                // child runtime 的事件已经按 childSessionId 落库，但旧链路只把
                // 少量工具事件镜像给 parent sink，导致 UI 订阅 child topic 后只能拿到打开时
                // 的 hydration，后续流式内容不会更新。raw child event 只通知父 runtime 的
                // 外部 sinks，不再次 append，因此不会重复持久化；bootstrap 再按 event.sessionId
                // 把它路由到 child publisher。
                await this.notifyEventSinks(event, {
                  ...request.traceContext,
                  sessionId: request.sessionId,
                });
                const mirroredEvent = mirrorSubagentToolEvent(event, {
                  agentId: request.agentId,
                  agentType: request.agentType,
                  background: request.background,
                  childSessionId: request.sessionId,
                  description: request.description,
                  parentSessionId: this.sessionId,
                  parentToolCallId,
                  parentTurnId: request.traceContext.turnId,
                  toolNameByChildToolCallId: mirroredToolNameByChildToolCallId,
                });
                if (!mirroredEvent) return;

                // parent mirror 保留原语义：父会话只看到 subagent 摘要/工具活动，raw child
                // 正文不会污染父 timeline。
                await this.notifyEventSinks(mirroredEvent, {
                  ...request.traceContext,
                  sessionId: this.sessionId,
                });
              },
            },
            logger: this.logger,
            traceContext: request.traceContext,
          },
        );

        // resume 只认显式的 true，其他真值不算，避免调用方误传打开一条空恢复路径
        // 恢复分支先读持久化消息再读最后一次模型选择记录，顺序决定分隔线是否重复
        // [失败路径] 没有持久化消息时抛 SessionNotFound，让调用方回到新建路径而不是创建空 session
        // 同模型恢复不重复插入分隔线，只有选择确实变化时才记录一次 pending 变更
        // 恢复只导入历史；本轮 profile 选出的模型仍是执行权威，并回写选择记录供冷恢复使用
        // 新建分支在返回前先确保 session 落库，把落库提升为父侧发布的闸门
        // [并发] 并发派生时目录查询会读到已发布但未落库的 child，闸门就是为这个窗口设的
        // 两条分支之后都会调用一次 session ready 通知，通知本身带幂等保护
        const resumesExistingChild = request.resumeFromStore === true;
        if (childBinding)
          markTemporaryRuntimeSelection(
            childRuntime as unknown as AgentRuntimeInternal,
            offPeak?.ordinarySelection,
          );
        let previousSelection: ModelSelection | undefined;
        if (resumesExistingChild) {
          const persistedMessages = await this.sessionStore?.messages({
            sessionID: request.sessionId,
          });
          // terminal resume 只恢复已有历史；模型初始化前失败不能变成一次空 session 创建。
          // 如果没有持久化消息却 resume，会创建一个空 session，导致"子代理复活但没有历史"
          // 的不一致状态——直接抛 SessionNotFound 让调用方走新建路径。
          if (!persistedMessages?.length) {
            throw createCoreError(
              CoreErrorType.SessionNotFound,
              `No transcript found for agent ${request.agentId}`,
              { recoverable: true },
            );
          }
          const entries = await this.sessionStore?.sessionEntries?.({
            sessionID: request.sessionId,
            type: SESSION_ENTRY_MODEL_SELECTION,
          });
          previousSelection = parseModelSelectionValue(entries?.at(-1)?.data);
          await childRuntime.resumeFromStore({
            persistedMessages,
            traceContext: request.traceContext,
          });
          // 恢复只导入历史；本轮 profile 选出的模型仍是执行权威，并更新冷恢复所用的选择记录。
          await persistRuntimeModelSelection(
            childRuntime as unknown as AgentRuntimeInternal,
            childSelection,
          );
        } else {
          // 父会话过去先发布 SubagentSpawned，child 的首轮 executeTurn 才落库。
          // 并发派生时目录查询会在两者之间读到少一个 child。这里把持久化提升为发布前闸门。
          await childRuntime.ensureSessionPersistedForExternalActivity(request.prompt, {
            traceContext: request.traceContext,
          });
        }
        await notifySessionReady();
        if (
          !resumesExistingChild ||
          (previousSelection && !sameModelSelection(previousSelection, childSelection))
        ) {
          // 同模型恢复不重复插入分隔线；配置变化复用现有事件和 transcript 记录。
          childRuntime.recordPendingModelChange({
            ...(previousSelection
              ? {
                  fromModel: previousSelection,
                  fromModelLabel: `${previousSelection.providerId}/${previousSelection.modelId}`,
                }
              : {}),
            toModel: childSelection,
            toModelLabel: `${childSelection.providerId}/${childSelection.modelId}`,
          });
          await childRuntime.emitModelSelected({
            modelSelection: childSelection,
            effectiveReasoningLevel: childModel.options.reasoningLevel,
            previousModelSelection: previousSelection ?? null,
            traceContext: request.traceContext,
          });
        }
        request.registerMessageSink?.(createSubagentMessageSink(childRuntime, request));
        try {
          // 这里是子代理真正开始消耗模型的地方，父只 await 这一个返回值作为结果
          // [资源] 全部收尾写在 finally，正常返回、抛错与取消三条路径都要经过它
          // abortSignal 原样透传，父取消后 child 的模型请求与工具执行同时收到中止
          // off-peak 绑定存在时同时写入任务 id 与执行域选择，内存抽取在子代理里跳过
          // inputSource 固定为 subagent，防止子代理轮次在成功率报表里被算成真实用户输入
          // inputPresentation 用 coordinator_input，与协调器转发的语义保持一致
          // [失败路径] 执行抛错时异常向上抛给父 Agent 工具，这里不吞、也不转成空结果
          // 返回 await 而不是直接返回 Promise，保证 finally 在结果交给父之前执行完毕
          return await childRuntime.executeTurn(request.prompt, undefined, {
            ...(childBinding
              ? {
                  offPeakTaskId: offPeak!.offPeakTaskId,
                  modelExecution: {
                    selectionScope: "execution" as const,
                    memoryExtraction: "skip" as const,
                  },
                }
              : { offPeakTaskId: undefined }),
            abortSignal: options?.signal,
            // 子 Runtime 的首轮输入来自父 Agent，而不是真实用户直接输入；保留源事实，避免
            // Subagent Turn 在 Trace 和成功率报表里被误归类为 user。
            inputSource: "subagent",
            inputPresentation: "coordinator_input",
            traceContext: request.traceContext,
          });
        } finally {
          const cancelled = options?.signal?.aborted === true;
          // 收尾顺序不能反：先封口通知，再取消后台任务。
          // 如果先取消后台任务，任务的完成通知可能在封口前漏进父会话，
          // 造成"子代理已结束，父会话还突然收到它的后台命令结果"。
          // 封口必须发生在取消后台任务之前，否则完成通知会在封口前漏进父会话
          // 封口原因区分取消与正常终态，父侧统计据此分辨被中止与已结束
          // [事务] 封口不可逆：一旦执行，后续任何后台完成都只留在 child 自己的记录里
          // 只有取消时才继续取消后台任务，正常终态要保留已完成的通知
          // 浏览器会话清理排在最后，它不依赖通知状态，失败只 warn
          // [失败路径] 清理浏览器会话的 catch 只记日志，不能把收尾中的抛错冒泡成子代理失败
          // 这三步与 childBinding 释放共同构成收尾契约，改动任一顺序都要重新核对
          childRuntime.sealBackgroundTaskNotifications({
            reason: cancelled ? "subagent_cancelled" : "subagent_terminal",
            traceContext: request.traceContext,
          });
          if (cancelled) {
            await childRuntime.cancelRunningRuntimeBackgroundTasks({
              reason: "subagent_cancelled",
              traceContext: request.traceContext,
            });
          }
          await childBrowserControlPort
            ?.closeSession?.({ sessionId: request.sessionId, traceContext: request.traceContext })
            .catch((error: unknown) => {
              this.logger?.warn("Subagent browser session cleanup failed", {
                error: error instanceof Error ? error.message : String(error),
                event: "browser.session_cleanup.failed",
              });
            });
        }
      } finally {
        childBinding?.release();
      }
    },
  });
}

function resolveSubagentEmbeddedSearchEnabled(): boolean {
  const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
    bashAvailable: true,
  });

  return embeddedSearchDecision.useEmbeddedSearchBranch;
}

export function createInheritedSubagentModelFactory(
  inheritedSelection: ModelSelection,
  inheritedModel: Model,
  fallbackFactory: AgentRuntimeDeps["modelFactory"],
): NonNullable<AgentRuntimeDeps["modelFactory"]> {
  return (target) => {
    if (
      target.selection.providerId === inheritedSelection.providerId &&
      target.selection.modelId === inheritedSelection.modelId &&
      target.selection.options?.reasoningLevel === inheritedSelection.options?.reasoningLevel
    ) {
      // Selection 保持显式意图的稀疏形态；不能拿它和 Active Model 的完整 effective
      // options 比较，否则默认值必然导致复用失败并让 child 重新解释可变 Registry。
      return inheritedModel;
    }
    return fallbackFactory(target);
  };
}

export function modelSelectionFromActiveModel(model: Model): ModelSelection {
  const reasoningLevel = model.options.reasoningLevel;
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

function createSubagentOverrideModelFactory(
  override: NonNullable<SubagentRunOptions["modelOverride"]>,
  fallbackFactory: AgentRuntimeDeps["modelFactory"],
): AgentRuntimeDeps["modelFactory"] {
  return (target) => {
    const model = fallbackFactory({
      ...target,
      selection: override.selection,
      requestDependencies: override.requestDependencies,
    });
    return getOffPeakModelBinding(override.requestDependencies)?.wrap(model) ?? model;
  };
}

/**
 * 把 profile 的 permissionMode 映射成 child runtime 的 mode。
 *
 * 关键约束：任何映射都只能"收紧"父会话权限——
 *   - bypassPermissions/dontAsk → inheritPermissionMode(parent, "yolo")：
 *     父不是 yolo 时不会魔法提权；
 *   - acceptEdits → edit；auto/plan 原样；
 *   - default/undefined → Explore 子代理默认 yolo（它本来只读），
 *     其它 agent 继承父 mode。
 * 未知枚举回退 parentMode，避免新增枚举被误当成"更宽松"。
 * 不变量 3：子代理权限只能收紧，不能凭 profile 提权——inheritPermissionMode
 * 内部保证"父不是 yolo 时，子也不能变成 yolo"。
 */
function resolveSubagentPermissionMode(
  parentMode: AgentRuntimeInternal["config"]["mode"],
  permissionMode: ExploreSubagentRuntimeRequest["permissionMode"],
  builtInExplore: boolean,
): AgentRuntimeInternal["config"]["mode"] {
  switch (permissionMode) {
    case "bypassPermissions":
    case "dontAsk":
      return inheritPermissionMode(parentMode, "yolo");
    case "acceptEdits":
      return "edit";
    case "auto":
      return "auto";
    case "plan":
      return "plan";
    case "default":
    case undefined:
      return inheritPermissionMode(parentMode, builtInExplore ? "yolo" : parentMode);
    default:
      return parentMode;
  }
}

/**
 * 计算 child 的工具白名单（最终交给 child runtime config）。
 *
 * 两条路径：
 *   - allowedTools 为空或含 "*"：继承父可用工具面。父的 MCP 工具还要再经
 *     父 allowlist 过滤一次，且必须使用同一份启动快照 descriptor（不能从
 *     registry 重新推导，否则父子看到的 MCP 集合会漂移）；
 *   - 显式 allowedTools：只取这些名字，并统一套 disallow rules。
 *
 * 两种路径都会：
 *   - 排除 subagent dispatch 工具（防止子代理再派生子代理造成递归放大）；
 *   - 追加 RESPOND_TO_COORDINATOR（子代理必须有回话通道，不受 profile 列表约束；
 *     全局 toolDisallowlist 仍在注册边界生效）。
 */
function resolveSubagentToolAllowlist(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
  visibleMcpToolNames: readonly string[],
): readonly string[] {
  // 子代理的 disallow 规则由父级规则与 profile 自己的规则合并，父级表达全局约束
  // 合并后统一编译成匹配规则，后面两条分支复用同一份，避免继承路径与显式路径口径不同
  // [失败路径] 继承路径里父的 MCP 工具还要再经父 allowlist 过滤，两份快照不能混用
  // 继承路径必须剔除 subagent dispatch 工具，这是递归深度的最后一道结构性防线
  // [权衡] 每次调用都重建规则而不缓存，规则依赖父配置，缓存会在配置热更新后失效
  // 显式 allowlist 路径同样套用 disallow，profile 不能靠列出工具名绕过父级禁令
  // 追加协调响应工具在两条路径末尾统一发生，保证子代理总有回话通道
  const disallowedRules = buildSubagentChildDisallowRules([
    ...(this.config.toolDisallowlist ?? []),
    ...(request.disallowedTools ?? []),
  ]);
  const inheritsAvailableTools =
    request.allowedTools.length === 0 || request.allowedTools.includes("*");
  if (inheritsAvailableTools) {
    const parentAllowedMcpToolNames = filterMcpToolNamesByParentAllowlist(
      visibleMcpToolNames,
      this.config.toolAllowlist,
    );
    const availableToolNames = [
      ...this.getTools()
        // child MCP 必须与 parent 启动 snapshot 使用同一批 descriptor，
        // 不能从另一份 registry 视图重新推导。
        .filter((tool) => tool.permission?.permission !== "mcp")
        .map((tool) => tool.name),
      ...parentAllowedMcpToolNames,
    ];
    return appendCoordinatorResponseTool(
      [...new Set(availableToolNames)]
        .filter((toolName) => !isSubagentDispatchToolName(toolName))
        .filter((toolName) => filterSubagentChildToolNames([toolName], disallowedRules).length > 0),
    );
  }
  if (request.allowedTools.length > 0) {
    return appendCoordinatorResponseTool(
      filterSubagentChildToolNames(request.allowedTools, disallowedRules),
    );
  }
  return appendCoordinatorResponseTool([]);
}

/**
 * 用父会话 allowlist 过滤 MCP 工具名。
 *
 * undefined 表示"父没有配置 allowlist"→ 全量放行；显式空数组表示"父不允许任何
 * MCP 工具"→ 全部过滤。这两种语义不能合并，否则空 allowlist 会被误读成全放行。
 */
function filterMcpToolNamesByParentAllowlist(
  toolNames: readonly string[],
  parentAllowlist: readonly string[] | undefined,
): readonly string[] {
  if (parentAllowlist === undefined) return toolNames;
  const allowed = new Set(parentAllowlist);
  return toolNames.filter((toolName) => allowed.has(toolName));
}

function isModelVisibleMcpToolName(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

function appendCoordinatorResponseTool(toolNames: readonly string[]): readonly string[] {
  if (toolNames.includes(RESPOND_TO_COORDINATOR_TOOL_NAME)) {
    return toolNames;
  }

  // child 控制通道不受 profile 工具列表约束；全局 toolDisallowlist 仍在 runtime 注册边界生效。
  return [...toolNames, RESPOND_TO_COORDINATOR_TOOL_NAME];
}

interface ResolvedSubagentMcpAccess {
  config: { enabled?: boolean } | undefined;
  port: McpPort | undefined;
  parentSnapshot: McpConnectionSnapshot | undefined;
  snapshot: McpConnectionSnapshot | undefined;
}

/**
 * 解析 child 的 MCP 访问方式。
 *
 * child 永远不拥有 MCP 连接生命周期，只可能：
 *   - 借用父启动快照（createBorrowedSubagentMcpAccess，按 profile.mcpServers 收窄）；
 *   - 完全禁用（父未启用 MCP 或父关闭）。
 *
 * 失败策略分两种：
 *   - profile 显式要求了 server（scopedServerNames）却拿不到 → 直接抛
 *     ConfigurationError（用户显式配置必须被尊重，不能静默降级）；
 *   - profile 没显式要求 → 返回空访问，让子代理以"无 MCP 工具"运行。
 * 未连接的 scoped server 同样抛错，错误 context 带 missingMcpServers 供 UI 展示。
 * 这是 fail-closed 与 fail-open 的边界：显式配置 fail-closed（必须满足），
 * 隐式继承 fail-open（没有就不用）。
 */
async function resolveSubagentMcpAccess(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
  officialCuaServerNames: ReadonlySet<string>,
): Promise<ResolvedSubagentMcpAccess> {
  if (!shouldBorrowParentMcp(request)) {
    return { config: undefined, parentSnapshot: undefined, port: undefined, snapshot: undefined };
  }

  const scopedServerNames = request.profile.mcpServers?.length
    ? request.profile.mcpServers
    : undefined;
  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    if (scopedServerNames) {
      throw createSubagentMcpUnavailableError(request);
    }
    return {
      config: this.config.mcp?.enabled === false ? { enabled: false } : undefined,
      parentSnapshot: undefined,
      port: undefined,
      snapshot: undefined,
    };
  }

  // child 不拥有连接生命周期，只能复用 parent constructor 已创建的启动快照。
  const parentStartupSnapshot = await this.mcpStartupPromise;
  if (!parentStartupSnapshot) {
    if (scopedServerNames) {
      throw createSubagentMcpUnavailableError(request);
    }
    return { config: undefined, parentSnapshot: undefined, port: undefined, snapshot: undefined };
  }

  const unavailableScopedServerNames = (scopedServerNames ?? []).filter(
    (serverName) => parentStartupSnapshot.statuses[serverName]?.status !== "connected",
  );
  if (unavailableScopedServerNames.length > 0) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Required MCP server is not connected: ${unavailableScopedServerNames.join(", ")}`,
      {
        context: {
          agentType: request.agentType,
          missingMcpServers: unavailableScopedServerNames,
        },
        recoverable: true,
      },
    );
  }

  const borrowed = createBorrowedSubagentMcpAccess(
    this.mcpPort,
    parentStartupSnapshot,
    scopedServerNames,
    officialCuaServerNames,
  );
  return {
    config: { enabled: true },
    parentSnapshot: parentStartupSnapshot,
    port: borrowed.port,
    snapshot: borrowed.snapshot,
  };
}

/**
 * 判断 child 是否需要借用父 MCP 访问。
 *
 * 三种情况需要：profile 显式列了 mcpServers；工具面是继承制（空/"*"）；
 * allowedTools 里出现具体 mcp__ 工具名或 server 选择器（mcp / mcp__server__*）。
 * 仅当 profile 只列普通工具时完全不借，避免平白把 MCP 工具挂进子代理。
 */
function shouldBorrowParentMcp(request: ExploreSubagentRuntimeRequest): boolean {
  if ((request.profile.mcpServers?.length ?? 0) > 0) return true;
  if (request.allowedTools.length === 0 || request.allowedTools.includes("*")) return true;
  return request.allowedTools.some((toolName) => {
    const normalized = toolName.trim();
    return isConcreteMcpToolName(normalized) || isMcpServerSelector(normalized);
  });
}

/**
 * 校验"显式要求的 MCP 工具/服务器"是否真的可用。
 *
 * 只在显式 allowlist 路径生效（继承路径跳过：父可见即子可见）。
 * 检查顺序：先看是否有 MCP 访问能力 → 再查 server 连接状态 →
 * 最后查具体工具是否在启动快照里。错误都带上缺失项清单，便于用户直接修配置。
 */
function validateSubagentMcpRequirements(
  request: ExploreSubagentRuntimeRequest,
  effectiveAllowedTools: readonly string[],
  access: ResolvedSubagentMcpAccess,
): void {
  const inheritsAvailableTools =
    request.allowedTools.length === 0 || request.allowedTools.includes("*");
  if (inheritsAvailableTools) return;

  const normalizedAllowedTools = effectiveAllowedTools.map((toolName) => toolName.trim());
  const requiredToolNames = normalizedAllowedTools.filter(isConcreteMcpToolName);
  const requiredServerNames = extractRequiredMcpServerNames(
    normalizedAllowedTools.filter(isMcpServerSelector),
  );
  if (requiredToolNames.length === 0 && requiredServerNames.length === 0) return;
  if (!access.port || !access.snapshot) {
    throw createSubagentMcpUnavailableError(request, requiredToolNames);
  }
  const snapshot = access.snapshot;

  const unavailableServerNames = requiredServerNames.filter(
    (serverName) => !matchesRequiredMcpServer(serverName, snapshot.statuses),
  );
  if (unavailableServerNames.length > 0) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Required MCP server is not connected: ${unavailableServerNames.join(", ")}`,
      {
        context: {
          agentType: request.agentType,
          missingMcpServers: unavailableServerNames,
        },
        recoverable: true,
      },
    );
  }

  const visibleToolNames = new Set(snapshot.tools.map((descriptor) => toMcpToolName(descriptor)));
  const missingToolNames = requiredToolNames.filter((toolName) => !visibleToolNames.has(toolName));
  if (missingToolNames.length === 0) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `Required MCP tool is not available in the parent startup snapshot: ${missingToolNames.join(", ")}`,
    {
      context: {
        agentType: request.agentType,
        missingMcpTools: missingToolNames,
      },
      recoverable: true,
    },
  );
}

function isConcreteMcpToolName(toolName: string): boolean {
  return isModelVisibleMcpToolName(toolName) && !isMcpServerSelector(toolName);
}

function isMcpServerSelector(toolName: string): boolean {
  return toolName === "mcp" || (toolName.startsWith("mcp__") && toolName.endsWith("__*"));
}

function createSubagentMcpUnavailableError(
  request: ExploreSubagentRuntimeRequest,
  requiredToolNames: readonly string[] = [],
) {
  return createCoreError(
    CoreErrorType.ConfigurationError,
    "Subagent MCP is unavailable because the parent startup snapshot is unavailable",
    {
      context: {
        agentType: request.agentType,
        requiredMcpTools: requiredToolNames,
      },
      recoverable: true,
    },
  );
}

function resolveSubagentSkillPort(
  parentSkillPort: SkillPort | undefined,
  skillNames: readonly string[] | undefined,
  cuaPolicy: OfficialCuaPolicy,
): SkillPort | undefined {
  if (!parentSkillPort) {
    return parentSkillPort;
  }
  return new FilteredSkillPort(
    parentSkillPort,
    skillNames && skillNames.length > 0 ? new Set(skillNames) : undefined,
    cuaPolicy,
  );
}

/**
 * 子代理技能端口：在父 SkillPort 之上加两层过滤。
 *
 *   1) 白名单：profile.skills 存在时只暴露这些 skill（bare name 或 qualified name 均可匹配）；
 *   2) CUA 隔离：官方 Computer Use skill 对子代理一律不可见/不可加载
 *      （占位构建下 CUA 能力本就 fail closed，这里提前把请求变成明确错误）。
 *
 * 为什么要按 qualified name 回绑：父端可能同时存在同名 plugin skill，
 * 直接用子代理传来的 bare alias 去 loadSkill 会加载到错误的那一个。
 * 多个匹配时报 ambiguous 错误，要求调用方使用全名，而不是猜一个。
 */
class FilteredSkillPort implements SkillPort {
  constructor(
    private readonly parent: SkillPort,
    private readonly allowedSkills: ReadonlySet<string> | undefined,
    private readonly cuaPolicy: OfficialCuaPolicy,
  ) {}

  async discoverSkills(
    request: Parameters<SkillPort["discoverSkills"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome> {
    const outcome = await this.parent.discoverSkills(request, options);
    const skills = outcome.skills.filter((skill) => this.isAllowedSkill(skill));
    return {
      ...outcome,
      skills,
      totalDiscovered: skills.length,
    };
  }

  async loadSkill(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillContent> {
    if (
      this.cuaPolicy.isOfficialSkillRequest(request.name) ||
      (await this.hasUniqueOfficialSkillMatch(request, options))
    ) {
      throw createSubagentComputerUseUnavailableError(request.name);
    }
    const resolvedName = await this.resolveAllowedSkillRequestName(request, options);
    if (!resolvedName) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Skill is not allowed for subagent",
        {
          context: {
            allowedSkills: this.allowedSkills ? [...this.allowedSkills] : [],
            skill: request.name,
            toolName: "Skill",
          },
          recoverable: true,
        },
      );
    }
    return this.parent.loadSkill({ ...request, name: resolvedName }, options);
  }

  private async hasUniqueOfficialSkillMatch(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<boolean> {
    if (request.name.includes(":")) return false;
    const outcome = await this.parent.discoverSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
        trace: request.trace,
      },
      options,
    );
    return isUniqueOfficialSkillRequest(outcome.skills, request.name, this.cuaPolicy);
  }

  private isAllowedSkill(skill: SkillContent["metadata"]): boolean {
    if (this.cuaPolicy.isOfficialSkill(skill)) return false;
    return (
      this.allowedSkills === undefined ||
      this.allowedSkills.has(skill.name) ||
      (skill.qualifiedName !== undefined && this.allowedSkills.has(skill.qualifiedName))
    );
  }

  private async resolveAllowedSkillRequestName(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<string | undefined> {
    const outcome = await this.discoverSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
        trace: request.trace,
      },
      options,
    );
    const matches = outcome.skills.filter((skill) => matchesSkillRequestName(skill, request.name));
    if (matches.length === 0) {
      return undefined;
    }
    if (matches.length > 1) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Skill name is ambiguous for subagent; use the fully qualified skill name",
        {
          context: {
            allowedSkills: this.allowedSkills ? [...this.allowedSkills] : [],
            matchingSkills: matches.map((skill) => skill.qualifiedName ?? skill.name),
            skill: request.name,
            toolName: "Skill",
          },
          recoverable: true,
        },
      );
    }
    // 可见 skills 列表会把 plugin skill 展示为 qualified name，并声明 bare alias 也可加载。
    // 子 agent 按 bare alias 调用时，先绑定回过滤后的 metadata，避免父端按全局同名 skill 误加载。
    return matches[0]?.qualifiedName ?? matches[0]?.name;
  }
}

/**
 * 预检 CUA 配置：profile 显式要求官方 Computer Use（server / tool / skill）时，
 * 在创建 child runtime 之前就给出明确的 ConfigurationError。
 *
 * 为什么要在创建前拦：占位构建里 CUA 会一路 fail closed，等到工具执行时再报错
 * 会让用户看到一个"跑了一半"的子代理；提前预检能保留完整 context（哪个 server/
 * tool/skill 触发的），并避免浪费一次 child runtime 初始化。
 * skill 的歧义检查是 lazy 的：discovery 失败会被忽略，留给真正 load 时报错。
 */
async function validateSubagentComputerUseConfiguration(
  request: ExploreSubagentRuntimeRequest,
  cuaPolicy: OfficialCuaPolicy,
  parentSkillPort: SkillPort | undefined,
): Promise<void> {
  const explicitServer = request.profile.mcpServers?.find((serverName) =>
    cuaPolicy.serverNames.has(serverName.trim()),
  );
  const explicitTool = request.allowedTools.find(
    (toolName) =>
      cuaPolicy.isOfficialToolRequest(toolName) || cuaPolicy.isOfficialServerSelector(toolName),
  );
  let explicitSkill = request.profile.skills?.find((skillName) =>
    cuaPolicy.isOfficialSkillRequest(skillName),
  );
  if (!explicitSkill && parentSkillPort && request.profile.skills?.length) {
    try {
      const outcome = await parentSkillPort.discoverSkills({
        workingDirectory: request.workingDirectory,
        trace: request.traceContext,
      });
      explicitSkill = request.profile.skills.find((skillName) =>
        isUniqueOfficialSkillRequest(outcome.skills, skillName, cuaPolicy),
      );
    } catch {
      // Skill discovery remains lazy; a later Skill load will surface its own error.
    }
  }
  if (!explicitServer && !explicitTool && !explicitSkill) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
    {
      context: {
        agentType: request.agentType,
        code: SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
        ...(explicitServer ? { mcpServer: explicitServer } : {}),
        ...(explicitTool ? { mcpTool: explicitTool } : {}),
        ...(explicitSkill ? { skill: explicitSkill } : {}),
      },
      recoverable: true,
    },
  );
}

export function isUniqueOfficialSkillRequest(
  skills: readonly SkillContent["metadata"][],
  requestName: string,
  cuaPolicy: Pick<OfficialCuaPolicy, "isOfficialSkill">,
): boolean {
  if (requestName.includes(":")) return false;
  const matches = skills.filter((skill) => matchesSkillRequestName(skill, requestName));
  return matches.length === 1 && matches[0] !== undefined && cuaPolicy.isOfficialSkill(matches[0]);
}

function createSubagentComputerUseUnavailableError(skillName: string) {
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
    {
      context: {
        code: SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
        skill: skillName,
        toolName: "Skill",
      },
      recoverable: true,
    },
  );
}

function matchesSkillRequestName(skill: SkillContent["metadata"], requestName: string): boolean {
  return skill.name === requestName || skill.qualifiedName === requestName;
}

function traceStringAttribute(
  traceContext: { attributes?: Record<string, string | number | boolean> },
  key: string,
): string | undefined {
  const value = traceContext.attributes?.[key];
  return typeof value === "string" ? value : undefined;
}
