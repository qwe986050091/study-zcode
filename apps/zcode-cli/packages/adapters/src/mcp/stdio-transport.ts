/* ============================================================
 * 进程树感知的 stdio transport（adapters/src/mcp/stdio-transport.ts）
 *
 * 定位：在 MCP SDK 的 StdioClientTransport 之上补齐两件事——整棵子进程树的回收，
 * 以及官方 stdio MCP 的逐消息身份头注入。
 * 输入：SDK stdio 参数（额外支持 requestMetaProvider）、可选 Job Object 工厂。
 * 输出：可直接交给 MCP Client 的 transport；暴露退出信息与存活状态。
 * 副作用：spawn 子进程、pipe、Windows Job Object 原生句柄、taskkill 子进程。
 * 失败语义：Job Object/taskkill 失败均降级（保留 SDK close 回退）；_dispose 中的
 * 树回收是 best-effort，不会阻断 pipe 清理。
 * 不变量：每个 transport 生命周期内只托管一棵进程树；退出信息只记录第一次 exit；
 * `_dispose` 必须由本类直接拥有（原型覆写），SDK 才会把它当作可克隆的探测 transport。
 * ============================================================ */

import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import type { ChildProcess } from "node:child_process";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import {
  attachProcessToWindowsJobObject,
  type WindowsJobObjectController,
} from "./windows-job-object.js";

type SdkStdioDispose = (this: StdioClientTransport) => Promise<void>;

const sdkDispose = Object.getOwnPropertyDescriptor(StdioClientTransport.prototype, "_dispose")
  ?.value as SdkStdioDispose | undefined;

/** 每次发请求前解析身份载荷；返回 undefined 表示本次不注入。 */
export type StdioRequestMetaProvider = () => Promise<Record<string, unknown> | undefined>;

/**
 * 子进程退出快照（只记第一次 exit）。
 *
 * exitCode：正常退出码，被信号终止时为 null；
 * signal：终止信号，正常退出时为 null；
 * startedAt / exitedAt：epoch ms，用于 uptime 与退出诊断。
 */
export interface StdioProcessExitInfo {
  exitCode: number | null;
  exitedAt: number;
  signal: NodeJS.Signals | null;
  startedAt: number;
}

type ProcessTreeStdioServerParameters = StdioServerParameters & {
  /**
   * 官方 stdio MCP 的逐消息身份载荷提供器。它作为 spawn 参数的非执行字段保留，确保 SDK
   * 为 modern probe 克隆 sibling transport 时，`server/discover` 与正式 session 使用同一注入边界。
   */
  requestMetaProvider?: StdioRequestMetaProvider;
};

/**
 * 构造选项：windowsJobObjectFactory 允许注入 Job Object 实现（测试/降级）。
 * 缺省使用 attachProcessToWindowsJobObject；返回 undefined 表示原生托管不可用。
 */
export interface ProcessTreeStdioClientTransportOptions {
  windowsJobObjectFactory?: (
    pid: number,
  ) => Promise<WindowsJobObjectController | undefined>;
}

/**
 * SDK 2.0 会为 stdio 版本探测创建一次性兄弟进程，但其私有回收钩子只终止直接子进程。
 * launcher/watchdog 派生的后代会因此变成孤儿；在同一个钩子里先回收整棵进程树，再让
 * SDK 清理 pipe 和读取缓冲区。原型上必须直接拥有 `_dispose`，SDK 才会把该 transport
 * 识别为可安全克隆的探测 transport。
 */
/**
 * 带进程树回收的 stdio transport。
 *
 * 覆写 send()：在消息 params._meta 中合并宿主提供的身份载荷（仅请求/通知，响应不动）。
 * 覆写 start()：记录退出信息，并在 Windows 上把子进程挂到 kill-on-close 的 Job Object。
 * processExit / processAlive：供 adapter 判断崩溃与存活；无副作用。
 * 原型 _dispose：先终止 Job Object，再 taskkill 整棵树，最后调用 SDK 原 dispose。
 */
export class ProcessTreeStdioClientTransport extends StdioClientTransport {
  private childProcess?: ChildProcess;
  private lastProcessExit?: StdioProcessExitInfo;
  private readonly requestMetaProvider?: StdioRequestMetaProvider;
  private readonly windowsJobObjectFactory: (
    pid: number,
  ) => Promise<WindowsJobObjectController | undefined>;
  private windowsJobObject?: WindowsJobObjectController;

  constructor(
    server: ProcessTreeStdioServerParameters,
    options: ProcessTreeStdioClientTransportOptions = {},
  ) {
    super(server);
    this.requestMetaProvider = server.requestMetaProvider;
    this.windowsJobObjectFactory =
      options.windowsJobObjectFactory ?? attachProcessToWindowsJobObject;
  }

  /** 终止并关闭 Windows Job Object；重复调用幂等，句柄失败不抛错。 */
  async terminateWindowsJobObject(): Promise<void> {
    const windowsJobObject = this.windowsJobObject;
    this.windowsJobObject = undefined;
    if (!windowsJobObject) return;
    try {
      windowsJobObject.terminate();
    } catch {
      // 继续执行 close 与 taskkill 回退。
    } finally {
      try {
        windowsJobObject.close();
      } catch {
        // 句柄关闭失败不能阻断 SDK pipe 清理。
      }
    }
  }

  /** 发送前解析并合并身份载荷；解析失败与否由 provider 自身决定，这里不吞业务错误。 */
  override async send(message: JSONRPCMessage): Promise<void> {
    const requestMeta = await this.requestMetaProvider?.();
    await super.send(mergeRequestMeta(message, requestMeta));
  }

  /**
   * 启动子进程并记录其生命周期。
   *
   * 若子进程已退出（spawn 即失败等），直接记录快照并返回；否则监听第一次 exit。
   * Windows 且已有 pid 时尝试挂 Job Object，失败则保留 taskkill 回退，不影响建连。
   * 副作用：spawn、事件监听、原生句柄创建；本方法本身不重新抛 Job Object 错误。
   */
  override async start(): Promise<void> {
    const startedAt = Date.now();
    await super.start();
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (!child) return;
    this.childProcess = child;
    const recordExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      this.lastProcessExit ??= {
        exitCode,
        exitedAt: Date.now(),
        signal,
        startedAt,
      };
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      recordExit(child.exitCode, child.signalCode);
      return;
    }
    child.once("exit", recordExit);

    // staging 曾把 Job Object 接管和退出观测各自合入成两个同名 start()，导致 CLI
    // 构建直接报 Duplicate function implementation；这里合并两个职责，保留 Windows
    // 进程树托管和跨平台退出记录。
    if (process.platform !== "win32" || this.pid == null) return;
    try {
      this.windowsJobObject = await this.windowsJobObjectFactory(this.pid);
    } catch {
      // 原生托管不可用时保留 taskkill 回退，不能让 MCP 建连因可选能力失败。
      this.windowsJobObject = undefined;
    }
  }

  /** 第一次 exit 的快照；从未退出/尚未 start 时 undefined。 */
  get processExit(): StdioProcessExitInfo | undefined {
    return this.lastProcessExit;
  }

  /** 子进程仍存活（存在且 exitCode/signalCode 均为 null）；未启动时为 false。 */
  get processAlive(): boolean {
    return Boolean(
      this.childProcess &&
      this.childProcess.exitCode === null &&
      this.childProcess.signalCode === null,
    );
  }
}

/**
 * 把身份载荷并入消息 params._meta。
 *
 * 仅当消息是请求/通知（有 method）且载荷非空时才改；响应没有 method，不得伪造 params。
 * 合并采用覆盖语义：宿主刚解析的载荷覆盖调用方残留值，防止旧凭证继续存活。
 * 返回新对象，不修改原消息。
 */
function mergeRequestMeta(
  message: JSONRPCMessage,
  requestMeta: Record<string, unknown> | undefined,
): JSONRPCMessage {
  // JSON-RPC response 没有 method，不得给响应伪造 params。只修改 client 发出的请求与通知。
  if (!("method" in message) || !requestMeta || Object.keys(requestMeta).length === 0) {
    return message;
  }
  const params = isRecord(message.params) ? message.params : {};
  const existingMeta = isRecord(params._meta) ? params._meta : {};
  return {
    ...message,
    params: {
      ...params,
      // 宿主刚解析的官方身份载荷必须覆盖调用方残留值，避免旧凭证继续存活。
      _meta: { ...existingMeta, ...requestMeta },
    },
  } as JSONRPCMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 覆写 SDK 的私有 _dispose 钩子：先回收整棵进程树，再交回 SDK 清理 pipe。
 *
 * 顺序不可颠倒：Job Object 必须先 terminate/close（Windows），随后 taskkill/pgrep
 * 回收后代；即使树回收失败也继续执行 SDK dispose，避免探测协商永久卡住。
 * 该属性必须直接定义在原型上，SDK 才认为此 transport 可安全克隆。
 */
Object.defineProperty(ProcessTreeStdioClientTransport.prototype, "_dispose", {
  configurable: true,
  async value(this: ProcessTreeStdioClientTransport): Promise<void> {
    const pid = this.pid;
    await this.terminateWindowsJobObject();
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
      try {
        await terminateMcpStdioProcessTree(pid);
      } catch {
        // SDK 的探测回收本来就是 best effort；仍需继续释放 pipe，避免协商永久卡住。
      }
    }

    if (sdkDispose) {
      await sdkDispose.call(this);
      return;
    }
    await this.close();
  },
});
