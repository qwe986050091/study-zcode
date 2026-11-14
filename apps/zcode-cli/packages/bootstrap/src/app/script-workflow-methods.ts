// ============================================================
// script workflow 的门面与工具端口装配（懒取 runtime）
// ============================================================
// create-app 在这里把脚本工作流的五个 facade 方法与工具端口一起装出来。ScriptWorkflowRuntime
// 需要 AgentRuntime，而 AgentRuntime 的构造又晚于本门面被引用，所以用 getRuntime 懒取：
// 第一次真正调用方法时才实例化，之后复用同一个实例。
// 本文件不持有业务状态；副作用只在 ScriptWorkflowRuntime 自身（读脚本、写 run 记录）。

import type { SubmitPromptOptions, ZCodeApp } from "./types.js";
import {
  ScriptWorkflowRuntime,
  type ScriptWorkflowRuntimeDeps,
} from "./script-workflow-runtime.js";
import { createScriptWorkflowToolPort } from "./script-workflow-tool-port.js";

/** 门面暴露给 ZCodeApp 的五个方法；工具端口不在此列。 */
type ScriptWorkflowFacade = Pick<
  ZCodeApp,
  | "listScriptWorkflows"
  | "resumeWorkflowScript"
  | "runWorkflowScript"
  | "scriptWorkflowStatus"
  | "validateWorkflowScript"
>;

interface ScriptWorkflowBridge extends ScriptWorkflowFacade {
  workflowPort: ReturnType<typeof createScriptWorkflowToolPort>;
}

/** 把 deps 里的 runtime 换成 getter：runtime 由 AgentRuntime 之后才可用。 */
type ScriptWorkflowBridgeDeps = Omit<ScriptWorkflowRuntimeDeps, "runtime"> & {
  getRuntime: () => ScriptWorkflowRuntimeDeps["runtime"];
};

/** 运行时选项是 SubmitPromptOptions 的子集：只透传取消信号、事件回调与 trace 上下文。 */
type ScriptWorkflowRuntimeOptions = Pick<
  SubmitPromptOptions,
  "abortSignal" | "traceContext"
> & {
  onEvent?: (event: unknown) => void | Promise<void>;
};

/**
 * 造脚本工作流桥：五个 facade 方法与工具端口共享同一个懒初始化的 ScriptWorkflowRuntime。
 *
 * 返回对象本身可立即使用；实例化推迟到第一次方法调用，避免在 AgentRuntime 尚未构造时
 * 触碰它。失败语义：deps.getRuntime 抛错会原样传到该次调用；本函数自身不抛错。
 */
export function createScriptWorkflowBridge(deps: ScriptWorkflowBridgeDeps): ScriptWorkflowBridge {
  let runtime: ScriptWorkflowRuntime | undefined;
  const getRuntime = () => {
    // 首次调用才实例化；`??=` 保证并发/多次调用只造一个实例。
    runtime ??= new ScriptWorkflowRuntime({ ...deps, runtime: deps.getRuntime() });
    return runtime;
  };
  return {
    listScriptWorkflows: (input) => getRuntime().list(input),
    resumeWorkflowScript: (input, options) => getRuntime().resume(input, toRuntimeOptions(options)),
    runWorkflowScript: (input, options) => getRuntime().run(input, toRuntimeOptions(options)),
    scriptWorkflowStatus: (input) => getRuntime().status(input),
    validateWorkflowScript: (input) => getRuntime().validate(input),
    workflowPort: createScriptWorkflowToolPort({
      fileSystemPort: deps.fileSystemPort,
      getRuntime,
      logger: deps.logger,
      sessionId: deps.sessionId,
      sessionStore: deps.sessionStore,
      storageRoot: deps.storageRoot,
      traceContext: deps.traceContext,
      workingDirectory: deps.workingDirectory,
    }),
  };
}

/** 把已有 runtime 的五个方法按 ScriptWorkflowFacade 形状绑定的辅助函数；不做延迟初始化。 */
function createScriptWorkflowFacade(runtime: ScriptWorkflowRuntime): ScriptWorkflowFacade {
  return {
    listScriptWorkflows: runtime.list.bind(runtime),
    resumeWorkflowScript: (input, options) => runtime.resume(input, toRuntimeOptions(options)),
    runWorkflowScript: (input, options) => runtime.run(input, toRuntimeOptions(options)),
    scriptWorkflowStatus: runtime.status.bind(runtime),
    validateWorkflowScript: runtime.validate.bind(runtime),
  };
}

/** SubmitPromptOptions → runtime 选项；只挑三项，其余字段（如 inputId/intent）不进入脚本链。 */
function toRuntimeOptions(
  options: Parameters<NonNullable<ZCodeApp["runWorkflowScript"]>>[1],
): ScriptWorkflowRuntimeOptions | undefined {
  if (!options) return undefined;
  return {
    abortSignal: options.abortSignal,
    onEvent: options.onEvent as ((event: unknown) => void | Promise<void>) | undefined,
    traceContext: options.traceContext,
  };
}
