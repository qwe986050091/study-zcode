/**
 * workflow-facade：expert/workflow 脚本执行面（非 dwf run）。
 * 定位：文件型 workflow store/definition store → ExpertWorkflowRuntime（按定义版本缓存）→
 *   workflowAgentRunner（每次活动起一个 child AgentRuntime）→ createWorkflowMethods 暴露给 App。
 * 所有权：child runtime 复用父会话的 sessionStore/modelFactory/permissionService/端口，不单独释放；
 *   客户端交互端口由父 runtime 派生（createChildClientPorts），避免子会话收到客户端不认识的身份。
 * 失败语义：定义缺失/kind 不匹配直接抛错；单个活动失败由 ExpertWorkflowRuntime 收敛为 run 状态。
 * 不变量：同一个 (definitionId, definitionVersion, kind) 只对应一个 ExpertWorkflowRuntime。
 */
// INV-01 两个文件型 store 必须共用 cliStorageRoot 下的 workflows 目录但保持实例分离；守住位置：workflowStore 与 workflowDefinitionStore 的 rootDir；改错故障：run 记录与定义落在不同根下，按 runId 回查定义会 not found，resume 直接失败
// INV-02 缓存键必须是 definitionId、definitionVersion、kind 三元组；守住位置：workflowRuntimeForDefinition 的 cacheKey 拼接；改错故障：漏掉版本后定义换代仍命中旧 runtime，用户改完脚本却还在执行上一版
// INV-03 内建 expert 定义只在未指定 definitionId 且 kind 等于内建 kind 时生效；守住位置：resolveWorkflowDefinition 的首个分支；改错故障：放宽条件会把用户自定义定义静默降级成内建 expert
// INV-04 definitionId 与显式 workflowKind 冲突时必须抛错而不是择一返回；守住位置：resolveWorkflowDefinition 的 kind 比对；改错故障：猜一个会让活动记进错误 kind 的 run 列表，status 查不到
// INV-05 模型选择必须取父会话当前值传给 child runtime；守住位置：run 内对 getSessionModelSelection 的调用；改错故障：新建默认值会让子会话跑在与父会话不同的模型上
// INV-06 Shell 选择必须继承父会话；守住位置：createWorkflowChildRuntime 的 bashShellSelection；改错故障：跳过继承会让 child 用 app 创建阶段尚未初始化的静态配置
// INV-07 客户端交互端口必须由父 runtime 派生；守住位置：createChildClientPorts 的展开注入；改错故障：直接透传 appOptions 端口会让反向请求落到客户端不认识的 session，response 永不返回
// INV-08 child 必须有独立的内存 eventStore；守住位置：AgentRuntime 依赖里的 eventStore；改错故障：复用父 store 会把 workflow 事件写进父会话时间线
// INV-09 child 的 mode 固定为 yolo 且不继承审批；守住位置：runtimeConfig 的 mode 覆盖；改错故障：改回继承会让后台 workflow 活动被 guarded 审批长期挂住
// INV-10 agentTelemetryCausationMode 必须是 linked_root；守住位置：telemetry 依赖注入处；改错故障：伪装成同步 child 会让 workflow span 挂在已返回的父工具 span 下，链路错乱
// INV-11 sessionStore、modelFactory、permissionService 全部借用父会话；守住位置：createWorkflowChildRuntime 的依赖透传；改错故障：child 自行新建会让父会话看不到子会话的持久化结果
// INV-12 [资源] 每次活动新建 child AgentRuntime 但复用父端口，新建端口未登记关闭并随进程结束；守住位置：appOptions 端口缺省分支；改错故障：每次另建 Node 适配器会泄漏子进程与临时输出目录
// INV-13 [并发] workflowRuntimeCache 的查与写必须在同一同步段完成；守住位置：workflowRuntimeForDefinition 内部；改错故障：中间插入 await 后两个并发启动会各建一个 runtime，同一活动出现双执行
// INV-14 [事务] 启动活动前必须先落定用户执行边界；守住位置：workflowAgentRunner 的首个 await；改错故障：跳过会让 shell selection 与 run 快照不一致，活动记录指向错误工作目录
// INV-15 [失败路径] 单个活动失败由 ExpertWorkflowRuntime 收敛为 run 状态；守住位置：runner 的 try 段；改错故障：在 runner 内重新抛出会让 run 丢失失败快照，状态永远停在 running
// INV-16 [失败路径] 定义缺失必须直接抛错，不得回退内建定义；守住位置：readDefinition 返回空后的分支；改错故障：回退会让用户误以为自己的定义正在执行
// INV-17 按 runId 查状态必须先读 run 快照再解析定义；守住位置：workflowRuntimeForLookup 的快照分支；改错故障：拿当前请求 definitionId 顶替会让旧版本 run 的 status 与 stop 打到新 runtime
// INV-18 guarded 模式必须原样保留，不得被静默切成 yolo；守住位置：switchWorkflowToYolo 的模式判断；改错故障：抹掉 guarded 会绕过审批链，高风险工具调用无人确认
//
// 模块职责：装配 workflow 门面的文件型 store、按定义版本缓存 runtime、为每次活动派生 child AgentRuntime，并暴露 list/run/resume/stop/status 等方法。
// 状态所有权：父会话的 sessionStore、modelFactory、permissionService、端口与 traceContext 归父 App；本文件只独占两个 store 与 workflowRuntimeCache。
// 阅读顺序：先看 CreateWorkflowFacadeDeps 的借用关系，再看 workflowAgentRunner 与 resolveWorkflowDefinition，最后看 createWorkflowChildRuntime 的隔离边界。
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { ConfigResult } from "@zcode/adapters/config";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import {
  createNodeWorkflowDefinitionStore,
  createNodeWorkflowStore,
} from "@zcode/adapters/workflow";
import {
  AgentRuntime,
  ExpertWorkflowRuntime,
  createExpertWorkflowDefinition,
  type AgentRuntimeConfig,
  type AgentRuntimeDeps,
  type PermissionService,
  type WorkflowAgentRunner,
} from "@zcode/core";
import {
  type AgentExecutionTelemetryPort,
  createChildTraceContext,
  createSessionId,
  type ContextSourcePort,
  type ExecutionPort,
  type FileSystemPort,
  type HttpClientPort,
  type ImageProcessorPort,
  type PdfDocumentPort,
  type Logger,
  type McpPort,
  type SessionEventSink,
  type SessionId,
  type SessionStorePort,
  type ToolArtifactStorePort,
  type TraceContext,
  type WorkflowDefinition,
} from "@zcode/contracts";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import type { PrepareUserExecutionBoundary, ZCodeAppOptions } from "./types.js";
import { createWorkflowMethods, type WorkflowFacade } from "./workflow-methods.js";

/**
 * 门面依赖：runtime/sessionStore/modelFactory/permissionService 都来自父会话（共享事实源）；
 * appOptions 里的端口是可注入的借用资源，缺省时本文件按配置另建。
 */
// 依赖全部由父会话注入，runtime、sessionStore、modelFactory、permissionService 是共享事实源，不得在此新建
// appOptions 里的端口属于可借用资源，缺省时才由本文件按配置另建
// [权衡] modelFactory 设为必填而非可选，迫使调用方显式传父会话那一份，避免 child 各自冻结一套
interface CreateWorkflowFacadeDeps {
  agentTelemetry: AgentExecutionTelemetryPort;
  appOptions: ZCodeAppOptions;
  appVersion: string;
  artifactStore?: ToolArtifactStorePort;
  cliStorageRoot: string;
  configResult: ConfigResult;
  contextSourcePort?: ContextSourcePort;
  eventSink?: SessionEventSink;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  logger: Logger;
  mcpPort?: McpPort;
  /** 父会话的 model factory（与 script-workflow-child-runtime.ts 同一约定）。 */
  modelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]>;
  permissionService: PermissionService;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  runtime: AgentRuntime;
  runtimeConfig: AgentRuntimeConfig;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  storageRoot: string;
  traceContext: TraceContext;
  workingDirectory: string;
}

/**
 * 构造 workflow 门面。同步初始化两个文件型 store 与一个空 runtime 缓存，不读写磁盘。
 * 输入：见 CreateWorkflowFacadeDeps；modelFactory 必须是父会话那一份，child 不各自冻结。
 * 输出：WorkflowFacade（list/run/resume/stop/status/retry 等方法的集合，含脚本 workflow 别名）。
 * 副作用：活动启动时会持久化会话、起 child AgentRuntime、写 run 快照；缓存会常驻到 App 关闭。
 * 不变量：workflowKind 缺省为内建 expert kind；definitionId 与 kind 冲突时抛错而不是猜一个。
 */
// facade 构造是同步的，只建两个 store 与空缓存，不读写磁盘，因此可在 App 初始化阶段直接调用
// 返回的 WorkflowFacade 覆盖 list、run、resume、stop、status、retry，脚本 workflow 只是别名，不另开入口
// [失败路径] 此函数不吞解析错误，定义缺失要到首次活动启动才抛出，而不是在构造期提前暴露
export function createWorkflowFacade(deps: CreateWorkflowFacadeDeps): WorkflowFacade {
  // run 快照与定义各用一个 store，共用同一 rootDir：职责分离，避免"读定义时误读到 run"。
  // run 快照 store 独占 run 记录的读写，与定义 store 共用 rootDir 但职责分离
  // 共用 rootDir 让 run 与定义落在同一份存储根下，迁移时只需搬一个目录
  // [失败路径] 若两者 rootDir 写成不同路径，按 runId 查到的定义会与 run 记录脱节
  const workflowStore = createNodeWorkflowStore({
    rootDir: join(deps.cliStorageRoot, "workflows"),
  });
  // 定义 store 只读定义文件，写入由外部工作流管理命令负责，facade 不在此落盘
  // [权衡] 读定义与写 run 分成两个实例，避免同一目录下读写语义混在一个对象里
  const workflowDefinitionStore = createNodeWorkflowDefinitionStore({
    rootDir: join(deps.cliStorageRoot, "workflows"),
  });
  const builtInExpertWorkflowDefinition = createExpertWorkflowDefinition();
  // 缓存键含 definitionVersion：定义换代后必须新建 runtime，否则旧定义会借缓存继续在内存生效。
  // 缓存以 definitionId、definitionVersion、kind 拼成的字符串为键，三个维度缺一不可
  // 版本参与键是硬性要求，定义换代后必须新建 runtime，否则旧定义会借缓存继续在内存生效
  // [资源] 缓存常驻到 App 关闭，没有淘汰策略，这是有意为之，因为 runtime 持有活动执行状态，中途丢弃会让进行中的 run 失联
  const workflowRuntimeCache = new Map<string, ExpertWorkflowRuntime>();
  // runner 每次活动新建 child AgentRuntime，先统一用户执行边界再执行单个 turn
  // 子 sessionId 由活动 id 派生，同一活动重试会得到新 id，避免事件写进上一次的会话
  // [失败路径] finally 只退订事件不关闭 child，child 借用父端口，关闭语义归父 App，提前关闭会让后续轮次写失败
  const workflowAgentRunner: WorkflowAgentRunner = {
    // 每次工作流活动起一个独立 child AgentRuntime：先统一用户执行边界（shell selection 落定），
    // 再生成子 sessionId/子 trace，最后执行单个 turn。finally 只退订，不关闭 child——
    // child 借用父 store/端口，关闭语义归父 App。
    run: async (request) => {
      await deps.prepareUserExecutionBoundary({ traceContext: request.traceContext });
      const workflowKind = request.workflowKind ?? builtInExpertWorkflowDefinition.kind;
      const childSessionId = createSessionId(`workflow_${request.activityId}`);
      const childTraceContext = createChildTraceContext(request.traceContext ?? deps.traceContext, {
        attributes: {
          parentSessionId: deps.sessionId,
          workflowActivityId: request.activityId,
          workflowKind,
          workflowPhase: request.phase,
          workflowRunId: request.runId,
        },
        sessionId: childSessionId,
      });
      const parentSelection = deps.runtime.getSessionModelSelection();
      await request.onChildSessionStarted?.({
        model: parentSelection
          ? `${parentSelection.providerId}/${parentSelection.modelId}`
          : undefined,
        sessionId: childSessionId,
        traceId: childTraceContext.traceId,
      });
      const childRuntime = createWorkflowChildRuntime(deps, {
        childSessionId,
        childTraceContext,
        workflowKind,
      });
      const unsubscribe = request.onEvent
        ? childRuntime.subscribeEvents({ onSessionEvent: request.onEvent })
        : undefined;

      try {
        const result = await childRuntime.executeTurn(request.prompt, undefined, {
          abortSignal: request.abortSignal,
          inputSource: "subagent",
          traceContext: childTraceContext,
        });
        const childSelection = childRuntime.getSessionModelSelection();
        return {
          model: childSelection
            ? `${childSelection.providerId}/${childSelection.modelId}`
            : undefined,
          response: result.response,
          sessionId: childSessionId,
          traceId: result.traceId,
          turnId: result.turnId,
        };
      } finally {
        unsubscribe?.();
      }
    },
  };

  // 定义解析：只有"未指定 definitionId 且 kind 是内建 expert"才走内建，避免把用户定义静默降级成内建；
  // definitionId 与显式 kind 不一致时直接报错，不猜调用方想要哪一个。
  // 只有未指定 definitionId 且 kind 是内建 expert 时才返回内建定义，其余一律走文件型 store
  // definitionId 与显式 kind 不一致时直接抛错，不猜调用方意图，错误信息同时给出实际 kind 与期望 kind
  // [失败路径] 回退到内建定义会把用户自定义工作流静默降级，线上表现为改了脚本却毫无变化
  const resolveWorkflowDefinition = async (input?: {
    definitionId?: string;
    workflowKind?: string;
  }): Promise<WorkflowDefinition> => {
    const requestedKind = input?.workflowKind ?? builtInExpertWorkflowDefinition.kind;
    const requestedDefinitionId = input?.definitionId;
    if (!requestedDefinitionId && requestedKind === builtInExpertWorkflowDefinition.kind) {
      return builtInExpertWorkflowDefinition;
    }

    const lookupId = requestedDefinitionId ?? requestedKind;
    const definition = await workflowDefinitionStore.readDefinition(lookupId);
    if (!definition) {
      throw new Error(`Workflow definition not found: ${lookupId}`);
    }
    if (input?.workflowKind && definition.kind !== input.workflowKind) {
      throw new Error(
        `Workflow definition ${definition.definitionId} has kind ${definition.kind}, expected ${input.workflowKind}`,
      );
    }
    return definition;
  };

  // 先按三元组查缓存，命中直接返回，未命中才构造 ExpertWorkflowRuntime 并回填
  // 构造时把 agentRunner、definition、事件回调与 workflowStore 一次性注入，runtime 之后不再换定义
  // [并发] 查与写必须在同一同步段内完成，中间不得插入 await，否则两个并发启动会各建一个 runtime
  const workflowRuntimeForDefinition = (definition: WorkflowDefinition): ExpertWorkflowRuntime => {
    const cacheKey = [definition.definitionId, definition.definitionVersion, definition.kind].join(
      ":",
    );
    const cached = workflowRuntimeCache.get(cacheKey);
    if (cached) return cached;
    const runtimeForDefinition = new ExpertWorkflowRuntime({
      agentRunner: workflowAgentRunner,
      definition,
      onWorkflowEvent: deps.appOptions.onWorkflowEvent,
      store: workflowStore,
    });
    workflowRuntimeCache.set(cacheKey, runtimeForDefinition);
    return runtimeForDefinition;
  };

  const workflowRuntimeForRequest = async (input?: {
    definitionId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowRuntime> =>
    workflowRuntimeForDefinition(await resolveWorkflowDefinition(input));

  // 按 runId 查状态时必须先读 run 快照再定位定义：run 可能属于旧版本定义，不能拿当前请求的
  // definitionId 顶替；只有快照缺失时才退回按请求参数解析。
  // 按 runId 查询时必须先读 run 快照，快照里的 definitionId 与 kind 才是该 run 的真实归属
  // 快照缺失时才退回按请求参数解析，这条兜底只用于尚未落盘的新 run
  // [失败路径] 用当前请求 definitionId 顶替快照会让旧版本 run 的 stop 与 status 打到新 runtime，旧活动永远停不下来
  const workflowRuntimeForLookup = async (input?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowRuntime> => {
    if (input?.runId) {
      const snapshot = await workflowStore.readRun(input.runId, { signal: input.abortSignal });
      if (snapshot) {
        if (
          snapshot.kind === builtInExpertWorkflowDefinition.kind &&
          (snapshot.definitionId === undefined ||
            snapshot.definitionId === builtInExpertWorkflowDefinition.definitionId)
        ) {
          return workflowRuntimeForDefinition(builtInExpertWorkflowDefinition);
        }
        return workflowRuntimeForDefinition(
          await resolveWorkflowDefinition({
            definitionId: snapshot.definitionId,
            workflowKind: snapshot.kind,
          }),
        );
      }
    }
    return workflowRuntimeForRequest({
      definitionId: input?.definitionId,
      workflowKind: input?.workflowKind,
    });
  };

  // 传了 definitionId 时要先解析定义并以其 kind 覆盖查询条件，否则会列出其它 kind 的 run
  // 查询始终带 cwd 与可选 limit，abortSignal 一路透传给 store，取消后不得继续遍历
  const listWorkflowRuns: NonNullable<WorkflowFacade["listWorkflows"]> = async (options) => {
    let workflowKind = options?.workflowKind;
    if (options?.definitionId) {
      const definition = await resolveWorkflowDefinition({
        definitionId: options.definitionId,
        workflowKind,
      });
      workflowKind = definition.kind;
    }
    return workflowStore.listRuns(
      { cwd: deps.workingDirectory, kind: workflowKind, limit: options?.limit },
      { signal: options?.abortSignal },
    );
  };

  const workflowExternalActivityPrompt = (definition: WorkflowDefinition, task: string): string =>
    definition.kind === builtInExpertWorkflowDefinition.kind
      ? `/expert ${task}`
      : `/workflow ${definition.kind} ${task}`;

  // 已处于 yolo 或 guarded 时保持原样（guarded 的审批链不能被静默抹掉）；其它模式切到 yolo，
  // 避免前台工作流活动被交互式审批长期挂住。
  // 只在当前模式既非 yolo 也非 guarded 时切到 yolo，避免前台活动被交互审批长期挂住
  // guarded 必须原样保留，审批链不能被静默抹掉
  // [权衡] 切 yolo 换取无人值守，代价是工作流活动内的工具调用不再逐次确认
  const switchWorkflowToYolo = (): void => {
    if (deps.runtime.getMode() !== "yolo" && deps.runtime.getMode() !== "guarded") {
      deps.runtime.updateConfig({ mode: "yolo" });
    }
  };

  // 启动输入统一在此解析定义并取 runtime，run 与 resume 走同一份装配逻辑
  // defaultKind 只在调用方没有显式 kind 时兜底，不得覆盖用户传入的 kind
  const createStartInput = async (
    input: { definitionId?: string; task: string; workflowKind?: string },
    defaultKind?: string,
  ) => {
    const definition = await resolveWorkflowDefinition({
      definitionId: input.definitionId,
      workflowKind: input.workflowKind ?? defaultKind,
    });
    const workflow = workflowRuntimeForDefinition(definition);
    return { definition, workflow };
  };

  const persistWorkflowActivity = async (
    definition: WorkflowDefinition,
    task: string,
    traceContext: TraceContext,
  ): Promise<void> => {
    await deps.runtime.ensureSessionPersistedForExternalActivity(
      workflowExternalActivityPrompt(definition, task),
      { traceContext },
    );
  };

  // 门面方法集合在此一次性注入依赖，builtInExpertWorkflowDefinition 与 traceContext 都按父会话那一份传
  // workingDirectory 与 sessionId 直接来自 deps，方法内部不再重新推导
  // [失败路径] 漏传 workflowRuntimeForLookup 会让 status 与 stop 退化成按请求参数解析，旧 run 定位失败
  return createWorkflowMethods({
    builtInExpertWorkflowDefinition,
    createStartInput,
    listWorkflowRuns,
    prepareUserExecutionBoundary: deps.prepareUserExecutionBoundary,
    persistWorkflowActivity,
    sessionId: deps.sessionId,
    switchWorkflowToYolo,
    traceContext: deps.traceContext,
    workflowRuntimeForLookup,
    workingDirectory: deps.workingDirectory,
  });
}

/**
 * 为一次工作流活动构造 child AgentRuntime。
 * 共享：sessionStore / modelFactory / permissionService / telemetry 全部来自父会话；
 *   端口优先用 appOptions 注入的，缺省才新建（这些新建端口未单独登记关闭，随进程结束）。
 * 隔离：mode 固定 yolo（workflow child 不在 Guarded 合同内）、独立内存 eventStore、独立 sessionId/trace。
 * 反直觉：客户端交互端口必须由父 runtime 派生，直接透传 appOptions 会让反向请求落到客户端不认识的会话。
 */
// child runtime 的 sessionStore、modelFactory、permissionService、telemetry 全部继承父会话
// 端口优先用 appOptions 注入的，缺省才新建，新建的端口未单独登记关闭，随进程结束
// [隔离] mode 固定 yolo、eventStore 独立、sessionId 与 trace 独立，workflow child 不在 Guarded 合同内
function createWorkflowChildRuntime(
  deps: CreateWorkflowFacadeDeps,
  options: {
    childSessionId: SessionId;
    childTraceContext: TraceContext;
    workflowKind: string;
  },
): AgentRuntime {
  return new AgentRuntime(
    options.childSessionId,
    {
      ...deps.runtimeConfig,
      agentName: options.workflowKind === "expert" ? "zcode-expert" : "zcode-workflow",
      // workflow child 不在 Guarded 合同内；只隔离父任务模式，不继承审批。
      mode: "yolo",
      modelSelection: deps.runtime.getSessionModelSelection(),
      // 父 Shell 在首条输入才解析，不能继承 app 创建时尚未初始化的静态配置。
      bashShellSelection: deps.runtime.getSessionShellSelection(),
      parentSessionId: deps.sessionId,
      taskType: "workflow_child",
      workingDirectory: deps.workingDirectory,
    },
    {
      agentTelemetry: deps.agentTelemetry,
      agentTelemetryCausation: deps.agentTelemetry.captureCausation(),
      // Workflow 在父工具返回后独立调度，不能伪装成父 Span 的同步 Child。
      agentTelemetryCausationMode: "linked_root",
      eventStore: createInMemorySessionEventStore(),
      sessionStore: deps.sessionStore,
      logger: deps.logger,
      executionPort:
        deps.appOptions.executionPort ??
        createNodeExecutionAdapter({
          onToolExecResource: deps.appOptions.onToolExecResource,
          network: {
            httpProxy: deps.configResult.config.network.httpProxy,
            noProxy: deps.configResult.config.network.noProxy,
            caCertFile: deps.configResult.config.network.caCertFile,
          },
          outputRootDir: join(deps.storageRoot, "cli", "exec"),
          bashOutputTempDir: tmpdir(),
          processEnv: deps.appOptions.env ?? process.env,
        }),
      fileSystemPort: deps.appOptions.fileSystemPort ?? createNodeFileSystemAdapter(),
      httpClientPort:
        deps.appOptions.httpClientPort ??
        createNodeWebFetchHttpClientAdapter({
          env: deps.appOptions.env ?? process.env,
          timeoutMs: deps.configResult.config.network.timeout,
          proxyUrl: deps.configResult.config.network.httpProxy,
          noProxy: deps.configResult.config.network.noProxy,
          caCertFile: deps.configResult.config.network.caCertFile,
        }),
      imageProcessorPort: deps.imageProcessorPort,
      pdfDocumentPort: deps.pdfDocumentPort,
      artifactStore: deps.artifactStore,
      contextSourcePort:
        deps.appOptions.contextSourcePort ??
        createNodeContextSourceAdapter({ env: deps.appOptions.env }),
      skillPort:
        deps.configResult.config.features.skill && deps.configResult.config.skills.enabled
          ? (deps.appOptions.skillPort ??
            createNodeSkillAdapter({
              extraRoots: deps.configResult.config.skills.roots,
              // workflow 子 agent 复用同一套 skill 发现逻辑，也必须继承主配置里的禁用路径。
              disabledPaths: collectDisabledPaths(deps.configResult.config.skillOverrides),
            }))
          : undefined,
      mcpPort: deps.mcpPort,
      eventSink: deps.eventSink,
      modelFactory: deps.modelFactory,
      resolveEffectiveModelSelection: deps.appOptions.resolveEffectiveModelSelection,
      // 对外交互端口由父 runtime 派生（permissionBroker + providerRuntimeHeadersPort）：
      // 子会话不是协议客户端认识的身份，直接透传 appOptions 的端口会让反向请求发到一个
      // 客户端找不到的 session 上、response 永不回来。
      ...deps.runtime.createChildClientPorts({
        agentId: options.childSessionId,
        agentType: options.workflowKind === "expert" ? "zcode-expert" : "zcode-workflow",
        childSessionId: options.childSessionId,
        description: `${options.workflowKind} workflow agent`,
        ...(options.childTraceContext.turnId === undefined
          ? {}
          : { parentTurnId: options.childTraceContext.turnId }),
      }),
      permissionService: deps.permissionService,
      appVersion: deps.appVersion,
      traceContext: options.childTraceContext,
    },
  );
}
