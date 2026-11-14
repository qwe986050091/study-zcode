/**
 * ============================================================================
 * hooks/workspace-hook-trust-records.ts —— 把审核选择冻结成信任记录
 * ============================================================================
 *
 * TrustRecord 记录的不是"当前 hook 声明",而是"授权那一刻的声明指纹":
 * 命令、来源路径、matcher、hookIndex、bundleDigest 全部按当时快照固化。
 * 之后声明被改动就会变成 stale_digest,必须重新批准（不变量 #10 的判定输入）。
 * 因此这里按 reviewItemId 回查快照,任何找不到的情形都直接报错,不写半条记录。
 * ============================================================================
 */
import type { WorkspaceHookBundleSnapshot, WorkspaceHookTrustRecord } from "@zcode/contracts";
import { workspaceHookTrustRecordSchema } from "@zcode/contracts";

export function createWorkspaceHookTrustRecords(input: {
  snapshot: WorkspaceHookBundleSnapshot;
  reviewItemIds: readonly string[];
  grantedAt: string;
  appVersion?: string;
}): WorkspaceHookTrustRecord[] {
  // 用 reviewItemId 建索引:审核请求只带 id,记录内容必须回查快照,
  // 不能让调用方自带一份可能已经过期的声明。
  const items = new Map(input.snapshot.hooks.map((entry) => [entry.reviewItemId, entry] as const));
  // 同一 item 被重复选择时只写一条,去重后的条数才是真实授权条数。
  return unique(input.reviewItemIds).map((reviewItemId) => {
    const entry = items.get(reviewItemId);
    // 未知 id 说明请求与快照不一致:写半条无效记录会让后续过期判定无从比较,
    // 所以整批直接失败。
    if (!entry) throw new Error(`Unknown Workspace Hook review item: ${reviewItemId}`);
    const source = input.snapshot.sourceFiles[entry.sourceFileIndex];
    // 来源下标越界代表快照不完整;宁可拒绝,也不落下一条没有来源的授权记录。
    if (!source) throw new Error(`Workspace Hook source is missing for ${reviewItemId}`);
    // 统一过 schema:字段名与格式是跨进程、跨落盘的稳定契约。
    return workspaceHookTrustRecordSchema.parse({
      workspaceIdentity: input.snapshot.workspaceIdentity,
      hookDeclarationDigest: entry.hookDeclarationDigest,
      digestAlgorithm: "sha256",
      decision: "trusted",
      grantedAt: input.grantedAt,
      bundleDigestAtGrant: input.snapshot.bundleDigest,
      eventAtGrant: entry.event,
      // 授权时展示的命令原样保留:后续靠它证明"用户当时看到的就是这条命令"。
      displayCommandAtGrant:
        entry.type === "process" ? [entry.command, ...(entry.args ?? [])].join(" ") : entry.command,
      sourcePathAtGrant: entry.sourceRelativePath,
      // 位置类字段(发现顺序、matcher 下标、hook 下标)一并固化:
      // 它们变化时同一条记录会指向另一个 hook,必须让记录随之失效。
      sourceDiscoveryOrderAtGrant: source.discoveryOrder,
      matcherAtGrant: entry.matcher,
      matcherIndexAtGrant: entry.matcherIndex,
      hookIndexAtGrant: entry.hookIndex,
      // 版本可选记录:用于排查"升级后判定变化"是否由应用版本差异引入。
      ...(input.appVersion ? { appVersionAtGrant: input.appVersion } : {}),
    });
  });
}

function unique<T>(values: readonly T[]): T[] {
  // 保持首次出现顺序:落盘顺序与用户选择顺序一致,便于审计比对。
  return [...new Set(values)];
}
