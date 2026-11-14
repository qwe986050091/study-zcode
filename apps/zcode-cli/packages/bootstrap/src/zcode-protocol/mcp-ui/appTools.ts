// INV-01 同作用域新代际替换旧代际：守住位置 遍历删除；改错故障 页面重载后旧工具仍可调用。
// INV-02 同服务只暴露最新登记实例：守住位置 序号比较；改错故障 旧窗口的工具覆盖新窗口。
// INV-03 登记序号首次分配后不变：守住位置 空值兜底；改错故障 重复登记让旧实例复活。
// INV-04 暴露集合按键名去重：守住位置 集合判断；改错故障 模型看到重名工具。
// INV-05 只返回本实例工具：守住位置 双字段过滤；改错故障 页面看到别人的工具。
// INV-06 运行时不接受即清空会话：守住位置 空值判断；改错故障 本地残留幽灵工具。
// INV-07 认领期与执行期两段计时：守住位置 两次设置；改错故障 页面卡住时模型永远等待。
// INV-08 认领超时注销实例：守住位置 超时分支；改错故障 死页面一直占着工具名。
// INV-09 认领幂等不重置计时：守住位置 已认领判断；改错故障 重放认领无限续命。
// INV-10 只接受本实例认领后的回传：守住位置 实例键比较；改错故障 页面替别人伪造结果。
// INV-11 参数超限在登记前拒绝：守住位置 字节判断；改错故障 大参数先占用调用槽。
// INV-12 结果超限转为失败：守住位置 字节判断；改错故障 巨型结果回灌模型。
// INV-13 每次调用重新解析实例：守住位置 调用内查找；改错故障 已替换实例仍被投递。
// INV-14 中止信号先移除监听再拒绝：守住位置 语句顺序；改错故障 取消后监听泄漏。
// INV-15 失败路径都清理待执行表：守住位置 统一结算；改错故障 模型侧承诺悬挂。
// INV-16 会话关闭先删表再结算：守住位置 语句顺序；改错故障 结算回调把状态写回。
// INV-17 日志带事件名与会话标识：守住位置 日志字段；改错故障 无法按会话排障。
// INV-18 注册表不持久化：守住位置 内存映射；改错故障 重启后恢复已死页面的工具。
//
// 模块职责：会话内 App 提供工具的登记、暴露集合与待执行调用唯一 owner。
// 状态所有权：三份内存状态全部由本注册表持有，会话关闭即清空。
// 阅读顺序：先看宿主接口，再看登记与认领，最后看执行器与同步。
import type { Logger, McpToolCallResult } from "@zcode/contracts";
import type { McpAppProvidedToolDefinition, McpAppProvidedToolExecutor } from "@zcode/core";
import {
  MCP_APPS_APP_TOOL_ARGUMENTS_MAX_BYTES,
  MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS,
  MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS,
  MCP_APPS_APP_TOOL_RESULT_MAX_BYTES,
  buildMcpAppsAppToolModelName,
  type McpAppsAppToolCallRequest,
  type McpAppsAppToolDescriptor,
} from "@zcode/shared/mcp-apps";
import { randomUUID } from "node:crypto";
import type {
  McpUiAppToolCallParams,
  McpUiAppToolInstance,
  McpUiRegisterAppToolsParams,
  McpUiRegisterAppToolsResult,
  McpUiResolveAppToolCallParams,
} from "./appToolsContract.js";

/**
 * App-Provided Tools 登记表：会话内页面实例的工具、暴露给模型的集合与待执行调用的唯一 owner。
 * 只在内存；会话关闭清空，不持久化。模型调用经"实例信箱"（`publishCall` → live-only 投影增量）投递给
 * 唯一实例，渲染端认领（claim）后页面 tools/call，结果经 resolve 回传。
 */
// applyTools 把暴露集合同步进会话 runtime，整体替换。
// 信箱只投递给单个实例：instanceKey 命中一个才算。
// logger 与 now 可注入，测试里替换时钟。
export interface McpUiAppToolsHost {
  /** 把暴露集合同步到会话 runtime（整体替换）；会话不在时返回 null。 */
  applyTools(
    sessionId: string,
    definitions: readonly McpAppProvidedToolDefinition[],
    execute: McpAppProvidedToolExecutor,
  ): string[] | null;
  /** 信箱投递：一次待执行调用 → 该会话的 live 投影（只投给 instance 一个实例）。 */
  publishCall(
    sessionId: string,
    target: {
      pluginId: string;
      serverName: string;
      instance: McpUiAppToolInstance;
      credential: import("@zcode/shared/mcp-apps").McpAppInstance;
    },
    call: McpAppsAppToolCallRequest,
  ): void;
  logger?: Logger;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => () => void;
  createCallId?: () => string;
}

interface InstanceRecord {
  credential: import("@zcode/shared/mcp-apps").McpAppInstance;
  instance: McpUiAppToolInstance;
  pluginId: string;
  serverName: string;
  /** 首次登记序号：同 server 只暴露序号最大的实例；重新登记不变。 */
  seq: number;
  tools: McpAppsAppToolDescriptor[];
}

interface PendingCall {
  instanceKey: string;
  toolName: string;
  claimed: boolean;
  settle(outcome: { result: McpToolCallResult } | { error: Error }): void;
  cancelTimer: () => void;
}

interface SessionState {
  instances: Map<string, InstanceRecord>;
  nextSeq: number;
  pending: Map<string, PendingCall>;
}

/** 实例键 = 沙箱作用域 + 代际；同作用域的新代际替换旧代际。 */
export const buildMcpUiAppToolInstanceKey = (instance: McpUiAppToolInstance) =>
  `${instance.scopeId}|${instance.generation}`;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/**
 * App-Provided Tools 的唯一内存 owner：每个 session 维护三份状态
 * （instances 登记表 / 暴露给模型的 definitions / 待执行调用 pending）。
 *
 * 生命周期：页面 register → 同步工具到 runtime → 模型 tool call 经 `execute` 投递信箱
 * （publishCall，live-only，不重发）→ 渲染端 claim → 页面 tools/call → resolve 回填。
 * 关键不变量：
 * - 同一 scopeId 的新代际替换旧代际；同 serverName 只暴露 seq 最大的实例；
 * - 每个 pending 调用有「认领期限」与「执行期限」两段计时，超时都以 error settle；
 * - 所有失败路径都先 removeEventListener + 删 pending，保证模型侧 Promise 不会悬挂；
 * - 不持久化；session 关闭即 clearSession 并让全部 pending 失败。
 */
// 每个 sessionId 各持一份 SessionState，互不共享。
// 计时器 unref()，默认不阻止进程退出。
// callId 生成器可注入，测试里能得到固定标识。
export class McpUiAppToolRegistry {
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private readonly createCallId: () => string;

  // 计时器默认 unref：后台超时任务不应阻止 CLI 进程退出；测试可注入 setTimer 控制时序。
  constructor(private readonly host: McpUiAppToolsHost) {
    this.now = host.now ?? Date.now;
    this.setTimer =
      host.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.createCallId = host.createCallId ?? randomUUID;
  }

  /**
   * 登记页面实例的工具集合。输入为已校验的 register params（sessionId / scopeId /
   * generation / serverName / tools / 实例凭证）。
   * 副作用：删除同 scopeId 的旧代际实例（连同其 pending 调用一并失败）、写 registered 日志、
   * 通过 host.applyTools 整体替换 runtime 暴露集。
   * 返回仅属于本实例（scopeId+generation 匹配）的 {name, modelName} 列表，
   * 而不是全部暴露项——页面只应看到自己的工具。session 不在时 applyTools 返回 null，
   * sync 会清空 session 并返回空。
   */
  // 新代际整体替换同 instanceKey 的旧代际。
  // 登记序号首次分配后不再变，重放沿用原序号。
  // register 整体替换暴露集合，不做增量合并。
  // 返回结果只含本实例注册的工具，不混入其他实例。
  register(params: McpUiRegisterAppToolsParams): McpUiRegisterAppToolsResult {
    const session = this.sessionOf(params.sessionId);
    const key = buildMcpUiAppToolInstanceKey(params);
    // 同一沙箱作用域的新代际（页面重载 / 重挂载）替换旧代际。
    for (const [existingKey, record] of Array.from(session.instances)) {
      if (existingKey !== key && record.instance.scopeId === params.scopeId) {
        this.dropInstance(params.sessionId, session, existingKey, "App page was reloaded");
      }
    }
    const existing = session.instances.get(key);
    session.instances.set(key, {
      credential: params.instance,
      instance: { scopeId: params.scopeId, generation: params.generation },
      pluginId: params.pluginId,
      serverName: params.serverName,
      seq: existing?.seq ?? session.nextSeq++,
      tools: params.tools,
    });
    const exposed = this.sync(params.sessionId, session);
    const mine = exposed.filter(
      (item) => item.scopeId === params.scopeId && item.generation === params.generation,
    );
    this.host.logger?.info("MCP UI app tools registered", {
      event: "mcp.ui.app_tools.registered",
      mcpServerName: params.serverName,
      sessionId: params.sessionId,
      toolCount: params.tools.length,
      exposedCount: mine.length,
    });
    return { tools: mine.map((item) => ({ name: item.toolName, modelName: item.modelName })) };
  }

  /**
   * 反登记实例并同步暴露集；返回被移除实例的工具数（0 表示键不存在，属幂等成功）。
   * 副作用：该实例所有 pending 调用以 "App page was closed" 失败（模型不会拿到假结果）。
   */
  unregister(sessionId: string, instance: McpUiAppToolInstance): number {
    const session = this.sessions.get(sessionId);
    const key = buildMcpUiAppToolInstanceKey(instance);
    const record = session?.instances.get(key);
    if (!session || !record) return 0;
    this.dropInstance(sessionId, session, key, "App page was closed");
    this.sync(sessionId, session);
    return record.tools.length;
  }

  /**
   * 渲染端认领待执行调用。返回 false 的三类原因：session/pending 不存在、callId 已知但
   * 属于别的实例键、调用已被注销。认领成功后把计时器从「认领期限」切换为「执行期限」，
   * 后者超时也会 settle(error)，所以模型侧一定会收到终态。
   */
  // buildMcpUiAppToolInstanceKey 不等时直接拒绝。
  // 已认领的 callId 重放仍返回 true。
  // claim 成功后计时器从认领期限切到执行期限。
  // 执行期限超时同样 settle(error)，模型侧一定收到终态。
  claim(params: McpUiAppToolCallParams): boolean {
    const session = this.sessions.get(params.sessionId);
    const pending = session?.pending.get(params.callId);
    const key = buildMcpUiAppToolInstanceKey(params);
    if (!session || !pending || pending.instanceKey !== key) return false;
    // callId 幂等：同一实例重放认领仍回 true，不重置执行计时；渲染端按 callId 去重，不会执行两次。
    if (pending.claimed) return true;
    pending.cancelTimer();
    pending.claimed = true;
    pending.cancelTimer = this.setTimer(
      () =>
        pending.settle({
          error: new Error(
            `App tool ${pending.toolName} timed out after ${MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS} ms`,
          ),
        }),
      MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS,
    );
    return true;
  }

  /**
   * 回传页面执行结果。只接受“本实例已认领该 callId”的调用（未认领的 resolve 返回 false），
   * 避免页面替其他实例伪造结果。error 分支统一包装成 Error；成功结果超过
   * RESULT_MAX_BYTES 也不截断，直接转为 error settle。
   * 返回 true 但不保证内容被接受——边界失败的语义已通过 settle(error) 传达给模型。
   */
  resolve(params: McpUiResolveAppToolCallParams): boolean {
    const session = this.sessions.get(params.sessionId);
    const pending = session?.pending.get(params.callId);
    if (
      !pending ||
      !pending.claimed ||
      pending.instanceKey !== buildMcpUiAppToolInstanceKey(params)
    ) {
      return false;
    }
    if (params.error) {
      pending.settle({ error: new Error(params.error.message || "App tool failed") });
      return true;
    }
    const result = params.result as McpToolCallResult;
    if (jsonBytes(result) > MCP_APPS_APP_TOOL_RESULT_MAX_BYTES) {
      pending.settle({
        error: new Error(`App tool result exceeds ${MCP_APPS_APP_TOOL_RESULT_MAX_BYTES} bytes`),
      });
      return true;
    }
    pending.settle({ result });
    return true;
  }

  /** 会话关闭：结束全部待执行调用并丢弃登记（runtime 随会话关闭，不再同步工具）。 */
  // 先删 session 再逐个 settle，防止 settle 回调里的 publishCall 又把状态写回本 session；
  // 不调用 host.applyTools——session 已不存在，无需再投影。
  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    for (const pending of Array.from(session.pending.values())) {
      pending.settle({ error: new Error("Session was closed") });
    }
  }

  // 构造模型侧执行器：每次调用都重新解析 session 与实例，实例在调用开始前被替换/关闭
  // 即 fail fast；参数大小与 abort 在进入 Promise 前检查，避免登记后才拒绝。
  private readonly execute = (sessionId: string): McpAppProvidedToolExecutor => {
    return (call, options) => {
      const session = this.sessions.get(sessionId);
      const instanceKey = buildMcpUiAppToolInstanceKey(call.definition);
      const instance = session?.instances.get(instanceKey);
      if (!session || !instance) {
        return Promise.reject(
          new Error(`The ${call.definition.serverName} app page is not running`),
        );
      }
      if (jsonBytes(call.arguments) > MCP_APPS_APP_TOOL_ARGUMENTS_MAX_BYTES) {
        return Promise.reject(new Error("App tool arguments are too large"));
      }
      if (options.signal.aborted) return Promise.reject(new Error("App tool call was cancelled"));
      return new Promise<McpToolCallResult>((resolve, reject) => {
        const callId = this.createCallId();
        let settled = false;
        const onAbort = () => pending.settle({ error: new Error("App tool call was cancelled") });
        const pending: PendingCall = {
          instanceKey,
          toolName: call.definition.toolName,
          claimed: false,
          settle: (outcome) => {
            if (settled) return;
            settled = true;
            pending.cancelTimer();
            options.signal.removeEventListener("abort", onAbort);
            session.pending.delete(callId);
            if ("result" in outcome) resolve(outcome.result);
            else {
              this.host.publishCall(
                sessionId,
                {
                  pluginId: instance.pluginId,
                  serverName: instance.serverName,
                  instance: instance.instance,
                  credential: instance.credential,
                },
                { callId, toolName: call.definition.toolName, arguments: {}, cancelled: true },
              );
              reject(outcome.error);
            }
          },
          // 认领期限：没有渲染端认领视为页面未运行（信箱不重发），结束调用并注销该实例。
          cancelTimer: this.setTimer(() => {
            pending.settle({
              error: new Error(`The ${instance.serverName} app page is not running`),
            });
            if (session.instances.has(instanceKey)) {
              this.dropInstance(sessionId, session, instanceKey, "App page is not running");
              this.sync(sessionId, session);
            }
          }, MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS),
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        session.pending.set(callId, pending);
        this.host.publishCall(
          sessionId,
          {
            pluginId: instance.pluginId,
            serverName: instance.serverName,
            instance: instance.instance,
            credential: instance.credential,
          },
          { callId, toolName: call.definition.toolName, arguments: call.arguments },
        );
      });
    };
  };

  // session 状态按需惰性创建；nextSeq 单调递增，用于「同 server 取最新实例」判定。
  private sessionOf(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { instances: new Map(), nextSeq: 1, pending: new Map() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  // 丢弃实例的原子步骤：先删登记，再让该实例所有 pending 以同一 reason 失败。
  // 顺序保证 settle 回调里若触发重新登记，不会把已死的 pending 复活。
  private dropInstance(
    sessionId: string,
    session: SessionState,
    instanceKey: string,
    reason: string,
  ): void {
    session.instances.delete(instanceKey);
    for (const pending of Array.from(session.pending.values())) {
      if (pending.instanceKey === instanceKey) pending.settle({ error: new Error(reason) });
    }
    this.host.logger?.debug?.("MCP UI app tool instance dropped", {
      event: "mcp.ui.app_tools.dropped",
      sessionId,
      reason,
    });
  }

  /** 计算暴露集合（同 server 只暴露最近登记的实例）并同步到 runtime；返回暴露的定义。 */
  // 冲突处理：按 serverName 排序 + modelName 去重，先到者胜，保证模型侧工具名稳定；
  // applyTools 返回 null 表示 session 已不存在，此时清空本地状态并返回空。
  // 返回值只包含 runtime 实际接受的名字（appliedNames 过滤），调用方可据此报“部分生效”。
  private sync(sessionId: string, session: SessionState): McpAppProvidedToolDefinition[] {
    const latestByServer = new Map<string, InstanceRecord>();
    for (const record of session.instances.values()) {
      const current = latestByServer.get(record.serverName);
      if (!current || record.seq > current.seq) latestByServer.set(record.serverName, record);
    }
    const definitions: McpAppProvidedToolDefinition[] = [];
    const seen = new Set<string>();
    const servers = Array.from(latestByServer.values()).sort((a, b) =>
      a.serverName.localeCompare(b.serverName),
    );
    for (const record of servers) {
      for (const tool of record.tools) {
        const modelName = buildMcpAppsAppToolModelName(record.serverName, tool.name);
        if (seen.has(modelName)) continue;
        seen.add(modelName);
        definitions.push({
          modelName,
          serverName: record.serverName,
          pluginId: record.pluginId,
          scopeId: record.instance.scopeId,
          generation: record.instance.generation,
          toolName: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          ...(tool.annotations?.readOnlyHint !== undefined
            ? { readOnlyHint: tool.annotations.readOnlyHint }
            : {}),
          ...(tool.annotations?.destructiveHint !== undefined
            ? { destructiveHint: tool.annotations.destructiveHint }
            : {}),
          ...(tool.annotations?.idempotentHint !== undefined
            ? { idempotentHint: tool.annotations.idempotentHint }
            : {}),
        });
      }
    }
    const applied = this.host.applyTools(sessionId, definitions, this.execute(sessionId));
    if (applied === null) {
      this.clearSession(sessionId);
      return [];
    }
    const appliedNames = new Set(applied);
    return definitions.filter((definition) => appliedNames.has(definition.modelName));
  }
}
