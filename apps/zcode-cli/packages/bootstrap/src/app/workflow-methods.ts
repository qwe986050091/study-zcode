// 文件：app/workflow-methods.ts，workflow 方法门面，把 expert 与普通两套入口绑到本会话端口与 trace。
// 分层：门面只做编排、参数补齐与透传，运行态全部归 ExpertWorkflowRuntime 与 App 端口。
// 顺序契约：启动五步固定，查询 / 取消 / 重试只取 runtime 后直调，不写活动记录。
// INV-01 门面签名是唯一契约，WorkflowFacade 只挑 ZCodeApp 已有方法名，不定义第二套重载；守住位置：WorkflowFacade 的 Pick 联合；改错故障：TUI 与协议客户端编译通过但运行期缺方法，workflow 面板整块不可用。
// INV-02 expert 与普通入口的差异仅限 kind 兜底，其余参数路径逐字段一致；守住位置：成对的 status / stop / resume / run 方法；改错故障：同一 run 经两个入口读到的进度不一致，用户看到的进度与真实执行分叉。
// INV-03 依赖集合由调用方一次注入，门面内不得延迟读取全局配置；守住位置：CreateWorkflowMethodsDeps 各字段；改错故障：多会话并发时读到后建会话的配置，旧会话 workflow 跑进别人的工作目录。
// INV-04 启动类前置顺序固定为执行边界、YOLO 切换、解析启动输入、活动落库、start；守住位置：runWorkflow 与 runExpertWorkflow 系列；改错故障：顺序颠倒会让未经边界校验的 run 落库，用户看到一条永不启动的僵尸活动。
// INV-05 任一前置抛错即整体不启动，活动记录不得写入；守住位置：启动类方法的 await 串；改错故障：权限被拒后仍留下活动，用户重试时看到重复失败记录并误判为已执行。
// INV-06 查询类方法不得触发执行边界校验或 YOLO 切换；守住位置：expertWorkflowStatus、readWorkflowEvents、listWorkflows；改错故障：只读轮询被权限弹窗打断，用户在观察进度时被迫反复确认。
// INV-07 retry 需要边界校验但不需要切换 YOLO，因为复用已存在的 run 上下文；守住位置：retryWorkflow；改错故障：重试路径悄悄改写模式，用户后续手动执行继承了非预期权限。
// INV-08 取消类方法不写活动记录也不改 YOLO，只把 abortSignal 与定位字段透传；守住位置：stopWorkflow 与 stopExpertWorkflow；改错故障：停止动作产生额外活动行，用户在历史里看到从未发生的启动。
// INV-09 traceContext 取值顺序为入参优先、会话级兜底，且必须在每个异步分支内解析；守住位置：retry / resume / run 的 traceContext 赋值；改错故障：后台任务归到错误的 trace，排障时整条调用链断开。
// INV-10 definitionId 在启动路径回落到解析出的 definition 自身 id，查询路径不做该回落；守住位置：runWorkflow 与 runExpertWorkflow 的 definitionId 赋值；改错故障：未指定 id 的启动落到空 id run，恢复时找不到对应定义。
// INV-11 cwd 一律取注入的 workingDirectory，不读进程当前目录；守住位置：所有 runtime 调用参数；改错故障：多窗口切换后 run 落到错误的项目根，产物写入他人目录。
// INV-12 每次调用重新查找 runtime 而不缓存实例；守住位置：workflowRuntimeForLookup 的调用点；改错故障：缓存的 runtime 持有已结束 run 的句柄，恢复操作静默失效。
// INV-13 abortSignal 必须同时透传给查找段与执行段，中途不得丢弃；守住位置：各方法的 abortSignal 字段；改错故障：取消后查找阶段仍在等待，用户按键后界面长时间无响应。
// INV-14 listWorkflows 直接复用注入的 listWorkflowRuns，不做二次包装；守住位置：listWorkflows 字段；改错故障：多包一层改变分页语义，列表出现重复或缺失的 run。
// INV-15 onEvent 只在启动与 resume 路径透传，查询路径不透传；守住位置：run / resume / retry 的 onEvent 字段；改错故障：查询路径挂上回调导致事件被消费两次，UI 重复渲染同一条节点更新。
// INV-16 后台与前台启动共享同一前置链，仅末步分叉为 startBackground 与 start；守住位置：runWorkflowBackground 与 runWorkflow 对照；改错故障：两条链各自演进后后台漏掉落库，重启后后台任务无可恢复记录。
// INV-17 workflowKind 兜底链为入参、解析出的定义 kind、内置 expert kind，expert 入口额外前置内置值；守住位置：createStartInput 调用与 start 参数；改错故障：kind 为空时选错编排器，用户拿到与所选工作流不符的输出。
// INV-18 门面闭包不捕获可变状态，所有读取发生在调用时；守住位置：createWorkflowMethods 返回对象；改错故障：长生命周期门面持有首次调用的会话快照，后续会话读了别人的工作目录。
// INV-19 抛错不在此层转换，错误原样上抛由入口层格式化；守住位置：全部 async 方法体无 catch；改错故障：门面吞掉类型信息后只剩一句文案，用户与日志都无法定位失败节点。
import type { ExpertWorkflowRuntime } from "@zcode/core";
import type { SessionId, TraceContext, WorkflowDefinition } from "@zcode/contracts";
import type { PrepareUserExecutionBoundary, ZCodeApp } from "./types.js";

/**
 * App 暴露给上层（TUI / 协议）的 workflow 方法切片；expert 与普通两套入口共用同一批 verb。
 * 只挑方法名，不复制实现，App 上的签名是唯一契约。
 */
// 【不变量】Pick 只做方法名投影，不改变 ZCodeApp 上的参数与返回类型，签名漂移由类型检查兜住。
// 【不变量】新增 verb 必须同时出现在此联合与返回对象中，缺一即门面不完整。
// 【权衡】不复制实现、不定义第二套接口，换取 App 成为唯一契约源。
// 【失败路径】联合漏项时只在 TUI 侧暴露缺方法，编译期无法提前发现。
export type WorkflowFacade = Pick<
  ZCodeApp,
  | "expertWorkflowStatus"
  | "workflowStatus"
  | "retryWorkflow"
  | "listExpertWorkflows"
  | "listWorkflows"
  | "readExpertWorkflowEvents"
  | "readWorkflowEvents"
  | "resumeExpertWorkflow"
  | "resumeWorkflow"
  | "stopExpertWorkflow"
  | "stopWorkflow"
  | "runExpertWorkflowBackground"
  | "runWorkflowBackground"
  | "runExpertWorkflow"
  | "runWorkflow"
>;

// 【资源】deps 是门面唯一输入面，生命周期跟随所属 App 会话，会话结束后门面必须一并丢弃，禁止跨会话复用。
// 【不变量】prepareUserExecutionBoundary 与会话权限模型绑定，注入点必须与工作目录同源。
// 【不变量】createStartInput 必须同时给出 definition 与 runtime，缺一都会让落库与启动参数不自洽。
// 【失败路径】persistWorkflowActivity 抛错即中断启动，调用方只能看到错误，看不到半条活动。
// 【并发】switchWorkflowToYolo 是进程级副作用，多会话并发启动时以其内部串行化保证为准。
interface CreateWorkflowMethodsDeps {
  builtInExpertWorkflowDefinition: WorkflowDefinition;
  createStartInput(
    input: { definitionId?: string; task: string; workflowKind?: string },
    defaultKind?: string,
  ): Promise<{ definition: WorkflowDefinition; workflow: ExpertWorkflowRuntime }>;
  listWorkflowRuns: NonNullable<WorkflowFacade["listWorkflows"]>;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  persistWorkflowActivity(
    definition: WorkflowDefinition,
    task: string,
    traceContext: TraceContext,
  ): Promise<void>;
  sessionId: SessionId;
  switchWorkflowToYolo(): void;
  traceContext: TraceContext;
  workflowRuntimeForLookup(input?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowRuntime>;
  workingDirectory: string;
}

/**
 * 把 workflow 的查询 / 生命周期操作绑到本会话的端口与 trace 上，返回可直接挂到 App 的门面。
 *
 * 启动类动作的顺序是契约：`prepareUserExecutionBoundary`（权限 / 执行边界检查）→
 * `switchWorkflowToYolo`（workflow 运行需 YOLO）→ `createStartInput`（解析 definition 与
 * runtime）→ `persistWorkflowActivity`（写活动记录）→ `start` / `startBackground`。查询与 stop /
 * retry / events 不做这些前置，只经 `workflowRuntimeForLookup` 拿到对应 run 的 runtime。
 * expert 入口在未显式给 kind 时补 `builtInExpertWorkflowDefinition.kind`；普通入口不补。
 * `traceContext` 优先用调用方传入的，其次会话级；`definitionId` 启动时回落到解析出的
 * definition 自身 id。失败语义：任一前置抛错即不启动，活动记录也不会写。
 */
// 【不变量】工厂同步返回纯对象，构造期不发起 I/O、不读取配置，构造失败面为零。
// 【资源】闭包只捕获 deps 引用，不缓存 runtime 与 run 句柄，避免句柄泄漏。
// 【不变量】返回对象的方法集合与 WorkflowFacade 完全一致，多一个少一个都是契约破坏。
// 【并发】同一门面可被并行调用，正确性依赖各方法内部无共享可变状态。
export function createWorkflowMethods(deps: CreateWorkflowMethodsDeps): WorkflowFacade {
  const { builtInExpertWorkflowDefinition } = deps;
  return {
    // 【不变量】未显式给 kind 时补内置 expert kind，查找与 status 两处必须用同一个补齐值。
    // 【失败路径】查找抛错直接上抛，不返回兜底状态，避免把不存在当成空闲。
    // 【权衡】此处不做执行边界校验，换取轮询零权限打扰。
    expertWorkflowStatus: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
        })
      ).status({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        runId: options?.runId,
        workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
      }),
    // 【不变量】普通入口不补 kind，未给出的 kind 交给 runtime 自行解析。
    // 【失败路径】definitionId 与 runId 同时缺失时由 runtime 报错，门面不做二次猜测。
    // 【不变量】与 expert 版本仅在 kind 兜底上不同，其余字段逐项对齐。
    workflowStatus: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind,
        })
      ).status({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        runId: options?.runId,
        workflowKind: options?.workflowKind,
      }),
    // 【不变量】先过执行边界再查找 runtime，边界拒绝时不得触碰任何 run。
    // 【资源】retry 复用已有 run 记录，不新建活动文档，因此不写 persistWorkflowActivity。
    // 【不变量】traceContext 在此解析并向下传递，重试事件归入发起重试的 trace。
    // 【失败路径】runtime 查找失败时错误原样上抛，调用方据此决定是否展示重试入口。
    retryWorkflow: async (options) => {
      await deps.prepareUserExecutionBoundary(options);
      return (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind,
        })
      ).retry({
        abortSignal: options?.abortSignal,
        activityId: options?.activityId,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        nodeId: options?.nodeId,
        onEvent: options?.onEvent,
        phase: options?.phase,
        runId: options?.runId,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: options?.workflowKind,
      });
    },
    listExpertWorkflows: async (options) =>
      deps.listWorkflowRuns({
        abortSignal: options?.abortSignal,
        definitionId: options?.definitionId,
        limit: options?.limit,
        workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
      }),
    // 【权衡】listWorkflows 直接等于 deps.listWorkflowRuns，不包一层：分页与排序只在实现里写一次；门面复制会漂移。
    // 【不变量】方法被取用时 this 绑定不依赖门面对象，注入方须自备绑定。
    // 【失败路径】注入实现抛错即用户可见错误，门面不做空数组兜底。
    listWorkflows: deps.listWorkflowRuns,
    // 【不变量】事件读取只按 runId 定位，缺省 kind 仅在查找层补齐。
    // 【失败路径】run 不存在时由查找抛错，不返回空事件列表以免误判为已完成。
    // 【并发】事件游标归 runtime 管理，门面透传 limit 而不做二次截断。
    readExpertWorkflowEvents: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options.abortSignal,
          runId: options.runId,
        })
      ).events({
        abortSignal: options.abortSignal,
        limit: options.limit,
        runId: options.runId,
      }),
    // 【不变量】与 expert 版本共享查找与 events 参数形状，差异仅在不补 kind。
    // 【资源】读取结束即释放 runtime，门面侧不保留订阅。
    // 【失败路径】abortSignal 触发后错误向上冒泡，调用方负责区分取消与真实失败。
    readWorkflowEvents: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options.abortSignal,
          runId: options.runId,
        })
      ).events({
        abortSignal: options.abortSignal,
        limit: options.limit,
        runId: options.runId,
      }),
    // 【不变量】resume 前置包含执行边界与 YOLO 切换，缺一都会让恢复路径违反权限模型。
    // 【不变量】definitionId 与 workflowKind 两处都补默认值，查找与 resume 必须一致。
    // 【资源】resume 不写活动记录，历史记录由原 run 承载。
    // 【失败路径】YOLO 切换失败即不进入查找，避免在错误模式下恢复执行。
    resumeExpertWorkflow: async (options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      return (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
        })
      ).resume({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        onEvent: options?.onEvent,
        runId: options?.runId,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
      });
    },
    // 【不变量】普通恢复不补 kind，仅同步前置与 traceContext 兜底。
    // 【并发】恢复与停止可能并发到达，最终状态由 runtime 的 run 锁裁决。
    // 【失败路径】恢复失败时不回滚 YOLO 切换，由上层决定是否继续会话。
    resumeWorkflow: async (options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      return (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind,
        })
      ).resume({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        onEvent: options?.onEvent,
        runId: options?.runId,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: options?.workflowKind,
      });
    },
    // 【不变量】取消只透传 abortSignal 与定位字段，不写活动、不切模式。
    // 【失败路径】查找失败时无法定位 run，错误上抛而非静默成功。
    // 【资源】取消完成后 runtime 由 runtime 侧收敛，门面不保留引用。
    stopExpertWorkflow: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
        })
      ).cancel({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        runId: options?.runId,
        workflowKind: options?.workflowKind ?? builtInExpertWorkflowDefinition.kind,
      }),
    stopWorkflow: async (options) =>
      (
        await deps.workflowRuntimeForLookup({
          abortSignal: options?.abortSignal,
          definitionId: options?.definitionId,
          runId: options?.runId,
          workflowKind: options?.workflowKind,
        })
      ).cancel({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: options?.definitionId,
        runId: options?.runId,
        workflowKind: options?.workflowKind,
      }),
    // 【不变量】后台启动前置与前台完全一致，仅末步改为 startBackground。
    // 【不变量】活动落库使用解析后的 definition 与原始 task，入参 definitionId 可为空。
    // 【并发】后台 run 的生命周期归 runtime，门面交出句柄后不再参与。
    // 【失败路径】落库失败则不启动，避免出现无记录的运行中任务。
    runExpertWorkflowBackground: async (input, options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      const { definition, workflow } = await deps.createStartInput(
        input,
        builtInExpertWorkflowDefinition.kind,
      );
      await deps.persistWorkflowActivity(
        definition,
        input.task,
        options?.traceContext ?? deps.traceContext,
      );
      return workflow.startBackground({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: input.definitionId,
        onEvent: options?.onEvent,
        sessionId: deps.sessionId,
        task: input.task,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: input.workflowKind ?? definition.kind,
      });
    },
    // 【不变量】createStartInput 不带默认 kind，由定义自身决定编排器。
    // 【失败路径】与 expert 版本同链，任一前置抛错即整体放弃启动。
    runWorkflowBackground: async (input, options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      const { definition, workflow } = await deps.createStartInput(input);
      await deps.persistWorkflowActivity(
        definition,
        input.task,
        options?.traceContext ?? deps.traceContext,
      );
      return workflow.startBackground({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: input.definitionId ?? definition.definitionId,
        onEvent: options?.onEvent,
        sessionId: deps.sessionId,
        task: input.task,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: input.workflowKind ?? definition.kind,
      });
    },
    // 【不变量】前台启动以 start 返回运行终态，调用方据此渲染完成或失败。
    // 【不变量】definitionId 缺省回落到定义自身 id，sessionId 固定取会话级。
    // 【权衡】前台执行不设超时，取消完全交给 abortSignal 与用户操作。
    runExpertWorkflow: async (input, options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      const { definition, workflow } = await deps.createStartInput(
        input,
        builtInExpertWorkflowDefinition.kind,
      );
      await deps.persistWorkflowActivity(
        definition,
        input.task,
        options?.traceContext ?? deps.traceContext,
      );
      return workflow.start({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: input.definitionId ?? definition.definitionId,
        onEvent: options?.onEvent,
        sessionId: deps.sessionId,
        task: input.task,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: input.workflowKind ?? definition.kind,
      });
    },
    // 【不变量】与 expert 前台版本逐字段对齐，差异仅在 kind 是否补内置值。
    // 【失败路径】启动抛错时活动记录已写入，调用方须以错误为准而非以活动存在性为准。
    runWorkflow: async (input, options) => {
      await deps.prepareUserExecutionBoundary(options);
      deps.switchWorkflowToYolo();
      const { definition, workflow } = await deps.createStartInput(input);
      await deps.persistWorkflowActivity(
        definition,
        input.task,
        options?.traceContext ?? deps.traceContext,
      );
      return workflow.start({
        abortSignal: options?.abortSignal,
        cwd: deps.workingDirectory,
        definitionId: input.definitionId ?? definition.definitionId,
        onEvent: options?.onEvent,
        sessionId: deps.sessionId,
        task: input.task,
        traceContext: options?.traceContext ?? deps.traceContext,
        workflowKind: input.workflowKind ?? definition.kind,
      });
    },
  };
}
