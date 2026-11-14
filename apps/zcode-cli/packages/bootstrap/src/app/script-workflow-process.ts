// INV-01 脚本正文经 argv 传入：守住位置 base64url 载荷；改错故障 正文落盘污染工作目录。
// INV-02 载荷单项编码整包：守住位置 JSON 序列化；改错故障 特殊字符被 shell 截断。
// INV-03 执行目录只作 cwd：守住位置 spawn 选项；改错故障 相对路径解析到宿主目录。
// INV-04 三路管道全部显式建立：守住位置 stdio 配置；改错故障 子进程写响应时阻塞。
// INV-05 标准错误只留尾部：守住位置 trimStderr；改错故障 长日志撑爆宿主内存。
// INV-06 标准输出按行解析：守住位置 readline 接口；改错故障 多行消息被拆碎。
// INV-07 空行直接跳过：守住位置 trim 判断；改错故障 JSON 解析抛错。
// INV-08 事件消息只观测不阻塞：守住位置 event 分支；改错故障 后续请求被拖住。
// INV-09 请求必须回执：守住位置 writeResponse；改错故障 子进程永久等待。
// INV-10 请求异常转成失败回执：守住位置 catch 分支；改错故障 异常逃逸导致整轮失败。
// INV-11 取消优先于退出码：守住位置 aborted 判断；改错故障 报退出码而非取消原因。
// INV-12 缺少完成消息视为失败：守住位置 completed 判断；改错故障 静默返回未定义值。
// INV-13 完成消息标记失败即抛错：守住位置 ok 判断；改错故障 错误结果被当成功。
// INV-14 非零退出码兜底报错：守住位置 exitCode 判断；改错故障 失败运行返回成功。
// INV-15 标准输入关闭后不再写：守住位置 stdin 判空；改错故障 空指针异常。
// INV-16 监听器在收尾时移除：守住位置 finally 分支；改错故障 重复注册导致泄漏。
// INV-17 未结算则补杀子进程：守住位置 settled 判断；改错故障 异常路径遗留孤儿进程。
// INV-18 协议行非法即整轮失败：守住位置 JSON.parse；改错故障 半截输出被忽略。
//
// 模块职责：把工作流脚本放进独立 Node 子进程执行，并把请求与事件回传给宿主。
// 状态所有权：子进程、完成消息与结算标记均为单次调用的局部状态。
// 阅读顺序：先看载荷与启动，再看逐行分发，最后看收尾与错误映射。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { WorkflowScriptDocument } from "./script-workflow-meta.js";
import { SCRIPT_WORKFLOW_CHILD_SOURCE } from "./script-workflow-child-source.js";

const WORKFLOW_CHILD_STDERR_LIMIT = 64 * 1024;

/**
 * 子进程发回的请求信封：`type` 决定宿主侧处理分支（agent / workflow / ...），`payload` 是
 * 该类型的原始参数，`id` 用于把 response 配对回 pending Promise。宿主只透传，不理解内容。
 */
// ScriptWorkflowChildRequest 只含 id / payload / type 三个字段。
// type 决定宿主侧的处理分支。
// payload 保持原始形态透传。
// id 用于把回执配对回等待方的 pending Promise。
// 宿主不解释 payload 内容。
export interface ScriptWorkflowChildRequest {
  id: string;
  payload: unknown;
  type: string;
}

interface ScriptWorkflowChildEvent {
  payload: unknown;
  type: string;
}

interface ScriptWorkflowChildRunResult {
  stderr: string;
  value: unknown;
}

/**
 * 在独立 Node 子进程里执行脚本体，并把子进程的 request / event / complete 回流给宿主。
 *
 * 输入：`document.body` 与脚本 URL、args、budget 一起 base64url 编码进 argv 最后一项；脚本正文
 * 走 argv 而不是 cwd 文件，执行目录只作为 `cwd` 语义。`handleRequest` 必须为每个 request id
 * 回一个值（异常会被序列化成 ok:false）；`handleEvent` 只做观测，不阻塞后续行。
 * 生命周期：stdout 逐行解析（JSONL），`complete` 消息才携带最终 value；abort 会 kill 子进程，
 * 且优先以 signal 的 reason 作为错误抛出；exit≠0 或无 complete 都视为失败。stderr 仅保留尾部
 * 64 KiB，用于错误兜底而不是完整日志。finally 保证监听器移除，未 settle 时补 kill 防泄漏。
 * 失败语义：协议行 JSON 非法、request 处理抛错、子进程异常退出都会让本次 run 失败。
 */
// 脚本正文与参数同包编码。
// 执行目录只影响子进程 cwd。
// handleRequest() 必须返回可序列化值，异常会被序列化成 ok:false。
// handleEvent() 只做观测，不参与控制流。
// finally 里 signal?.removeEventListener("abort", abort) 撤销注册。
export async function runScriptWorkflowChild(input: {
  args?: unknown;
  budgetTotal?: number;
  document: WorkflowScriptDocument;
  handleEvent(event: ScriptWorkflowChildEvent): Promise<void> | void;
  handleRequest(request: ScriptWorkflowChildRequest): Promise<unknown>;
  signal?: AbortSignal;
  workingDirectory: string;
}): Promise<ScriptWorkflowChildRunResult> {
  const payload = Buffer.from(
    JSON.stringify({
      args: input.args,
      budgetTotal: input.budgetTotal,
      scriptBody: input.document.body,
      scriptUrl: pathToFileURL(input.document.path).href,
    }),
    "utf8",
  ).toString("base64url");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", SCRIPT_WORKFLOW_CHILD_SOURCE, "--", payload],
    {
      cwd: input.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderr = "";
  let completed:
    | {
        error?: string;
        ok: boolean;
        stack?: string;
        value?: unknown;
      }
    | undefined;
  let settled = false;

  const abort = (): void => {
    child.kill();
  };
  input.signal?.addEventListener("abort", abort, { once: true });

  child.stderr.on("data", (chunk: Buffer) => {
    // 只保留尾部：早期 stderr 对定位脚本失败帮助有限，但无限累积会撑爆宿主内存。
    stderr = trimStderr(stderr + chunk.toString("utf8"));
  });

  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    void handleChildLine(line, {
      child,
      complete: (message) => {
        completed = message;
      },
      handleEvent: input.handleEvent,
      handleRequest: input.handleRequest,
    }).catch((error) => {
      completed = {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      };
      child.kill();
    });
  });

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    settled = true;
    // 先看 abort：子进程被 kill 后 exitCode 可能非 0，但语义上应报告取消原因而不是退出码。
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("Workflow script run cancelled");
    }
    if (!completed) {
      throw new Error(stderr || `Workflow child exited without completion: ${exitCode}`);
    }
    if (!completed.ok) {
      throw new Error(completed.error || "Workflow script failed", {
        cause: completed.stack,
      });
    }
    if (exitCode !== 0) {
      throw new Error(stderr || `Workflow child exited with code ${exitCode}`);
    }
    return {
      stderr,
      value: completed.value,
    };
  } finally {
    input.signal?.removeEventListener("abort", abort);
    if (!settled) child.kill();
  }
}

// line.trim() 为空时不产生任何副作用。
// 事件消息由 handleEvent() 先于请求分发。
// "complete" 消息只记录 value，不立即返回。
// handleRequest() 成功时写 ok:true 回执。
// [失败路径] handleRequest 抛错时回执 ok:false 并附 stack：子进程按 ok:false 退出非零，父进程不必再猜错误来源。
async function handleChildLine(
  line: string,
  deps: {
    child: ReturnType<typeof spawn>;
    complete(message: { error?: string; ok: boolean; stack?: string; value?: unknown }): void;
    handleEvent(event: ScriptWorkflowChildEvent): Promise<void> | void;
    handleRequest(request: ScriptWorkflowChildRequest): Promise<unknown>;
  },
): Promise<void> {
  if (!line.trim()) return;
  const message = JSON.parse(line) as
    | {
        id: string;
        kind: "request";
        payload: unknown;
        type: string;
      }
    | {
        kind: "event";
        payload: unknown;
        type: string;
      }
    | {
        error?: string;
        kind: "complete";
        ok: boolean;
        stack?: string;
        value?: unknown;
      };

  if (message.kind === "event") {
    await deps.handleEvent({ payload: message.payload, type: message.type });
    return;
  }
  if (message.kind === "complete") {
    deps.complete(message);
    return;
  }

  try {
    const value = await deps.handleRequest(message);
    writeResponse(deps.child, {
      id: message.id,
      ok: true,
      value,
    });
  } catch (error) {
    writeResponse(deps.child, {
      error: error instanceof Error ? error.message : String(error),
      id: message.id,
      ok: false,
    });
  }
}

function writeResponse(
  child: ReturnType<typeof spawn>,
  message: { error?: string; id: string; ok: boolean; value?: unknown },
): void {
  if (!child.stdin) return;
  child.stdin.write(`${JSON.stringify({ kind: "response", ...message })}\n`);
}

function trimStderr(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= WORKFLOW_CHILD_STDERR_LIMIT) return value;
  return value.slice(-WORKFLOW_CHILD_STDERR_LIMIT);
}
