// 窗口级 Host attachment 注册表：按 attachmentId 记录「谁（哪个窗口/哪个 clientMode）持有了
// 哪一份 Host 服务面」，并统一负责回收。
//
// 职责边界：
// - 这里是 attachment 生命周期的唯一账本，Host 侧只通过本文件 attach/detach/dispose 管理；
// - 不保存业务状态（会话、任务队列、快照都不在此），仅保存 params 与 dispose 句柄；
// - 不负责决定「暴露哪些 service」，那是 windowHostAttachmentRpcPolicy 的职责，本文件只透传
//   clientMode 给 expose 回调，由调用方据此选择策略。
//
// 大纲不变量 #18（desktop attachment 的 clientMode / generation(seq) / dispose 语义）：
// - clientMode：随 attachment 一起记账，供上层区分 desktop-continuous（可持有完整服务面）与
//   web-remote-replayable（只能拿 allowlist 服务面）；source-settings 这类仅桌面可用的 scope
//   必须在 attach 入口直接拒绝 replayable，不能等到 expose 阶段才失败。
// - generation（序号语义）：generation 由 resolveScope 产出并随 attachment 固化，表示该
//   attachment 所属的 Host 代际；远端重连换代时用 detachStaleRemoteSessionAttachments 只清理
//   旧代际，保留同代际的既有 attachment，避免重连抖动导致手机侧端口被反复摘除。
// - dispose：幂等且只生效一次（disposed 标志），任何摘除路径（显式 detach、port close、
//   过期代际清理、registry dispose）都走 disposeTracked，保证底层 handle 不会被重复释放。

import type { WindowHostAttachmentScope } from "@zcode/shared";
import type { ZCodeAgentV4ClientMode } from "@zcode/services";

/** attachment 注册表对 MessagePort 的最小依赖：只要求能监听一次 close，用于跟随端口销毁。 */
export interface WindowHostAttachmentPort {
  once(event: "close", listener: () => void): unknown;
}

/** 注册表内部持有的资源句柄：dispose 必须幂等，被 registry 调用多次也只释放一次。 */
export interface WindowHostAttachmentHandle {
  dispose(): void;
}

/**
 * resolveScope 的产出：把请求里的抽象 scope 解析成真正可用的服务面。
 * - services：该 scope 对应的 Host 服务集合（本地窗口 / 远端会话 / source settings 各不相同）；
 * - generation：解析当刻的 Host 代际，attach 时固化，用于后续 stale 清理判断；
 * - capabilities：可选能力标记，仅用于透传给 expose 回调，注册表本身不解读。
 */
export interface WindowHostResolvedAttachmentScope<TServices, TCapabilities = never> {
  services: TServices;
  generation: number;
  capabilities?: TCapabilities;
}

/**
 * 一次 attach 的完整输入，也是注册表后续唯一的事实来源（list/清理全部读这里）。
 * - requestId：发起方的一次请求标识，仅用于诊断与回传，不参与去重；
 * - attachmentId：注册表的 key，同一 id 再次 attach 视为替换，旧句柄立即 dispose；
 * - clientMode：决定服务面策略的归属方标识，registry 只记账不判断（见文件头 #18）；
 * - scope：窗口 / 远端会话 / source settings，决定清理时按哪个维度匹配；
 * - generation：resolveScope 产出的代际快照，stale 清理依赖它区分新旧连接。
 */
export interface WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities = never> {
  requestId: string;
  attachmentId: string;
  clientMode: ZCodeAgentV4ClientMode;
  scope: WindowHostAttachmentScope;
  services: TServices;
  generation: number;
  capabilities?: TCapabilities;
  port: TPort;
}

interface TrackedAttachment<TServices, TPort, TCapabilities = never> {
  params: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities>;
  handle: WindowHostAttachmentHandle;
  disposed: boolean;
}

/**
 * 创建窗口级 attachment 注册表。
 *
 * 职责：完成「解析 scope -> 暴露服务 -> 记账 -> 在端口关闭/显式摘除/代际过期时回收」的闭环。
 * 输入：resolveScope 负责把抽象 scope 换成 services + generation（失败即拒绝，不落地）；
 * expose 负责真正建立服务面并返回可回收句柄，注册表不关心其内部实现。
 * 输出：attach / detach* / list / size / dispose 一组操作，无返回值语义上的业务错误（只抛
 * 客户端契约错误，如 replayable 请求 source-settings）。
 * 副作用：调用 expose 会发布 RPC channel；回收会触发 handle.dispose；会对 port 注册 close 监听。
 * 失败语义：resolveScope 抛错时不写入任何状态，同一 attachmentId 的既有端口保持不变；
 * expose 抛错时同样不记账，避免出现「有记录但无可回收句柄」的空洞。
 * 维护的不变量（#18）：
 * - Map 中同一 attachmentId 至多一条记录，替换时先落地新记录再 dispose 旧记录，
 *   保证替换瞬间不会把 key 删空；
 * - port 的 close 回调只有在「当前 key 仍指向本 tracked 记录」时才回收，避免被替换后
 *   旧端口的 close 事件误杀新 attachment；
 * - 所有回收路径复用 disposeTracked，保证 handle.dispose 幂等调用。
 */
export function createWindowHostAttachmentRegistry<
  TServices,
  TPort extends WindowHostAttachmentPort,
  TCapabilities = never,
>(options: {
  resolveScope: (
    scope: WindowHostAttachmentScope,
  ) => WindowHostResolvedAttachmentScope<TServices, TCapabilities>;
  expose: (
    params: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities>,
  ) => WindowHostAttachmentHandle;
}) {
  const attachments = new Map<string, TrackedAttachment<TServices, TPort, TCapabilities>>();

  // 幂等释放：disposed 标志保证同一句柄在任何回收路径下只被 dispose 一次。
  function disposeTracked(tracked: TrackedAttachment<TServices, TPort, TCapabilities>): void {
    if (tracked.disposed) {
      return;
    }
    tracked.disposed = true;
    tracked.handle.dispose();
  }

  // 建立/替换一个 attachment：先解析 scope 再 expose，最后把结果写入 Map 并接管旧句柄。
  // 失败即返回（无部分状态）；替换语义是「先换账本再 dispose 旧句柄」，不与端口 close 竞争。
  function attach(params: {
    requestId: string;
    attachmentId: string;
    clientMode: ZCodeAgentV4ClientMode;
    scope: WindowHostAttachmentScope;
    port: TPort;
  }): void {
    if (params.clientMode === "web-remote-replayable" && params.scope.kind === "source-settings") {
      throw new Error("Source settings attachments are Desktop-only");
    }
    // scope 必须先由 Host registry 验证；验证失败时不能影响同 attachmentId 的现有端口。
    const resolved = options.resolveScope(params.scope);
    const exposedParams: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities> = {
      ...params,
      services: resolved.services,
      generation: resolved.generation,
      ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
    };
    const handle = options.expose(exposedParams);
    const tracked: TrackedAttachment<TServices, TPort, TCapabilities> = {
      params: exposedParams,
      handle,
      disposed: false,
    };
    const previous = attachments.get(params.attachmentId);
    attachments.set(params.attachmentId, tracked);
    if (previous) {
      disposeTracked(previous);
    }
    params.port.once("close", () => {
      if (attachments.get(params.attachmentId) !== tracked) {
        return;
      }
      attachments.delete(params.attachmentId);
      disposeTracked(tracked);
    });
  }

  // 显式摘除：调用方（Host）已知该附件不再使用，直接删记录并回收；不存在时静默幂等。
  function detach(attachmentId: string): void {
    const tracked = attachments.get(attachmentId);
    if (!tracked) {
      return;
    }
    attachments.delete(attachmentId);
    disposeTracked(tracked);
  }

  // 远端会话重连换代后的清理：只摘除「同一 remoteSessionId 且 generation 不等于当前值」的记录。
  // 保留同代际记录是刻意的：重连抖动期间新 attachment 已建立，不能按 session 维度全量清空。
  function detachStaleRemoteSessionAttachments(
    remoteSessionId: string,
    currentGeneration: number,
  ): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "remote" ||
        tracked.params.scope.remoteSessionId !== remoteSessionId ||
        tracked.params.generation === currentGeneration
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      disposeTracked(tracked);
    }
  }

  // 会话彻底结束时按 remoteSessionId 全量摘除（不看 generation），用于关闭会话/删源等终态。
  function detachRemoteSessionAttachments(remoteSessionId: string): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "remote" ||
        tracked.params.scope.remoteSessionId !== remoteSessionId
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      disposeTracked(tracked);
    }
  }

  // source settings 属于桌面专属 scope，按 sourceServerId 维度回收，与远端会话清理互不干扰。
  function detachSourceSettingsAttachments(sourceServerId: string): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "source-settings" ||
        tracked.params.scope.sourceServerId !== sourceServerId
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      disposeTracked(tracked);
    }
  }

  return {
    attach,
    detach,
    detachRemoteSessionAttachments,
    detachSourceSettingsAttachments,
    detachStaleRemoteSessionAttachments,
    size: () => attachments.size,
    // 只读投影：给诊断/上层展示当前持有者，不暴露 handle，也不能借此修改注册表。
    list: () =>
      Array.from(attachments.values(), (tracked) => ({
        requestId: tracked.params.requestId,
        attachmentId: tracked.params.attachmentId,
        clientMode: tracked.params.clientMode,
        scope: tracked.params.scope,
        generation: tracked.params.generation,
      })),
    // 窗口关闭/Host 退出时的兜底：全部回收后清空账本，后续 attach 仍可继续使用新实例。
    dispose(): void {
      for (const tracked of attachments.values()) {
        disposeTracked(tracked);
      }
      attachments.clear();
    },
  };
}
