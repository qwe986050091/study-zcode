// 文件职责：Bot 侧访问远程项目的唯一装配点，把身份解析、在线连接、租约与订阅收口在这里。
// INV-01：所有入口先 readHost 再 admit，对外返回的 service 必须绑定 Lease；
//         直接返回 taskService 裸对象会让连接切换后仍向旧 Source 发命令。
//         （守住它的位置：getZCodeTaskService/getModelSelectionService 的包装）
// INV-02：workspaceIdentity 与 workspacePath 必须同时匹配，且显式 hostId 与身份推导一致；
//         任一不符说明调用方拼错目标，继续执行会写进另一个项目。
//         （守住它的位置：readHost 的两处 throw）
// INV-03：membershipId 与 connection.owner 共同判定「连接仍是同一个」，每次调用前复核；
//         只看 hostId 无法发现断开重连，只看 owner 无法发现目录里换了 host 记录。
//         （守住它的位置：assertLease 与 Proxy 的每次调用前检查）
// INV-04：订阅只转发当前 owner 的未来事件，不缓存、不补发；
//         手机端 replayable 语义由另一条链路负责，混用会重复投递历史事件。
// 破坏后果：INV-01/03 破 → 命令发往已断开或已换主的 Source，表现为「发送成功但没反应」。
import { parseRemoteWorkspaceIdentity, remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import type {
  BotProjectConnection,
  BotProjectRuntimePort,
  BotRemoteRuntimeService,
  BotRemoteTarget,
  BotRuntimeSubscription,
  IZCodeTaskService,
} from "#src/bot-project-runtime/contract.js";
export type {
  BotRemoteRuntimeService,
  BotProjectRuntimePort,
  BotProjectConnection,
} from "#src/bot-project-runtime/contract.js";

// Lease 不是可长期持有的凭证而是快照：是否仍有效必须每次经 assertLease 重新确认，
// 把它当能力缓存就等于跨过了连接切换。
type Lease = { hostId: string; membershipId: string; connection: BotProjectConnection };

// 工厂只做闭包装配、不持有可变连接态：所有连接信息都从 port 现查，
// 与桌面 Host 同进程运行时才不会出现两份真相。
export function createBotProjectRuntime(port: BotProjectRuntimePort): BotRemoteRuntimeService {
  async function readHost(target: BotRemoteTarget) {
// [失败路径] 身份串解析失败或与路径不一致时直接抛错：这是调用方传参错误，
// 静默回退到路径推导会让 Bot 操作到另一个工作区。
    const parsed = parseRemoteWorkspaceIdentity(target.workspaceIdentity);
    if (!parsed || parsed.workspacePath !== target.workspacePath)
      throw new Error("Bot workspace identity/path mismatch");
    const directory = await port.remoteProjectService.readDirectory();
    const identityHost = remoteHostIdFromWorkspaceIdentity(target.workspaceIdentity);
    if (target.hostId && parsed.sourceServerId && target.hostId !== identityHost)
      throw new Error("Bot host/identity mismatch");
// [权衡] legacyWorkspace 是旧数据兼容键，只在 identity 与 path 全等时才采信；
// 放宽匹配会让老条目的 hostId 覆盖新身份推导结果。
    const legacyHost = directory.entries.find(
      (entry) =>
        entry.legacyWorkspace?.workspaceIdentity === target.workspaceIdentity &&
        entry.legacyWorkspace.workspacePath === target.workspacePath,
    )?.hostId;
// [失败路径] 找不到 host 返回 undefined 而不抛错：调用方需区分「连接被移除」
// （可提示重连）与「参数非法」（应视为 bug）。
    return directory.hosts.find(
      (host) => host.id === (target.hostId ?? legacyHost ?? identityHost),
    );
  }

// [并发] 三处同时比对：host.id（身份）、membershipId（授权代次）、owner（物理连接实例）。
// [失败路径] 抛错而不返回 false：租约失效后继续执行会向旧连接发命令，必须让调用链显式失败。
  async function assertLease(target: BotRemoteTarget, lease: Lease): Promise<void> {
    const host = await readHost(target);
    if (
      host?.id !== lease.hostId ||
      host.membershipId !== lease.membershipId ||
      port.resolveOnline(lease.hostId)?.owner !== lease.connection.owner
    )
      throw new Error("Bot Source connection changed during admission");
  }

// [并发] 读目录与读在线表是两步，期间连接可能被替换，所以 bindWorkspace 之后
// 必须再 assertLease 一次，否则工作区会被绑到即将失效的连接上。
  async function admit(target: BotRemoteTarget): Promise<Lease> {
    const host = await readHost(target);
    const connection = host ? port.resolveOnline(host.id) : undefined;
    if (!host || !connection) throw new Error("Bot Source is offline or removed");
    const lease = { hostId: host.id, membershipId: host.membershipId, connection };
// [资源] bindWorkspace 是有副作用的远端操作（订阅/路由建立），这里不注册清理：
// 断开由连接管理器统一负责，重复 bind 的幂等性必须由实现方保证。
    await connection.bindWorkspace(target);
    await assertLease(target, lease);
    return lease;
  }

// [失败路径] 流作用域必须与目标完全一致：Bot 频道只接受 bot-channel-continuous，
// 参数不符立即抛错，避免把桌面连续流接到 Bot 上导致投递语义错配。
  function subscribe(
    target: BotRemoteTarget,
    initial: Lease,
    params: Parameters<IZCodeTaskService["onDynamicTaskEvent"]>[0],
    receive: Parameters<ReturnType<IZCodeTaskService["onDynamicTaskEvent"]>>[0],
  ): BotRuntimeSubscription {
    if (
      params.workspacePath !== target.workspacePath ||
      params.workspaceIdentity !== target.workspaceIdentity ||
      params.deliveryKind !== "bot-channel-continuous"
    )
      throw new Error("Bot stream scope/delivery mismatch");
    let disposed = false;
// disposed/generation 是订阅代次：重连期间可能有多条 admit 在飞，旧代次的 then
// 必须被丢弃，否则同一事件会被转发两遍或转给已 dispose 的订阅。
    let generation = 0;
    let owner: object | undefined;
    let subscription: BotRuntimeSubscription | undefined;
// [并发] 每条事件都重新查 owner：事件到达时连接可能已换主，
// 闭包里捕获的 lease.connection 只是订阅建立时的快照。
    const attach = (lease: Lease) => {
      owner = lease.connection.owner;
      subscription = lease.connection.taskService.onDynamicTaskEvent(params)((event) => {
        // 只转发当前物理 owner 的未来事件；不缓存、不补发手机 replayable 内容。
        if (
          !disposed &&
          owner === lease.connection.owner &&
          port.resolveOnline(lease.hostId)?.owner === owner
        )
          return receive(event);
      });
    };
    attach(initial);
// [并发] generation 自增放在 dispose 之前：先让旧代次失效再拆订阅，
// 避免旧 admit 的 then 在这两步之间插进来重新 attach。
    const changed = port.onConnectionsChanged(() => {
      if (disposed || port.resolveOnline(initial.hostId)?.owner === owner) return;
      const currentGeneration = ++generation;
      subscription?.dispose();
      subscription = undefined;
      owner = undefined;
      if (!port.resolveOnline(initial.hostId)) return;
// [失败路径] admit 失败只 warn 不重试：连接管理器会再次触发 connectionsChanged，
// 在这里自建重试循环会与它的退避叠加成惊群。
      void admit(target)
        .then((lease) => {
          if (!disposed && generation === currentGeneration) attach(lease);
        })
        .catch((error: unknown) => {
          if (!disposed && generation === currentGeneration)
            port.warn(
              `Bot live subscription unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
    });
    return {
// [资源] dispose 必须幂等：先置 disposed 再自增代次并拆订阅，
// 顺序反了会让回调在 dispose 过程中再写一次 owner/subscription。
      dispose() {
        if (disposed) return;
        disposed = true;
        generation++;
        changed.dispose();
        subscription?.dispose();
      },
    };
  }

  const service: BotRemoteRuntimeService = {
// 只读不绑定：调用方用它做可用性探测，绑定会带来远端副作用。
    async isConnected(target) {
      const host = await readHost(target);
      return Boolean(host && port.resolveOnline(host.id));
    },
    async ensureConnected(target) {
      const host = await readHost(target);
      if (!host) return { ok: false, message: "Bot Source connection has been removed" };
      try {
        await port.remoteProjectService.connectHost(host.id);
        const current = await readHost(target);
        if (current?.membershipId !== host.membershipId || !port.resolveOnline(host.id))
// [并发] connectHost 前后各读一次目录：membershipId 变化说明期间发生了重新配对，
// 此时返回成功会让调用方拿到一个已失效的 host。
          throw new Error("Bot Source connection changed during reconnect");
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
// [事务] 先绑定再同步偏好再复核租约：同步偏好是远端写操作，
// 若租约在绑定后失效，这次写入会落到旧连接上。
    async getZCodeTaskService(target) {
      const lease = await admit(target);
      await lease.connection.agentService.syncAppRuntimePreferences(
        await port.readRuntimePreferences(),
      );
      await assertLease(target, lease);
      return new Proxy(lease.connection.taskService, {
// [并发] Proxy 拦截全部方法：每次调用前复核租约，把「连接已切换」变成显式失败；
// 不用一次性快照的 service，是因为长生命周期调用方会跨连接复用同一对象。
        get(base, property, receiver) {
          if (property === "onDynamicTaskEvent")
            return (params: Parameters<IZCodeTaskService["onDynamicTaskEvent"]>[0]) =>
              (receive: Parameters<ReturnType<IZCodeTaskService["onDynamicTaskEvent"]>>[0]) =>
                subscribe(target, lease, params, receive);
          const value: unknown = Reflect.get(base, property, receiver);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            await assertLease(target, lease);
            return Reflect.apply(value, base, args);
          };
        },
      });
    },
// 模型选择同样走租约：它读写远端 Source 的模型配置，连接切换后旧 service 仍可被调用。
    async getModelSelectionService(target) {
      const lease = await admit(target);
      return {
        getView: async (...args) => {
          await assertLease(target, lease);
          return lease.connection.modelSelectionService.getView(...args);
        },
      };
    },
// [并发] 按 host 去重：多个 target 可能指向同一主线连接，重复同步会让远端偏好
// 的最终值依赖迭代顺序；Set 保证每个 Source 只写一次。
    async syncAppRuntimePreferences(preferences) {
      const hosts = new Set<string>();
      for (const target of await port.readBoundTargets()) {
        const host = await readHost(target);
// [失败路径] 失效或离线目标跳过而不抛错：这是全量广播入口，
// 单个失效连接不应阻断其余 Source 的偏好同步。
        if (!host || hosts.has(host.id) || !port.resolveOnline(host.id)) continue;
        hosts.add(host.id);
        const lease = await admit(target);
        await lease.connection.agentService.syncAppRuntimePreferences(preferences);
      }
    },
  };
  return service;
}
