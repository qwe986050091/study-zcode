// session 级 API 重试状态的运行时缓存：把 live 事件带来的重试态与 protocol snapshot 对齐。
// INV-01：key 必须由 resolveWorkspaceKey(workspace) 与 sessionId 两段组成，缺任一段会让会话互相覆盖状态。
// INV-02：只有收到「恢复进展」载荷才把状态清成 null，retry attempt 开始不清。
// INV-03：snapshot 自带的 runtime.apiRetry 优先于缓存并回写缓存，snapshot 是真相来源。
// INV-04：completed/error 必须强制清空，否则已结束的会话仍会显示「重试中」。
import {
  normalizeZCodeApiRetryStatus,
  isZCodeModelRetryRecoveryProgressPayload,
  resolveWorkspaceKey,
  type ZCodeSessionApiRetryStatus,
  type ZCodeSessionStateSnapshot,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
} from "@zcode/shared";
import type { ZCodeSessionServiceEvent, ZCodeTaskTarget } from "#src/zcode-session/zcodeSession.js";

export function createZCodeSessionApiRetryRuntimeTracker(): {
  trackApiRetryFromSessionEvent: (
    params: ZCodeTaskTarget,
    event: ZCodeSessionServiceEvent,
  ) => ZCodeSessionServiceEvent;
  withApiRetryRuntime: (snapshot: ZCodeSessionStateSnapshot) => ZCodeSessionStateSnapshot;
} {
// [并发] 实例内的可变 Map：tracker 由 session 服务单线程持有，不跨 worker 共享，因此不加锁。
  const apiRetryBySessionKey = new Map<string, ZCodeSessionApiRetryStatus | null>();

// 事件总线入口：只处理带重试语义的两种事件，其余事件原样透传，避免改写调用方依赖的对象身份。
  function trackApiRetryFromSessionEvent(
    params: ZCodeTaskTarget,
    event: ZCodeSessionServiceEvent,
  ): ZCodeSessionServiceEvent {
    if (
// session.updated 覆盖常规快照推送，streamRecovery.updated 覆盖断流恢复进度，两者共用同一套解析。
      event.type === "session.event" &&
      (event.event.type === "session.updated" || event.event.type === "streamRecovery.updated")
    ) {
      // desktop-continuous 的 snapshot runtime 需要跟住 core recovery 进度；
      // 否则切回正在恢复的会话时只能看到空的重试状态。
// 同一载荷可能由不同版本的 CLI 产出，字段位置不统一，解析统一收口到 apiRetryFromSessionPayload。
      const apiRetry = apiRetryFromSessionPayload(asRecord(event.event.payload));
      const key = sessionKey({
        workspacePath: params.workspacePath,
// key 的两段都从既有身份字段推导，不接受调用方传裸字符串，避免不同调用点拼法不一致（INV-01）。
        workspaceIdentity: params.workspaceIdentity,
        sessionId: event.event.sessionId,
      });
// [权衡] undefined 表示「这条载荷没带重试信息」，必须与显式 null（表示已清除）区分；
// 混为一谈会让任意一次无关更新都抹掉正在显示的重试态。
      if (apiRetry !== undefined) {
        apiRetryBySessionKey.set(key, apiRetry);
      } else if (
// [失败路径] 只对「缓存里已有重试态」的会话执行清除：否则会把从未重试的会话写成 null，
// 让 INV-02 的「未知」与「已知无」区分失效。
        apiRetryBySessionKey.get(key) != null &&
        isZCodeModelRetryRecoveryProgressPayload(asRecord(event.event.payload))
      ) {
        // snapshot runtime 和 live UI 要使用同一个恢复成功边界；
        // retry attempt 开始不清，等首个模型进展到达才清，避免重连时状态闪烁或切回 task 后残留。
        apiRetryBySessionKey.set(key, null);
      }
      return event;
    }
// snapshot 路径只补回重试态，不改写其他字段：快照其余内容必须由 core 决定（INV-03）。
    if (event.type === "snapshot") {
      return {
        ...event,
        snapshot: withApiRetryRuntime(event.snapshot),
      };
    }
    return event;
  }

// 把缓存里的重试态投影进快照；返回新对象而不就地修改，因为快照可能被多个订阅者共享。
  function withApiRetryRuntime(snapshot: ZCodeSessionStateSnapshot): ZCodeSessionStateSnapshot {
    const sessionId = snapshot.session?.sessionId;
// 从快照自身反推 key，而不是接受外部传入：保证「存状态」与「补状态」用的是同一套身份字段。
    const workspacePath = snapshot.session?.workspace?.workspacePath;
// [失败路径] 缺 sessionId 或 workspace 的快照无法建立 key，原样返回：宁可少显示提示，也不能写错 key。
    if (!sessionId || !workspacePath) {
      return snapshot;
    }
    const key = sessionKey({
      workspacePath,
// snapshot 的 workspaceIdentity 与 live 事件取自同一 workspace 对象，两处拼出的 key 才会命中同一条缓存。
      workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
      sessionId,
    });
// [权衡] 快照自带值优先并回写缓存：snapshot 是跨 Host 传输的权威结果，缓存只是它的本地投影。
    if (snapshot.runtime?.apiRetry !== undefined) {
      apiRetryBySessionKey.set(key, snapshot.runtime.apiRetry);
      return snapshot;
    }
// [事务] 终态不可逆：会话结束后无论缓存里有什么都必须清空，否则后续快照会把陈旧重试态再投影一次。
    if (snapshot.session.status === "completed" || snapshot.session.status === "error") {
      apiRetryBySessionKey.set(key, null);
      return {
        ...snapshot,
        runtime: {
          ...snapshot.runtime,
          apiRetry: null,
        },
      };
    }
// [失败路径] 没有缓存就不改快照：用 has 而不是 get，才能区分「缓存了 null」与「从未见过」。
    if (!apiRetryBySessionKey.has(key)) {
      return snapshot;
    }
    return {
      ...snapshot,
      runtime: {
        ...snapshot.runtime,
        // desktop-continuous 主路径读取 protocol snapshot 时不经过 task adapter。
        // 这里把订阅到的网络重试临时态补回 snapshot，切回运行中 task 时当前 turn 底部才能继续显示重试提示。
// [并发] ?? null 只是兜底：has 与 get 之间没有 await，单线程下不会被删除，这里不会读到 undefined。
        apiRetry: apiRetryBySessionKey.get(key) ?? null,
      },
    };
  }

// 用 \u0000 分隔而不是冒号：Windows 路径本身含冒号，任何可打印分隔符都可能拼出歧义 key。
  function sessionKey(params: ZCodeTaskTarget): string {
    return `${resolveWorkspaceKey(params)}\u0000${params.sessionId}`;
  }

  return {
// 对外只暴露两个方法，Map 不外泄：缓存生命周期随 tracker 实例，session 服务销毁即释放。
    trackApiRetryFromSessionEvent,
    withApiRetryRuntime,
  };
}

// 载荷来源分三层：顶层 apiRetry、runtime.apiRetry、_meta.zcode.apiRetry，都未命中才回退到专用解析器。
function apiRetryFromSessionPayload(
  payload: Record<string, unknown>,
): ZCodeSessionApiRetryStatus | null | undefined {
// 用 in 而不是取值判断 undefined：显式 apiRetry: null 表示「已清除」，必须短路，不能继续向下找。
  if ("apiRetry" in payload) {
    return normalizeZCodeApiRetryStatus(payload.apiRetry);
  }
// 新协议写顶层，旧 adapter 写在 runtime 或 _meta.zcode 里；三层都是为版本兼容，不是重复实现。
  const runtimeRetry = normalizeZCodeApiRetryStatus(asRecord(payload.runtime).apiRetry);
  if (runtimeRetry !== undefined) {
    return runtimeRetry;
  }
// _meta 是 adapter 透传的原始 zcode 元信息，字段可能整层缺失，故用 asRecord 链式兜底。
  const metaRetry = normalizeZCodeApiRetryStatus(asRecord(asRecord(payload._meta).zcode).apiRetry);
  if (metaRetry !== undefined) {
    return metaRetry;
  }
  return (
// [权衡] streamRecovery 优先于 modelNetwork：前者是恢复流程的最新状态，后者可能只是更早的尝试记录。
    zcodeApiRetryFromStreamRecoveryPayload(payload) ??
    zcodeApiRetryFromModelNetworkStatusPayload(payload)
  );
}

// 只接受普通对象：数组与 null 都归一成空对象，让上层用统一形状读取，不必每处判空。
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
