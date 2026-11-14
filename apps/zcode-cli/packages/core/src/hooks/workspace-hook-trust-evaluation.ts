/**
 * ============================================================================
 * hooks/workspace-hook-trust-evaluation.ts —— 单条工作区 Hook 的信任判定
 * ============================================================================
 *
 * 纯函数:把 policy / store 状态 / 持久记录 / 撤销墓碑 / 旧 slot 记录
 * 归约成 trustState,再映射到 admissionClass 与 effectiveRunnable。
 *
 * 【判定优先级】(从强到弱,先命中即定)
 *   policy=deny                         → blocked_policy
 *   store=corrupt                       → blocked_untrusted
 *   allow_trusted_only 且无持久记录      → blocked_policy
 *   有持久记录                          → trusted_persistent(撤销墓碑已被重新批准清除)
 *   命中撤销墓碑                        → revoked
 *   同一 slot 存在旧 digest 的记录       → stale_digest(声明被改过,需重新批准)
 *   其余                                → pending_trust
 *
 * 【effectiveRunnable】不仅要求 admissionClass=admitted,还要求
 * configuredEnabled 且 policy 不是 deny——"已信任"不等于"当前启用"。
 * ============================================================================
 */
import type {
  CanonicalWorkspaceHookEntry,
  WorkspaceHookBundleSnapshot,
  WorkspaceHookEffectiveState,
  WorkspaceHookPolicy,
  WorkspaceHookTrustRecord,
  WorkspaceHookTrustState,
} from "@zcode/contracts";
import {
  WORKSPACE_HOOK_STATE_ADMISSION_MAP,
  workspaceHookEffectiveStateSchema,
} from "@zcode/contracts";
import type { WorkspaceHookTrustStoreStatus } from "./workspace-hook-trust-types.js";

export function evaluateWorkspaceHookEntry(input: {
  entry: CanonicalWorkspaceHookEntry;
  snapshot: WorkspaceHookBundleSnapshot;
  policy: WorkspaceHookPolicy;
  persistentRecords: ReadonlyMap<string, WorkspaceHookTrustRecord>;
  revokedKeys: ReadonlySet<string>;
  storeStatus: WorkspaceHookTrustStoreStatus;
}): WorkspaceHookEffectiveState {
  const { entry, snapshot, policy } = input;
  const key = trustKey(snapshot.workspaceIdentity, entry.hookDeclarationDigest);
  const persistent = input.persistentRecords.get(key);
  let trustState: WorkspaceHookTrustState;

  if (policy.mode === "deny") {
    // 策略 deny 优先于一切信任记录:管理员/策略层拒绝时,历史上的批准不生效。
    trustState = "blocked_policy";
  } else if (input.storeStatus === "corrupt") {
    // store 损坏时无法确认"哪些批准仍然有效",整体按不可信处理。
    trustState = "blocked_untrusted";
  } else if (policy.mode === "allow_trusted_only") {
    // 只信持久批准:内存里的 pending/临时状态一律不放行。
    trustState = persistent ? "trusted_persistent" : "blocked_policy";
  } else if (persistent) {
    trustState = "trusted_persistent";
  } else if (input.revokedKeys.has(key)) {
    trustState = "revoked";
  } else if (hasStaleSlotRecord(snapshot, entry, input.persistentRecords.values())) {
    trustState = "stale_digest";
  } else {
    trustState = "pending_trust";
  }

  const mapped = WORKSPACE_HOOK_STATE_ADMISSION_MAP[trustState];
  return workspaceHookEffectiveStateSchema.parse({
    reviewItemId: entry.reviewItemId,
    sourceRootEnabled: entry.sourceRootEnabled,
    declarationEnabled: entry.declarationEnabled,
    runtimeHooksEnabled: entry.runtimeHooksEnabled,
    configuredEnabled: entry.configuredEnabled,
    editable: entry.editable,
    trustState,
    admissionClass: mapped.admissionClass,
    // 三重条件:映射结论为 admitted + 声明当前启用 + 策略最终不是 deny。
    // 缺任何一条都不能执行——"信任"与"启用"是独立维度。
    effectiveRunnable:
      mapped.admissionClass === "admitted" && entry.configuredEnabled && policy.mode !== "deny",
    workspaceIdentity: snapshot.workspaceIdentity,
    bundleDigest: snapshot.bundleDigest,
    hookDeclarationDigest: entry.hookDeclarationDigest,
    sourcePaths: [
      snapshot.sourceFiles[entry.sourceFileIndex]?.canonicalPath ?? entry.sourceRelativePath,
    ],
    reasonCode: mapped.reasonCode,
  });
}

export function trustKey(workspaceIdentity: string, hookDeclarationDigest: string): string {
  // 用 NUL 分隔而不是 ":"/"/":workspaceIdentity 与 digest 都可能含路径/分隔符,
  // 普通分隔符会产生跨字段碰撞(两个不同组合拼出同一个 key)。
  return `${workspaceIdentity}\u0000${hookDeclarationDigest}`;
}

/**
 * 检测"同一槽位(slot)曾批准过不同 digest"的情况:
 * 声明内容被修改后 digest 变了,但位置(event/source/matcher/indices)没变。
 * 这不是 pending 新条目,而是 stale:用户需要重新审查被改过的内容,
 * UI 也要区分"从未批准"与"批准过但内容变了"。
 */
function hasStaleSlotRecord(
  snapshot: WorkspaceHookBundleSnapshot,
  entry: CanonicalWorkspaceHookEntry,
  records: Iterable<WorkspaceHookTrustRecord>,
): boolean {
  const source = snapshot.sourceFiles[entry.sourceFileIndex];
  if (!source) return false;
  for (const record of records) {
    if (record.workspaceIdentity !== snapshot.workspaceIdentity) continue;
    if (record.hookDeclarationDigest === entry.hookDeclarationDigest) continue;
    if (
      record.sourceDiscoveryOrderAtGrant === undefined ||
      record.matcherIndexAtGrant === undefined ||
      record.hookIndexAtGrant === undefined
    ) {
      continue;
    }
    if (
      record.eventAtGrant === entry.event &&
      record.sourcePathAtGrant === entry.sourceRelativePath &&
      record.sourceDiscoveryOrderAtGrant === source.discoveryOrder &&
      record.matcherAtGrant === entry.matcher &&
      record.matcherIndexAtGrant === entry.matcherIndex &&
      record.hookIndexAtGrant === entry.hookIndex
    ) {
      return true;
    }
  }
  return false;
}
