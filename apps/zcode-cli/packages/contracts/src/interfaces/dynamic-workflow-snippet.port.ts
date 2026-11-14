// ============================================================
// Dynamic Workflow Snippet Port - snippet 的同步编译执行边界
// ============================================================
// 与 {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort} 并列而非合并：
// run 端口的构造前提是 durable journal（没有持久化就没有 run），而 snippet 完全瞬态、
// 只依赖两个执行端口——把它挂在 run 端口上等于让实验通道被 durability 前提连坐。
//
// 【三条不变式】①同一执行面：编译与 world-read 走生产的同一套 lowering / 沙箱 / caps，
// 存在理由就是保真；②完全瞬态：InMemoryJournalStore、随机 runId、不落 `dwf_*` 行、不进
// 后台任务追踪器，进程退出即消失是契约而非缺陷；③asks 在编译期被排除（scratch facade 没有
// `agent()`），driver 的 ask 族方法运行期到达即为接线 bug。生产者是 bootstrap 的
// `createDynamicWorkflowSnippetService`，消费者是 core 的 `EvalWorkflowSnippet` handler。

import type { TraceContext } from "../tracing/tracer.js";

/**
 * 【契约坐标】与 `CreateWorkflow` 的诊断同形（code / line / column / message），但端口不
 * import zod schema——这里的类型只描述编译器的产物。生产者：`collectDiagnostics`（同一次
 * ts.Program，含 TS1184 与 index-access 改写）；消费者：core handler 直接把它渲染成
 * tool_result，模型据此在同一调用内修代码重试。行号 1 起、列号 1 起，指向 snippet 源码本身。
 */
/** 一条编译诊断的 JSON 形状（与 CreateWorkflow 的诊断同形；端口不 import zod schema）。 */
export interface DynamicWorkflowSnippetDiagnostic {
  code: number;
  column: number;
  line: number;
  message: string;
}

/**
 * 【契约坐标】`code` 是**一次性**源码（没有脚本文件、没有 resume 身份）；`cwd` 同时是沙箱
 * 子进程 cwd 与 `world-read` 的根；`timeoutMs` 是整段 snippet 的墙钟，钳制归工具层，端口只
 * 按值执行；`trace` 贯穿编译与执行。请求里没有 runId / sessionId——snippet 不落库、不归属
 * 任何会话，失败也不产生可恢复的 run。生产者：core 的 `EvalWorkflowSnippet` handler；
 * 消费者：bootstrap 的 snippet service。
 */
export interface DynamicWorkflowSnippetEvalRequest {
  /** snippet 源码（scratch facade 词汇：files.*、git.*、log、纯 TS）。 */
  code: string;
  /** 执行工作目录（沙箱子进程 cwd、world-read 的根）。 */
  cwd: string;
  /** 整段 snippet 的墙钟（ms）。钳制归工具层；端口只按值执行。 */
  timeoutMs: number;
  trace: TraceContext;
}

/**
 * 【契约坐标】`signal` 覆盖**整段** eval（编译 + 执行 + 结算），中止后返回 `failed` 形态而不是
 * 抛错；它不跨调用保留，下次 eval 是全新的一次。生产者：core handler 的 tool call 取消；
 * 消费者：snippet service 的沙箱与 world-read 执行面。
 */
export interface DynamicWorkflowSnippetEvalOptions {
  signal?: AbortSignal;
}

/**
 * 【契约坐标】三种形态互斥且由 `kind` 判别：`diagnostics` 表示**什么都没执行**；
 * `completed` 的 `artifact` 是脚本顶层返回值（`undefined` 即字段缺席，序列化上界 256 KiB，
 * 超限落到 `failed`）；`failed` 的 `error.code` 是稳定码（超时 / 脚本抛错 / cap 拒绝 / 中止）。
 * `logs` 在后两种形态都在场，上界 100 行、每行 2048 字；`logsTruncated` 说出是否发生过裁剪。
 * 生产者：snippet service；消费者：core handler 的 tool_result。结果不落库。
 *
 * eval 的结构化结果。三种形态互斥：
 *   - 编译不过：`diagnostics` 非空，未执行任何东西；
 *   - 执行完成：`artifact` 是脚本顶层返回值（`undefined` 产物即字段缺席）；
 *   - 执行失败：`error` 携带稳定错误码（超时 / 脚本抛错 / cap 拒绝都在此形态）。
 * logs 在后两种形态都在场（失败前的叙事同样有价值）。
 */
export type DynamicWorkflowSnippetEvalResult =
  | { kind: "diagnostics"; diagnostics: DynamicWorkflowSnippetDiagnostic[] }
  | { kind: "completed"; artifact?: unknown; logs: string[]; logsTruncated: boolean }
  | {
      kind: "failed";
      error: { code: string; message: string };
      logs: string[];
      logsTruncated: boolean;
    };

/**
 * 【契约坐标】`evalSnippet` **同步等到结算**（返回 Promise 但无后台句柄可查、无 cancel 方法）：
 * 没有 runId、没有 `dwf_*` 行、没有后台任务追踪，因此也不存在冷恢复或续跑。失败不会被重试，
 * 诊断与日志就是全部可观测面。生产者：bootstrap 的 snippet service；消费者：core 的
 * `EvalWorkflowSnippet` handler（每个 tool call 一次调用）。
 */
export interface DynamicWorkflowSnippetPort {
  /** 编译一次并同步执行至结算（完全瞬态：无 dwf_* 行、无后台任务）。 */
  evalSnippet(
    request: DynamicWorkflowSnippetEvalRequest,
    options?: DynamicWorkflowSnippetEvalOptions,
  ): Promise<DynamicWorkflowSnippetEvalResult>;
}
