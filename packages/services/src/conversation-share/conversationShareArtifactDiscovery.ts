/* oxlint-disable eslint(max-lines) -- input attachment staging and preview artifact discovery share one immutable snapshot boundary. */
// 结果物发现：把「会话里能看到的文件/图片/附件」变成一份可上传的不可变快照。
// 三个来源在同一处收敛：用户输入的 attachment、注册过的 artifact Row、助手正文里提到的文件路径。
// INV-01：所有读取都受 revision + logEpoch 水位约束，水位不一致必须失败而不是拼接（守住它：stale 检查）。
// INV-02：发布阶段必须复验已注册 artifact 的字节，用户可能在选择后改过文件（守住它：materializeRegisteredArtifacts 的 size/sha256 比对）。
// INV-03：单个候选的「不可读 / 类型不支持」降级为 warning，容量与安全结构问题必须阻断（守住它：两处 catch 的分支）。
// INV-04：同一 canonicalPath 只上传一次，跨来源去重靠真实路径而非 ref（守住它：existingCanonicalPaths / previewCanonicalPaths）。
// 改错后果：分享里混入旧版本文件、同一文件重复上传、或用户看到的卡片在发布时被静默丢弃。
// [权衡] 快照在发布入口一次性算完并返回三份产物（rows/bytesBySourceRef/additionalArtifacts），
// 而不是让上层分多次查询：只有一次性算完才能保证三者对应同一时刻的磁盘状态。
import { createHash } from "node:crypto";
import { isWorkflowShareFallbackRow } from "#src/conversation-share/conversationShareWorkflowSnapshot.js";

import {
  buildConversationPreviewArtifactCandidates,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
  extractConversationPreviewFileReferences,
  type ConversationPreviewArtifactCandidate,
  type ConversationPreviewFileChange,
  type ConversationShareCapabilities,
} from "@zcode/shared";
import type {
  ArtifactRow,
  ConversationArtifactType,
  ConversationRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  readZCodeAttachmentFaultCode,
} from "@zcode/shared/zcode-protocol-v4";

import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type {
  ConversationShareFailureIssue,
  PublishTextConversationInput,
} from "./conversationShare.js";
import { ConversationShareServiceError } from "./conversationShare.js";
import type { ConversationShareArtifactSource } from "./conversationShareArtifactSource.js";
import type { ConversationSharePublicArtifact } from "./conversationSharePublicProjection.js";

// sourceRef 是「会话里的引用」，canonicalPath 是「磁盘上的同一性」，两者用途不同，不能合并。
interface MaterializedShareArtifact {
  sourceRef: string;
  canonicalPath: string;
  bytes: Uint8Array;
}

// 发现阶段直接产出成品 ArtifactRow：rowId 已分配、sha256 已算定，投影阶段不再补字段。
interface DiscoveredShareArtifact extends MaterializedShareArtifact {
  row: ArtifactRow;
}

// rows 已包含新插入的 artifact 行；additionalArtifacts 是输入附件对应的公开描述，
// 它们不进 rows（因为原行仍带着 attachment），但必须进 manifest 才能被上传与校验。
// issues 目前恒为空数组，保留字段是为了让调用方不必在版本升级时改签名。
// warnings 与 issues 分开：前者不阻断发布，UI 只能以提示形式展示。
export interface ConversationShareArtifactSnapshot {
  rows: ConversationRow[];
  bytesBySourceRef: Map<string, Uint8Array>;
  additionalArtifacts: ConversationSharePublicArtifact[];
  issues: ConversationShareFailureIssue[];
  /** 非阻断：被跳过的预览结果物，发布照常继续。 */
  warnings: ConversationShareFailureIssue[];
}

// 预检结果快照：发布时用它判断「用户看到的卡片」与「现在能发现的卡片」是否一致。
// 四个指纹各管一段：revision/logEpoch 管数据水位，capabilities 管能力，candidate 管候选集合。
// visibleSourceRefs 记录预检时被判为可见的引用——发布只能少不能多，
// 否则用户没看到的内容会被偷偷分享出去。
export interface ConversationSharePreviewPreflightSnapshot {
  revision: number;
  logEpoch: string;
  capabilitiesFingerprint: string;
  candidateFingerprint: string;
  visibleSourceRefs: readonly string[];
}

// 指纹只覆盖「影响用户所见」的字段，不含 rowId/时间：这些在两次读取间可能合法变化，
// 若纳入指纹会让本来一致的候选集被判成变化，从而反复要求用户重新确认。
// JSON.stringify 的键序由对象字面量固定，因此同输入必得同串，可直接做相等比较。
// [权衡] 用 JSON 而不是哈希：这里只做同进程内比较，哈希增加成本却没有额外收益。
export function getConversationSharePreviewCandidateFingerprint(
  candidates: readonly ConversationPreviewArtifactCandidate[],
): string {
  return JSON.stringify(
    candidates.map((candidate) => ({
      sourceRef: candidate.sourceRef,
      displayName: candidate.displayName,
// 预览形态参与指纹：png 与 md 的渲染差异会改变用户所见的卡片类型。
      previewKind: candidate.previewKind,
      artifactType: candidate.artifactType,
      mimeType: candidate.mimeType,
// 轮次归属参与指纹：同名文件出现在不同轮次时是不同的候选，不能被当成同一份。
      productTurnId: candidate.productTurnId,
// 是否依赖文件改动列表决定了发现阶段是否会发额外 RPC，属于「所见即所得」的一部分。
// 指纹用 JSON.stringify 的数组顺序：候选集合的顺序本身就是 UI 展示顺序，必须保序。
      requiresFileChanges: candidate.requiresFileChanges,
    })),
  );
}

// 发现阶段的失败统一归类为 invalid_conversation：它们都是「这份会话现在不能分享」，
// 而不是网络或服务端问题，UI 因此不该提示重试。
function throwDiscoveryError(message: string): never {
  throw new ConversationShareServiceError("invalid_conversation", message);
}

// 反斜杠先归一成正斜杠：远端 Windows 路径也会进到这里，不能只按本机平台处理。
function fileNameOf(path: string): string {
  return path.replace(/\\/gu, "/").split("/").at(-1) ?? path;
}

// dot > 0 排除隐藏文件（.gitignore 没有扩展名）；dot 在末尾也排除（trailing dot）。
// 返回小写：能力列表里的扩展名大小写不一致是常见情况，比较前必须统一。
function extensionOf(path: string): string | null {
  const fileName = fileNameOf(path);
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toLowerCase() : null;
}

// 匹配规则是「扩展名 AND mime 同时命中同一个能力项」，不能拆成两次独立查找：
// 拆开会出现扩展名来自 png 项、mime 来自 jpeg 项的错配。
// 返回具体的 artifactType 而不是布尔值，是因为上传 descriptor 需要它。
// 返回 null 表示「不支持」，由调用方转成 warning 并跳过该候选。
function matchAllowedArtifact(
  capabilities: ConversationShareCapabilities,
  candidate: Pick<ConversationPreviewArtifactCandidate, "mimeType" | "previewKind" | "sourceRef">,
): { artifactType: ConversationArtifactType; mimeType: string } | null {
  // 视频/音频只是预览卡片候选；ConversationArtifactType 没有媒体枚举，即使服务端
  // 能力列表意外包含媒体类型，也不能把它们重新放进可上传 manifest。
// 媒体类型在协议里没有对应的 ConversationArtifactType，即便服务端能力列表误加也不能放行；
// 这里显式短路，避免后面按扩展名匹配时把 mp4 当成普通文件上传。
  if (candidate.previewKind === "video" || candidate.previewKind === "audio") {
    return null;
  }
  const extension = extensionOf(candidate.sourceRef);
  if (!extension) return null;
// 能力里的扩展名可能带点，统一去掉后再比；mime 只做小写比较，不改写带参数的形式。
  const allowed = capabilities.allowed_artifacts.find(
    (allowedCandidate) =>
      allowedCandidate.extensions.some(
        (candidateExtension) => candidateExtension.replace(/^\./u, "").toLowerCase() === extension,
      ) &&
      allowedCandidate.mime_types.some(
        (candidateMimeType) => candidateMimeType.toLowerCase() === candidate.mimeType,
      ),
  );
// 找不到同时匹配扩展名与 mime 的能力项就判不支持：宁可漏掉一个文件，也不上传类型存疑的内容。
  if (!allowed) return null;
// mime 用候选自带值而不是能力项里的值：候选的 mime 来自真实文件，能力项只是允许集合。
  return { artifactType: allowed.type, mimeType: candidate.mimeType };
}

// 已注册 artifact 的复读：这些行在选择阶段就已经确定，但字节必须现在取。
// inlineBytesBySourceRef 提供「字节已在内存」的快速通道（行内图片），
// 命中时不读盘，canonicalPath 退化为 sourceRef（它本来就不是文件）。
async function materializeRegisteredArtifacts(options: {
  workspacePath: string;
  maxArtifactBytes: number;
  artifacts: ConversationSharePublicArtifact[];
  inlineBytesBySourceRef?: ReadonlyMap<string, Uint8Array>;
  artifactSource: ConversationShareArtifactSource;
}): Promise<MaterializedShareArtifact[]> {
// 顺序与 registeredArtifacts 一致：上层用 sourceRef 建索引，顺序不影响正确性，
// 但保持一致能让字节合并与 manifest 的顺序可预测，便于对比两次运行的差异。
  const materialized: MaterializedShareArtifact[] = [];
  for (const artifact of options.artifacts) {
// 优先用内存字节：行内图片的 sourceRef 不是真实路径，交给 artifactSource 读会失败。
// 三元表达式两侧形状一致，避免后续对 canonicalPath 的语义做分支判断。
    const inlineBytes = options.inlineBytesBySourceRef?.get(artifact.sourceRef);
    const { bytes, canonicalPath } = inlineBytes
      ? { bytes: inlineBytes, canonicalPath: artifact.sourceRef }
      : await options.artifactSource.read({
          workspacePath: options.workspacePath,
          ref: artifact.sourceRef,
          maxBytes: options.maxArtifactBytes,
        });
// 摘要在这里重算而不是信任 descriptor：descriptor 是选择阶段算的，磁盘可能已变。
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // Row 在工具完成时记录，用户可能在发布前修改同一路径；必须复验当前字节，
    // 否则 projection/manifest 描述的是旧文件而 multipart 上传的是新文件。
    if (
// 长度与摘要必须同时对上：只比长度会漏掉「同长度替换」，只比摘要则无法区分截断。
// 不一致直接抛 invalid_conversation：宁可发布失败，也不能上传与 manifest 描述不符的字节。
      bytes.byteLength !== artifact.descriptor.size_bytes ||
      sha256 !== artifact.descriptor.sha256
    ) {
      throwDiscoveryError("Conversation artifact changed after it was registered");
    }
// 只登记校验通过的条目；抛错时整个快照失败，不会留下部分登记的中间状态。
    materialized.push({ sourceRef: artifact.sourceRef, canonicalPath, bytes });
  }
  return materialized;
}

// 正文引用发现：从助手文本里提取路径，结合 fileChanges 判断是否指向被修改的文件，
// 最终产出 artifact 行。全部候选都要过一次存在性 + 能力 + 字节校验。
// [失败路径] 文件改动查询的 stale 错误必须冒泡成「会话已变化」，不能降级：
// 否则会把不同 revision 的对话与文件拼进同一份分享。
// [并发] 两次只读 RPC（rows 与 fileChanges）之间没有锁，水位校验是唯一的正确性保障。
async function discoverPreviewArtifacts(options: {
  zcodeAgentService: Pick<
    IZCodeAgentService,
    "conversationFileChangesV4" | "conversationAttachmentReadV4"
  >;
  artifactSource: ConversationShareArtifactSource;
  input: PublishTextConversationInput;
  selectedRows: ConversationRow[];
  capabilities: ConversationShareCapabilities;
  revision: number;
  logEpoch: string;
  existingCanonicalPaths: Set<string>;
  issues: ConversationShareFailureIssue[];
  warnings: ConversationShareFailureIssue[];
  turnOrdinalByProductTurnId?: ReadonlyMap<string, number>;
  preflightPreviewSnapshots?: ReadonlyMap<string, ConversationSharePreviewPreflightSnapshot>;
  currentCapabilitiesFingerprint?: string;
}): Promise<DiscoveredShareArtifact[]> {
// 只收已完成（成功或中断）的 turnHeader：进行中的轮次文件仍在变，分享出去必然不一致。
  const headersByProductTurnId = new Map<string, TurnHeaderRow>();
  for (const row of options.selectedRows) {
    if (
// 一个 productTurnId 只应有一个 turnHeader；若数据异常出现重复，后者覆盖前者，
// 因为 Map.set 语义如此，且两个 header 通常指向同一轮。
      row.kind === "turnHeader" &&
      row.productTurnId &&
      (row.state === "completedSuccess" || row.state === "completedInterrupted")
    ) {
      headersByProductTurnId.set(row.productTurnId, row);
    }
  }
// 复用调用方传入的序号表，缺失的按出现顺序补：warning 里的 turnOrdinal 必须与 UI 一致。
  const turnOrdinalByProductTurnId = new Map<string, number>(options.turnOrdinalByProductTurnId);
  for (const row of options.selectedRows) {
    if (
      row.kind !== "turnHeader" ||
      !row.productTurnId ||
      turnOrdinalByProductTurnId.has(row.productTurnId)
    ) {
      continue;
    }
    turnOrdinalByProductTurnId.set(row.productTurnId, turnOrdinalByProductTurnId.size + 1);
  }
// 合成的工作流摘要行被排除：它里面是产物标题，不是用户可见的路径引用，
// 纳入提取会把工作流产物重复发现一次。
  const assistantTextByProductTurnId = new Map<string, string[]>();
  for (const row of options.selectedRows) {
// 多段 assistantText 用空行拼接后再提取：模型可能把路径写在第二段，分段提取会漏。
    if (row.kind !== "assistantText" || !row.productTurnId || isWorkflowShareFallbackRow(row))
      continue;
    const texts = assistantTextByProductTurnId.get(row.productTurnId) ?? [];
    texts.push(row.text);
    assistantTextByProductTurnId.set(row.productTurnId, texts);
  }
  const discovered: DiscoveredShareArtifact[] = [];
// 新行号从已选行最大值起增，保证不与任何现有行冲突，也不会与同批插入的工作流行撞号。
  const maxSourceRowId = options.selectedRows.reduce(
    (maximum, row) => Math.max(maximum, row.rowId),
    0,
  );

// 没有对应 turnHeader 的正文无法挂载 artifact 行，直接跳过而不是抛错。
  for (const [productTurnId, textParts] of assistantTextByProductTurnId) {
    const header = headersByProductTurnId.get(productTurnId);
    if (!header) continue;
// join 结果既用于提取引用，也用于候选构造；两者必须看到完全相同的文本，
// 否则提取出的引用可能不在候选集合里。
    const assistantText = textParts.join("\n\n");
// 提取器只看正文与 workspacePath，不访问磁盘；实际存在性由后面的 stat 判断。
// 把 workspacePath 传进去是为了识别相对路径与绝对路径两种写法。
    const references = extractConversationPreviewFileReferences(
      assistantText,
      options.input.workspacePath,
    );
// 只有 markdown/html 引用需要文件改动上下文（用于判断引用的是否是本次改动产物）。
    const needsFileChanges = references.some(
      (reference) => reference.kind === "markdown" || reference.kind === "html",
    );
    let fileChanges: ConversationPreviewFileChange[] | undefined;
// 已被 revert 的改动不再查询：此时文件已回到旧内容，拿改动列表只会误导判定。
// entityId 缺失说明行身份不稳定，无法作为 RPC target，必须失败而不是猜。
    if (needsFileChanges && header.fileChanges?.state !== "reverted") {
      if (!header.entityId || !header.productTurnId) {
        throwDiscoveryError("Conversation file changes are missing a stable turn identity");
      }
// 显式声明结果类型是为了让 try 外的赋值可见；用 Awaited<ReturnType<...>> 而非手写结构，
// 保证 Agent 接口演进时这里自动跟随。
      let result: Awaited<ReturnType<IZCodeAgentService["conversationFileChangesV4"]>>;
      try {
        result = await options.zcodeAgentService.conversationFileChangesV4({
          workspacePath: options.input.workspacePath,
          ...(options.input.workspaceIdentity
            ? { workspaceIdentity: options.input.workspaceIdentity }
            : {}),
          ...(options.input.remoteSessionId
            ? { remoteSessionId: options.input.remoteSessionId }
            : {}),
          sessionId: options.input.sessionId,
// 用行级 target（rowId + entityId）而不是直接用 productTurnId：实体 ID 才能定位到具体行版本。
          target: { rowId: header.rowId, entityId: header.entityId },
// 带上 baseRevision/baseLogEpoch：不带的话服务端只能按「最新」返回，
// 与已选 rows 的水位不一致时会拼出跨版本内容。
          baseRevision: options.revision,
          baseLogEpoch: options.logEpoch,
        });
      } catch (error) {
        // rows/range 与 fileChanges 是两次只读 RPC；若中间 projection 已推进，继续发布会
        // 把不同 revision 的对话和文件拼在一起。陈旧水位必须在 prepare 前显式失败。
// 只有明确的水位错误才转成业务失败；其它错误原样抛出，保留协议层诊断。
        const message = error instanceof Error ? error.message : String(error);
// 两个错误码分别代表「revision 落后」与「日志纪元变化」，对用户是同一件事：会话被改过，需重新选择。
// 用消息包含判断而不是错误类型，是因为该错误由远端 Agent 以字符串形式透传。
        if (message.includes("proto.staleRevision") || message.includes("proto.staleLogEpoch")) {
          throwDiscoveryError("Conversation changed while preparing share");
        }
        throw error;
      }
// 归一成「路径 + 状态」的最小结构：提取器不需要 diff 内容，减少传递面。
      fileChanges = result.items.map((item) => ({
        path: item.path,
        state: result.state === "reverted" ? "reverted" : "active",
      }));
    }

// 候选可能包含重复项与已失效项，这里是「宽进」；后面的 stat/能力检查负责「严出」。
    const candidates = buildConversationPreviewArtifactCandidates({
      assistantText,
      productTurnId,
      workspacePath: options.input.workspacePath,
      fileChanges,
    });
// 预检快照按 productTurnId 索引：只有同一轮的四项指纹全等，才认为用户看到的就是当前候选。
    const preflightSnapshot = options.preflightPreviewSnapshots?.get(productTurnId);
// preflightMatches 为 false 时不阻断操作，只把候选退回全量。
// 不匹配时退回全量候选（而不是空集），因为用户仍可选择继续，UI 会重新展示差异。
    const preflightMatches =
      preflightSnapshot !== undefined &&
      preflightSnapshot.revision === options.revision &&
      preflightSnapshot.logEpoch === options.logEpoch &&
      preflightSnapshot.capabilitiesFingerprint === options.currentCapabilitiesFingerprint &&
      preflightSnapshot.candidateFingerprint ===
        getConversationSharePreviewCandidateFingerprint(candidates);
// 匹配时只保留预检里判为可见的引用：这是「不能多分享」的硬约束，
// 即使某个候选现在可见了，用户没看到过就不能发。
    const candidatesForPublish = preflightMatches
      ? candidates.filter((candidate) =>
          preflightSnapshot.visibleSourceRefs.includes(candidate.sourceRef),
        )
      : candidates;
// previewCanonicalPaths 是「本轮已见过」集合，用于同一轮内去重；
// fallbackReadCache 保存无 stat 能力时读到的字节，避免后面再读一遍。
    const visibleCandidates: ConversationPreviewArtifactCandidate[] = [];
    const previewCanonicalPaths = new Set<string>();
    const fallbackReadCache = new Map<string, { bytes: Uint8Array; canonicalPath: string }>();
// 两阶段：先确认「卡片还在」，再确认「类型支持」。顺序不能反——
// 类型不支持的 warning 只应对确实存在的文件发出。
    for (const candidate of candidatesForPublish) {
      // 与 UI 预览卡片保持一致：先 stat 决定卡片是否仍存在，再判断分享能力。
      // 发布阶段重新确认失败时要回传 warning，避免“分享成功”却悄悄漏掉选择时可见的卡片。
// 用 as const 固定字面量类型，避免 workspacePath/ref 被拓宽成 string 后与接口不匹配。
// 这里只带两个字段：artifactSource 的接口只认「workspace + ref」，其余由实现自己判定。
      const visibleCandidateSource = {
        workspacePath: options.input.workspacePath,
        ref: candidate.sourceRef,
      } as const;
      try {
// [权衡] 有 stat 时只 stat 不读字节：大文件在发现阶段读一次、上传前再读一次代价过高；
// 真正的字节校验交给后面的 read 与摘要比对。
// stat 的 canonicalPath 才是去重主键，符号链接指向同一文件时应合并。
        if (options.artifactSource.stat) {
// 同一真实路径在本轮已出现过就跳过，避免 markdown 与 html 两条引用指向同一文件时重复上传。
          const stat = await options.artifactSource.stat(visibleCandidateSource);
          if (previewCanonicalPaths.has(stat.canonicalPath)) continue;
          previewCanonicalPaths.add(stat.canonicalPath);
        } else {
          // artifactSource.stat 是可选能力，不是所有测试桩或历史运行时都实现。
          // 缺省时以 read 做存在性确认，保持向后兼容：仍能从行内引用发现结果物。
// 无 stat 能力的兼容路径：用一次受 maxBytes 约束的 read 同时完成存在性与去重判定。
          const materialized = await options.artifactSource.read({
            ...visibleCandidateSource,
            maxBytes: options.capabilities.max_artifact_bytes,
          });
          if (previewCanonicalPaths.has(materialized.canonicalPath)) continue;
          previewCanonicalPaths.add(materialized.canonicalPath);
// 无 stat 时读到的字节缓存起来，后面阶段直接复用，避免同一文件读两遍。
          fallbackReadCache.set(candidate.sourceRef, materialized);
        }
      } catch (error) {
        if (
          error instanceof ConversationShareServiceError &&
          error.reasonCode === "artifact_read_failed"
        ) {
          options.warnings.push({
            code: "artifact_read_failed",
            scope: "artifact",
            rowId: header.rowId,
            turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
            artifactDisplayName: candidate.displayName,
            artifactType: candidate.artifactType,
            extension: candidate.displayName.split(".").at(-1)?.toLowerCase(),
            mimeType: candidate.mimeType,
            availability: error.diagnostics?.errno === "ENOENT" ? "not_found" : "unknown",
          });
          continue;
        }
        throw error;
      }
// 可见上限与 UI 预览卡片一致：超出部分用户在确认页根本没看到，
// 因此不能进来（否则等于分享未展示内容）。超限不报错，静默截断。
      if (visibleCandidates.length < CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT) {
        visibleCandidates.push(candidate);
      }
    }

// 第二阶段：逐个做能力匹配与字节读取。能力不匹配只记 warning，
// 因为用户仍可分享同一轮里的其它消息。
    for (const candidate of visibleCandidates) {
// 匹配失败的 warning 里带上 allowedFormats 与 allowedArtifacts，
// 让 UI 能直接告诉用户「支持哪些格式」，而不是只说一句不支持。
      const match = matchAllowedArtifact(options.capabilities, candidate);
      if (!match) {
        // 文件类型不在 capabilities 时只跳过该候选，分享其它消息；选择阶段 preflight 和成功态
        // 共用这条结构化提示，不能再把单个不支持文件升级成整次发布失败。
        options.warnings.push({
          code: "artifact_type_not_allowed",
          scope: "artifact",
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: candidate.displayName.split(".").at(-1)?.toLowerCase(),
          mimeType: candidate.mimeType,
          allowedFormats: options.capabilities.allowed_artifacts.flatMap((allowed) =>
            allowed.extensions.map(
              (extension) => `${allowed.type.toUpperCase()} (.${extension.replace(/^\./u, "")})`,
            ),
          ),
          allowedArtifacts: options.capabilities.allowed_artifacts.map((allowed) => ({
            type: allowed.type,
            extensions: allowed.extensions,
            mimeTypes: allowed.mime_types,
          })),
        });
        continue;
      }
      // stat 通过后仍需 read：文件可能在选择阶段到发布阶段之间被删除或变化。
// 先声明后赋值是为了让 try 块外仍能引用；cached 命中时跳过 IO。
      let materialized;
// 缓存键是 sourceRef 而不是 canonicalPath：此时还没读到 canonicalPath，无 stat 时也无从得知。
      const cached = fallbackReadCache.get(candidate.sourceRef);
      try {
        if (cached) {
          materialized = cached;
        } else {
          materialized = await options.artifactSource.read({
            workspacePath: options.input.workspacePath,
            ref: candidate.sourceRef,
            maxBytes: options.capabilities.max_artifact_bytes,
          });
        }
      } catch (error) {
        if (
          !(error instanceof ConversationShareServiceError) ||
          error.reasonCode !== "artifact_read_failed"
        ) {
          // limit_exceeded / unsafe_structure 仍然阻断：那是需要用户处理的真实约束。
          throw error;
        }
        options.warnings.push({
          code: "artifact_read_failed",
          scope: "artifact",
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: candidate.displayName.split(".").at(-1)?.toLowerCase(),
          mimeType: candidate.mimeType,
          availability: error.diagnostics?.errno === "ENOENT" ? "not_found" : "unknown",
        });
        continue;
      }
// 与已注册 artifact（以及之前轮次发现的文件）去重：同一文件只上传一份，
// 但每个引用行仍会各自保留 ref 指向同一 artifact。
      if (options.existingCanonicalPaths.has(materialized.canonicalPath)) continue;
      options.existingCanonicalPaths.add(materialized.canonicalPath);
// localKey 同时用作 artifactVersionId 与 logicalArtifactKey：
// 前者标识「这一版内容」，后者标识「这个逻辑产物」，此处二者一一对应。
// 前缀 preview 与 input/workflow 区分来源，便于排查哪条链路产出的行。
      const localKey = `preview:${productTurnId}:${candidate.sourceRef}`;
// 行挂在发起引用的轮次上（header 的 turnId/productTurnId），而不是发现顺序上。
      discovered.push({
        sourceRef: candidate.sourceRef,
        canonicalPath: materialized.canonicalPath,
        bytes: materialized.bytes,
        row: {
// +1 保证第一行严格大于 maxSourceRowId；用 discovered.length 保持同一批内递增且稳定。
          rowId: maxSourceRowId + discovered.length + 1,
          turnId: header.turnId,
          productTurnId: header.productTurnId,
          createdAt: header.endedAt ?? header.createdAt,
          createdAtSeq: header.createdAtSeq,
          kind: "artifact",
          artifactVersionId: localKey,
          logicalArtifactKey: localKey,
          displayName: candidate.displayName,
          artifactType: match.artifactType,
          mimeType: match.mimeType,
          sizeBytes: materialized.bytes.byteLength,
          sha256: createHash("sha256").update(materialized.bytes).digest("hex"),
          ref: candidate.sourceRef,
          state: "current",
        },
      });
    }
  }
  return discovered;
}

// 用户输入附件的分块读取：与结果物读取不同，附件字节只能通过 Agent 的 V4 接口拿，
// 因为它要经过 workspace/session 授权校验，不能直接读盘。
// [资源] 全程在内存里累积 chunks，因此必须先用 maxBytes 卡住总量。
async function readInputAttachment(options: {
  zcodeAgentService: Pick<IZCodeAgentService, "conversationAttachmentReadV4">;
  input: PublishTextConversationInput;
  row: Extract<ConversationRow, { kind: "userInput" }>;
  attachmentIndex: number;
  maxBytes: number;
}): Promise<{ bytes: Uint8Array; mediaType: string }> {
// 附件必须有稳定行身份：RPC 的 target 依赖 rowId + entityId，缺失时无法安全读取。
// 这里抛 invalid_conversation 而不是跳过，因为「说好的附件读不到身份」属于契约破裂。
  const attachment = options.row.attachments?.[options.attachmentIndex];
  if (!attachment || !options.row.entityId) {
    throw new ConversationShareServiceError(
      "invalid_conversation",
      "Conversation input attachment is missing a stable row identity",
    );
  }
// totalBytes 由服务端首次返回，用于后续所有越界判断；
// mediaType 允许服务端修正（附件声明的 mime 可能不准），但缺省时沿用原值。
// 先收集 chunks 再一次性拼接，避免边读边扩容导致多次复制。
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let totalBytes: number | undefined;
  let mediaType = attachment.mime;
// 循环终止只由 nextOffset === null 决定，其它情况都必须在块内校验，
// 否则服务端返回异常游标时会变成无限循环。
  while (true) {
    const result = await options.zcodeAgentService.conversationAttachmentReadV4({
      workspacePath: options.input.workspacePath,
      ...(options.input.workspaceIdentity
        ? { workspaceIdentity: options.input.workspaceIdentity }
        : {}),
      ...(options.input.remoteSessionId ? { remoteSessionId: options.input.remoteSessionId } : {}),
      sessionId: options.input.sessionId,
      ref: attachment.ref,
      target: { rowId: options.row.rowId, entityId: options.row.entityId },
      attachmentIndex: options.attachmentIndex,
      offset,
// 块大小取协议上限与业务上限的较小值：单页不能超过协议限制，也不能超过总预算；
// 后者保证即使只剩很小额度，也不会一次读到超限数据。
      limit: Math.min(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes, options.maxBytes),
    });
// 协议只提供 base64，必须解码成字节后再累计；长度以解码结果为准而不是声明长度。
// totalBytes 用 ??= 只认第一次的声明值，防止后续页返回不一致的总长。
    const bytes = new Uint8Array(Buffer.from(result.dataBase64, "base64"));
// 用 ??= 而不是 =：后续页若返回不同 totalBytes，说明文件在读取期间变了，保留首值才能被下面的比较抓到。
    totalBytes ??= result.totalBytes;
// 服务端返回的 mime 优先，但它可能为空串；空串时保留附件声明值而不是写成空。
    mediaType = result.mediaType || mediaType;
// 两个条件合并抛 limit_exceeded：总量超限，或「还有下一页却返回空块」。
// 后者是游标卡住的信号，继续循环会先耗尽内存再超时，不如立刻失败。
    if (totalBytes > options.maxBytes || (bytes.byteLength === 0 && result.nextOffset !== null)) {
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation input attachment exceeds the byte limit",
      );
    }
    chunks.push(bytes);
// 游标按实际解码长度推进，与 nextOffset 的期望值在下一次循环比对。
    offset += bytes.byteLength;
// nextOffset === null 表示服务端已到末尾，是正常退出的唯一条件。
    if (result.nextOffset === null) break;
// 游标必须严格等于已读长度，且不能超过总长：不等说明分块边界错位，
// 继续拼会把重复或缺失的字节当成完整附件。
    if (result.nextOffset !== offset || result.nextOffset > totalBytes) {
      throw new ConversationShareServiceError(
        "invalid_conversation",
        "Conversation input attachment returned invalid read progress",
      );
    }
  }
// 按实际读取总长一次性分配，然后逐块拷贝；避免 concat 产生中间副本。
  const output = new Uint8Array(offset);
  let cursor = 0;
// 用 cursor 而非重新累加长度：写入位置与读取顺序严格一致，便于审计。
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  if (
// 两种证据都要对：服务端声明的总长，以及原始附件记录的字节数（可能为 0 表示未知）。
// 任一不等都说明附件在分享前被替换或截断，必须失败。
    totalBytes !== output.byteLength ||
    (attachment.bytes > 0 && attachment.bytes !== output.byteLength)
  ) {
    throw new ConversationShareServiceError(
      "invalid_conversation",
      "Conversation input attachment changed before sharing",
    );
  }
// 空附件没有分享价值，且会让后续 sha256 与 size 校验出现「0 字节成功」的假象。
  if (output.byteLength === 0) {
    throw new ConversationShareServiceError(
      "invalid_conversation",
      "Conversation input attachment is empty",
    );
  }
  return { bytes: output, mediaType };
}

// 输入附件处理：合法的改写成 zcode-artifact://share/... 引用并登记字节，
// 不合法/读不到的降级为 warning 并保留原引用（或删除）。
// [事务] 返回的是「新 rows 数组 + 新 attachments 对象」，不改调用方传入的行，
// 这样预检与发布可以各自基于同一份输入得到独立结果。
async function discoverInputAttachments(options: {
  zcodeAgentService: Pick<IZCodeAgentService, "conversationAttachmentReadV4">;
  input: PublishTextConversationInput;
  selectedRows: ConversationRow[];
  capabilities: ConversationShareCapabilities;
  warnings: ConversationShareFailureIssue[];
  turnOrdinalByProductTurnId?: ReadonlyMap<string, number>;
}): Promise<{
  rows: ConversationRow[];
  artifacts: ConversationSharePublicArtifact[];
  bytesBySourceRef: Map<string, Uint8Array>;
}> {
// 只复制 userInput 行及其 attachments 数组，其余行保持引用：
// 后续只改 attachments 字段，浅拷贝一层足够且避免整树复制。
// 不复制 attachments 会导致改写污染调用方的会话缓存。
  const rows = options.selectedRows.map((row) =>
    row.kind === "userInput"
      ? { ...row, attachments: row.attachments?.map((attachment) => ({ ...attachment })) }
      : row,
  );
  const artifacts: ConversationSharePublicArtifact[] = [];
  const bytesBySourceRef = new Map<string, Uint8Array>();
// 计数器跨轮次递增，保证同一次快照内 artifactId 唯一；按轮重置会产生重名。
  let artifactIndex = 0;
  for (const row of rows) {
// row.kind !== "userInput"、附件缺失或长度为 0 时直接跳过，其它行不进入附件改写。
    if (row.kind !== "userInput" || !row.attachments || row.attachments.length === 0) continue;
    const nextAttachments = [];
    for (const [attachmentIndex, attachment] of row.attachments.entries()) {
// 扩展名缺失时退化为 txt：历史附件可能没有后缀，但内容多为纯文本；
// mime 只取主类型并小写，丢掉 charset 等参数后再与能力列表比较。
      const extension = extensionOf(attachment.fileName) ?? "txt";
// 去掉 charset 等参数后小写，才能与能力列表精确比较；
// 完全缺失时按 text/plain 处理，这是历史附件的默认语义。
      const mimeType = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() || "text/plain";
      const allowed = options.capabilities.allowed_artifacts.find(
        (candidate) =>
          candidate.extensions.some(
            (value) => value.replace(/^\./u, "").toLowerCase() === extension,
          ) && candidate.mime_types.some((value) => value.toLowerCase() === mimeType),
      );
// 轮序号可能未知（例如跨批选择），因此用可选链并在落 warning 时条件展开，
// 不能写成 undefined 字段，否则 RPC 序列化会带上显式 undefined。
      const turnOrdinal = row.productTurnId
        ? options.turnOrdinalByProductTurnId?.get(row.productTurnId)
        : undefined;
// 类型不允许时保留原 attachment（不改写引用），只记 warning：
// 直接删除会让用户在分享内容里凭空少了附件却没有任何解释。
      if (!allowed) {
        options.warnings.push({
          code: "artifact_type_not_allowed",
          scope: "artifact",
          rowId: row.rowId,
          ...(turnOrdinal === undefined ? {} : { turnOrdinal }),
          artifactDisplayName: attachment.fileName,
          artifactType: extension === "txt" ? "text" : extension,
          extension,
          mimeType,
          allowedArtifacts: options.capabilities.allowed_artifacts.map((candidate) => ({
            type: candidate.type,
            extensions: candidate.extensions,
            mimeTypes: candidate.mime_types,
          })),
        });
        continue;
      }
      try {
// 读取失败的错误分类在下面统一处理，这里只负责拿到字节与最终 mime。
        const materialized = await readInputAttachment({
          zcodeAgentService: options.zcodeAgentService,
          input: options.input,
          row,
          attachmentIndex,
          maxBytes: options.capabilities.max_artifact_bytes,
        });
// sourceRef 用「行 + 附件下标」而不是文件名：文件名可重复且可能变化，
// 行级坐标在一次快照内唯一且稳定，可直接作为 bytesBySourceRef 的键。
        const sourceRef = `input:${row.rowId}:${attachmentIndex}`;
// 前缀 share-input- 用于和预览发现的产物区分，便于服务端与日志按来源归类。
        const artifactId = `share-input-artifact-${++artifactIndex}`;
// 公开引用固定用 share 伪协议：导入端据此判断「这是分享内产物」而非本地路径，
// artifactId 由服务端在校验 manifest 时重新映射，客户端不需要保证全局唯一。
        const ref = `zcode-artifact://share/${artifactId}`;
        const sha256 = createHash("sha256").update(materialized.bytes).digest("hex");
        artifacts.push({
          sourceRef,
          descriptor: {
            artifact_id: artifactId,
            logical_artifact_key: `share-input-key-${artifactIndex}`,
            producer_product_turn_id: row.productTurnId ?? row.turnId,
            artifact_version: 1,
            state: "current",
            ref,
            artifact_type: allowed.type,
            display_name: attachment.fileName,
            extension,
            mime_type: mimeType,
            size_bytes: materialized.bytes.byteLength,
            sha256,
          },
        });
// 字节登记与 descriptor 构造必须成对：少了登记，上传阶段会找不到这个 artifact 的内容。
        bytesBySourceRef.set(sourceRef, materialized.bytes);
// 改写后的 attachment 同时更新 ref 与 previewRef，并把 bytes 修正为真实长度；
// 原 attachment 的其它字段（mime/fileName 等）原样保留。
        nextAttachments.push({
          ...attachment,
          ref,
          previewRef: ref,
          bytes: materialized.bytes.byteLength,
        });
      } catch (error) {
// 协议层把原因编码在 faultCode 里，优先用它分类而不是匹配消息文本。
        const faultCode = readZCodeAttachmentFaultCode(error);
        if (
// 授权/连接不可信属于「协议未就绪」而不是内容问题：
// UI 应提示重新连接或升级，而不是让用户删附件重试。
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized ||
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted
        ) {
          throw new ConversationShareServiceError(
            "artifact_protocol_not_ready",
            "Conversation input attachment is not authorized",
            { reasonCode: "artifact_protocol_not_ready" },
          );
        }
        if (
// 容量超限必须阻断整次发布：静默降级会让接收者拿到一份缺附件的会话，
// 而分享者以为一切都发出去了。
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge ||
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge
        ) {
          // 容量超限是确定阻断，不能降级成「附件不可用」warning 后静默发布——
          // 那样接收者拿不到附件，分享者也看不出错误类别（见预检同名分类）。
          throw new ConversationShareServiceError(
            "limit_exceeded",
            "Conversation input attachment exceeds the artifact size limit",
            {
              reasonCode: "artifact_size_limit",
              issues: [
                {
                  code: "artifact_size_limit",
                  scope: "artifact",
                  rowId: row.rowId,
                  ...(turnOrdinal === undefined ? {} : { turnOrdinal }),
                  ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
                  artifactDisplayName: attachment.fileName,
                  artifactType: allowed.type,
                  extension,
                  mimeType,
                  limit: options.capabilities.max_artifact_bytes,
                },
              ],
            },
          );
        }
        options.warnings.push({
          code: "input_attachment_unavailable",
          scope: "artifact",
          rowId: row.rowId,
          ...(turnOrdinal === undefined ? {} : { turnOrdinal }),
          ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
          artifactDisplayName: attachment.fileName,
          artifactType: allowed.type,
          extension,
          mimeType,
          availability:
            faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound ||
            faultCode === ZCODE_ATTACHMENT_FAULT_CODES.statNotFile ||
            (error instanceof ConversationShareServiceError &&
              error.diagnostics?.errno === "ENOENT")
              ? "not_found"
              : "unknown",
        });
      }
    }
// 全部附件都被放弃时删除 attachments 字段而不是留空数组：
// 空数组会让 UI 渲染一个空的附件区，且投影校验对空数组与缺字段的处理不同。
    if (nextAttachments.length > 0) {
      row.attachments = nextAttachments;
    } else {
      delete row.attachments;
    }
  }
  return { rows, artifacts, bytesBySourceRef };
}

// 把 artifact 行插到所属轮次的最后一行之后，保持「行属于其轮」的局部性；
// 若直接追加到数组末尾，跨轮选择时产物会跑到别的轮次下方。
function insertDiscoveredArtifacts(
  selectedRows: ConversationRow[],
  artifacts: DiscoveredShareArtifact[],
): ConversationRow[] {
  if (artifacts.length === 0) return selectedRows;
// 按轮分组，保持发现顺序；无 productTurnId 的归到空串桶，最终落到全局末尾。
  const artifactsByProductTurnId = new Map<string, ArtifactRow[]>();
  for (const artifact of artifacts) {
    const productTurnId = artifact.row.productTurnId ?? "";
    const productTurnArtifacts = artifactsByProductTurnId.get(productTurnId);
    if (productTurnArtifacts) productTurnArtifacts.push(artifact.row);
    else artifactsByProductTurnId.set(productTurnId, [artifact.row]);
  }
// 记录每轮最后一行的下标；forEach 覆盖写入，天然得到最后一个位置。
// lastRowIndexByProductTurnId 用下标而不是「下一行轮次不同」，因为最后一行没有下一行可比。
  const lastRowIndexByProductTurnId = new Map<string, number>();
  selectedRows.forEach((row, index) => {
    if (row.productTurnId) lastRowIndexByProductTurnId.set(row.productTurnId, index);
  });
  return selectedRows.flatMap((row, index) => {
// 非「本轮最后一行」原样返回；只有最后一行后面才挂产物行，
// 这样同一轮的产物不会插到该轮中间打断消息顺序。
    if (!row.productTurnId || lastRowIndexByProductTurnId.get(row.productTurnId) !== index) {
      return [row];
    }
    return [row, ...(artifactsByProductTurnId.get(row.productTurnId) ?? [])];
  });
}

// 快照总入口，顺序不可调换：输入附件先改写 rows，已注册 artifact 再复读，
// 最后才是正文引用发现——因为去重集合需要前两者的 canonicalPath。
// 三步共用同一个 warnings 数组，保证 UI 看到的是合并后的完整提示列表。
// registeredArtifacts 来自工作流/行内图片转换，已含 descriptor，这里只补字节。
// inlineBytesBySourceRef 是「字节已在内存」的旁路，避免对行内图片做无意义的磁盘查找。
export async function buildConversationShareArtifactSnapshot(options: {
  zcodeAgentService: Pick<
    IZCodeAgentService,
    "conversationFileChangesV4" | "conversationAttachmentReadV4"
  >;
  artifactSource: ConversationShareArtifactSource;
  input: PublishTextConversationInput;
  selectedRows: ConversationRow[];
  registeredArtifacts: ConversationSharePublicArtifact[];
  inlineBytesBySourceRef?: ReadonlyMap<string, Uint8Array>;
  capabilities: ConversationShareCapabilities;
  revision: number;
  logEpoch: string;
  turnOrdinalByProductTurnId?: ReadonlyMap<string, number>;
  preflightPreviewSnapshots?: ReadonlyMap<string, ConversationSharePreviewPreflightSnapshot>;
  currentCapabilitiesFingerprint?: string;
}): Promise<ConversationShareArtifactSnapshot> {
// issues 与 warnings 分开传递：前者的语义是「阻断性问题」，
// 当前实现把所有可恢复问题都放进 warnings，issues 保持空以兼容既有调用方。
  const issues: ConversationShareFailureIssue[] = [];
  const warnings: ConversationShareFailureIssue[] = [];
// 第一步必须做附件：它会改写 userInput 的 ref，后续发现阶段看到的是最终形态。
  const inputAttachments = await discoverInputAttachments({
    zcodeAgentService: options.zcodeAgentService,
    input: options.input,
    selectedRows: options.selectedRows,
    capabilities: options.capabilities,
    warnings,
    turnOrdinalByProductTurnId: options.turnOrdinalByProductTurnId,
  });
  const selectedRows = inputAttachments.rows;
// 第二步复读已注册 artifact：任何字节变化都在这里失败，早于任何网络请求。
  const registered = await materializeRegisteredArtifacts({
    workspacePath: options.input.workspacePath,
    maxArtifactBytes: options.capabilities.max_artifact_bytes,
    artifacts: options.registeredArtifacts,
    inlineBytesBySourceRef: options.inlineBytesBySourceRef,
    artifactSource: options.artifactSource,
  });
// 第三步传 existingCanonicalPaths 做跨来源去重：已注册的文件不再重复发现。
  const discovered = await discoverPreviewArtifacts({
    ...options,
    selectedRows,
    issues,
    warnings,
    existingCanonicalPaths: new Set(registered.map((artifact) => artifact.canonicalPath)),
    turnOrdinalByProductTurnId: options.turnOrdinalByProductTurnId,
    preflightPreviewSnapshots: options.preflightPreviewSnapshots,
    currentCapabilitiesFingerprint: options.currentCapabilitiesFingerprint,
  });
  return {
    rows: insertDiscoveredArtifacts(selectedRows, discovered),
    bytesBySourceRef: new Map(
      [
        ...registered,
        ...discovered,
        ...[...inputAttachments.bytesBySourceRef.entries()].map(([sourceRef, bytes]) => ({
          sourceRef,
          bytes,
          canonicalPath: sourceRef,
        })),
      ].map((artifact) => [artifact.sourceRef, artifact.bytes]),
    ),
// bytesBySourceRef 合并三路并统一以 sourceRef 为键：上传阶段只认这一个索引，
// 三路若各自维护索引，很容易出现「有 manifest 项但取不到字节」。
    additionalArtifacts: inputAttachments.artifacts,
    issues,
    warnings,
  };
}
