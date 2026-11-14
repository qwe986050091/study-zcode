// 广播服务的 Node 侧实现：同一 host 进程内既有本窗口订阅者，又要通过 parentPort
// 与 Main 的 BroadcastHub 交换跨窗口消息与 claim 租约。
// INV-01：订阅者互相隔离（守住者：send）；任一订阅者抛错不能让后续订阅者漏收，
//         也不能让 send 对外失败——广播失败不该阻断发起方的业务流程。
// INV-02：claim 的 reserved → committed 单向推进（守住者：commitClaim/releaseClaim 的
//         status+token 双校验）；破坏后同一 key 会被两个窗口同时播放。
// INV-03：超时后迟到的 acquired 必须立刻 release（守住者：message 处理器 timedOut 分支）；
//         不释放则无人持有的 reservation 要等满 TTL 才让别人争抢。
// INV-04：pendingClaims 必须有界（守住者：超时后的 cleanupTimeout）；泄漏会让每个
//         失败的 claim 永久占内存，长驻 host 最终 OOM。
import { Emitter } from "@zcode/rpc";
import {
  HostResponseTypes,
  HostMessageTypes,
  broadcastMessageSchema,
  hostBroadcastClaimResultMessageSchema,
  hostBroadcastEnvelopeSchema,
} from "@zcode/shared";
import type {
  BroadcastClaimAcquireResult,
  BroadcastClaimLease,
  IBroadcastService,
  BroadcastMessage,
} from "./broadcast.js";

// claim 超时 2s：超过这个时间说明 Main 侧拥塞或窗口正在退出，继续等待只会拖住
// 播放前的准备路径；宁可当次不播，也不能在两个窗口同时播同一段音频。
const BROADCAST_CLAIM_TIMEOUT_MS = 2_000;
const BROADCAST_CLAIM_RESERVATION_TTL_MS = 5_000;
const BROADCAST_CLAIM_RETRY_MS = 250;
const MAX_LOCAL_CLAIMS = 1_024;
let claimRequestSequence = 0;

type LocalClaimRecord = {
  token: string;
  status: "reserved" | "committed";
  expiresAt: number | null;
};

// [资源] 两段回收：先按 TTL 清过期 reservation，再按插入序丢最老的条目压回上限。
// Map 保证插入序，keys().next() 即最老一条；committed 永不过期，只能靠这层兜底。
function pruneLocalClaims(claims: Map<string, LocalClaimRecord>, now = Date.now()): void {
  for (const [key, claim] of claims) {
    if (claim.status === "reserved" && claim.expiresAt !== null && claim.expiresAt <= now) {
      claims.delete(key);
    }
  }
  while (claims.size > MAX_LOCAL_CLAIMS) {
    const oldest = claims.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    claims.delete(oldest);
  }
}

function createClaimRequestId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return randomId;
  }
  claimRequestSequence += 1;
  return `broadcast-claim-${Date.now()}-${claimRequestSequence}`;
}

function createLocalClaimToken(): string {
  return `local-${createClaimRequestId()}`;
}

/**
 * 广播服务 Node 实现 —— 运行在 host process 中
 *
 * send() 时：
 *   1. 触发本地 emitter（本窗口的 Renderer 通过 RPC event 收到）
 *   2. 通过 parentPort 发给 main 进程（由 BroadcastHub 中转给其他窗口）
 *
 * 收到 main 转发的广播时：
 *   触发本地 emitter → Renderer 通过 RPC event 收到
 *
 * @param parentPort - Electron host process 的 parentPort（Electron.ParentPort）
 *                     传 null 表示无跨窗口能力（如 web server 模式）
 */
export function createBroadcastService(
  parentPort: {
    postMessage(message: unknown): void;
    on(event: "message", listener: (e: { data: unknown }) => void): void;
  } | null,
): IBroadcastService {
  const emitter = new Emitter<BroadcastMessage>();
  const localClaims = new Map<string, LocalClaimRecord>();
  const pendingClaims = new Map<
    string,
    {
      key: string;
      resolve: (result: BroadcastClaimAcquireResult) => void;
      timeout: ReturnType<typeof setTimeout>;
      timedOut: boolean;
      cleanupTimeout: ReturnType<typeof setTimeout> | null;
    }
  >();

// commit/release 共用一条控制通道：两者都不需要返回值，失败也只记「Main 会兜底回收」。
// 拆成两条消息只会让 Main 多一个分支，而语义上它们都是「租约状态变更」。
  const postClaimControl = (
    type:
      | typeof HostResponseTypes.BroadcastClaimCommit
      | typeof HostResponseTypes.BroadcastClaimRelease,
    lease: BroadcastClaimLease,
  ): void => {
    if (!parentPort) {
      return;
    }
    try {
      parentPort.postMessage({ type, key: lease.key, claimToken: lease.token });
    } catch {
      // host 正在退出时允许失败；Main 会在 unregister 时回收未 commit reservation。
    }
  };

// [并发] 消息处理器是同步的：表项删除与定时器清理必须在 resolve 之前完成，
// 否则调用方拿到结果后立刻发起下一次 claim 时，旧条目仍在表里造成 requestId 误配。
  // 监听 main 进程转发的广播和跨窗口 claim 结果。
  if (parentPort) {
    parentPort.on("message", (e: { data: unknown }) => {
// [失败路径] 先按广播信封解析、再按 claim 结果解析，未知消息直接忽略：
// parentPort 上混有其他 host 模块的消息，严格校验避免把无关数据当广播投递。
      const broadcastResult = hostBroadcastEnvelopeSchema.safeParse(e.data);
      if (broadcastResult.success && broadcastResult.data.type === HostMessageTypes.Broadcast) {
        emitter.fire(broadcastResult.data.message);
        return;
      }

      const claimResult = hostBroadcastClaimResultMessageSchema.safeParse(e.data);
      if (!claimResult.success) {
        return;
      }
      const pending = pendingClaims.get(claimResult.data.requestId);
      if (!pending) {
        return;
      }
      pendingClaims.delete(claimResult.data.requestId);
      clearTimeout(pending.timeout);
      if (pending.cleanupTimeout) {
        clearTimeout(pending.cleanupTimeout);
      }
      // 请求已超时但 Main 稍后授予 reservation 时，必须用原 key/token 主动释放；
      // 否则已经没有组件持有该 lease，只能等 TTL 才能让其他窗口继续争抢。
// [并发] 迟到结果的三态：acquired 要主动释放；busy/committed 无需处理——
// busy 表示别人拿到，committed 表示 Main 已按旧请求落库，本进程都没有可释放的租约。
      if (pending.timedOut) {
        if (claimResult.data.status === "acquired") {
          postClaimControl(HostResponseTypes.BroadcastClaimRelease, {
            key: pending.key,
            token: claimResult.data.claimToken,
          });
        }
        return;
      }
      if (claimResult.data.status === "acquired") {
// resolve 用 pending.key 而不是结果里的 key：解析器不保证回传 key，而租约必须与
// 请求时的规范化 key 严格一致，否则后续 commit 的 token 校验必然失配。
        pending.resolve({
          status: "acquired",
          lease: { key: pending.key, token: claimResult.data.claimToken },
        });
        return;
      }
      if (claimResult.data.status === "busy") {
        pending.resolve({ status: "busy", retryAfterMs: claimResult.data.retryAfterMs });
        return;
      }
      pending.resolve({ status: "committed" });
    });
  }

// 获取租约的统一入口，两种模式语义对齐：acquired 可播、busy 需退避、committed 说明
// 别的窗口已播过（调用方应放弃）、unavailable 表示无法确认（fail-closed 不播）。
  const acquireClaim = async (key: string): Promise<BroadcastClaimAcquireResult> => {
    const normalizedKey = key.trim();
// 空 key 一律 unavailable：空字符串会被所有调用方共享，退化成全局互斥，
// 一个窗口播放就会阻塞全部广播，而且从日志上很难看出根因。
    if (!normalizedKey) {
      return { status: "unavailable" };
    }
    if (!parentPort) {
      const now = Date.now();
      pruneLocalClaims(localClaims, now);
      const existing = localClaims.get(normalizedKey);
      if (existing?.status === "committed") {
        return { status: "committed" };
      }
      if (existing) {
        return {
          status: "busy",
          retryAfterMs: Math.max(
            0,
            Math.min(BROADCAST_CLAIM_RETRY_MS, (existing.expiresAt ?? now) - now),
          ),
        };
      }
// [权衡] 退化模式不实现「reservation 过期后清理再重试」的完整状态机，只用 expiresAt
// 让后续者退避；单进程内不存在真正竞争，够用且省掉一层定时器与清理顺序问题。
      const lease = { key: normalizedKey, token: createLocalClaimToken() };
      localClaims.set(normalizedKey, {
        token: lease.token,
        status: "reserved",
        expiresAt: now + BROADCAST_CLAIM_RESERVATION_TTL_MS,
      });
      pruneLocalClaims(localClaims, now);
      return { status: "acquired", lease };
    }

// requestId 由本进程生成而非 Main：Main 只需原样回传，不必维护「谁在等」的状态，
// 超时清理也完全在本地完成，Main 重启不会留下一堆孤儿请求。
    const requestId = createClaimRequestId();
    return new Promise<BroadcastClaimAcquireResult>((resolve) => {
      // claim 超时不能乐观播放；Main 可能已经把同一 key 授予另一窗口。
      // 迟到的 acquired 结果会在消息处理器中按 token 主动 release。
// 超时分支只置位 timedOut 并 resolve unavailable，不删表项：Main 可能稍后仍回一条
// acquired，处理器需要这个表项才能拿到 key/token 去主动 release。
      const timeout = setTimeout(() => {
        const pending = pendingClaims.get(requestId);
        if (pending) {
          pending.timedOut = true;
          pending.cleanupTimeout = setTimeout(() => {
            pendingClaims.delete(requestId);
          }, BROADCAST_CLAIM_RESERVATION_TTL_MS + BROADCAST_CLAIM_TIMEOUT_MS);
        }
        resolve({ status: "unavailable" });
      }, BROADCAST_CLAIM_TIMEOUT_MS);
// [资源] 先建表项再 postMessage：若 Main 回得极快，消息处理器可能在表项写入前到达，
// 结果会被当成未知请求丢弃，调用方只能一直等到超时。
      pendingClaims.set(requestId, {
        key: normalizedKey,
        resolve,
        timeout,
        timedOut: false,
        cleanupTimeout: null,
      });
      try {
// [失败路径] 这里的 postMessage 可能抛错（host 正在退出），下面的 catch 会清表项并 resolve；
// 不能留下一个永不 resolve 的 Promise 拖住播放路径，那会让调用方永远等不到结果。
        parentPort.postMessage({
          type: HostResponseTypes.BroadcastClaimRequest,
          requestId,
          key: normalizedKey,
        });
      } catch {
        clearTimeout(timeout);
        pendingClaims.delete(requestId);
        resolve({ status: "unavailable" });
      }
    });
  };

// commit 把 reserved 定为 committed：只有 token 匹配才生效，防止拿旧租约把
// 别人刚拿到的 reservation 覆盖成 committed，从而永久占用该 key。
  const commitClaim = async (lease: BroadcastClaimLease): Promise<void> => {
    if (parentPort) {
      postClaimControl(HostResponseTypes.BroadcastClaimCommit, lease);
      return;
    }
    pruneLocalClaims(localClaims);
    const current = localClaims.get(lease.key);
    if (current?.status === "reserved" && current.token === lease.token) {
      localClaims.set(lease.key, { ...current, status: "committed", expiresAt: null });
    }
  };

// release 只删 reserved：committed 代表播放已完成，删掉它会让同一 key 被再次争抢，
// 造成重复播放；已完成场景的幂等由 committed 状态本身承担。
  const releaseClaim = async (lease: BroadcastClaimLease): Promise<void> => {
    if (parentPort) {
      postClaimControl(HostResponseTypes.BroadcastClaimRelease, lease);
      return;
    }
    pruneLocalClaims(localClaims);
    const current = localClaims.get(lease.key);
    if (current?.status === "reserved" && current.token === lease.token) {
      localClaims.delete(lease.key);
    }
  };

  return {
// [权衡] 先本地 fire 再 postMessage：本窗口订阅者立即收到，否则还要等 Main 回环，
// 播报延迟取决于 IPC。代价是投递顺序依赖 Main 的中转实现，两条路径并非同一队列。
    async send(message: BroadcastMessage): Promise<void> {
// [失败路径] 入参先过 schema：广播内容会被序列化到其他进程，非法字段必须在
// 跨进程前暴露成异常，而不是让每个接收方各自解析失败后静默丢消息。
      const validatedMessage = broadcastMessageSchema.parse(message);
      // 1. 通知本窗口的 Renderer
// [并发] fire 同步遍历，订阅者异常由 Emitter 内部隔离；这里不能把整段包进 try/catch，
// 否则一个订阅者的错误会跳过下面的 postMessage，导致跨窗口丢广播。
      emitter.fire(validatedMessage);
      // 2. 发给 main 进程做跨窗口中转
      if (parentPort) {
        parentPort.postMessage({ type: HostResponseTypes.Broadcast, message: validatedMessage });
      }
    },
    acquireClaim,
    commitClaim,
    releaseClaim,
// 「获取并立即提交」的便捷封装：适用于只需互斥、不需要持有租约的场景。
// acquire 失败返回 false 而不是抛错，调用方按「本次不播」处理即可。
    async tryClaim(key: string): Promise<boolean> {
      const result = await acquireClaim(key);
      if (result.status !== "acquired") {
        return false;
      }
      await commitClaim(result.lease);
      return true;
    },
    onMessage: emitter.event,
  };
}
