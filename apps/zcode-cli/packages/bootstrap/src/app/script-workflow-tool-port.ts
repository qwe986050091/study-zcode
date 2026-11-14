/**
 * script-workflow-tool-port：把 legacy 脚本工作流包装成 Core 的 WorkflowPort（Workflow 工具的后端）。
 * 定位：解析来源（scriptPath / script / name / resumeFromRunId）→ 复制或落盘到会话工作目录 →
 *   交给 ScriptWorkflowRuntime 后台执行；start 只负责启动并交回 runId，执行结果进入内存快照表。
 * 身份口径：runId 优先用请求里的 resumeFromRunId（真正的续跑），否则 `wf_<uuid>`；随后用
 *   WORKFLOW_RUN_ID_PATTERN 校验，非法 id 直接拒，避免进 URL / 路径 / 日志。
 * 所有权：本端口不关闭任何东西；两张 Map 只做本进程的读面缓存（launchSnapshots 终态 / 
 *   completionSnapshots 在飞 promise），会话真相仍在 sessionStore（可跨进程冷读）。
 * 失败语义：start 的失败是"工具调用失败"（抛）；后台执行失败则收敛成 status=failed 的 snapshot
 *   并写 error 日志，绝不让游离 promise 变成 unhandled rejection。
 * 不变量：父 turn 的取消不中止已返回 runId 的后台任务（执行用独立 AbortController）。
 */
// INV-01 start 返回前必须已登记 running 快照，否则随后查询会判成「没有这个 run」；守住位置：start 里写入 launchSnapshots 的分支；改错故障：客户端拿到 runId 却查不到任务，进度面板显示未知任务。
// INV-02 后台 promise 必须同时挂成功与失败两个回调，两条分支都要把终态写回快照表；守住位置：runPromise.then 的两个回调；改错故障：失败 run 永远停在 running，用户只能等到超时。
// INV-03 后台任务的 AbortController 必须独立于 tool call 的 signal，父 turn 取消不得连带杀掉已在跑的任务；守住位置：start 里构造 runAbortController 的位置；改错故障：用户取消当前对话时，已交付 runId 的脚本被无故中止。
// INV-04 等待路径的取消只影响等待者，不得传播到后台执行；守住位置：waitForWorkflowTaskCompletion 的 onAbort 分支；改错故障：一次界面侧等待超时把仍在产出的工作流整体杀死。
// INV-05 signal 已处于 aborted 时等待必须立即 reject 且不注册监听；守住位置：waitForWorkflowTaskCompletion 的前置判断；改错故障：取消后的等待悬挂，调用方拿不到明确失败。
// INV-06 abort 监听必须在成功、失败、abort 三条出口都清理，禁止重复 reject 与监听泄漏；守住位置：cleanup 的三个调用点；改错故障：长会话里监听器累积，取消分发越来越慢。
// INV-07 来源解析顺序固定为 scriptPath、script、name、resumeFromRunId，显式路径优先于续跑；守住位置：resolveWorkflowToolSource 的四段分支；改错故障：同一请求里的新脚本被旧 run 顶掉，用户执行到过期代码。
// INV-08 四种来源全缺席必须抛错而不是启动空脚本；守住位置：resolveWorkflowToolSource 末尾兜底；改错故障：空工作流被当成成功启动，用户看到后台任务却没有输出。
// INV-09 脚本落盘必须原子写并自动建父目录，读方不得看到半截文件；守住位置：persistInlineScript 与 persistScriptCopy 的写盘参数；改错故障：执行时读到截断脚本，报语法错误且难以定位。
// INV-10 run 一律读会话目录副本，源文件后续修改或删除不影响本次执行；守住位置：persistScriptCopy 的复制语义；改错故障：启动后用户编辑源脚本，结果与提交内容不一致。
// INV-11 复制完成后必须对副本再校验一次，防止写盘引入不可读或结构损坏文件；守住位置：各来源分支的第二次 validateScriptPath；改错故障：坏副本进入 runtime，报错指向内部路径而非用户脚本。
// INV-12 runId 优先取 resumeFromRunId，否则生成 wf_ 前缀 uuid，并且必须过 WORKFLOW_RUN_ID_PATTERN；守住位置：start 的 runId 计算与正则校验；改错故障：非法 id 进路径与日志，形成穿越或日志注入。
// INV-13 取消检查在来源解析前后各做一次，解析期间的 abort 不得被忽略；守住位置：start 开头与解析之后的两处 aborted 判断；改错故障：用户已取消却仍写盘并起 run，留下游离后台任务。
// INV-14 completionSnapshots 只存 finally 链，结算即自删，不得保留已完成 promise；守住位置：completionSnapshots.set 的包装；改错故障：长会话内该表只增不减，内存随 run 数上涨。
// INV-15 成功快照的 output 只在终态生成，running 阶段读任务不得返回结论；守住位置：getWorkflowTaskSnapshot 的 output 条件；改错故障：轮询方在 running 时拿到 failed，提前判死。
// INV-16 六态到四态的映射必须收敛在单点函数，未知值归 lost 而非 running；守住位置：workflowTaskStatus；改错故障：新增状态被误认为仍在跑，等待逻辑永不超时。
// INV-17 store 不支持脚本工作流时返回 undefined 并回退内存快照，不得抛错；守住位置：getWorkflowTaskSnapshot 与 waitForTask 的兜底；改错故障：存储能力差异让查询整体失败，未知工具直接降级失败。
// INV-18 name 必须过白名单正则并补 .workflow.js 后缀，非法字符直接抛不得静默替换；守住位置：workflowFileName；改错故障：name 变成路径片段，脚本写到会话目录之外。
//
// 总述一：本文件是 Workflow 工具的后端端口，把 legacy 脚本工作流包装成 Core 的 WorkflowPort。
// 总述二：start 走「解析 → 落盘 → 登记 → 启动」，读面按 store 优先、内存快照兜底的顺序。
// 总述三：端口不关闭也不拥有任何资源，会话真相始终在 sessionStore，可跨进程冷读。
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  WORKFLOW_RUN_ID_PATTERN,
  createCoreError,
  CoreErrorType,
  isFileSystemPortError,
  type FileSystemPort,
  type Logger,
  type ScriptWorkflowRunStatus,
  type SessionId,
  type SessionStorePort,
  type TraceContext,
  type WorkflowOutput,
  type WorkflowPort,
  type WorkflowStartRequest,
  type WorkflowTaskSnapshot,
  type WorkflowTaskStatus,
} from "@zcode/contracts";
import { readWorkflowScriptDocument } from "./script-workflow-meta.js";
import type { ScriptWorkflowRuntime } from "./script-workflow-runtime.js";
import { isScriptWorkflowStore } from "./script-workflow-utils.js";

// 三个常量定住落盘口径：统一后缀、name 白名单、内建工作流兜底表。
// [权衡] 白名单只放行字母数字与 . _ -，不带路径分隔符，从源头堵住路径穿越。
// [资源] 内建表当前为空但保留查找层，填充时只登记 name 到绝对路径。
const WORKFLOW_SCRIPT_SUFFIX = ".workflow.js";
const WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const BUILTIN_WORKFLOW_ALLOWLIST = new Map<string, string>();

// [并发] 依赖面固定七项：文件系统、存储、runtime 懒取器、日志、trace、落盘根与会话 id。
// getRuntime 用函数形态注入，构造端口时不必先有 runtime，打破初始化顺序环。
interface ScriptWorkflowToolPortDeps {
  fileSystemPort: FileSystemPort;
  getRuntime: () => ScriptWorkflowRuntime;
  logger?: Logger;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  storageRoot: string;
  traceContext: TraceContext;
  workingDirectory: string;
}

/**
 * 造 WorkflowPort。返回三成员对象，状态只有两张 Map：
 *   launchSnapshots = 本进程见过的 run 快照（终态直接可读，不必回 store）；
 *   completionSnapshots = 在飞执行的 promise（waitForTask 据此等待，结算即删）。
 * 输入：deps 提供文件系统、store、runtime 懒取器（getRuntime 延迟到启动时才解析，避免构造环）。
 * 输出：getTask / waitForTask / start。
 * 失败语义：getTask/waitForTask 以 undefined 表示"没有这个 run"；start 的来源解析或写盘失败直接抛。
 */
// 每次调用产出独立端口实例，两张快照表随实例生命周期存亡，不跨实例共享。
// 端口只做编排与读面缓存，脚本执行归 runtime，状态持久化归 sessionStore。
export function createScriptWorkflowToolPort(deps: ScriptWorkflowToolPortDeps): WorkflowPort {
  // [并发] 在飞 promise 表：键为 runId，值为 finally 包装后的等待句柄，结算即删。
  // 只登记本进程发起的 run，别进程或历史 run 一律回落到 store 读。
  const completionSnapshots = new Map<string, Promise<WorkflowTaskSnapshot | undefined>>();
  // 本进程见过的终态快照，专门补 store 尚未落行时的读面缺口。
  const launchSnapshots = new Map<string, WorkflowTaskSnapshot>();
  return {
    // [权衡] 读优先级先 store 后内存，store 命中即权威，两处都不中才给 undefined。
    // [失败路径] store 抛错不在这里吞掉，交由工具调用层统一转成错误码与用户提示。
    async getTask(taskId): Promise<WorkflowTaskSnapshot | undefined> {
      // store 是跨进程权威；内存快照只在"行还没落 / 已逐出"时兜底，两处都不中才是 undefined。
      return (await getWorkflowTaskSnapshot(deps, taskId)) ?? launchSnapshots.get(taskId);
    },
    // 等待只对「仍在跑且本进程持有 promise」有意义，其余情况立刻返回当前事实。
    // 已终态直接返回，别进程的 run 没有本地 promise，只能退化成一次查询。
    // [并发] 多个等待者可共享同一个 completion，等待本身不持锁也不改快照。
    async waitForTask(taskId, options): Promise<WorkflowTaskSnapshot | undefined> {
      // 只有"仍在跑且本进程有 promise"才值得等；否则立刻返回当前事实（已终态 / 别进程的 run）。
      const current = (await getWorkflowTaskSnapshot(deps, taskId)) ?? launchSnapshots.get(taskId);
      if (!current || current.status !== "running") return current;
      const completion = completionSnapshots.get(taskId);
      if (!completion) return current;
      return waitForWorkflowTaskCompletion(completion, options?.signal);
    },
    // start 只负责启动三段：解析来源、登记 running 快照、把任务丢给 runtime。
    // 返回 status 恒为 backgrounded，真正结果要靠后续查询或等待取得。
    async start(request, options): Promise<WorkflowOutput> {
      // 取消检查放在来源解析前后各一次：解析期间可能已经 abort，不能带着已取消的意图去写盘/起 run。
      if (options?.signal?.aborted) {
        throw createCoreError(CoreErrorType.ToolCancelled, "Workflow launch cancelled");
      }
      // [失败路径] 解析是 start 里唯一碰文件系统的阶段，此时尚未登记快照，抛错不留幽灵 run。
      const source = await resolveWorkflowToolSource(deps, request, options?.signal);
      if (options?.signal?.aborted) {
        throw createCoreError(CoreErrorType.ToolCancelled, "Workflow launch cancelled");
      }
      // 续跑沿用调用方给的 runId，新跑用 wf_ 前缀加随机 uuid，两者走同一套校验。
      // [权衡] 不做 runId 去重：续跑本就要求同一 id，冲突由正则与 store 语义拦住。
      // [失败路径] 生成后立刻过 WORKFLOW_RUN_ID_PATTERN，非法 id 不进 URL、路径与日志。
      const runId = request.resumeFromRunId ?? `wf_${crypto.randomUUID()}`;
      if (!WORKFLOW_RUN_ID_PATTERN.test(runId)) {
        throw new Error(`Invalid workflow run id: ${runId}`);
      }
      const startedAt = new Date();
      launchSnapshots.set(runId, {
        description: source.name ?? runId,
        name: source.name,
        runId,
        startedAt,
        status: "running",
        taskId: runId,
      });

      const runtime = deps.getRuntime();
      // 后台 workflow 已脱离当前 tool call；父 turn 取消不应中止已返回 runId 的任务。
      // [并发] 独立控制器是本文件的关键隔离：后台 run 与 tool call 的 signal 完全脱钩。
      // 因此父 turn 取消只影响本次调用，不会中止已交回 runId 的任务。
      // [权衡] 端口不暴露取消入口，任务终点由脚本自身或 runtime 内部策略决定。
      const runAbortController = new AbortController();
      const runPromise = source.scriptPath
        ? runtime.run(
            {
              args: request.args,
              resumeFromRunId: request.resumeFromRunId,
              runId,
              scriptPath: source.scriptPath,
            },
            { abortSignal: runAbortController.signal },
          )
        : runtime.resume({ runId }, { abortSignal: runAbortController.signal });

      // [事务] 成功与失败两个回调都把终态整体覆盖进快照，不存在部分更新。
      // [失败路径] onRejected 必须返回快照而非 rethrow，否则后台 promise 变成未处理拒绝。
      const completion = runPromise.then(
        (result) => {
          // 成功分支：终态快照覆盖 running 初值；output 只在终态生成（running 时读任务拿不到输出）。
          const snapshot: WorkflowTaskSnapshot = {
            completedAt: new Date(),
            description: source.name ?? result.runId,
            name: source.name,
            output: workflowOutputFromRunResult(result, source, deps.traceContext.traceId),
            runId,
            startedAt,
            status: workflowTaskStatus(result.status),
            taskId: runId,
          };
          launchSnapshots.set(runId, snapshot);
          return snapshot;
        },
        (error: unknown) => {
          // 失败分支：任何抛错都收敛成 failed 快照 + 错误日志，返回值不 reject——后台 run 没人 await，
          // 让 promise 拒绝就会变成 unhandled rejection。
          const snapshot: WorkflowTaskSnapshot = {
            completedAt: new Date(),
            description: source.name ?? runId,
            error: toError(error).message,
            name: source.name,
            runId,
            startedAt,
            status: "failed",
            taskId: runId,
          };
          launchSnapshots.set(runId, snapshot);
          deps.logger?.error("Background workflow failed before status was persisted", toError(error), {
            event: "workflow.tool.background_failed",
            module: "bootstrap.workflow",
            runId,
            status: "failed",
          });
          return snapshot;
        },
      );
      // 存的是 finally 链：结算即自删，waitForTask 之后不会一直挂着一条已完成的 promise。
      // [资源] 存的是 finally 链而非原始 promise，任何出口都会自删条目。
      // 自删后再次等待只能读快照，「等待」语义退化成「查询」，这是有意的取舍。
      completionSnapshots.set(
        runId,
        completion.finally(() => {
          completionSnapshots.delete(runId);
        }),
      );
      // 显式丢弃引用只为表明"不等待"；错误已在 onRejected 落成快照，这里不会产生未处理拒绝。
      void completion;

      return {
        backgroundTaskId: runId,
        name: source.name,
        response: `Workflow started as ${runId}. Use /workflows ${runId} to watch progress.`,
        runId,
        scriptPath: source.scriptPath,
        status: "backgrounded",
        traceId: request.trace.traceId,
      };
    },
  };
}

// 把 completion 与可选 signal 组合成新 promise，任一方先有结果即结束。
// [资源] 监听器在成功、失败、abort 三条出口都要清理，否则长会话里持续累积。
function waitForWorkflowTaskCompletion(
  completion: Promise<WorkflowTaskSnapshot | undefined>,
  signal: AbortSignal | undefined,
): Promise<WorkflowTaskSnapshot | undefined> {
  if (!signal) return completion;
  if (signal.aborted) return Promise.reject(workflowAbortReason(signal));

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(workflowAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    completion.then(
      (snapshot) => {
        cleanup();
        resolve(snapshot);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

// [失败路径] 优先透传 signal.reason，缺失时兜底造 Error，保证 reject 始终可读。
function workflowAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Workflow task wait aborted");
}

/** run 结果 → 工具输出：status 二值化（completed 之外一律 failed），traceId 固定用父 trace 便于串联。 */
// 纯映射不做 I/O：run 结果翻成工具输出，scriptPath 取自解析结果而非运行结果。
// [错误码映射] 工具输出只有 completed 与 failed 两态，cancelled 也算失败。
function workflowOutputFromRunResult(
  result: Awaited<ReturnType<ScriptWorkflowRuntime["run"]>>,
  source: ResolvedWorkflowSource,
  traceId: string,
): WorkflowOutput {
  return {
    backgroundTaskId: result.runId,
    name: source.name,
    response: result.response,
    runId: result.runId,
    scriptPath: source.scriptPath,
    status: result.status === "completed" ? "completed" : "failed",
    traceId,
  };
}

/**
 * store → snapshot 的只读投影；只有终态才给 output——running 阶段读任务不应该拿到"结论"。
 * store 不支持脚本工作流时返回 undefined（不是错误），由调用方回退内存快照。
 */
// store 记录的只读投影，字段直接搬运不做业务推断，记录缺失返回 undefined。
// [权衡] 终态才给 output：running 阶段读任务不应该拿到「结论」。
async function getWorkflowTaskSnapshot(
  deps: ScriptWorkflowToolPortDeps,
  taskId: string,
): Promise<WorkflowTaskSnapshot | undefined> {
  if (!isScriptWorkflowStore(deps.sessionStore)) return undefined;
  const run = await deps.sessionStore.getScriptWorkflowRun(taskId);
  if (!run) return undefined;
  const status = workflowTaskStatus(run.status);
  return {
    completedAt: run.completedAt ? new Date(run.completedAt) : undefined,
    description: run.name,
    error: failureMessage(run.failure),
    name: run.name,
    output:
      status === "completed" || status === "failed" || status === "cancelled"
        ? {
            backgroundTaskId: run.id,
            name: run.name,
            response: `Workflow ${status}: ${run.id}`,
            runId: run.id,
            scriptPath: run.scriptPath,
            status: status === "completed" ? "completed" : "failed",
            traceId: deps.traceContext.traceId,
          }
        : undefined,
    runId: run.id,
    startedAt: new Date(run.startedAt ?? run.createdAt),
    status,
    taskId: run.id,
  };
}

interface ResolvedWorkflowSource {
  name?: string;
  scriptPath?: string;
}

/**
 * 来源解析，优先级固定：scriptPath > script > name > resumeFromRunId（最后兜底）。
 * 顺序理由：显式路径必须先于续跑，否则同一请求里的新脚本会被旧 run 顶掉；inline / name / 路径
 *   都会先复制进会话工作目录，run 一律读副本（源文件之后被改或删都不影响本次执行）。
 * 失败语义：四种来源全缺席时抛；具体路径不存在由各自 helper 抛。
 */
// 四段分支按 scriptPath、script、name、resumeFromRunId 顺序线性排列，命中即返回。
// [失败路径] 各分支内部失败直接上抛，不降级到下一来源，避免执行到非预期脚本。
async function resolveWorkflowToolSource(
  deps: ScriptWorkflowToolPortDeps,
  request: WorkflowStartRequest,
  signal?: AbortSignal,
): Promise<ResolvedWorkflowSource> {
  if (request.scriptPath) {
    const sourcePath = resolve(request.workingDirectory, request.scriptPath);
    await validateScriptPath(deps.fileSystemPort, sourcePath, request.trace, signal);
    const copiedPath = await persistScriptCopy(deps, request, sourcePath, signal);
    await validateScriptPath(deps.fileSystemPort, copiedPath, request.trace, signal);
    return { scriptPath: copiedPath };
  }

  if (request.script) {
    const scriptPath = await persistInlineScript(deps, request, signal);
    await validateScriptPath(deps.fileSystemPort, scriptPath, request.trace, signal);
    return { scriptPath };
  }

  if (request.name) {
    const sourcePath = await resolveNamedWorkflowPath(deps, request.name, request.trace, signal);
    const copiedPath = await persistScriptCopy(deps, request, sourcePath, signal);
    await validateScriptPath(deps.fileSystemPort, copiedPath, request.trace, signal);
    return { name: request.name, scriptPath: copiedPath };
  }

  if (request.resumeFromRunId) {
    return findResumeSource(deps, request.resumeFromRunId);
  }

  throw new Error("Workflow requires scriptPath, script, name, or resumeFromRunId.");
}

/** 内联脚本原子写入会话 workflows/ 目录；文件名用 name，否则用 sanitized 的 parentToolCallId。 */
async function persistInlineScript(
  deps: ScriptWorkflowToolPortDeps,
  request: WorkflowStartRequest,
  signal?: AbortSignal,
): Promise<string> {
  const scriptPath = sessionWorkflowScriptPath(deps.storageRoot, deps.sessionId, request);
  await deps.fileSystemPort.writeTextFile(
    {
      atomic: true,
      content: request.script ?? "",
      createParents: true,
      path: scriptPath,
      trace: request.trace,
    },
    { signal },
  );
  return scriptPath;
}

/** 把外部脚本复制进会话目录并返回副本路径：run 以副本为准，源文件后续变更不回溯。 */
// 先读源文件再原子写会话目录，两步共用同一 signal，副本成为本次执行的唯一事实。
// [资源] 源文件只读一次，之后被改或删都不回溯，保证启动与执行看到同一内容。
async function persistScriptCopy(
  deps: ScriptWorkflowToolPortDeps,
  request: WorkflowStartRequest,
  sourcePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const script = await deps.fileSystemPort.readTextFile(
    { path: sourcePath, trace: request.trace },
    { signal },
  );
  const scriptPath = sessionWorkflowScriptPath(deps.storageRoot, deps.sessionId, request);
  await deps.fileSystemPort.writeTextFile(
    {
      atomic: true,
      content: script.content,
      createParents: true,
      path: scriptPath,
      trace: request.trace,
    },
    { signal },
  );
  return scriptPath;
}

/** 查找顺序：项目 .zcode/workflows → 家目录 .zcode/workflows → 内建白名单；首个可读文件胜出，全无则抛。 */
// 查找顺序固定项目目录、家目录、内建表，首个可读文件胜出。
// [权衡] candidates 顺序把 .zcode/workflows 放在家目录之前：仓库内同名脚本覆盖全局版本，首个可读文件胜出。
async function resolveNamedWorkflowPath(
  deps: ScriptWorkflowToolPortDeps,
  name: string,
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<string> {
  const fileName = workflowFileName(name);
  const candidates = [
    join(deps.workingDirectory, ".zcode", "workflows", fileName),
    join(homedir(), ".zcode", "workflows", fileName),
  ];
  const builtIn = BUILTIN_WORKFLOW_ALLOWLIST.get(name);
  if (builtIn) candidates.push(builtIn);

  for (const candidate of candidates) {
    if (await isReadableFile(deps.fileSystemPort, candidate, trace, signal)) return candidate;
  }
  throw new Error(`Workflow not found: ${name}`);
}

/** 续跑来源只认记录里的 scriptPath：store 不可用 / 记录缺失 / 无 scriptPath 都是不可续跑，分别抛出。 */
// [失败路径] store 不可用、记录缺失、记录无 scriptPath 是三种失败，分别给出可区分文案。
async function findResumeSource(
  deps: ScriptWorkflowToolPortDeps,
  runId: string,
): Promise<ResolvedWorkflowSource> {
  if (!isScriptWorkflowStore(deps.sessionStore)) {
    throw new Error("Script workflow store is not available for this session store.");
  }
  const run = await deps.sessionStore.getScriptWorkflowRun(runId);
  if (!run) throw new Error(`Workflow run not found: ${runId}`);
  if (!run.scriptPath) throw new Error(`Workflow run has no script path: ${runId}`);
  return { name: run.name, scriptPath: run.scriptPath };
}

/** 只校验"能读成合法脚本"（语法/结构错误由 readWorkflowScriptDocument 抛）；两段之间再查一次 abort。 */
// 校验复用读取文档的入口，语法与结构错误由底层抛，读完再查一次 abort 防慢读漏取消。
async function validateScriptPath(
  fileSystemPort: FileSystemPort,
  scriptPath: string,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  await readWorkflowScriptDocument({ fileSystemPort, scriptPath, traceContext });
  if (signal?.aborted) {
    throw createCoreError(CoreErrorType.ToolCancelled, "Workflow launch cancelled");
  }
}

// [错误码映射] 只把 not_found 转成 false，权限等其它错误继续上抛，避免把故障当不存在。
async function isReadableFile(
  fileSystemPort: FileSystemPort,
  path: string,
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const stat = await fileSystemPort.stat({ path, trace }, { signal });
    return stat.kind === "file";
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") return false;
    throw error;
  }
}

/** name 白名单校验（防路径穿越）+ 缺省补统一后缀；非法字符直接抛，不静默替换。 */
// 名字先过白名单正则再过后缀补全，顺序不能反，否则后缀里的点会绕过校验。
// [失败路径] 非法字符直接抛，静默替换会让同一 name 在不同机器落到不同文件。
function workflowFileName(name: string): string {
  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    throw new Error(`Workflow name must contain only letters, numbers, dot, dash, or underscore.`);
  }
  return name.endsWith(WORKFLOW_SCRIPT_SUFFIX) ? name : `${name}${WORKFLOW_SCRIPT_SUFFIX}`;
}

// 6 态收敛成 Core 的 4 态：pending/running/paused 都是 running（paused 可续），未知值才归 lost。
// [错误码映射] pending、running、paused 统一收敛成 running，paused 视为可续跑。
// 未知值归 lost 而非 running，避免将来新增状态让等待逻辑永不结束。
function workflowTaskStatus(status: ScriptWorkflowRunStatus): WorkflowTaskStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "pending" || status === "running" || status === "paused") return "running";
  return "lost";
}

function failureMessage(failure: unknown): string | undefined {
  if (!failure) return undefined;
  if (typeof failure === "string") return failure;
  if (typeof failure === "object" && "message" in failure) {
    const message = (failure as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return String(failure);
}

/** 会话内脚本目录：<storageRoot>/cli/sessions/<sessionId>/workflows/，文件名取 name 或 sanitized 的调用 id。 */
// 路径固定为 storageRoot 下的 cli/sessions/<sessionId>/workflows，用 join 拼而不手写分隔符。
function sessionWorkflowScriptPath(
  storageRoot: string,
  sessionId: SessionId,
  request: WorkflowStartRequest,
): string {
  const baseName = request.name
    ? workflowFileName(request.name)
    : `${safeId(request.parentToolCallId)}${WORKFLOW_SCRIPT_SUFFIX}`;
  return join(storageRoot, "cli", "sessions", sessionId, "workflows", baseName);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}
