import type { McpAppInstance } from "@zcode/shared/mcp-apps";
import { createHash, randomUUID } from "node:crypto";

export interface McpUiInstanceBinding {
  /** 隔离/去重用的身份键：identity 优先，没有则退回 workspacePath（workspaceKey 口径）。 */
  workspace: string;
  /** 账号上下文参与 appIdentity 计算，切换账号不会复用同一凭证。 */
  accountContext?: string;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  resourceUri: string;
  ownerWebContentsId: number;
}
type Source = { identity: string; generation: number };
interface InstanceRecord {
  lease: McpAppInstance;
  binding: McpUiInstanceBinding;
  source: Source;
  cancel: AbortController;
  watched?: boolean;
  pins: Set<string>;
  onActivity?: (callId: string, active: boolean) => void;
}
/** 单一凭证 owner。撤销先从登记表移除，再触发取消；迟到结果无法重新获得执行权。 */
export class McpUiInstances {
  private readonly runtimeId = randomUUID();
  private generation = 0;
  private readonly records = new Map<string, InstanceRecord>();
  private readonly logical = new Map<string, string>();
  // 逻辑键 = 绑定七元组（含 ownerWebContentsId），用于识别"同一页面槽位"；物理键是 token。
  private key(b: McpUiInstanceBinding): string {
    return JSON.stringify([
      b.workspace,
      b.sessionId,
      b.pluginId,
      b.serverName,
      b.scopeId,
      b.resourceUri,
      b.ownerWebContentsId,
    ]);
  }
  /**
   * 打开（或复用）一个 App 实例凭证。同一逻辑槽位且 source 与 accountContext 完全一致时复用旧 lease，
   * 避免页面重挂载导致凭证换代；否则先关闭旧实例（abort 在途调用）再签发新代际。
   * appIdentity 由 workspace/server/source/account 哈希得到，不含 sessionId，跨会话稳定。
   */
  open(binding: McpUiInstanceBinding, source: Source): McpAppInstance {
    const key = this.key(binding);
    const previous = this.records.get(this.logical.get(key) ?? "");
    if (
      previous &&
      previous.source.identity === source.identity &&
      previous.source.generation === source.generation &&
      previous.binding.accountContext === binding.accountContext
    )
      return previous.lease;
    if (previous) this.close(previous.lease);
    const lease: McpAppInstance = {
      runtimeId: this.runtimeId,
      generation: ++this.generation,
      token: randomUUID(),
      appIdentity: createHash("sha256")
        .update(
          JSON.stringify([
            binding.workspace,
            binding.serverName,
            source.identity,
            binding.accountContext ?? "",
          ]),
        )
        .digest("hex"),
    };
    this.records.set(lease.token, {
      lease,
      binding,
      source,
      cancel: new AbortController(),
      pins: new Set(),
    });
    this.logical.set(key, lease.token);
    return lease;
  }
  /**
   * 校验请求确实属于当前有效实例：runtimeId/generation/appIdentity 与绑定（workspace/session/plugin/server）
   * 任一不符即拒绝；service 连接快照代际不符时还会撤销凭证（先确认归属再撤销，避免错 server 关掉合法页面）。
   * 失败一律抛通用错误，调用方映射为协议错误；返回值是内部记录，供调用方读取 cancel.signal 与 pins。
   */
  validate(
    lease: McpAppInstance,
    scope: {
      sessionId: string;
      pluginId: string;
      serverName: string;
      workspace?: { workspaceIdentity?: string; workspacePath: string };
    },
    source: Source | null,
  ): InstanceRecord {
    const record = this.records.get(lease.token);
    if (
      !record ||
      record.lease.runtimeId !== lease.runtimeId ||
      record.lease.generation !== lease.generation ||
      record.lease.appIdentity !== lease.appIdentity ||
      (scope.workspace &&
        record.binding.workspace !==
          (scope.workspace.workspaceIdentity?.trim() || scope.workspace.workspacePath)) ||
      record.binding.sessionId !== scope.sessionId ||
      record.binding.pluginId !== scope.pluginId ||
      record.binding.serverName !== scope.serverName
    )
      throw new Error("MCP App instance is no longer authorized");
    // 先确认请求确属本实例，再用该连接快照撤销凭证。错 server / 旧代际的请求不能关闭合法页面。
    if (
      !source ||
      source.identity !== record.source.identity ||
      source.generation !== record.source.generation
    ) {
      this.close(record.lease);
      throw new Error("MCP App instance is no longer authorized");
    }
    return record;
  }
  /**
   * 为一次在途调用打 pin：返回该实例的取消信号与幂等 release。pin 计数决定 isBusy，
   * 实例关闭时 abort 信号，release 后计数归零；凭证已失效时直接抛错（不再授予执行权）。
   */
  retain(token: string, callId: string) {
    const record = this.records.get(token);
    if (!record) throw new Error("MCP App instance is no longer authorized");
    const pin = `${callId}:${randomUUID()}`;
    record.pins.add(pin);
    record.onActivity?.(pin, true);
    return {
      signal: record.cancel.signal,
      release: () => {
        if (record.pins.delete(pin)) record.onActivity?.(pin, false);
      },
    };
  }
  /** 实例是否仍有在途调用；用于"忙时不得换页/重载"一类判定。 */
  isBusy(lease: McpAppInstance): boolean {
    return (this.records.get(lease.token)?.pins.size ?? 0) > 0;
  }
  /** 按 token 取内部记录（含 binding/source/pins），调用方需自行判断是否仍有效。 */
  find(token: string): InstanceRecord | undefined {
    return this.records.get(token);
  }
  /**
   * 关闭实例：先验 runtimeId/generation/appIdentity 三者一致，才从登记表与逻辑索引移除并 abort。
   * 不匹配说明这是旧凭证的迟到关闭，返回 false 且不影响当前实例。
   */
  close(lease: McpAppInstance): boolean {
    const record = this.records.get(lease.token);
    if (
      !record ||
      record.lease.runtimeId !== lease.runtimeId ||
      record.lease.generation !== lease.generation ||
      record.lease.appIdentity !== lease.appIdentity
    )
      return false;
    this.records.delete(lease.token);
    const key = this.key(record.binding);
    if (this.logical.get(key) === lease.token) this.logical.delete(key);
    record.cancel.abort();
    return true;
  }
  /** 会话关闭：遍历关闭该 session 的全部实例（abort 在途调用），不区分 server/plugin。 */
  closeSession(sessionId: string): void {
    for (const record of this.records.values())
      if (record.binding.sessionId === sessionId) this.close(record.lease);
  }
}
export const mcpUiInstances = new McpUiInstances();
