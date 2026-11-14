// 延迟草稿注册表：记录「哪些 session 曾把快照作为草稿暂存过」，供后续判断是否续写。
// 状态只存在于内存 Set 中，进程重启即丢失；它不是持久事实，不能作为数据恢复依据。
// 不变量(INV)：写入与查询必须用同一 key 推导（identity 优先，sessionId 限定作用域）。
// 改错会怎样：key 不一致会让草稿永远命中不到，或在切换 workspace 后误命中别的 session。
import type { ZCodeSessionStateSnapshot } from "@zcode/shared";
import type {
  ZCodeSessionWorkspaceTarget,
  ZCodeTaskTarget,
} from "#src/zcode-session/zcodeSession.js";

// 统一身份 key：identity 存在时优先，路径仅作本地 fallback，同一 workspace 不能出现两种 key。
function getWorkspaceKey(target: ZCodeSessionWorkspaceTarget): string {
  // identity 为空串或纯空白时回退路径，保证 remember/has/forget 三处得到同一种 key 形状。
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

// 用 NUL 字符分隔 workspace 与 sessionId：二者都可能含任意字符，普通分隔符会产生 key 碰撞。
function getSessionScopedKey(target: ZCodeTaskTarget): string {
  return `${getWorkspaceKey(target)}\0${target.sessionId}`;
}

// 每个注册表实例独立持有 Set，不共享全局状态，避免不同 Host/窗口之间串号。
export function createZCodeDeferredDraftRegistry() {
  // 集合生命周期随注册表实例，Host 重建即清空；它不是持久事实，不能据此恢复草稿。
  const sessionKeys = new Set<string>();

  return {
// 以快照里的 session 为准，identity 缺失时才回退到调用方参数，否则会把草稿记到过期 workspace 上。
    remember(params: ZCodeSessionWorkspaceTarget, snapshot: ZCodeSessionStateSnapshot): void {
      // 用快照内的 sessionId 生成 key 而非调用方参数：快照可能是旧版本写下的，以内容为准才能与查询命中同一项。
      sessionKeys.add(
        getSessionScopedKey({
          workspacePath: snapshot.session.workspace.workspacePath,
          workspaceIdentity:
            snapshot.session.workspace.workspaceIdentity ?? params.workspaceIdentity,
          sessionId: snapshot.session.sessionId,
        }),
      );
    },

// 查询必须复用同一 key 推导；任何自造的 key 都会静默返回 false，且难以排查。
    has(target: ZCodeTaskTarget): boolean {
      // 纯内存查询，未注册即返回 false（表示无需续写）；本调用不产生 IO，也不修改集合。
      return sessionKeys.has(getSessionScopedKey(target));
    },

// forget 只移除延迟标记，不触碰真实 session 状态；必须与 remember 使用同一 key。
    forget(target: ZCodeTaskTarget): void {
      // 删除幂等：未注册的 key 删除为 no-op，调用方无需先查 has 再决定是否 forget。
      sessionKeys.delete(getSessionScopedKey(target));
    },
  };
}
