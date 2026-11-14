// INV-01 绑定按会话隔离：守住位置 记录键；改错故障 会话之间互相覆盖绑定。
// INV-02 断开需发送函数身份一致：守住位置 引用比较；改错故障 旧清理删掉新连接。
// INV-03 断开同时移除评审绑定：守住位置 双删除；改错故障 设置页拿到已释放客户端。
// INV-04 更新前校验命令通道：守住位置 发送函数比较；改错故障 迟到回调换回旧通道。
// INV-05 判定统一走单调性函数：守住位置 单一裁决源；改错故障 各处自行比较代次。
// INV-06 同流过期与重放不覆盖：守住位置 判定结果分支；改错故障 回放请求回滚界面。
// INV-07 同流冲突同样拒绝：守住位置 结果枚举；改错故障 两个请求互相覆盖。
// INV-08 跨流接受新权威：守住位置 兜底覆盖；改错故障 旧运行时的代次永久挡住新请求。
// INV-09 清除可限定交互标识：守住位置 可选参数比较；改错故障 清掉其他交互的绑定。
// INV-10 按工作区查找取最新：守住位置 创建时间排序；改错故障 命中旧请求。
// INV-11 授权查找需三项齐全：守住位置 摘要与条目比较；改错故障 跨包误用授权。
// INV-12 信任状态白名单固定：守住位置 集合判断；改错故障 未知状态也能提交。
// INV-13 等待先查一次现状：守住位置 入口读取；改错故障 已存在时仍挂起到超时。
// INV-14 等待超时返回空：守住位置 定时器回调；改错故障 永久挂起。
// INV-15 结算只发生一次：守住位置 已结算标记；改错故障 定时器与订阅重复结算。
// INV-16 订阅后补查一次：守住位置 复核位置；改错故障 首读与订阅之间丢事件。
// INV-17 身份优先于路径：守住位置 键取值；改错故障 同路径远端标签误选本地通道。
// INV-18 查询带身份时禁止路径回落：守住位置 末尾条件；改错故障 未知身份选到旧本地绑定。
//
// 模块职责：保存工作区钩子评审请求与命令通道绑定，并提供按工作区查找。
// 状态所有权：绑定真值在本 store，页面只做订阅与临时展示。
// 阅读顺序：先看两张绑定表与动作，再看三种查找，最后看等待与匹配规则。
import { create } from "zustand";
import type {
  CommandAck,
  CommandEnvelope,
  WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
// review 单调性裁决单一来源；store 的应用策略是 cross_flow 接受新 Runtime 权威
// （renderer 服从 canonical snapshot 的最新投递）。
import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";

// WorkspaceHookCommandBinding 的命令通道按 sessionId 存放。
// 每条绑定带 sendCommand() 与可选的 onCommandSettled() 回调。
// 远端会话额外带 workspaceIdentity 作隔离键。
// 远程工作区还要带 remoteSessionId 才能回连。
export interface WorkspaceHookCommandBinding {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  onCommandSettled?: (commandId: string) => void;
}

export interface WorkspaceHookReviewBinding {
  request: WorkspaceHookReviewRequestPayload;
  workspacePath: string;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  onCommandSettled?: (commandId: string) => void;
}

interface WorkspaceHookReviewState {
  bindings: Record<string, WorkspaceHookReviewBinding>;
  commandBindings: Record<string, WorkspaceHookCommandBinding>;
  connect(sessionId: string, binding: WorkspaceHookCommandBinding): void;
  disconnect(sessionId: string, sendCommand: WorkspaceHookCommandBinding["sendCommand"]): void;
  upsert(sessionId: string, binding: WorkspaceHookReviewBinding): void;
  clear(sessionId: string, interactionId?: string): void;
}

// WorkspaceHookReviewState 只有 bindings 与 commandBindings 两张表。
// connect()/disconnect()/upsert()/clear() 都以 sessionId 为键。
// disconnect() 比较 sendCommand 引用，防止旧清理删掉新连接。
export const useWorkspaceHookReviewStore = create<WorkspaceHookReviewState>((set) => ({
  bindings: {},
  commandBindings: {},
  connect: (sessionId, binding) =>
    set((state) => ({
      commandBindings: { ...state.commandBindings, [sessionId]: binding },
    })),
  disconnect: (sessionId, sendCommand) =>
    set((state) => {
      const current = state.commandBindings[sessionId];
      if (!current || current.sendCommand !== sendCommand) return state;
      const commandBindings = { ...state.commandBindings };
      delete commandBindings[sessionId];
      const review = state.bindings[sessionId];
      if (!review || review.sendCommand !== sendCommand) return { commandBindings };
      // command channel 已断开后不能继续保留同一连接的 review binding；否则 Settings
      // 会拿到 disposed client。sendCommand identity guard 可避免旧连接 cleanup 清掉新连接。
      const bindings = { ...state.bindings };
      delete bindings[sessionId];
      return { bindings, commandBindings };
    }),
  upsert: (sessionId, binding) =>
    set((state) => {
      const commandBinding = state.commandBindings[sessionId];
      if (commandBinding && commandBinding.sendCommand !== binding.sendCommand) {
        // renderer 重连时旧 effect 可能迟到；只有当前 session command channel 才能刷新
        // review binding，避免 equal-generation replay 把新 client 换回 disposed client。
        return state;
      }
      const current = state.bindings[sessionId];
      if (current) {
        const verdict = verdictWorkspaceHookReviewRequest(current.request, binding.request);
        // generation 只在一个 Runtime flow 内可比较。新 Runtime 会生成新
        // reviewFlowId 并从 1 重计；跨 flow（cross_flow）必须服从 canonical snapshot 的
        // 最新投递，否则旧 Runtime 的高 generation 会永久挡住新权威请求。同 flow 则严格
        // 要求 generation 单调，replay/conflict/stale 不得覆盖当前 binding。
        if (verdict === "same_flow_stale" || verdict === "same_flow_replay" ||
          verdict === "same_flow_conflict") {
          return state;
        }
      }
      return { bindings: { ...state.bindings, [sessionId]: binding } };
    }),
  clear: (sessionId, interactionId) =>
    set((state) => {
      const current = state.bindings[sessionId];
      if (!current || (interactionId && current.request.interactionId !== interactionId)) {
        return state;
      }
      const bindings = { ...state.bindings };
      delete bindings[sessionId];
      return { bindings };
    }),
}));

export function findWorkspaceHookReviewBinding(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  workspacePath?: string | null,
  workspaceIdentity?: string,
): WorkspaceHookReviewBinding | undefined {
  return Object.values(bindings)
    .filter((binding) =>
      matchesWorkspaceBinding({
        bindingWorkspaceIdentity: binding.request.workspaceIdentity,
        bindingWorkspacePath: binding.workspacePath,
        workspaceIdentity,
        workspacePath,
      }),
    )
    .sort((left, right) => right.request.createdAt - left.request.createdAt)[0];
}

const TRUSTABLE_WORKSPACE_HOOK_STATES = new Set([
  "pending_trust",
  "revoked",
  "stale_digest",
]);

/**
 * 查找能授权指定静态 Settings 行的精确 immutable review binding。
 *
 * Settings 的 trustState 只负责展示，绝不能直接成为 mutation authority；真正提交前必须
 * 同时匹配 workspace、bundle 和 opaque reviewItemId，避免等待期间跨 generation/bundle
 * 误用另一条 request。
 */
// findWorkspaceHookReviewBindingForItem() 必须同时匹配 workspace、bundle 与 reviewItemId。
// trustState 只信任可授权的三种状态，其余一律拒绝。
// 多条命中时按 createdAt 取最新者。
export function findWorkspaceHookReviewBindingForItem(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  input: {
    workspacePath?: string | null;
    workspaceIdentity?: string;
    bundleDigest: string;
    reviewItemId: string;
  },
): WorkspaceHookReviewBinding | undefined {
  return Object.values(bindings)
    .filter(
      (binding) =>
        matchesWorkspaceBinding({
          bindingWorkspaceIdentity: binding.request.workspaceIdentity,
          bindingWorkspacePath: binding.workspacePath,
          workspaceIdentity: input.workspaceIdentity,
          workspacePath: input.workspacePath,
        }) &&
        binding.request.bundleDigest === input.bundleDigest &&
        binding.request.items.some(
          (item) =>
            item.reviewItemId === input.reviewItemId &&
            TRUSTABLE_WORKSPACE_HOOK_STATES.has(item.trustState),
        ),
    )
    .sort((left, right) => right.request.createdAt - left.request.createdAt)[0];
}

export function waitForWorkspaceHookReviewBindingForItem(
  input: {
    workspacePath?: string | null;
    workspaceIdentity?: string;
    bundleDigest: string;
    reviewItemId: string;
  },
  timeoutMs: number,
): Promise<WorkspaceHookReviewBinding | undefined> {
  const current = findWorkspaceHookReviewBindingForItem(
    useWorkspaceHookReviewStore.getState().bindings,
    input,
  );
  if (current) return Promise.resolve(current);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const timer = globalThis.setTimeout(() => finish(undefined), timeoutMs);
    const finish = (binding: WorkspaceHookReviewBinding | undefined) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(binding);
    };
    unsubscribe = useWorkspaceHookReviewStore.subscribe((state) => {
      const binding = findWorkspaceHookReviewBindingForItem(state.bindings, input);
      if (binding) finish(binding);
    });

    // subscribe 与首次读取之间仍可能发生一次同步 upsert；订阅完成后再检查一次收口竞态。
    const afterSubscribe = findWorkspaceHookReviewBindingForItem(
      useWorkspaceHookReviewStore.getState().bindings,
      input,
    );
    if (afterSubscribe) finish(afterSubscribe);
  });
}

export function findWorkspaceHookCommandBinding(
  bindings: Record<string, WorkspaceHookCommandBinding>,
  workspacePath?: string | null,
  workspaceIdentity?: string,
): WorkspaceHookCommandBinding | undefined {
  return Object.values(bindings).find((binding) =>
    matchesWorkspaceBinding({
      bindingWorkspaceIdentity: binding.workspaceIdentity,
      bindingWorkspacePath: binding.workspacePath,
      workspaceIdentity,
      workspacePath,
    }),
  );
}

// matchesWorkspaceBinding() 查询键优先取 workspaceIdentity，其次取 workspacePath。
// 绑定带 identity 时只允许与查询键严格相等。
// 无 workspaceIdentity 的旧绑定才按 workspacePath 回落。
function matchesWorkspaceBinding(input: {
  bindingWorkspaceIdentity?: string;
  bindingWorkspacePath: string;
  workspaceIdentity?: string;
  workspacePath?: string | null;
}): boolean {
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  if (!workspaceKey) return false;
  const bindingWorkspaceIdentity = input.bindingWorkspaceIdentity?.trim();
  if (bindingWorkspaceIdentity) {
    // identity 命中或 path 命中的 OR 判定不够：同一路径的远程 tab 因 path
    // 相等会被本地 Settings 选成信任提交通道，形成跨 workspace 误授权。
    // 修法：binding 一旦带 identity 就只能严格匹配 workspaceKey；只有自身无
    // identity 的旧本地 binding 才允许按 path fallback。
    return bindingWorkspaceIdentity === workspaceKey;
  }
  // 当前查询本身携带 identity 时同样禁止降级到 path；否则未知远程 identity 会误选
  // 一个无 identity 的本地旧 binding。
  return !input.workspaceIdentity?.trim() && input.bindingWorkspacePath === input.workspacePath;
}
