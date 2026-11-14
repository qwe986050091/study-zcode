/**
 * ============================================================================
 * hooks/workspace-hook-policy.ts —— 工作区 Hook 策略的存储与变更通知
 * ============================================================================
 *
 * policy 决定该工作区能否运行项目内 hook(user_decides / allow_trusted_only / deny),
 * 也是 securityRevision 变化的来源之一:策略变更必须让运行期准入重新评估。
 *
 * 本类只是内存实现:写入前统一过 schema,值相同的写入不广播,
 * 避免无变更的 set 触发下游重建与重复评估（链路 9）。
 * ============================================================================
 */
import type { WorkspaceHookPolicy } from "@zcode/contracts";
import { workspaceHookPolicySchema } from "@zcode/contracts";

// 默认 user_decides:不预先信任任何项目 hook,由用户逐条决定;
// policyRevision 是内置版本标记,策略换代后它变化,使旧评估结论失效。
const DEFAULT_POLICY: WorkspaceHookPolicy = Object.freeze({
  mode: "user_decides",
  policyRevision: "builtin:user-decides:v1",
});

export interface WorkspaceHookPolicyChange {
  /** 缺省表示"全局默认策略"变化,而不是某个具体工作区。 */
  workspaceIdentity?: string;
  policy: WorkspaceHookPolicy;
}

export interface WorkspaceHookPolicyProvider {
  /** 读取必须同步:信任评估路径是同步的,不能在这里引入异步等待。 */
  getPolicy(workspaceIdentity: string): WorkspaceHookPolicy;
  subscribe(listener: (change: WorkspaceHookPolicyChange) => void): () => void;
}

export class InMemoryWorkspaceHookPolicyProvider implements WorkspaceHookPolicyProvider {
  private defaultPolicy: WorkspaceHookPolicy;
  private readonly policies = new Map<string, WorkspaceHookPolicy>();
  // 监听器用 Set:同一函数重复订阅只生效一次,退订直接 delete 即可。
  private readonly listeners = new Set<(change: WorkspaceHookPolicyChange) => void>();

  constructor(defaultPolicy: WorkspaceHookPolicy = DEFAULT_POLICY) {
    // 构造时也过一遍 schema:默认策略同样不能绕过校验。
    this.defaultPolicy = workspaceHookPolicySchema.parse(defaultPolicy);
  }

  getPolicy(workspaceIdentity: string): WorkspaceHookPolicy {
    // 未登记的工作区回退到默认策略,不隐式创建条目。
    return this.policies.get(workspaceIdentity) ?? this.defaultPolicy;
  }

  subscribe(listener: (change: WorkspaceHookPolicyChange) => void): () => void {
    // 返回退订函数:调用方卸载时必须调用,否则实例会一直持有监听器。
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setWorkspacePolicy(workspaceIdentity: string, policy: WorkspaceHookPolicy): void {
    // 先校验再比较:非法策略既不能写入,也不会广播给下游。
    const next = workspaceHookPolicySchema.parse(policy);
    // 值未变化则直接返回:避免下游把"无变更"当成安全修订变化而重建/重评（链路 9）。
    if (samePolicy(this.policies.get(workspaceIdentity), next)) return;
    // 先写状态再广播:回调里读到的必须是新策略,不能是旧值。
    this.policies.set(workspaceIdentity, next);
    this.emit({ workspaceIdentity, policy: next });
  }

  clearWorkspacePolicy(workspaceIdentity: string): void {
    // 只有确实删掉了条目才广播:重复 clear 不应制造额外变更事件。
    if (!this.policies.delete(workspaceIdentity)) return;
    this.emit({ workspaceIdentity, policy: this.defaultPolicy });
  }

  setDefaultPolicy(policy: WorkspaceHookPolicy): void {
    // 默认策略影响所有未单独登记的工作区,广播时不带 workspaceIdentity。
    const next = workspaceHookPolicySchema.parse(policy);
    if (samePolicy(this.defaultPolicy, next)) return;
    this.defaultPolicy = next;
    this.emit({ policy: next });
  }

  private emit(change: WorkspaceHookPolicyChange): void {
    // 同步遍历:策略变更必须立刻影响后续 dispatch 的准入判断,不能延后到微任务。
    for (const listener of this.listeners) listener(change);
  }
}

function samePolicy(current: WorkspaceHookPolicy | undefined, next: WorkspaceHookPolicy): boolean {
  // 用稳定序列化比较:策略是纯数据对象,字段顺序由构造处固定,可直接比较字符串。
  return current !== undefined && JSON.stringify(current) === JSON.stringify(next);
}
