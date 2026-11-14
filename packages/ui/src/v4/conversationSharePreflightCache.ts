// INV-01 指纹覆盖轮次全部行：守住位置 签名构造；改错故障 正文变化后仍命中旧预检。
// INV-02 签名只取稳定字段：守住位置 映射；改错故障 临时渲染态导致指纹抖动。
// INV-03 附件只取四项：守住位置 映射；改错故障 大字段参与哈希拖慢计算。
// INV-04 预览候选参与指纹：守住位置 附加字段；改错故障 文件引用变化不触发重检。
// INV-05 作用域三元组参与哈希：守住位置 scope；改错故障 跨会话命中同一缓存。
// INV-06 上下文同名键优先：守住位置 空值合并；改错故障 显式覆盖被忽略。
// INV-07 哈希固定八位十六进制：守住位置 末尾格式化；改错故障 键长度不稳定。
// INV-08 缓存键用不可见分隔：守住位置 拼接；改错故障 作用域与轮次标识互相拼接误命中。
// INV-09 全局错误去重：守住位置 过滤；改错故障 同一全局问题重复展示。
// INV-10 有定位字段的不过早去重：守住位置 守卫；改错故障 多个待处理轮次被合并成一条。
// INV-11 去重键覆盖全部判别字段：守住位置 JSON 构造；改错故障 不同问题被视为同一问题。
// INV-12 首次出现才保留：守住位置 集合；改错故障 重复项占满列表。
// INV-13 缺轮次明细时回落整体：守住位置 空值合并；改错故障 老宿主返回被当成失败。
// INV-14 轮次结果按请求顺序产出：守住位置 map；改错故障 缓存条目顺序与选中顺序不一致。
// INV-15 缺失判定含指纹比对：守住位置 过滤；改错故障 内容变化后仍认为已缓存。
// INV-16 行数预算按组重算：守住位置 聚合；改错故障 沿用单批合计导致上限误判。
// INV-17 任一缺失即放弃合并预算：守住位置 早退；改错故障 用不完整数据显示上限。
// INV-18 上限取各组最小值：守住位置 归约；改错故障 取最大值放行超量分享。
//
// 模块职责：为会话分享预检生成轮次指纹、缓存键与聚合结果。
// 状态所有权：纯函数模块；缓存本身由调用方持有。
// 阅读顺序：先看指纹与键，再看问题去重，最后看条目构建与聚合。
import type {
  ConversationShareFailureIssue,
  ConversationSharePreflightResult,
  ConversationShareTurnPreflightResult,
} from "@zcode/services";
import { extractConversationPreviewFileReferences } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface ConversationShareTurnFingerprintContext {
  capabilitiesFingerprint?: string;
  logEpoch?: string;
  productTurnId?: string;
  remoteSessionId?: string;
  revision?: number;
  sessionId?: string;
  workspaceKey?: string;
}

// conversationShareTurnFingerprint 先按 productTurnId 过滤 turnRows。
// 再把 assistantText 交给 extractConversationPreviewFileReferences。
// candidateFingerprint 只保留 kind/path/start/end 四个位置字段。
// signature 白名单式取 rowId/kind/state/status/text 等字段。
// 最终对整包 JSON 取哈希。
export function conversationShareTurnFingerprint(
  rows: readonly ConversationRow[],
  productTurnId: string,
  workspacePath = "",
  context: ConversationShareTurnFingerprintContext = {},
): string {
  const turnRows = rows.filter((row) => row.productTurnId === productTurnId);
  const assistantText = turnRows
    .filter((row): row is Extract<ConversationRow, { kind: "assistantText" }> => {
      return row.kind === "assistantText";
    })
    .map((row) => row.text)
    .join("\n\n");
  const candidateFingerprint = extractConversationPreviewFileReferences(
    assistantText,
    workspacePath,
  ).map((candidate) => ({
    kind: candidate.kind,
    path: candidate.path,
    start: candidate.start,
    end: candidate.end,
  }));
  const signature = turnRows.map((row) => ({
    rowId: row.rowId,
    kind: row.kind,
    state: "state" in row ? row.state : undefined,
    status: "status" in row ? row.status : undefined,
    text: "text" in row ? row.text : undefined,
    fileChanges: row.kind === "turnHeader" ? row.fileChanges : undefined,
    display: row.kind === "toolCall" ? row.display : undefined,
    attachments:
      row.kind === "userInput"
        ? row.attachments?.map((attachment) => ({
            ref: attachment.ref,
            fileName: attachment.fileName,
            mime: attachment.mime,
            bytes: attachment.bytes,
          }))
        : undefined,
  }));
  return hashString(
    JSON.stringify({
      scope: {
        workspaceKey: context.workspaceKey ?? workspacePath,
        remoteSessionId: context.remoteSessionId ?? "",
        sessionId: context.sessionId ?? "",
      },
      productTurnId: context.productTurnId ?? productTurnId,
      revision: context.revision,
      logEpoch: context.logEpoch,
      capabilitiesFingerprint: context.capabilitiesFingerprint,
      rows: signature,
      previewCandidates: candidateFingerprint,
    }),
  );
}

export function conversationSharePreflightCacheKey(
  scopeKey: string,
  productTurnId: string,
): string {
  return `${scopeKey}\u0000${productTurnId}`;
}

/**
 * 聚合多个 turn 的预检结果时，去掉同一条无法定位到具体轮次/文件的全局错误。
 * 轮次或文件级问题保留各自定位字段，避免把用户真正需要处理的多个问题合并掉。
 */
// dedupeConversationShareIssues 用 seen 按出现顺序过滤。
// hasLocator 为真时问题一律保留。
// 只有 transport/conversation 且无定位的问题进入去重。
// key 由 JSON.stringify 的判别字段组成。
// seen.add 后首次出现即登记。
export function dedupeConversationShareIssues(
  issues: readonly ConversationShareFailureIssue[],
): ConversationShareFailureIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const hasLocator =
      issue.rowId !== undefined ||
      issue.turnOrdinal !== undefined ||
      issue.artifactDisplayName !== undefined;
    // transport/conversation 问题本身就是全局状态；turn/artifact 问题没有定位字段时，
    // 即使内容相同也要保留，避免把多个待处理轮次误合并成一条。
    if (!hasLocator && issue.scope !== "transport" && issue.scope !== "conversation") {
      return true;
    }
    const key = JSON.stringify({
      code: issue.code,
      scope: issue.scope,
      rowId: issue.rowId,
      turnOrdinal: issue.turnOrdinal,
      artifactDisplayName: issue.artifactDisplayName,
      artifactType: issue.artifactType,
      extension: issue.extension,
      mimeType: issue.mimeType,
      actual: issue.actual,
      limit: issue.limit,
      retryAfterMs: issue.retryAfterMs,
      phase: issue.phase,
      allowedFormats: issue.allowedFormats,
      allowedArtifacts: issue.allowedArtifacts,
      availability: issue.availability,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 把一次预检结果拆成按 turn 的缓存条目。
 *
 * dev 下 host 进程不会随 services 重建重启，老 host 返回的结果没有 turnResults，
 * 调用方直接 `.map` 会抛异常并被下游 catch 报成「服务端预检失败」。这里对字段缺失做降级：
 * 找不到某个 turn 的明细就回落到整体 issues，宁可粒度粗一点也不能把成功的预检说成失败。
 */
// entriesByProductTurnId 先按 productTurnId 建索引。
// result.turnResults 不是数组时按空数组处理。
// productTurnIds.map 保持请求顺序逐个产出。
// entry 缺失时回落 result.blockingIssues 等整体字段。
// turnFingerprint 从 turnFingerprints 逐条附加。
export function buildConversationSharePreflightCacheEntries(
  result: ConversationSharePreflightResult,
  productTurnIds: readonly string[],
  turnFingerprints: ReadonlyMap<string, string>,
): ConversationShareTurnPreflightResult[] {
  const entriesByProductTurnId = new Map(
    (Array.isArray(result.turnResults) ? result.turnResults : []).map((entry) => [
      entry.productTurnId,
      entry,
    ]),
  );
  return productTurnIds.map((productTurnId) => {
    const entry = entriesByProductTurnId.get(productTurnId);
    return {
      ...(entry ?? {
        blockingIssues: result.blockingIssues,
        skippableWarnings: result.skippableWarnings,
        deferredIssues: result.deferredIssues,
      }),
      productTurnId,
      turnFingerprint: turnFingerprints.get(productTurnId),
    };
  });
}

export function getMissingConversationSharePreflightTurnIds(
  scopeKey: string,
  selectedProductTurnIds: readonly string[],
  cache: ReadonlyMap<string, ConversationShareTurnPreflightResult>,
  turnFingerprints?: ReadonlyMap<string, string>,
): string[] {
  return selectedProductTurnIds.filter((productTurnId) => {
    const entry = cache.get(conversationSharePreflightCacheKey(scopeKey, productTurnId));
    return (
      entry === undefined ||
      (turnFingerprints !== undefined &&
        entry.turnFingerprint !== turnFingerprints.get(productTurnId))
    );
  });
}

/** 行数是整组选中项的约束，取消/新增轮次后必须重算，不能沿用某一批 RPC 的合计。 */
// aggregateConversationShareBlockingIssues 先 flatMap 出全部 blockingIssues。
// 任一条目缺 rowBudget 就跳过行数合并。
// actual 按各 entry.rowBudget.count 求和。
// limit 取各组最小值再判 rows_limit 超限。
export function aggregateConversationShareBlockingIssues(
  entries: readonly ConversationShareTurnPreflightResult[],
): ConversationShareFailureIssue[] {
  const issues = entries.flatMap((entry) => entry.blockingIssues);
  if (!entries.length || entries.some((entry) => !entry.rowBudget))
    return dedupeConversationShareIssues(issues);
  const actual = entries.reduce((count, entry) => count + entry.rowBudget!.count, 0);
  const limit = Math.min(...entries.map((entry) => entry.rowBudget!.limit));
  return dedupeConversationShareIssues([
    ...issues.filter((issue) => issue.code !== "rows_limit"),
    ...(actual > limit
      ? [{ code: "rows_limit" as const, scope: "conversation" as const, actual, limit }]
      : []),
  ]);
}
