/* oxlint-disable eslint(max-lines) -- 发布、远端 staging、安全轮询和原子导入共享同一 attempt 生命周期，拆分会让清理与进度状态失去单一 owner。 */
// 分享业务编排层：预检 → 产物物化 → 公开投影 → 上传 → confirm → 轮询，以及导入的下载/落盘/建会话。
// 它同时拥有 attempt 生命周期（进度阶段、预检快照、幂等表），因此不拆分。
// INV-01：发布必须基于同一份 rows 水位（revision + logEpoch），分页读期间水位变化立即失败（守住它：loadAllRows）。
// INV-02：发送给服务端的 rows 只能来自公开投影，绝不能直接发本地 rows（守住它：两处 buildConversationSharePublicProjection）。
// INV-03：导入的字节必须同时通过 size 与 sha256 校验，且校验在写盘之前（守住它：importShareInternal 的检查）。
// INV-04：导入幂等键同时按 (shareCode, workspace) 与 +clientRequestId 两级缓存（守住它：completedImports 两张表）。
// INV-05：预检快照必须有界并在发布终态回收，否则长驻 host 内存单调增长（守住它：set/clear 与 FIFO 上限）。
// 改错后果：跨版本内容拼接、把本地运行态发给后端被 3205 拒绝、重复导入产生双份会话、或 Host 内存泄漏。
// [权衡] 所有阶段都在同一个类里，代价是这个文件很大；收益是进度、快照、幂等三张状态表只有一个 owner。
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

import type {
  ConversationShareArtifactDescriptor,
  ConversationShareCapabilities,
  ConversationShareConfirmRequest,
  ConversationShareContinuation,
  ConversationShareRecord,
  Locale,
} from "@zcode/shared";
import {
  projectShareToolDisplay,
  decodeConversationShareRows,
  supportsConversationShareContent,
  buildConversationPreviewArtifactCandidates,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
  extractConversationPreviewFileReferences,
  type ConversationPreviewArtifactCandidate,
  localizeConversationShareUrl,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  readZCodeAttachmentFaultCode,
} from "@zcode/shared/zcode-protocol-v4";
import { Emitter } from "@zcode/rpc";

import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "#src/zcode-session/zcodeSession.js";
import { getConversationWorkspaceDir } from "#src/paths.js";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  ConversationShareServiceError,
  sanitizeConversationShareIssues,
  type IConversationShareService,
  type PublishTextConversationInput,
  type ConversationSharePublishProgress,
  type ConversationShareImportProgress,
  type ConversationShareFailureIssue,
  type ConversationSharePreflightInput,
  type ConversationSharePreflightResult,
  type ConversationShareAllowedArtifact,
  type ConversationShareTurnPreflightResult,
  type ImportConversationShareInput,
  type ImportConversationShareResult,
  type ImportedConversationShare,
} from "./conversationShare.js";
import {
  ConversationShareClientError,
  type ConversationShareHttpClient,
} from "./conversationShareHttpClient.js";
import {
  buildConversationShareArtifactSnapshot,
  getConversationSharePreviewCandidateFingerprint,
  type ConversationSharePreviewPreflightSnapshot,
} from "./conversationShareArtifactDiscovery.js";
import {
  buildConversationShareConfirmRequest,
  sha256ConversationShareJson,
} from "./conversationShareIntegrity.js";
import { materializeConversationShareInlineImages } from "./conversationShareInlineImages.js";
import { buildConversationSharePublicProjection } from "./conversationSharePublicProjection.js";
import type { ConversationShareArtifactSource } from "./conversationShareArtifactSource.js";
import { formatSharedContextV1 } from "./sharedContextFormatter.js";

import {
  collectConversationShareWorkflowSnapshot,
  isWorkflowShareFallbackRow,
  type ShareWorkflowReader,
} from "./conversationShareWorkflowSnapshot.js";

// confirm 的安全检查是非终态，必须串行轮询：间隔 5s 是服务端建议值，
// 总超时 120s 覆盖人工审核队列的常见延迟；两者都可被 options 覆盖以便测试。
const DEFAULT_CONFIRM_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CONFIRM_POLL_TIMEOUT_MS = 120_000;
// download 兜底不能是裸 fetch（无 AbortSignal/超时）：对象存储连接挂住时导入会停在
// downloading 阶段直到 undici 默认 ~300s 兜底，体验上等于卡死。120s 覆盖慢速下行的大 artifact。
// 下载超时必须显式传入 AbortSignal：不设时对象存储挂住连接会让导入停在 downloading。
const DOWNLOAD_TIMEOUT_MS = 120_000;
// 只有这三种 errno 表示「内容已不可得」，可降级为跳过；EACCES 等仍要按失败上报。
const MISSING_ARTIFACT_ERRNOS = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
// 预检快照的兜底上限：单次分享最多写入所选轮次数量的条目，200 足够覆盖正常会话，
// 又能保证长驻 host 不会因为「一直预检、从不发布」而无限增长。
// 快照表上限是兜底而不是业务约束：用户可能反复预检却从不发布，FIFO 淘汰保证内存有界。
const PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES = 200;
// 预检 stat 的并发上限：本地几乎无差别，SSH/远程 workspace 下每次 stat 都是一次
// 网络往返，串行会让「下一步」长时间停在 checking。上限保证不把远端 host 打爆。
// 并发 6 是远端 workspace 的经验折中：串行会让「下一步」长时间停在 checking，
// 再高则每次 stat 的往返会把 Host 连接池占满，反而拖慢其它请求。
const SHARE_PREFLIGHT_STAT_CONCURRENCY = 6;

// sleep 可注入，测试里用即时 resolve 避免真的等待 5s 轮询间隔。
function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * 有界并发 map，保持输出与输入同序。
 *
 * 预检的每次 stat 在 SSH/远程 workspace 下都是一次网络往返，串行会让「下一步」
 * 长时间停在 checking。并发上限存在的意义是不把远端 host 打爆；结果按下标回填，
 * 因此 issue 的产生顺序仍然是确定的（与串行实现完全一致）。
 */
// 有界并发 map：worker 数量取 min(limit, 条目数)，每个 worker 从共享游标取下一个下标。
// 结果按下标回填，因此输出顺序恒等于输入顺序，issue 的产生顺序与串行实现一致。
// 任一 run 抛错都会让 Promise.all 立即 reject，但其它 worker 仍会跑完当前条目。
async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  limit: number,
  run: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (items.length === 0) return [];
// 预分配数组并按下标写入：不用 push，因为并发完成顺序是不确定的。
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
// 每个 worker 循环领取下标直到越界；nextIndex++ 的竞态由单线程事件循环保证原子。
// [并发] 这里没有真正的锁：await 之间可能交错，但每个下标只被一个 worker 领取。
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** stat 的结果或失败原因；并发阶段只收集，分类仍在同序的第二轮里做。 */
type SettledResult<Value> = { ok: true; value: Value } | { ok: false; error: unknown };

// 把「成功值 / 失败原因」显式建模：并发阶段先收集，分类留到同序的第二轮，
// 避免在 worker 里写 issue 导致顺序不确定。
async function settle<Value>(run: () => Promise<Value>): Promise<SettledResult<Value>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

// 只认 artifact_read_failed + 白名单 errno 两项同时成立：单看 errno 会把其它阶段的
// ENOENT（例如落盘写入）也当成「文件不存在」而静默跳过。
function isMissingArtifactReadError(error: unknown): boolean {
  return (
    error instanceof ConversationShareServiceError &&
    error.reasonCode === "artifact_read_failed" &&
    typeof error.diagnostics?.errno === "string" &&
    MISSING_ARTIFACT_ERRNOS.has(error.diagnostics.errno)
  );
}

// 文件名/目录名净化：先 NFKC 归一（全角冒号也会被转成半角），再替换保留字符与控制字符。
// 用于 share_id 生成的目录名，必须保证在不同平台上都能创建。
// 替换为 - 而不是删除，避免两个不同 id 净化后撞成同一个目录名。
function sanitizeFileSegment(value: string): string {
  const forbidden = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  return [...value.normalize("NFKC")]
    .map((character) =>
      character.codePointAt(0)! < 32 || forbidden.has(character) ? "-" : character,
    )
    .join("");
}

// 导入文件名去重：先取 basename、净化、去掉首尾点与空格、截断 180 字符；
// 重名时在扩展名之前插入 artifactId 的 8 位后缀，保持扩展名仍可被识别。
// usedNames 用 lowerCase 记录，因为大小写不敏感文件系统上 A.png 与 a.png 是同一文件。
// 兜底名 artifact 保证极端输入（全非法字符）也能落盘。
function uniqueImportedFileName(
  displayName: string,
  artifactId: string,
  usedNames: Set<string>,
): string {
  const base =
    sanitizeFileSegment(basename(displayName.replace(/\\/gu, "/")))
      .replace(/^[. ]+|[. ]+$/gu, "")
      .slice(0, 180) || "artifact";
  let candidate = base;
  if (usedNames.has(candidate.toLowerCase())) {
    const dot = base.lastIndexOf(".");
    const suffix = artifactId.replace(/[^A-Za-z0-9]/gu, "").slice(-8) || "artifact";
    candidate = dot > 0 ? `${base.slice(0, dot)}-${suffix}${base.slice(dot)}` : `${base}-${suffix}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

// 所有外部依赖（时钟、sleep、download、session service）都可注入，
// 这样轮询超时、网络失败、会话创建都能在单测里可控地复现。
// zcodeSessionService 是可选的：只读预览场景不需要导入能力。
export interface ConversationShareServiceOptions {
  zcodeAgentService: ConversationShareAgentService;
  client: ConversationShareHttpClient;
  artifactSource: ConversationShareArtifactSource;
  confirmPollIntervalMs?: number;
  confirmPollTimeoutMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  zcodeSessionService?: Pick<IZCodeSessionService, "createSession" | "listSessions">;
  download?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** 单个 artifact 下载的超时（含读 body）；缺省 120s。 */
  downloadTimeoutMs?: number;
  conversationWorkspaceRoot?: string;
  /** 只由 Desktop Host 注入的 canonical share 页面根地址。 */
  shareWebUrl?: string;
  logger?: ServiceLogger;
}

// 组合「工作流读取」与四个 V4 查询：前者由 workflow snapshot 定义，后者是本层直接依赖。
type ConversationShareAgentService = ShareWorkflowReader &
  Pick<
    IZCodeAgentService,
    | "conversationRowsRangeV4"
    | "conversationFileChangesV4"
    | "conversationAttachmentReadV4"
    | "conversationAttachmentStatV4"
  >;

/** Symbol method 不可由 string-command ProxyChannel 调用，仅供 Desktop Host attachment 装配。 */
export const conversationShareConnectionScopeFactory = Symbol(
  "conversationShareConnectionScopeFactory",
);

// 这三个协议错误表示「Host attachment 身份还没就绪」，对用户是可重试的连接问题，
// 而不是内容或服务端故障，因此单独归一成 connection_unavailable。
const CONNECTION_UNAVAILABLE_ERRORS = new Set([
  "fault.conversation.rowsRangeConnectionUntrusted",
  "fault.connection.handshakeRequired",
  "fault.connection.closed",
]);

// 只按错误 message 判断（这些码由 ProxyChannel 以字符串抛出，没有类型信息）；
// 不匹配的原样返回，保留原始错误类型供上层分类。
function normalizeConversationShareConnectionError(error: unknown): unknown {
  if (error instanceof Error && CONNECTION_UNAVAILABLE_ERRORS.has(error.message)) {
    return new ConversationShareServiceError(
      "connection_unavailable",
      "Conversation share connection is not ready",
    );
  }
  return error;
}

// 幂等键的 workspace 部分：优先用 identity（远端可稳定表达），其次路径，
// 都缺省时用固定哨兵，表示「默认 conversation workspace」。
// 不能用空串，否则与「显式空 identity」无法区分。
function workspaceKeyOf(path: string | undefined, identity: string | undefined): string {
  return identity?.trim() || path?.trim() || "__default_conversation_workspace__";
}

// 用 NUL 分隔两段：shareCode 与 workspaceKey 都可能含常见分隔符，
// NUL 不会出现在任何一段里，因此拼接无歧义。
function importDedupeKey(shareCode: string, workspaceKey: string): string {
  return `${shareCode}\u0000${workspaceKey}`;
}

// 预检快照的键：workspace + remoteSession + session + productTurn 四段。
// 带上 remoteSessionId 是因为同一 workspace 下可能有多个远端会话；
// 不带 selection/accessMode，因为快照只描述「这一轮可见的候选」，与发布参数无关。
function previewPreflightKey(
  input: Pick<
    PublishTextConversationInput | ConversationSharePreflightInput,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
  >,
  productTurnId: string,
): string {
  return [
    workspaceKeyOf(input.workspacePath, input.workspaceIdentity),
    input.remoteSessionId ?? "",
    input.sessionId,
    productTurnId,
  ].join("\u0000");
}

/**
 * 导入会话的标题前缀。services 层没有 intl，这里只维护一份最小映射；
 * 前缀在导入时定型并持久化为 session.title（titleSource: "custom"），之后切界面语言不再改写。
 */
const IMPORTED_SHARE_TITLE_PREFIX: Readonly<Record<Locale, string>> = {
  "zh-CN": "来自分享：",
  "en-US": "From Share: ",
};

// 标题前缀在导入时定型并持久化，之后切换界面语言不会改写历史会话标题。
function formatImportedShareSessionTitle(shareTitle: string, locale: Locale | undefined): string {
  return `${IMPORTED_SHARE_TITLE_PREFIX[locale ?? "zh-CN"]}${shareTitle.trim()}`;
}

// 只改写 URL 站点，其它字段原样返回；URL 形状不认识时返回原对象，不构造新对象。
function localizePublishedShare(
  share: ConversationShareRecord,
  locale: Locale | undefined,
): ConversationShareRecord {
  if (!locale) return share;
  const shareUrl = localizeConversationShareUrl(share.share_url, locale);
  return shareUrl === share.share_url ? share : { ...share, share_url: shareUrl };
}

/** 本端产出的只读副本格式版本；与 wire 的 schema_version 各自独立演进。 */
// IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION 只描述本地落盘格式，不跟随 wire 协议升级。
const IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION = 1;

/**
 * 落盘的只读副本形状；来自磁盘，渲染前必须校验。
 *
 * formatVersion 与 rows 都刻意宽容：用户在新版导入过会话后回退到旧版时，只读块应该尽量
 * 显示出来（认不出的行跳过 + 顶部软提示），而不是整块静默消失让人以为内容丢了。
 */
// 磁盘内容属于跨存储边界，渲染前必须过 schema；rows/content_blocks 刻意用 unknown 数组，
// 让「新版写入、旧版读取」时按行降级而不是整块失败。
// .strip() 丢弃未知顶层字段，避免把未来字段带进渲染层。
const importedConversationShareFileSchema = z
  .object({
    formatVersion: z.number().int().positive(),
    shareId: z.string().trim().min(1),
    contextId: z.string().trim().min(1),
    title: z.string(),
    rows: z.array(z.unknown()),
    content_blocks: z.array(z.unknown()).optional(),
    artifacts: z.array(
      z.object({
        artifactId: z.string().trim().min(1),
        displayName: z.string(),
        mimeType: z.string().optional(),
        workspaceRelativePath: z.string().optional(),
      }),
    ),
  })
  .strip();

interface ConversationRowsRead {
  rows: ConversationRow[];
  revision: number;
  logEpoch: string;
}

// 轮序号按 turnHeader 出现顺序从 1 递增，重复的 productTurn 只记第一次：
// 同一轮可能有多个 header（异常数据），取首个才能与 UI 的展示顺序一致。
function turnOrdinalByProductTurn(rows: readonly ConversationRow[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.productTurnId || result.has(row.productTurnId)) continue;
    result.set(row.productTurnId, result.size + 1);
  }
  return result;
}

function rowTurnOrdinal(row: ConversationRow, ordinals: Map<string, number>): number | undefined {
  return row.productTurnId ? ordinals.get(row.productTurnId) : undefined;
}

// data: 与 file: 是本地/内联资源，公开载荷里出现即意味着泄漏或未投影；
// 键名为 ref 的字段跳过：attachment 的 ref 合法性由 artifact 协议检查单独负责。
// 递归只看数组与对象，标量不是字符串就返回 false。
function hasUnsafeShareString(value: unknown): boolean {
  if (typeof value === "string") return /^(?:data|file):/iu.test(value);
  if (Array.isArray(value)) return value.some(hasUnsafeShareString);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === "ref" ? false : hasUnsafeShareString(entry),
  );
}

// zcode-artifact:// 引用表示「本机授权读取」，出现在公开 rows 里说明协议未就绪。
function hasUnsupportedArtifactReference(value: unknown): boolean {
  if (typeof value === "string") return /^zcode-artifact:\/\//iu.test(value);
  if (Array.isArray(value)) return value.some(hasUnsupportedArtifactReference);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === "ref" ? false : hasUnsupportedArtifactReference(entry),
  );
}

/**
 * V1 公开投影承载不了的已定稿内部结构静默移除：删掉不能公开的字段或整行，保留该轮其余
 * 内容，让发布不再被整体打死，也不把内部渲染结构暴露成用户错误。
 *
 * 只降级「已定稿但无法承载」的内容；运行中的轮次/行/工具/子代理仍由
 * collectShareStructureIssues 阻断 —— 那些内容尚未定稿，跳过等于分享半成品。
 */
// 预清洗：把「公开格式无法承载」的已定稿结构删字段或丢行，并产出非阻断提示。
// 顺序是先 sanitize 再 removeIndependentArtifactRows：artifact 行需要先被识别，
// 才能在其引用被删除时一起移除，避免留下悬空引用。
// 运行中的结构不在这里处理：它们会由 collectShareStructureIssues 拦成阻断错误，
// 因为「正在写入的内容」不能靠删字段表达。
// [权衡] 返回新数组但行对象尽量复用，只有被改动的行才复制。
function sanitizeUnsupportedShareStructures(rows: readonly ConversationRow[]): ConversationRow[] {
  const sanitized: ConversationRow[] = [];
  for (const row of rows) {
    if (row.kind === "timelineMarker") {
      // 运行中的 marker 留着，让 collectShareStructureIssues 照旧阻断——内容尚未定稿。
      // 被阻断的发布不会进入投影，保留该 marker 无副作用。
// 运行中的 marker 与 streaming 正文要区分：前者可能是长任务的状态标记，
// 后者是明确的未完成文本，处理方式不同。
      const markerRunning =
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running");
      if (markerRunning) {
        sanitized.push(row);
        continue;
      }
      if (
        row.marker.type === "forkNotice" ||
        row.marker.type === "forkCreated" ||
        row.marker.type === "checkpointRestored"
      ) {
        // 分支/回滚 marker 只携带本地会话关系，公开页本来就不渲染；直接移除，不能把
        // 内部时间线结构计入“文件被跳过”或打扰用户。
        continue;
      }
      // 其余 marker 静默剥掉，不打扰分享者：
      // - compact（上下文已压缩）纯运行时记账，对只读读者没有价值；而且它的 lane 是
      //   assistantWork，留在 flow 尾部会顶掉「最终正文」折叠锚点，让整轮过程默认展开
      //   （conversationTurnWorkSegments.ts 的 assistantHistoryDefaultOpen）——这是它必须走的主因。
      // - goalVerify / goalSet / retryNotice 在分享页本来就不渲染，纯占位吃 max_rows 配额。
      // - modelChange 只能显示一句泛化的「模型已切换」，信息量低且暴露内部切模型行为。
      continue;
    }
// 计划模式工具的输出含本地计划文件路径与交互句柄，公开格式没有对应结构，整行丢弃。
// 它不是错误而是「不可分享内容」，因此只记 content_unavailable 提示。
    if (row.kind === "toolCall" && row.toolName === "EnterPlanMode") {
      // EnterPlanMode 只是内部模式切换边界，渲染层（isVisibleAssistantWorkRow）本来就过滤掉，
      // 但它仍会进 payload 白吃 max_rows / max_payload_bytes 配额，永远不显示。
      continue;
    }
    sanitized.push(row);
  }
  return sanitized;
}

// 产物级清洗：能力不支持的 artifact 行整行移除，并给出类型级提示。
// 必须在公开投影之前执行，否则投影会因为未知 artifactType 直接失败，
// 导致一个不支持的产物毁掉整次分享。
// originalRows 用于回查该行的轮次与序号，让提示能定位到具体位置。
function sanitizeUnsupportedShareArtifacts(
  rows: readonly ConversationRow[],
  capabilities: ConversationShareCapabilities,
  ordinalRows: readonly ConversationRow[],
): { rows: ConversationRow[]; warnings: ConversationShareFailureIssue[] } {
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
  const warnings: ConversationShareFailureIssue[] = [];
// 只过滤 artifact 行，其余行原样保留：这一步不做投影，
// 因此不能顺手删掉别的行类型，否则会在提示里丢失「被跳过」的位置信息。
  const retained = rows.filter((row) => {
    if (row.kind !== "artifact") return true;
    const extension = fileExtension(row.displayName);
    const mimeType = normalizedMimeType(row.mimeType);
// 三项同时匹配（type + 扩展名 + mime）：只匹配 type 会把不同格式误判为可分享。
    const allowed = capabilities.allowed_artifacts.find(
      (candidate) =>
        candidate.type === row.artifactType &&
        candidate.extensions.some(
          (value) => value.replace(/^\./u, "").toLowerCase() === extension,
        ) &&
        candidate.mime_types.some((value) => value.toLowerCase() === mimeType),
    );
// 命中即保留，不复制行对象：后续投影会重建公开行，这里只需决定去留。
    if (allowed) return true;
    warnings.push({
      code: "artifact_type_not_allowed",
      scope: "artifact",
      rowId: row.rowId,
      ...(row.productTurnId && ordinals.has(row.productTurnId)
        ? { turnOrdinal: ordinals.get(row.productTurnId) }
        : {}),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
      artifactDisplayName: row.displayName,
      artifactType: row.artifactType,
      ...(extension ? { extension } : {}),
      mimeType,
      allowedFormats: allowedFormatLabels(capabilities),
      allowedArtifacts: allowedArtifactSummaries(capabilities),
    });
    return false;
  });
  return { rows: retained, warnings };
}

// collectShareStructureIssues 一次性收集所有阻断问题，不遇到第一个就抛。
// 这样 UI 能提示「第 3 轮有运行中的工具、第 5 轮有本地引用」，
// 用户可以直接取消那几轮，而不是反复试错。
// 返回的 issue 已带 turnOrdinal/rowId，且不含任何值内容。
function collectShareStructureIssues(
  rows: readonly ConversationRow[],
  ordinalRows: readonly ConversationRow[] = rows,
): ConversationShareFailureIssue[] {
  const issues: ConversationShareFailureIssue[] = [];
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
// 统一由 add 补齐定位字段：missing_product_turn 的行没有 productTurnId，
// 因此用可选展开，而不是强行写 undefined。
// 去重键是 rowId + code，同一行同一原因只报一次。
  const add = (row: ConversationRow, code: ConversationShareFailureIssue["code"]) => {
    issues.push({
      code,
      scope: code === "missing_product_turn" ? "conversation" : "turn",
      ...(row.rowId === undefined ? {} : { rowId: row.rowId }),
      ...(rowTurnOrdinal(row, ordinals) === undefined
        ? {}
        : { turnOrdinal: rowTurnOrdinal(row, ordinals) }),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
    });
  };
  for (const row of rows) {
// 缺轮次归属的行无法投影，也不能靠用户取消某一轮解决，属于数据问题。
    if (!row.productTurnId) add(row, "missing_product_turn");
// 运行中的轮次和工具/子代理分开报，UI 才能分别给出「等待完成」与「取消该轮」。
    if (row.kind === "turnHeader" && row.state === "running") add(row, "running_turn");
    if ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") {
      add(row, "streaming_row");
    }
    if (
      row.kind === "toolCall" &&
      (row.status === "inputStreaming" ||
        row.status === "pendingApproval" ||
        row.status === "running")
    ) {
      add(row, "active_tool_call");
    }
// 子代理运行中同样阻断：它的上下文仍在增长，分享出去只会是半截内容。
    if (row.kind === "subagent" && row.status === "running") add(row, "active_subagent");
    if (row.kind === "timelineMarker") {
      // 只有「运行中」的时间线操作仍阻断；fork/checkpoint/compact summaryRef 已由
      // sanitizeUnsupportedShareStructures 降级为跳过。
      if (
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")
      ) {
        add(row, "unsupported_timeline");
      }
    }
// 本地/内联引用是硬阻断：它意味着该行含本机可读资源，无法在公开页表达。
// 若同时存在 artifact 协议引用，会单独归为 artifact_protocol_not_ready，优先级更高。
    if (hasUnsafeShareString(row)) add(row, "unsafe_url");
    if (hasUnsupportedArtifactReference(row)) add(row, "artifact_protocol_not_ready");
  }
  return issues;
}

// 给 UI 的「支持哪些格式」标签，去重后排序，保证同一能力集合在不同调用点文案一致。
function allowedFormatLabels(capabilities: ConversationShareCapabilities): string[] {
  return capabilities.allowed_artifacts.flatMap((allowed) =>
    allowed.extensions.map(
      (extension) => `${allowed.type.toUpperCase()} (.${extension.replace(/^\./u, "")})`,
    ),
  );
}

// 结构化能力摘要用于前端渲染表格；只暴露展示字段，不含内部限制细节。
function allowedArtifactSummaries(
  capabilities: ConversationShareCapabilities,
): ConversationShareAllowedArtifact[] {
  return capabilities.allowed_artifacts.map((allowed) => ({
    type: allowed.type,
    extensions: [...allowed.extensions],
    mimeTypes: [...allowed.mime_types],
  }));
}

// 能力指纹参与预检快照比对：能力变化（例如服务端下调单文件上限）
// 会让用户此前看到的「可分享」不再成立，必须要求重新确认。
// 用 JSON.stringify 而非哈希：只需要同进程内相等比较。
function capabilitiesFingerprint(capabilities: ConversationShareCapabilities): string {
  return createHash("sha256").update(JSON.stringify(capabilities)).digest("hex");
}

// 与公共投影里的 extensionOf 不同：这里允许「未知」，返回 undefined 表示无法推断，
// 调用方据此决定是走 mime 还是直接判不支持。
function fileExtension(fileName: string): string | undefined {
  const baseName = fileName.replace(/\\/gu, "/").split("/").at(-1) ?? fileName;
  const dot = baseName.lastIndexOf(".");
  return dot > 0 && dot < baseName.length - 1 ? baseName.slice(dot + 1).toLowerCase() : undefined;
}

// 去掉参数并小写，才能与能力列表做精确比较；空值回退 text/plain。
function normalizedMimeType(mime: string): string {
  return mime.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

// 附件展示名取 basename：原始 fileName 可能带目录，直接展示会暴露本地路径结构。
function attachmentDisplayName(fileName: string): string {
  return basename(fileName.replace(/\\/gu, "/")) || "附件";
}

// 预检阶段的类型判定，返回能力项而不是布尔值，便于把 type 写进 issue 的 allowedArtifacts。
// 判定顺序与 manifest 校验保持一致，避免「预检说可以、发布时被拒」。
function allowedArtifactFor(
  capabilities: ConversationShareCapabilities,
  extension: string | undefined,
  mimeType: string,
) {
  if (!extension) return undefined;
  return capabilities.allowed_artifacts.find(
    (allowed) =>
      allowed.extensions.some((value) => value.replace(/^\./u, "").toLowerCase() === extension) &&
      allowed.mime_types.some((value) => value.toLowerCase() === mimeType),
  );
}

/**
 * 附件错误分类统一走协议侧稳定 fault 码（见 attachment-faults.ts）。
 *
 * 不能按 `error.message` 正则分类：RPC 包装/schema 校验一变就失效——
 * 超大附件的 ZodError 曾因此被误判成「未知」并降级成 deferred，静默丢内容。
 * 仅在 fault 码缺席时保留一条 errno 文本兜底，用于尚未带结构化码的旧 zcode-cli。
 */
// 「确定不存在」才允许降级：只有明确 not_found 的 faultCode，
// 未知错误必须按阻断处理，否则会把「读取失败」误报成「文件已删除」。
// 这类降级会进入 warning，用户仍可继续发布。
function isDefiniteMissingAttachment(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.statNotFile
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|not found|not_found|statNotFile|is_directory/iu.test(message);
}

// 授权失败说明连接身份不可信（或协议未就绪），必须阻断并要求重新连接。
function isAttachmentAuthorizationError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /shareStatNotAuthorized|shareReadNotAuthorized|connectionUntrusted/iu.test(message);
}

/** 附件体积超出协议/通道可承载范围：选择阶段就应作为确定阻断呈现。 */
// 容量超限是确定阻断：用户必须移除该附件或改选更小的内容。
function isAttachmentTooLargeError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  return (
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge ||
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge
  );
}

// 把聚合结果拆回「每轮一行」：UI 的取消选择是按轮操作的，
// 因此每轮需要自己的 ok / issue 列表与 rowBudget。
// 没有问题的轮次也要出现（ok=true），让 UI 明确知道该轮可分享。
// selectedTurnIds 保证顺序与用户选择一致，而不是按发现顺序。
function buildTurnPreflightResults(
  productTurnIds: readonly string[],
  turnOrdinalByProductTurnId: ReadonlyMap<string, number>,
  blockingIssues: readonly ConversationShareFailureIssue[],
  skippableWarnings: readonly ConversationShareFailureIssue[],
  deferredIssues: readonly ConversationShareFailureIssue[],
): ConversationShareTurnPreflightResult[] {
  return productTurnIds.map((productTurnId) => {
    const turnOrdinal = turnOrdinalByProductTurnId.get(productTurnId);
// 归属规则：有 turnOrdinal 的按轮精确匹配；没有轮次/行/文件定位信息的
// conversation 级问题（例如整份会话的 rows_limit）挂到每一轮，
// 否则 UI 选中任意一轮时都看不到这条阻断，会以为可以继续。
    const forTurn = (issues: readonly ConversationShareFailureIssue[]) =>
      issues.filter(
        (issue) =>
          issue.turnOrdinal === turnOrdinal ||
          (issue.turnOrdinal === undefined &&
            issue.rowId === undefined &&
            issue.artifactDisplayName === undefined &&
            (issue.scope === "conversation" || issue.scope === "transport")),
      );
    return {
      productTurnId,
      blockingIssues: forTurn(blockingIssues),
      skippableWarnings: forTurn(skippableWarnings),
      deferredIssues: forTurn(deferredIssues),
    };
  });
}

// 独立的 artifact 行（不是由工具行派生的）在公开投影里没有可引用的宿主，
// 会被识别为悬空引用，因此在清洗阶段移除。
function removeIndependentArtifactRows(rows: readonly ConversationRow[]): ConversationRow[] {
  // 文件候选来自用户输入附件和最终可见的 Assistant 预览卡片；内嵌图片随后独立转换。历史 artifact row
  // 若没有对应预览卡片，不再作为第三条独立发现来源进入公开 projection。
  return rows.filter((row) => row.kind !== "artifact");
}

// 便捷构造器：只给 kind 与 message，其余诊断由调用方补，避免重复写 new。
function throwServiceError(
  kind: ConstructorParameters<typeof ConversationShareServiceError>[0],
  message: string,
): never {
  throw new ConversationShareServiceError(kind, message);
}

// 选择解析：三种粒度（all / productTurns / rowAnchors）统一归一成 productTurn 集合 + 有序行。
// rowAnchors 会扩展到整轮：分享协议以轮为最小单位，半轮内容无法保证引用闭包。
// 返回的 rows 保持原始 rowId 升序，后续所有阶段都依赖这个顺序。
// [失败路径] 空选择直接失败，避免生成一份「空分享」。
function selectRows(
  rows: ConversationRow[],
  selection: PublishTextConversationInput["selection"],
): { rows: ConversationRow[]; productTurnIds: string[] } {
  let selectedProductTurnIds: Set<string>;
  if (selection.kind === "all") {
    selectedProductTurnIds = new Set(
      rows
        .filter((row) => row.kind === "turnHeader")
        .map((row) => row.productTurnId)
        .filter((value): value is string => value !== undefined),
    );
  } else if (selection.kind === "productTurns") {
    if (selection.productTurnIds.length === 0) {
      throwServiceError("invalid_selection", "At least one product turn must be selected");
    }
// 用 Set 做成员判断，避免每行都线性查选择列表。
    selectedProductTurnIds = new Set(selection.productTurnIds);
  } else {
    if (selection.rowIds.length === 0) {
      throwServiceError("invalid_selection", "At least one conversation row must be selected");
    }
// 按 rowId 建索引以便 rowAnchors 快速定位；缺行说明锚点已过期，直接失败。
// 不能用下标：rowId 是全局序号，与数组下标并不相同。
// 索引只用于把用户点选的行锚点映射回轮次；它不参与输出顺序，
// 输出顺序始终由 rows 的原始遍历决定。
    const rowsById = new Map(rows.map((row) => [row.rowId, row]));
    selectedProductTurnIds = new Set<string>();
    for (const rowId of new Set(selection.rowIds)) {
      const row = rowsById.get(rowId);
      if (!row?.productTurnId) {
        throwServiceError("invalid_selection", "A selected row no longer exists");
      }
      selectedProductTurnIds.add(row.productTurnId);
    }
  }

// orderedProductTurnIds 记录「首次出现顺序」：返回给服务端的 ID 顺序会影响
// 分享页的轮次排列，必须与用户在会话里看到的一致。
// 尾部再补上选择了但没有任何行的轮次，保证选择列表完整。
// 这里同时统计每个轮的 header 数量：一个 productTurn 出现两个 header 属于
// 异常数据，无法确定该用哪一个作为分享的轮边界，因此下面直接判选择无效。
  const orderedProductTurnIds: string[] = [];
  const headerCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.productTurnId) continue;
    headerCounts.set(row.productTurnId, (headerCounts.get(row.productTurnId) ?? 0) + 1);
    if (selectedProductTurnIds.has(row.productTurnId)) {
      orderedProductTurnIds.push(row.productTurnId);
    }
  }
  if (
    orderedProductTurnIds.length === 0 ||
    orderedProductTurnIds.length !== selectedProductTurnIds.size ||
    orderedProductTurnIds.some((productTurnId) => headerCounts.get(productTurnId) !== 1)
  ) {
    throwServiceError("invalid_selection", "Selected product turns are incomplete or ambiguous");
  }

// turnId 是行的轮次归属，与 productTurnId 并存：旧数据可能只有 turnId，
// 用它在下面兜底保留这些行，让投影阶段显式报「缺 productTurnId」，
// 而不是在过滤阶段静默丢行、发布一份看起来正常的残缺会话。
  const selectedTurnIds = new Set(
    rows
      .filter(
        (row) =>
          row.kind === "turnHeader" &&
          row.productTurnId !== undefined &&
          selectedProductTurnIds.has(row.productTurnId),
      )
      .map((row) => row.turnId),
  );

  return {
    productTurnIds: orderedProductTurnIds,
    // 旧投影可能缺 productTurnId；只要 turnId 落在已选轮次也必须保留，让校验显式拒绝，
    // 不能在过滤时静默丢行后发布一份不完整会话。
    rows: rows.filter(
      (row) =>
        (row.productTurnId !== undefined && selectedProductTurnIds.has(row.productTurnId)) ||
        (row.productTurnId === undefined && selectedTurnIds.has(row.turnId)),
    ),
  };
}

// 服务实例的生命周期与 Host 进程一致，因此所有 Map 字段都必须自带回收策略，
// 不能依赖「调用方用完会清理」。
// 依赖全部构造注入：业务代码不读全局配置，测试与远端 facade 可以完整替换传输层。
// [并发] 同一个实例可能被多个 operationId 并发驱动，各阶段状态都按 operationId 分键。
// 唯一的跨 operation 共享状态是 completedImports（幂等表），它按 share+workspace 聚合，
// 这正是「同一分享在不同客户端请求下只导入一次」的语义来源。
// 注意：publishPhases 只用于失败日志定位，不参与业务判断。
export class ConversationShareService implements IConversationShareService {
  private readonly zcodeAgentService: ConversationShareAgentService;
// HTTP 客户端与 artifactSource 分别负责「远端协议」与「本地/远端文件读取」，
// 两者不互相调用：上传字节永远来自 artifactSource，协议细节永远在 client 内。
  private readonly client: ConversationShareHttpClient;
  private readonly artifactSource: ConversationShareArtifactSource;
  private readonly confirmPollIntervalMs: number;
  private readonly confirmPollTimeoutMs: number;
// 时钟与 sleep 一并注入：超时、重试间隔、marker 的 createdAt 都用同一个时钟，
// 测试里推进「虚拟时间」就能覆盖 120s 轮询，而不必真的等待。
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
// emitter 按 operationId 惰性创建，并在最后一个监听者移除时自毁：
// 这样「订阅—取消」多次也不会在长驻 Host 里累积空 emitter。
// [资源] onDidRemoveLastListener 里同时 delete 与 dispose，顺序不能反。
  private readonly progressEmitters = new Map<string, Emitter<ConversationSharePublishProgress>>();
  private readonly importProgressEmitters = new Map<
    string,
    Emitter<ConversationShareImportProgress>
  >();
// 只依赖两个方法：创建导入会话与列出会话做恢复；不注入整个 session service，
// 以免本模块意外获得删除/改名等破坏性能力。
  private readonly zcodeSessionService?: Pick<
    IZCodeSessionService,
    "createSession" | "listSessions"
  >;
// download 是注入点：单测用它模拟挂起、超时、超大 Content-Length，无需真实网络。
  private readonly download: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
// 单产物下载超时独立于 confirm 超时：前者是带宽问题，后者是审核队列问题，
// 合并成一个参数会让两类故障互相牵制。
  private readonly downloadTimeoutMs: number;
  private readonly conversationWorkspaceRoot: string;
  private readonly shareWebUrl: string;
// 索引固定落在 conversation workspace 根目录，而不是 .zcode-share 内部：
// 后者会被失败清理逻辑按 importRoot 删除，索引必须独立于单次导入的目录。
  private readonly importIndexPath: string;
  private readonly logger: ServiceLogger;
  private readonly publishPhases = new Map<string, ConversationSharePublishProgress["phase"]>();
  // 选择阶段与发布阶段共享“最终可见卡片”边界；发布仍会重新 stat/read，但不会重新
  // 纳入选择阶段已经因缺失而被 UI 隐藏的候选。
  //
  // 生命周期：desktop host 是长驻进程，这张表原来只在 stat 未 settle 时删单条，
  // 会随使用时长单调增长。现在有两道回收：发布终态按 session 前缀清理，
  // 以及 set 时的 FIFO 上限兜底（覆盖用户中途放弃分享、永远不发布的路径）。
  private readonly previewPreflightSnapshots = new Map<
    string,
    ConversationSharePreviewPreflightSnapshot
  >();
// 两张已完成表：精确键（share+workspace+clientRequestId）保证重放同一请求返回同一结果，
// 宽键（share+workspace）保证换一个 clientRequestId 也不会重复导入。
// 宽键命中时同样返回 reused=true，但保留首次的 sessionId。
  private readonly completedImports = new Map<string, ImportConversationShareResult>();
  private readonly completedImportsByWorkspace = new Map<string, ImportConversationShareResult>();
// 进行中表存的是 Promise 而不是锁：后到的同键请求直接 await 同一个 Promise，
// 因此不会出现两次下载、两次建会话。
// 精确键与宽键都要登记，宽键用于跨请求去重。
  private readonly inFlightImports = new Map<string, Promise<ImportConversationShareResult>>();
  private readonly inFlightImportsByWorkspace = new Map<
    string,
    Promise<ImportConversationShareResult>
  >();
// 磁盘索引异步加载，用 definite assignment 声明：构造函数里同步启动、异步完成，
// 任何读写幂等表的方法都必须先 await 它，否则会看到空表并把已导入的分享再导入一次。
  private completedImportsLoaded!: Promise<void>;
// 写链条只用于串行化落盘：初始是已 resolve 的 Promise，
// 因此第一次 persist 不会被前序失败阻塞（见 persistCompletedImportIndex 的注释）。
  private importIndexWriteChain: Promise<void> = Promise.resolve();

// 所有可选依赖都在这里兜底：轮询参数、时钟、sleep、下载实现、workspace root、日志。
// 兜底值必须与生产语义一致（Date.now / 全局 fetch / 真实目录），否则测试通过而线上异常。
  constructor(options: ConversationShareServiceOptions) {
    this.zcodeAgentService = options.zcodeAgentService;
    this.client = options.client;
    this.artifactSource = options.artifactSource;
    this.confirmPollIntervalMs = options.confirmPollIntervalMs ?? DEFAULT_CONFIRM_POLL_INTERVAL_MS;
    this.confirmPollTimeoutMs = options.confirmPollTimeoutMs ?? DEFAULT_CONFIRM_POLL_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? wait;
    this.zcodeSessionService = options.zcodeSessionService;
    this.download = options.download ?? ((url, init) => fetch(url, { signal: init?.signal }));
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    this.conversationWorkspaceRoot =
      options.conversationWorkspaceRoot ?? getConversationWorkspaceDir();
    // 兜底写死生产站 https://zcode.z.ai/cn/share，于是测试环境（API base 走
    // 配置的 ZCode origin）导入后回链仍指向生产站，点分割线打开的是另一个环境的分享。
    // 改用与 API base 同一个环境解析器（buildRuntimeZCodeApiUrl 也走它），保证同环境。
    // 优先级不变：显式 option > ZCODE_CONVERSATION_SHARE_WEB_URL > 按环境推导。
// 分享站地址必须与 API 同环境：写死生产站会让测试环境的分享回链跳到生产，
// 用户点开看到的是另一个环境的页面。末尾斜杠统一去掉，拼接时才不会出双斜杠。
    this.shareWebUrl = (
      options.shareWebUrl ??
      process.env.ZCODE_CONVERSATION_SHARE_WEB_URL ??
      `${resolveRuntimeZCodeEndpointOrigin(process.env)}/cn/share`
    ).replace(/\/+$/u, "");
    this.importIndexPath = join(this.conversationWorkspaceRoot, ".zcode-share-imports.json");
    this.logger = options.logger ?? createServiceLogger("conversation-share");
// 构造函数里不 await：加载失败不能让服务创建失败。
// 但加载完成前完成的导入不会被写回，因此 load 内部对坏条目逐条跳过而不是整体放弃。
    this.completedImportsLoaded = this.loadCompletedImportIndex();
    if (this.zcodeSessionService) {
// 启动期清理孤儿导入目录：不 await，避免拖慢 Host 启动；失败只影响磁盘清理，
// 不能影响任何业务可用性。
      void this.cleanupAbandonedImports().catch(() => undefined);
    }
  }

// 能力查询完全转发给 client：本层不缓存，因为服务端可能随时调整上限或开关。
// 每次调用都打到服务端（client 侧自带缓存策略），本层不做二次缓存：
// 能力直接影响「能不能发布」，拿到过期上限会让用户在服务端拒绝后反复重试。
  getCapabilities() {
    return this.client.getCapabilities();
  }

  /** 写入预检快照，并在超过上限时按插入序淘汰最旧条目（Map 保持插入序）。 */
// 先删后插让重写的 key 回到插入序末尾，淘汰逻辑才等价于 LRU 而不是「最早创建」。
// [资源] 上限兜底覆盖「预检后放弃发布」的路径，否则这张表只会随使用时长增长。
  private setPreviewPreflightSnapshot(
    key: string,
    snapshot: ConversationSharePreviewPreflightSnapshot,
  ): void {
    // 重新写同一 key 时先删再插，让它回到插入序末尾，淘汰才是真正的「最久未更新」。
    this.previewPreflightSnapshots.delete(key);
    this.previewPreflightSnapshots.set(key, snapshot);
    while (this.previewPreflightSnapshots.size > PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES) {
      const oldestKey = this.previewPreflightSnapshots.keys().next().value;
      if (oldestKey === undefined) break;
      this.previewPreflightSnapshots.delete(oldestKey);
    }
  }

  /** 分享结束后回收该 workspace+session 的全部预检快照。 */
  private clearPreviewPreflightSnapshots(
    input: Pick<
      PublishTextConversationInput | ConversationSharePreflightInput,
      "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
    >,
  ): void {
// 键是 workspace\0remoteSession\0session\0productTurn 四段，末段传空串
// 恰好得到「该会话下所有轮次」的公共前缀，无需解析键结构。
// 只按会话维度清理，避免影响同一 Host 上其它会话的预检快照。
    const prefix = previewPreflightKey(input, "");
    for (const key of this.previewPreflightSnapshots.keys()) {
      if (key.startsWith(prefix)) this.previewPreflightSnapshots.delete(key);
    }
  }

// 对外预检入口只做连接错误归一：预检本身不写任何远端状态，可安全重试。
  async preflight(
    input: ConversationSharePreflightInput,
  ): Promise<ConversationSharePreflightResult> {
    try {
      return await this.preflightWithAgent(input, this.zcodeAgentService);
    } catch (error) {
      throw normalizeConversationShareConnectionError(error);
    }
  }

// 预检与发布共享同一套清洗/物化/发现流程，差别只有两处：
// 1) workflow snapshot 带 preflight=true，不下载产物字节；
// 2) 结果按 blocking / skippable / deferred 三类返回，而不是直接抛错。
// 三类语义：blocking 必须用户处理；skippable 会自动降级；deferred 是「现在读不到但可能稍后能读」。
// [失败路径] 选择解析失败被转为 blockingIssue 而不是抛错，让 UI 仍能展示其它可选项。
  private async preflightWithAgent(
    input: ConversationSharePreflightInput,
    agentService: ConversationShareAgentService,
  ): Promise<ConversationSharePreflightResult> {
    const capabilities = await this.client.getCapabilities();
// 允许的产物类型先算一次：它要进每一条附件/预览 issue 的 allowedArtifacts，
// 让 UI 在不额外请求能力接口的情况下也能渲染「支持哪些格式」。
    const supportedArtifactTypes = allowedArtifactSummaries(capabilities);
    const conversation = await this.loadAllRows(input, agentService);
// 三个数组在函数内累积，最后统一脱敏返回；顺序即 issue 的产生顺序（串行语义）。
// 三类 issue 从一开始就分开累积：blocking 阻断发布、skippable 自动降级、
// deferred 表示「现在读不到但可能稍后能读」，UI 对三者的交互完全不同。
// 全程只累积不抛错，最终统一脱敏返回，保证一次预检能看到全部问题。
    const blockingIssues: ConversationShareFailureIssue[] = [];
    const skippableWarnings: ConversationShareFailureIssue[] = [];
    const deferredIssues: ConversationShareFailureIssue[] = [];

// selected 用 let 而不是 const：选择失败时它不会被赋值，
// 下面的 catch 会提前 return，因此后续代码可以安全地假定它已初始化。
    let selected: { rows: ConversationRow[]; productTurnIds: string[] };
    try {
// 选择失败时仍返回完整的水位与能力指纹：UI 需要这些信息才能重新拉取候选。
// 非业务错误（例如 IO）继续上抛，不能被包装成「选择无效」。
      selected = selectRows(conversation.rows, input.selection);
    } catch (error) {
      if (error instanceof ConversationShareServiceError) {
        blockingIssues.push({
          code: "invalid_selection",
          scope: "conversation",
        });
      } else {
        throw error;
      }
      return {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        blockingIssues,
        skippableWarnings,
        deferredIssues,
        supportedArtifactTypes,
        turnResults: [],
      };
    }

    const inlineImages = materializeConversationShareInlineImages(
      removeIndependentArtifactRows(sanitizeUnsupportedShareStructures(selected.rows)),
      capabilities,
      turnOrdinalByProductTurn(conversation.rows),
    );
    const artifactSanitized = sanitizeUnsupportedShareArtifacts(
      inlineImages.rows,
      capabilities,
      conversation.rows,
    );
    const workflowSnapshot = await collectConversationShareWorkflowSnapshot({
      agent: agentService,
      input,
      rows: artifactSanitized.rows,
      allRows: conversation.rows,
      capabilities,
      capturedAt: this.now(),
      preflight: true,
    });
    if (!supportsConversationShareContent(capabilities, "tool-presentation")) {
      for (const row of selected.rows) {
        if (
          row.kind === "toolCall" &&
          (projectShareToolDisplay(row.output?.display) || row.display?.kind === "node_repl_images")
        )
          inlineImages.warnings.push({
            code: "content_unavailable",
            scope: "turn",
            productTurnId: row.productTurnId,
            rowId: row.rowId,
          });
      }
    }
    const selectedRows = workflowSnapshot.rows;
    const contentWarnings: ConversationShareFailureIssue[] = workflowSnapshot.drafts.flatMap(
      (draft) =>
        draft.payload.unavailable ||
        draft.payload.artifacts.some((artifact) => artifact.unavailable) ||
        !supportsConversationShareContent(capabilities)
          ? [
              {
                code: "content_unavailable",
                scope: "turn",
                productTurnId: draft.productTurnId,
                turnOrdinal: turnOrdinalByProductTurn(conversation.rows).get(draft.productTurnId),
              },
            ]
          : [],
    );
    skippableWarnings.push(
      ...inlineImages.warnings,
      ...artifactSanitized.warnings,
      ...contentWarnings,
    );
    blockingIssues.push(...collectShareStructureIssues(selectedRows, conversation.rows));
    let hasShareableContent = selectedRows.some((row) => {
      if (row.kind === "turnHeader" || row.kind === "timelineMarker") return false;
      if (row.kind === "assistantText" || row.kind === "reasoning")
        return row.text.trim().length > 0;
      if (row.kind === "userInput") return row.text.trim().length > 0;
      if (row.kind === "toolCall") {
        return Boolean(
          row.inputText?.trim() || row.output?.text?.trim() || row.error?.message?.trim(),
        );
      }
      return true;
    });

    const turnOrdinalByProductTurnId = turnOrdinalByProductTurn(conversation.rows);
    // 先把需要 stat 的附件收集齐，再有界并发跑，最后按原顺序分类。
    // 拆成两轮是为了在拿到远程并发收益的同时，让 issue 的产生顺序与串行实现一致。
// 第一轮只做纯本地计算（扩展名、mime、能力匹配）并收集待 stat 项，不发任何 RPC；
// 这样即使一个附件都没有，也不会为预检多打一次网络。
// baseIssue 在这里预生成，是为了让后续三种结局复用同一份定位字段。
    const attachmentChecks: {
      row: Extract<ConversationRow, { kind: "userInput" }> & {
        entityId: string;
      };
      attachmentIndex: number;
      attachment: NonNullable<
        Extract<ConversationRow, { kind: "userInput" }>["attachments"]
      >[number];
      allowed: ReturnType<typeof allowedArtifactFor>;
      baseIssue: Omit<ConversationShareFailureIssue, "code">;
    }[] = [];
    for (const row of selectedRows) {
      if (row.kind !== "userInput" || !row.attachments) continue;
// attachmentIndex 是附件在行内的序号，stat/read 都用它定位；
// 不能用文件名，因为同一行可以有两个同名附件。
      for (const [attachmentIndex, attachment] of row.attachments.entries()) {
// 扩展名与 mime 都从声明值推导（不读盘）：预检要在磁盘 I/O 之前就能判出
// 「格式不支持」，这类问题与文件是否存在无关。
        const extension = fileExtension(attachment.fileName);
        const mimeType = normalizedMimeType(attachment.mime);
        const allowed = allowedArtifactFor(capabilities, extension, mimeType);
        const baseIssue = {
          scope: "artifact" as const,
          rowId: row.rowId,
          ...(row.productTurnId && turnOrdinalByProductTurnId.has(row.productTurnId)
            ? { turnOrdinal: turnOrdinalByProductTurnId.get(row.productTurnId) }
            : {}),
          ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
          artifactDisplayName: attachmentDisplayName(attachment.fileName),
          ...(extension ? { extension } : {}),
          mimeType,
          ...(allowed ? { artifactType: allowed.type } : { artifactType: extension ?? "unknown" }),
          allowedArtifacts: supportedArtifactTypes,
// baseIssue 预置所有「按附件定位」的字段，后续各分支只补 code 与数值，
// 保证同一附件在不同原因下 UI 定位一致。
// artifactType 在类型不支持时回退成扩展名或 unknown，避免 issue 里出现空类型。
        } satisfies Partial<ConversationShareFailureIssue>;
        if (!row.entityId) {
          blockingIssues.push({
            code: "input_attachment",
            scope: "artifact",
            rowId: row.rowId,
            ...(baseIssue.turnOrdinal === undefined ? {} : { turnOrdinal: baseIssue.turnOrdinal }),
            ...(baseIssue.productTurnId === undefined
              ? {}
              : { productTurnId: baseIssue.productTurnId }),
            artifactDisplayName: attachmentDisplayName(attachment.fileName),
          });
          continue;
        }
// 这里复制 row 并窄化 entityId：TypeScript 无法把上面的 if 判断带入闭包，
// 复制后 RPC 调用处的 target 才有确定类型。
// allowed 允许为 undefined（类型不支持），分类阶段据此优先给 warning。
        attachmentChecks.push({
          row: { ...row, entityId: row.entityId },
          attachmentIndex,
          attachment,
          allowed,
          baseIssue,
        });
      }
    }
// 第二轮：有界并发 stat，任一失败都用 settle 捕获成值而不是抛出，
// 这样「一个附件读不到」不会中断整次预检。
// 并发上限只约束在飞请求数，结果数组仍与 attachmentChecks 等长同序；
// [资源] 单个附件 stat 的返回体积很小，因此这里可以把全部请求同时在飞。
    const attachmentStats = await mapWithConcurrency(
      attachmentChecks,
      SHARE_PREFLIGHT_STAT_CONCURRENCY,
      (check) =>
        settle(() =>
          agentService.conversationAttachmentStatV4({
            workspacePath: input.workspacePath,
            ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            sessionId: input.sessionId,
            target: { rowId: check.row.rowId, entityId: check.row.entityId },
            attachmentIndex: check.attachmentIndex,
            ref: check.attachment.ref,
          }),
        ),
    );
// 第三轮：按收集顺序分类。顺序必须与 checks 一致，issue 列表才能稳定，
// UI 才不会在两次预检之间出现条目跳位。
// 用下标而不是 Promise.all 的完成顺序遍历：issue 的顺序必须只取决于输入，
// 否则同一份会话在不同网络状况下会得到不同的提示顺序。
    for (const [checkIndex, check] of attachmentChecks.entries()) {
      const { row, attachment, allowed, baseIssue } = check;
// 断言非空是安全的：结果数组与 checks 等长；
// 用 ! 而不是 throw，避免为一个不可能分支增加噪音。
      const settled = attachmentStats[checkIndex]!;
      if (settled.ok) {
// stat 是「当前磁盘真实状态」，与附件声明的 bytes 可能不同：后者只是选择时的快照。
        const stat = settled.value;
        if (!allowed) {
          // 即使类型不支持，也必须先完成选择阶段存在性检查；只有存在的附件才展示
          // artifact_type_not_allowed，避免把已经清理的附件误报成能力问题。
          //
          // 类型判定必须排在体积判定之前：不支持的类型根本不会被上传，它的体积
          // 与分享无关。反过来会把「格式不支持（可跳过）」升级成「体积超限（阻断）」，
          // 用户被一个压缩也解决不了的错误挡住。
          skippableWarnings.push({
            code: "artifact_type_not_allowed",
            ...baseIssue,
          });
// 单文件上限用 stat 的真实总长判断，而不是附件声明的 bytes：
// 声明值可能过期，真实值才是上传时会失败的那个。
        } else if (stat.totalBytes > capabilities.max_artifact_bytes) {
          blockingIssues.push({
            code: "artifact_size_limit",
            ...baseIssue,
            actual: stat.totalBytes,
            limit: capabilities.max_artifact_bytes,
          });
// 长度变化只降级为 warning 并标 availability=changed：文件可能只是被重新生成，
// 但用户看到的内容已不是确认时的那个，必须显式告知。
        } else if (attachment.bytes > 0 && stat.totalBytes !== attachment.bytes) {
          skippableWarnings.push({
            code: "artifact_changed",
            ...baseIssue,
            availability: "changed",
          });
        } else {
          hasShareableContent = true;
        }
      } else {
        const error = settled.error;
        if (isAttachmentAuthorizationError(error)) {
          blockingIssues.push({
            code: "artifact_protocol_not_ready",
            scope: "artifact",
            rowId: row.rowId,
            ...(baseIssue.turnOrdinal === undefined ? {} : { turnOrdinal: baseIssue.turnOrdinal }),
            ...(baseIssue.productTurnId === undefined
              ? {}
              : { productTurnId: baseIssue.productTurnId }),
            artifactDisplayName: attachmentDisplayName(attachment.fileName),
          });
// 连 stat 都因体积失败时仍归为确定阻断：把它放进 deferred 会让发布阶段才失败。
        } else if (isAttachmentTooLargeError(error)) {
          // 附件大到连 stat 都无法表达时，仍然是「已知容量超限」这一确定阻断，
          // 绝不能降级成 deferred —— 那会让发布悄悄丢掉这个附件。
          blockingIssues.push({
            code: "artifact_size_limit",
            ...baseIssue,
            limit: capabilities.max_artifact_bytes,
          });
// 明确不存在才降级为 warning；未知错误走 deferred 并保留 hasShareableContent，
// 因为「现在读不到」不等于「不可分享」。
        } else if (isDefiniteMissingAttachment(error)) {
          skippableWarnings.push({
            code: "input_attachment_unavailable",
            ...baseIssue,
            availability: "not_found",
          });
        } else {
          hasShareableContent = true;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...baseIssue,
            availability: "unknown",
          });
        }
      }
    }

    if (!hasShareableContent) {
      blockingIssues.push({
        code: "no_shareable_content",
        scope: "conversation",
      });
    }

    if (blockingIssues.length > 0) {
      const sanitizedBlockingIssues = sanitizeConversationShareIssues(blockingIssues);
      const sanitizedWarnings = sanitizeConversationShareIssues(skippableWarnings);
      const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
      return {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        blockingIssues: sanitizedBlockingIssues.issues,
        skippableWarnings: sanitizedWarnings.issues,
        deferredIssues: sanitizedDeferred.issues,
        supportedArtifactTypes,
        turnResults: buildTurnPreflightResults(
          selected.productTurnIds,
          turnOrdinalByProductTurnId,
          sanitizedBlockingIssues.issues,
          sanitizedWarnings.issues,
          sanitizedDeferred.issues,
        ),
      };
    }

    const registeredProjection = buildConversationSharePublicProjection({
      rows: selectedRows,
      selectedProductTurnIds: selected.productTurnIds,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
    });
    if (registeredProjection.rows.length > capabilities.max_rows) {
      blockingIssues.push({
        code: "rows_limit",
        scope: "conversation",
        actual: registeredProjection.rows.length,
        limit: capabilities.max_rows,
      });
    }
// manifest 校验在投影之后进行：此时 artifact 的公开 ID 与大小都已确定，
// 才能判断总数/总字节/重复 ID。
// 内嵌图片的 issue 需要补行定位，因此下面按 displayName 回查 artifact 行。
    const manifestIssues = this.collectArtifactManifestIssues(
      capabilities,
      registeredProjection.artifacts,
    ).map((issue) => {
      // 内嵌图片的容量问题必须带轮次定位，否则拆分 turn 缓存时会漏掉文件级阻断。
      const row = selectedRows.find(
        (candidate) =>
// 回查键用 displayName 而不是 ID：manifest issue 产生时不带行信息，
// 而 displayName 在一次分享内由发现阶段保证唯一。
          candidate.kind === "artifact" && candidate.displayName === issue.artifactDisplayName,
      );
      return row
        ? {
            ...issue,
            rowId: row.rowId,
            productTurnId: row.productTurnId,
            turnOrdinal: rowTurnOrdinal(row, turnOrdinalByProductTurnId),
          }
        : issue;
    });
    blockingIssues.push(
// 唯一的降级例外：类型不支持只是「这个产物不上传」，不应阻断整次发布。
// 其余 manifest 问题（数量/总量/重复）都会让服务端拒绝，必须阻断。
      ...manifestIssues.filter((issue) => issue.code !== "artifact_type_not_allowed"),
    );
    skippableWarnings.push(
      ...manifestIssues.filter((issue) => issue.code === "artifact_type_not_allowed"),
    );

// header 承载 fileChanges 与 entityId，是「本轮引用了哪些文件」的入口；
// 没有 header 的轮次直接跳过，因为无法发起 fileChanges 查询。
    const headersByProductTurnId = new Map<
      string,
      Extract<ConversationRow, { kind: "turnHeader" }>
    >();
// 先按轮聚合正文，再逐轮提取路径引用：正文被拆成多行，
// 单行提取会漏掉跨行的 markdown 链接与相对路径。
// 合成的工作流摘要行要排除，否则会把产物标题当成文件引用。
    const assistantTextByProductTurnId = new Map<string, string[]>();
    for (const row of selectedRows) {
      if (row.kind === "turnHeader" && row.productTurnId) {
        headersByProductTurnId.set(row.productTurnId, row);
      }
      if (row.kind === "assistantText" && row.productTurnId && !isWorkflowShareFallbackRow(row)) {
        const texts = assistantTextByProductTurnId.get(row.productTurnId) ?? [];
        texts.push(row.text);
        assistantTextByProductTurnId.set(row.productTurnId, texts);
      }
    }

// 逐轮串行查询：fileChanges 的结果依赖会话水位，并发发起会让错误归属难以定位；
// assistantTextByProductTurnId 通常只有个位数，串行查询的额外延迟可以接受。
    for (const [productTurnId, textParts] of assistantTextByProductTurnId) {
      const header = headersByProductTurnId.get(productTurnId);
      if (!header) continue;
      const assistantText = textParts.join("\n\n");
// 只从「本端能识别的 markdown 引用」里提候选，不做文件系统扫描：
// 分享应当只包含助手明确指向的内容，而不是 workspace 里的全部文件。
      const references = extractConversationPreviewFileReferences(
        assistantText,
        input.workspacePath,
      );
      const needsFileChanges = references.some(
        (reference) => reference.kind === "markdown" || reference.kind === "html",
      );
// fileChanges 只在引用需要「是否本次改动」时查询；查询失败不影响其它轮次。
// 缺 entityId 的行无法定位，记 deferred 而不是静默跳过。
      let fileChanges: Array<{ path: string; state: "active" | "reverted" }> | undefined;
// 只有 markdown/html 引用才需要「本次是否改动」的判断，纯图片卡片不需要；
// 已 reverted 的轮次直接跳过查询：改动已回滚，查询结果对可见性没有影响。
      if (needsFileChanges && header.fileChanges?.state !== "reverted") {
        if (!header.entityId) {
          deferredIssues.push({
            code: "artifact_read_failed",
            scope: "artifact",
            rowId: header.rowId,
            turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
            productTurnId,
            availability: "unknown",
          });
          continue;
        }
        const result = await agentService.conversationFileChangesV4({
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          sessionId: input.sessionId,
          target: { rowId: header.rowId, entityId: header.entityId },
          baseRevision: conversation.revision,
          baseLogEpoch: conversation.logEpoch,
        });
// 服务端返回的 state 是整批级别的，这里把它复制到每个 item 上：
// 候选构建只接收 path+state 列表，不感知批次结构。
        fileChanges = result.items.map((item) => ({
          path: item.path,
          state: result.state === "reverted" ? ("reverted" as const) : ("active" as const),
        }));
      }

      const candidates = buildConversationPreviewArtifactCandidates({
        assistantText,
        productTurnId,
        workspacePath: input.workspacePath,
        fileChanges,
      });
// visibleCandidates 是「UI 上真正会显示卡片」的子集，与 candidates（全部候选）不同；
// 预检快照只记录前者，因为用户只能对自己看见的内容做确认。
      const visibleCandidates: ConversationPreviewArtifactCandidate[] = [];
// 去重基于 stat 后的真实路径而不是 sourceRef：同一条引用可能写作相对路径与绝对路径，
// 二者 sourceRef 不同但指向同一个文件，重复计入会多占一个可见卡片名额。
      const previewCanonicalPaths = new Set<string>();
// 这个标志表示「本轮所有候选的存在性都已确定」；只要有一个候选 stat 未定，
// 就不写入预检快照，避免发布时用一份不完整的可见集合做比对。
      let previewStatSettled = this.artifactSource.stat !== undefined;
      // stat 并发发起，判定仍按候选原顺序进行：去重和可见卡片上限都依赖顺序，
      // 而每次 stat 在远程 workspace 下都是一次往返。
// 先取出方法再并发调用：每次访问 getter 可能产生新函数，且这里要判断是否支持 stat。
      const artifactSourceStat = this.artifactSource.stat;
// 按候选顺序发起并发 stat，结果下标与候选一一对应；
// 后面仍按原顺序分类，因此「去重」和「可见上限」的行为与串行一致。
      const candidateStats = artifactSourceStat
        ? await mapWithConcurrency(candidates, SHARE_PREFLIGHT_STAT_CONCURRENCY, (candidate) =>
            settle(() =>
              artifactSourceStat({
                workspacePath: input.workspacePath,
                ref: candidate.sourceRef,
              }),
            ),
          )
        : [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const issue = {
          scope: "artifact" as const,
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          productTurnId,
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: fileExtension(candidate.displayName),
          mimeType: candidate.mimeType,
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Omit<ConversationShareFailureIssue, "code">;

        // 先检查候选上限内的全部路径，再从存在的路径里取 UI 同样的可见卡片上限。
        // 这样不会因为前面几个文件存在就漏掉后续候选的存在性检查。
        const settled = candidateStats[candidateIndex];
        if (!settled) {
          previewStatSettled = false;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...issue,
            availability: "unknown",
          });
          continue;
        }
        if (settled.ok) {
// 同一真实路径在本轮内只算一个候选：正文里常同时出现相对与绝对两种写法。
          if (previewCanonicalPaths.has(settled.value.canonicalPath)) continue;
// 去重集合只在本轮内有效：不同轮引用同一文件仍应各自保留引用关系。
          previewCanonicalPaths.add(settled.value.canonicalPath);
        } else {
          if (isMissingArtifactReadError(settled.error)) {
            // Assistant 预览文件已不存在时，UI 也不会显示这张卡片，因此不产生 Share warning。
            continue;
          }
          previewStatSettled = false;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...issue,
            availability: "unknown",
          });
          continue;
        }
// 超过可见上限的候选只做存在性检查、不进入可见集合：
// 这样「第 11 个文件是否还存在」仍会被校验，但不会污染用户确认的卡片列表。
        if (visibleCandidates.length < CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT) {
          visibleCandidates.push(candidate);
        }
      }

      for (const candidate of visibleCandidates) {
        const issue = {
          scope: "artifact" as const,
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          productTurnId,
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: fileExtension(candidate.displayName),
          mimeType: candidate.mimeType,
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Omit<ConversationShareFailureIssue, "code">;
        const allowed =
// video/audio 不参与 allowedArtifacts 白名单，始终以预览卡片呈现，跳过上传清单。
// 因此这里传 undefined，跳过 allowedArtifactFor 的判定。
          candidate.previewKind === "video" || candidate.previewKind === "audio"
            ? undefined
            : allowedArtifactFor(
                capabilities,
                fileExtension(candidate.displayName),
                candidate.mimeType,
              );
        if (!allowed) {
          skippableWarnings.push({ code: "artifact_type_not_allowed", ...issue });
        }
      }
// 快照只记录「本轮可见的 sourceRef 集合」，不记录字节；
// 发布阶段用它保证不会分享用户没在确认页看到的内容。
// 快照按轮存储：UI 允许用户只勾选部分轮次发布，
// 因此「所见集合」也必须能按轮取用，而不能只有一个会话级快照。
      const snapshotKey = previewPreflightKey(input, productTurnId);
// 四项指纹一致才可写快照；能力或候选变化时宁可删掉旧快照，
// 让发布走「全量候选」分支并重新提示用户。
// 只有全部候选的存在性都已确定才写快照；部分未定说明这份「用户所见」
// 本身还不完整，写进去会让发布阶段误判候选一致。
      if (previewStatSettled) {
        this.setPreviewPreflightSnapshot(snapshotKey, {
          revision: conversation.revision,
          logEpoch: conversation.logEpoch,
          capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
          candidateFingerprint: getConversationSharePreviewCandidateFingerprint(candidates),
          visibleSourceRefs: visibleCandidates.map((candidate) => candidate.sourceRef),
        });
      } else {
// 删除而不是保留旧值：旧快照会让发布阶段误以为用户确认的就是现在的候选。
        this.previewPreflightSnapshots.delete(snapshotKey);
      }
    }

    const sanitizedBlockingIssues = sanitizeConversationShareIssues(blockingIssues);
    const sanitizedWarnings = sanitizeConversationShareIssues(skippableWarnings);
    const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
    return {
      revision: conversation.revision,
      logEpoch: conversation.logEpoch,
      capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
      blockingIssues: sanitizedBlockingIssues.issues,
      skippableWarnings: sanitizedWarnings.issues,
      deferredIssues: sanitizedDeferred.issues,
      supportedArtifactTypes,
      turnResults: buildTurnPreflightResults(
        selected.productTurnIds,
        turnOrdinalByProductTurnId,
        sanitizedBlockingIssues.issues,
        sanitizedWarnings.issues,
        sanitizedDeferred.issues,
      ).map((result) => ({
        ...result,
// rowBudget 按轮统计投影后的行数：用户需要知道「这一轮占了多少额度」，
// 才能决定取消哪一轮来腾出空间。
// 用 productTurnIds 的 indexOf 找到公开 ID，不能用下标直接对应（顺序可能不同）。
        rowBudget: {
          count: registeredProjection.rows.filter(
            (row) =>
              row.productTurnId ===
              registeredProjection.selectedProductTurnIds[
                selected.productTurnIds.indexOf(result.productTurnId)
              ],
          ).length,
          limit: capabilities.max_rows,
        },
      })),
    };
  }

// 预览与续传都是纯转发：它们不需要本地会话数据，也不需要可信 Agent 身份。
  getPreview(shareCode: string) {
    return this.client.getPreview(shareCode);
  }

// schema_version 固定发 1：本端只实现了 v1 的完整校验；
// 服务端若返回更高版本，client 会显式报「请升级」而不是误判为损坏。
// clientRequestId 透传用于服务端幂等与日志对账。
  getContinuation(input: { shareCode: string; clientRequestId: string }) {
    return this.client.getContinuation(input.shareCode, {
      schema_version: 1,
      client_request_id: input.clientRequestId,
    });
  }

  /** Host attachment 内部 facade：复用同一业务 service，只替换 V4 Rows/File 查询的可信 Agent scope。 */
// 连接作用域化的唯一实现点：同一个 service 实例，把四个 V4 查询换成传入的 Agent。
// 只替换需要「代表下游身份」的方法；导入、预览、进度、幂等表全部共享，
// 因此远端请求不会创建第二份 completedImports，重复导入仍然被拦住。
// [权衡] 这里用对象字面量逐个方法转发，新增接口方法会编译失败，逼作者显式决定。
  [conversationShareConnectionScopeFactory](
    agentService: ConversationShareAgentService,
  ): IConversationShareService {
    return {
      getCapabilities: () => this.getCapabilities(),
// 作用域版的 preflight 也要做连接错误归一，否则远端 facade 拿不到统一错误类型。
      preflight: async (input) => {
        try {
          return await this.preflightWithAgent(input, agentService);
        } catch (error) {
          throw normalizeConversationShareConnectionError(error);
        }
      },
// publish 不需要额外归一：publishWithAgent 内部已按阶段包装错误。
// operationId 由调用方提供，进度事件据此归集到正确的订阅者。
      publish: (input, operationId) => this.publishWithAgent(input, operationId, agentService),
      onDynamicPublishProgress: (operationId) => this.onDynamicPublishProgress(operationId),
      importShare: (input, operationId) => this.importShare(input, operationId),
      onDynamicImportProgress: (operationId) => this.onDynamicImportProgress(operationId),
// 读取已导入副本不依赖 Agent：它读的是本地磁盘上的只读快照。
      getImportedConversation: (input) => this.getImportedConversation(input),
      getPreview: (shareCode) => this.getPreview(shareCode),
      getContinuation: (input) => this.getContinuation(input),
    };
  }

// 订阅入口返回 RpcEvent：调用方在组件挂载时订阅、卸载时取消，
// emitter 的最后一个监听者被移除时会自动释放。
  onDynamicPublishProgress(operationId: string) {
    return this.getProgressEmitter(operationId).event;
  }

// 导入进度与发布进度分开两套 emitter：两者可同时进行，phase 枚举也不同。
  onDynamicImportProgress(operationId: string) {
    return this.getImportProgressEmitter(operationId).event;
  }

  /**
   * 下载单个 artifact 的字节：带单请求超时（含读 body）与 Content-Length 预检。
   *
   * download 兜底不能是裸 fetch（无 AbortSignal），且 size/SHA-256 校验不能在
   * arrayBuffer() 之后才执行——挂住的连接会让导入无限停在 downloading 阶段（undici 默认
   * ~300s 兜底，体验上等于卡死）；被篡改的存储还能让客户端先把超大 payload 全量读进内存
   * 再发现不符。超时按 network 失败；Content-Length 声明超过 manifest 的 size_bytes 时
   * 在读 body 前直接判 integrity 失败并中断连接——完整性校验放在无界下载之后只保证
   * 正确性，不保护客户端资源。
   */
// 单产物下载：超时覆盖「建连 + 读 body」，Content-Length 先于读体校验。
// [资源] 必须在读 body 前判长度：否则被篡改的存储可以让客户端先把超大 payload
// 全量读进内存，再在摘要校验时失败——完整性正确但资源已被耗尽。
// [失败路径] 超时归 network（可重试），长度/摘要不符归 integrity（不可重试）。
  private async downloadArtifactBytes(
    artifact: ConversationShareContinuation["artifacts"][number],
  ): Promise<{ bytes: Uint8Array; responseMimeType?: string }> {
    const artifactIssue = (
      code: ConversationShareFailureIssue["code"],
      extra?: { actual?: number; limit?: number },
    ): ConversationShareFailureIssue => ({
      code,
      scope: "artifact",
      artifactDisplayName: artifact.display_name,
      artifactType: artifact.artifact_type,
      extension: artifact.extension,
      mimeType: artifact.mime_type,
      phase: "downloading",
      ...(extra?.actual === undefined ? {} : { actual: extra.actual }),
      ...(extra?.limit === undefined ? {} : { limit: extra.limit }),
    });
// 超时用 AbortController 而不是 Promise.race：只有真正中断底层连接
// 才能释放 socket 并让 undici 停止读 body，race 只是让调用方提前返回。
    const controller = new AbortController();
// 计时覆盖「建连 + 读 body」全过程：只在建连阶段设超时挡不住慢速滴流的下行。
// [资源] 定时器在 finally 里清除，否则成功路径也会留下一个未触发的挂起计时器。
    const abortTimer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    try {
      const response = await this.download(artifact.download_url, { signal: controller.signal });
// 4xx/5xx 归 network 而不是 integrity：预签名 URL 可能只是过期，
// 重新走一次续传拿新 URL 就能成功，因此这一层必须保持可重试语义。
      if (!response.ok) {
        throw new ConversationShareServiceError(
          "network",
          "Conversation artifact download failed",
          { issues: [artifactIssue("unknown")] },
        );
      }
// header 缺失时 Number(null) 得到 0，会被下面的比较自然跳过；
// 有值且大于声明大小时才提前失败，等于声明大小的正常路径不受影响。
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > artifact.size_bytes) {
        // body 已确定不会通过校验：先中断连接再抛错，不把超大响应读进内存。
        controller.abort();
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact integrity check failed",
          {
            issues: [
              artifactIssue("artifact_changed", {
                actual: declaredBytes,
                limit: artifact.size_bytes,
              }),
            ],
          },
        );
      }
// [资源] 这是整个导入里唯一把单文件完整读进内存的点；
// 串行下载保证峰值内存约为「单文件上限 + 上一次的 GC 余量」，而不是并发数倍。
      const bytes = new Uint8Array(await response.arrayBuffer());
      const responseMimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      return { bytes, responseMimeType };
    } catch (error) {
// 只把「非本模块抛出的中止」翻译成超时：上面主动 abort 的场景已经抛了
// invalid_contract，若一并改写成 network 会让不可重试的错误变成可重试。
      if (controller.signal.aborted && !(error instanceof ConversationShareServiceError)) {
        throw new ConversationShareServiceError(
          "network",
          "Conversation artifact download timed out",
          {
            issues: [artifactIssue("unknown")],
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(abortTimer);
    }
  }

// 导入对外入口只做幂等编排，真正的下载/落盘/建会话在 importShareInternal。
// 两级幂等：精确键（share+workspace+clientRequestId）用于请求重放；
// 宽键（share+workspace）用于「同一分享被不同请求各导入一次」的去重。
// 两表都是先查后写，但真正的互斥靠 inFlight Promise：并发到达时只有一个会创建任务。
// [并发] 完成表写入发生在 Promise.then 里，因此「已进入 inFlight」的请求一定拿到同一结果。
  async importShare(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    await this.completedImportsLoaded;
    const workspaceKey = workspaceKeyOf(input.targetWorkspacePath, input.targetWorkspaceIdentity);
// 必须先等磁盘索引加载完成：否则重启后第一次导入看不到历史记录，会重复导入。
// 加载失败已被内部吞掉，这里 await 不会抛出。
    const workspaceKeyedShare = importDedupeKey(input.shareCode, workspaceKey);
// 精确键 = 宽键 + NUL + clientRequestId：NUL 不会出现在任何一段里，拼接无歧义。
    const key = `${workspaceKeyedShare}\u0000${input.clientRequestId}`;
// 精确键优先于宽键：同一请求重放要拿到「它自己那次」的结果，
// 宽键只在前者缺失时兜底（例如请求重试换了 clientRequestId）。
    const completed =
      this.completedImports.get(key) ?? this.completedImportsByWorkspace.get(workspaceKeyedShare);
// 命中已完成记录直接返回 reused=true：调用方据此跳转到既有会话，而不是新建。
    if (completed) {
      this.logger.info(undefined, "conversation share import reused", {
        operationId,
        phase: "complete",
      });
      return { ...completed, reused: true };
    }
// 先查精确键再查宽键：精确命中说明是同一请求的重复，宽键命中说明是别的请求
// 正在导入同一个分享，两者都应等待同一个 Promise。
    const inFlight =
      this.inFlightImports.get(key) ?? this.inFlightImportsByWorkspace.get(workspaceKeyedShare);
// 直接返回同一个 Promise，而不是排队等锁：并发者拿到的是同一个结果对象，
// 因此不会出现两个调用各自建一次会话、各自写一份目录。
    if (inFlight) {
      return inFlight;
    }
// 成功后才写完成表并落盘；落盘失败被吞掉，因为会话已经创建，结果仍然有效。
// 顺序不能反：先落盘再写内存，会在落盘失败时留下「磁盘有、内存无」的不一致。
    const promise = this.importShareInternal(input, operationId)
      .then((result) => {
        this.completedImports.set(key, result);
        this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
        return this.persistCompletedImportIndex()
          .catch(() => undefined)
          .then(() => result);
      })
      .finally(() => {
        this.inFlightImports.delete(key);
      });
// 必须在同步段内登记：从创建 Promise 到登记之间没有 await，
// 因此不存在其它请求在这段窗口里看不到 inFlight 而重复开任务的间隙。
    this.inFlightImports.set(key, promise);
    this.inFlightImportsByWorkspace.set(workspaceKeyedShare, promise);
// inFlightImports（精确键）在 finally 里删，保证异常路径也清理。
// 宽键需要在成功/失败两个回调里各自删，因为 finally 无法判断要删哪一个键。
// 用「当前值 === promise」判断，防止误删后来者创建的另一个任务。
    void promise.then(
      () => {
        if (this.inFlightImportsByWorkspace.get(workspaceKeyedShare) === promise) {
          this.inFlightImportsByWorkspace.delete(workspaceKeyedShare);
        }
      },
      () => {
        if (this.inFlightImportsByWorkspace.get(workspaceKeyedShare) === promise) {
          this.inFlightImportsByWorkspace.delete(workspaceKeyedShare);
        }
      },
    );
    return promise;
  }

// 导入主流程：读续传 → 定位目录 → 复用或新建 → 下载校验 → 落盘 → 建会话 → 清理。
// 目录布局固定为 <workspace>/.zcode-share/<share_id>/，内含 marker、staging、artifacts、conversation。
// staging 与最终目录分开，是为了让「下载到一半」的导入在失败时能被整体删除而不留半成品。
// [事务] 提交点是 createSession：此前失败都可以删 importRoot，此后必须保留。
  private async importShareInternal(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult> {
// 没有 session service 就无法把内容变成可打开的会话，直接 feature_disabled 而不是半途失败。
    if (!this.zcodeSessionService) {
      throwServiceError("feature_disabled", "Conversation share import is unavailable");
    }
    // 两个摘要已在 ConversationShareHttpClient.getContinuation 里对服务端原样发来的值复核过。
    // 不能在这里拿解析产物重算：zod 默认剥掉未知字段，那样发布端加一个 optional 字段就会让
    // 所有老客户端算出不同的哈希，把纯 additive 的演进误报成「分享文件校验失败」。
// 完整性校验在 client.getContinuation 内完成，这里拿到的已经是「验证过」的内容；
// 不在这里重算摘要，避免 zod 剥离未知字段导致 additive 演进被误判为篡改。
    const continuation = await this.getContinuation(input);

// remote 的判定取「kind 或 identity」的或：kind 是显式声明，
// identity 是旧调用方只带身份不带 kind 的兼容路径，两者都意味着不能写本地路径。
// 远端目标统一落到本机 conversationWorkspaceRoot，并在结果里回传 fallbackReason。
    const remoteTarget =
      input.targetWorkspaceKind === "remote" || Boolean(input.targetWorkspaceIdentity);
    const workspacePath =
      input.targetWorkspacePath && !remoteTarget
        ? input.targetWorkspacePath
        : this.conversationWorkspaceRoot;
    const workspaceIdentity =
      input.targetWorkspaceIdentity && !remoteTarget ? input.targetWorkspaceIdentity : undefined;
// remoteTarget 为真时一律落到本机 conversationWorkspaceRoot：远端 workspace 不能写本地路径。
// share_id 作为目录名必须净化，避免它含分隔符把写入引到 .zcode-share 之外。
    const shareRoot = join(workspacePath, ".zcode-share");
    const importRoot = join(shareRoot, sanitizeFileSegment(continuation.share.share_id));
    const markerPath = join(importRoot, ".zcode-share-import.json");
// staging 与最终产物目录同级，保证 rename 不跨设备（EXDEV）；
// 下载中途失败时只需删 importRoot，staging 与最终目录一并消失。
    const stagingPath = join(importRoot, ".share-import-staging");
    const finalArtifactsPath = join(importRoot, "shared-artifacts");
    const conversationPath = join(importRoot, "shared-conversation.json");
// importId 只写进 marker，用于区分「同一目录的不同次导入尝试」；
// 它不参与幂等判断，幂等判断只认 shareCode/sessionId。
    const importId = randomUUID();
    const contextId = `shared-context-${randomUUID()}`;
    const sessionId = `share-import-${randomUUID()}`;
    // 这个 URL 会进持久化的 provenance 与 sharedContextImport 快照，而
    // sharedContextImportV2StateSchema 只接受规范的 /cn/share/<code>；durable 记录也不该
    // 存随界面语言变化的值（用户之后切语言，存的就错了）。本地化只在展示时做。
// 这里存的是规范 URL（不含语言前缀），因为它会进持久化 provenance；
// 语言只在展示时由 localizePublishedShare 处理，切语言不会改写历史记录。
// shareCode 必须编码：它直接来自用户输入/链接，未编码时可能带查询串或路径段。
    const shareUrl = `${this.shareWebUrl}/${encodeURIComponent(input.shareCode)}`;
    await mkdir(shareRoot, { recursive: true });
    try {
// marker 同时用于「恢复」与「防并发」：存在且 shareCode 匹配说明之前导入过或正在导入。
// 解析失败走 catch 继续新建，因为坏 marker 不应永久阻塞用户。
      const existingMarker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (
        existingMarker.shareCode === input.shareCode &&
        typeof existingMarker.sessionId === "string" &&
// 前缀校验是必要的：marker 可能被手工编辑或来自旧版本，只有本前缀的 sessionId 才可信。
// 还要去 listSessions 里确认会话真实存在，否则恢复出来的是一个打不开的 id。
        existingMarker.sessionId.startsWith("share-import-")
      ) {
        const sessions = await this.zcodeSessionService.listSessions({ workspacePath, limit: 100 });
        const existingSession = sessions.find(
          (item) => item.sessionId === existingMarker.sessionId,
        );
        if (
          existingSession &&
          typeof existingMarker.contextId === "string" &&
          typeof existingMarker.shareUrl === "string"
        ) {
          return {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            sessionId: existingSession.sessionId,
            contextId: existingMarker.contextId,
            shareUrl: existingMarker.shareUrl,
            title: existingSession.title,
            reused: true,
          };
        }
        await rm(importRoot, { recursive: true, force: true });
      }
    } catch {
      // 没有 marker 或 marker 不完整时继续创建；非本次 share 的目录不会被删除。
    }
    // 语义是「失败时是否还允许删 importRoot」，不是「我创建了它」：session 一旦提交
    // 就必须解除武装（见下方 createSession 之后）。
// 语义是「失败时是否还允许删除 importRoot」，不是「我是否创建了它」。
// 只有本次成功创建目录后才置 true；createSession 成功后立刻置 false。
// 这样即使 marker 清理或进度上报抛错，也不会删掉已被会话引用的结果物。
    let importRootCleanupArmed = false;
    try {
// marker 指向的会话已不存在（用户删了会话）：清掉旧目录后重新导入，
// 否则 mkdir 会因 EEXIST 直接失败，用户永远无法再次导入这份分享。
      await mkdir(importRoot);
      importRootCleanupArmed = true;
    } catch (error) {
// 目录已存在但没有可用 marker：多半是另一个进程正在导入同一分享，
// 归类为 unknown 并给出「正在进行」，避免用户以为是数据损坏。
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throwServiceError("unknown", "Conversation share import is already in progress");
      }
      throw error;
    }
    try {
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "preparing",
          createdAt: this.now(),
        }),
        "utf8",
      );
    } catch (error) {
      await rm(importRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    try {
// 先写 marker（phase=preparing）再建 staging：进程在两者之间崩溃时，
// 下次启动能通过 marker 知道这个目录属于本次导入并清理。
      await mkdir(stagingPath);
      const installedArtifacts: Array<{
        artifactId: string;
        workspaceRelativePath: string;
        displayName: string;
        mimeType: string;
        sha256: string;
      }> = [];
      const usedNames = new Set<string>();
      let completedArtifacts = 0;
// 进度以「已完成 / 总数」上报，0 表示刚进入下载阶段；总数用于渲染进度条。
// 每个阶段都重新上报一次，即使计数不变，让 UI 能切换阶段文案。
      this.reportImportProgress(operationId, "downloading", 0, continuation.artifacts.length);
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "downloading",
          createdAt: this.now(),
        }),
        "utf8",
      );
// 串行下载：并行会把内存占用放大到「并发数 × 单文件上限」，
// 且失败时难以保证已写入 staging 的文件集合可解释。
      for (const artifact of continuation.artifacts) {
        const { bytes, responseMimeType } = await this.downloadArtifactBytes(artifact);
// 摘要按实际收到的字节计算，与 manifest 声明值比较；这是内容完整性的唯一证据。
        const sha256 = createHash("sha256").update(bytes).digest("hex");
// [失败路径] 长度或摘要任一不符都判 invalid_contract 并带 complete issue，
// 让 UI 直接显示「哪个产物损坏、期望多大、实际多大」。
// 此时仍在 staging 阶段，整目录会被清理，不会留下半份结果物。
// 不可重试：同一 URL 再下一次也会得到同样的坏字节，重试只会浪费流量。
        if (bytes.byteLength !== artifact.size_bytes || sha256 !== artifact.sha256) {
          throw new ConversationShareServiceError(
            "invalid_contract",
            "Conversation artifact integrity check failed",
            {
              issues: [
                {
                  code: "artifact_changed",
                  scope: "artifact",
                  artifactDisplayName: artifact.display_name,
                  artifactType: artifact.artifact_type,
                  extension: artifact.extension,
                  mimeType: artifact.mime_type,
                  actual: bytes.byteLength,
                  limit: artifact.size_bytes,
                  phase: "downloading",
                },
              ],
            },
          );
        }
        // content-type 不一致不能直接判 invalid_contract，否则 .md 一律导入失败——
        // 对象存储/CDN 按自己的规则给下载打标签（.md 常被标成 text/plain 或
        // application/octet-stream），与发布时的 mime_type 无关。
        //
        // 而到这一行字节已经通过 size + SHA-256 校验，且清单本身由 artifact_set_sha256 覆盖，
        // 所以 artifact.mime_type 才是权威值，响应头不提供任何额外完整性保证——
        // 拿它当门禁只会造成误拒。这里降级为记录，不再阻断。
        if (
          responseMimeType &&
// content-type 只记录不阻断：对象存储常把 .md 标成 text/plain，
// 而字节已通过 size + sha256 校验，manifest 的 mime 才是权威值。
          responseMimeType.toLowerCase() !== artifact.mime_type.toLowerCase()
        ) {
          this.logger.info(undefined, "conversation share artifact content-type differs", {
            artifactType: artifact.artifact_type,
            extension: artifact.extension,
            expectedMimeType: artifact.mime_type,
            responseMimeType,
          });
        }
// 文件名去重是对「大小写不敏感文件系统」的兜底：两个产物可能只差大小写。
// 传入 artifact_id 作为重名后缀来源，保证结果稳定可复现。
        const fileName = uniqueImportedFileName(
          artifact.display_name,
          artifact.artifact_id,
          usedNames,
        );
        await writeFile(join(stagingPath, fileName), bytes);
        installedArtifacts.push({
          artifactId: artifact.artifact_id,
          workspaceRelativePath: `.zcode-share/${sanitizeFileSegment(continuation.share.share_id)}/shared-artifacts/${fileName}`,
          displayName: artifact.display_name,
          mimeType: artifact.mime_type,
          sha256: artifact.sha256,
        });
        completedArtifacts += 1;
        this.reportImportProgress(
          operationId,
          "downloading",
          completedArtifacts,
          continuation.artifacts.length,
        );
      }
      this.reportImportProgress(
        operationId,
        "installing",
        completedArtifacts,
        continuation.artifacts.length,
      );
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "installing",
          createdAt: this.now(),
        }),
        "utf8",
      );
// [事务] rename 是原子提交：要么整个 artifacts 目录可见，要么完全不可见，
// 不会出现「只装了一半」的中间态被会话引用。
// 必须在写 shared-conversation.json 之前：后者记录的是最终相对路径。
// 跨设备时 rename 可能失败（EXDEV），但 staging 与最终目录始终同父目录，不会跨设备。
      await rename(stagingPath, finalArtifactsPath);
      // 只读块要能永久离线打开：分享可能过期或尚未上线，渲染时不能回源，
      // 所以把公开 rows 与结果物元数据一起落在 importRoot 内，随失败清理一起删除。
      //
      // 写 rawRows 而不是解析产物：本端认不出的行和字段照样存下来，用户升级之后就能看到，
      // 不会因为导入当天的版本较旧而被永久抹掉。
      await writeFile(
        conversationPath,
        JSON.stringify({
          formatVersion: IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION,
          shareId: continuation.share.share_id,
          contextId,
          title: continuation.share.title,
          rows: continuation.rawRows,
          ...(continuation.content_blocks ? { content_blocks: continuation.content_blocks } : {}),
          artifacts: continuation.artifacts.map((artifact) => ({
            artifactId: artifact.artifact_id,
            displayName: artifact.display_name,
            mimeType: artifact.mime_type,
            workspaceRelativePath: installedArtifacts.find(
              (installed) => installed.artifactId === artifact.artifact_id,
            )?.workspaceRelativePath,
          })),
        }),
        "utf8",
      );
// 上下文文本与行数据分开保存：前者喂给模型，后者给 UI 渲染。
// 生成上下文时用的是「解码后的 rows」，因此本端不认识的行不会进入 markdown。
      const context = formatSharedContextV1({
        share: { shareId: continuation.share.share_id, title: continuation.share.title },
        rows: continuation.rows,
        installedArtifacts,
      });
// 不认识的 kind 不阻断导入：会话仍可打开，只是模型上下文里少了那部分内容；
// 必须留日志，否则「模型好像没看到某段」这类问题无从排查。
      if (context.unsupportedKinds.length > 0) {
        // 模型侧 shared_context 少了内容：不阻断导入，但必须留痕。
        this.logger.info(undefined, "shared context skipped row kinds this build cannot format", {
          kinds: context.unsupportedKinds,
        });
      }
      this.reportImportProgress(
        operationId,
        "committing",
        completedArtifacts,
        continuation.artifacts.length,
      );
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "committing",
          createdAt: this.now(),
        }),
        "utf8",
      );
// 提交点：persistence=immediate 保证会话落盘后才返回，避免「返回了但重启就没了」。
// provenance 里记录两个摘要与 markdown 摘要，用于事后核对导入内容与分享是否一致。
// 标题前缀让导入会话在任务列表可识别；而 UI 只读 contextId/status/shareUrl，不会被前缀影响。
// installedArtifacts 只存相对路径：绝对路径会随 workspace 迁移失效。
// [事务] 该调用成功即代表导入成功，之后的清理与上报都不能再让导入失败。
      const snapshot = await this.zcodeSessionService.createSession({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        sessionId,
        persistence: "immediate",
        importedHistory: {
          source: "sharedContext",
          // 会话标题加前缀，让导入的会话在任务列表里一眼可识别。
          // 注意 UI 侧没有任何地方读 sharedContextImport.title（只读 contextId/status/shareUrl），
          // 所以前缀不会污染展示；CLI 已直接用 importedHistory.title 写 session.title。
          title: formatImportedShareSessionTitle(continuation.share.title, input.locale),
          markdown: context.markdown,
          provenance: {
            shareId: continuation.share.share_id,
            contextId,
            shareUrl,
            status: "pending",
            projectionSha256: continuation.integrity.projection_sha256,
            artifactSetSha256: continuation.integrity.artifact_set_sha256,
            formatterVersion: 1,
            markdownSha256: context.markdownSha256,
            installedArtifacts: installedArtifacts.map((artifact) => ({
              artifactId: artifact.artifactId,
              workspaceRelativePath: artifact.workspaceRelativePath,
            })),
          },
        },
      });
      // session 已提交，且它的 provenance 引用 importRoot 里已安装的
      // artifacts。此后 marker 清理或进度上报一旦抛错，旧的 catch 会 rm -rf importRoot，
      // 用户就拿到一个引用缺失文件的会话。失败半径必须止于 createSession 之前，
      // 所以这里立刻解除清理武装；marker 是纯痕迹文件，删不掉也不该让导入失败。
// 立即解除清理武装：此刻会话已引用结果物，任何后续异常都不能删除目录。
// 这是整个导入流程里最关键的一行顺序约束。
      importRootCleanupArmed = false;
// marker 是纯痕迹文件；删不掉也不该让一次成功导入变成失败，因此吞掉错误。
      await rm(markerPath, { force: true }).catch(() => undefined);
      this.reportImportProgress(
        operationId,
        "complete",
        completedArtifacts,
        continuation.artifacts.length,
      );
      return {
        workspacePath,
        workspaceIdentity,
        sessionId: snapshot.session.sessionId,
        contextId,
        shareUrl,
        title: continuation.share.title,
        reused: false,
        ...(remoteTarget
          ? { fallbackReason: "remote_workspace" as const }
          : input.targetWorkspacePath
            ? {}
            : { fallbackReason: "default_workspace" as const }),
      };
    } catch (error) {
      // 导入改为落在现有 workspace 后，删除 workspace 根目录会损坏用户项目；
      // 失败清理只能触及本次 import-owned 子目录。
      if (importRootCleanupArmed) {
        await rm(importRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * 按 contextId 找回导入时落盘的公开 rows。
   *
   * 目录名用的是 share_id 而不是 contextId（二者不等价），所以扫 .zcode-share/ 下各
   * importRoot 并比对文件内的 contextId —— 不额外维护索引，历史导入也能被读到。
   * 内容来自磁盘，属跨存储边界，必须过 schema 再交给渲染层。
   */
// 读取已导入副本：目录名是 share_id 而不是 contextId，二者不等价，
// 因此必须扫描 .zcode-share 下各目录并比对文件内的 contextId。
// 不维护额外索引，是为了让历史导入（索引文件出现之前的数据）也能被读到。
// 内容来自磁盘，属于跨存储边界，必须过 schema 再交给渲染层。
  async getImportedConversation(input: {
    workspacePath: string;
    contextId: string;
  }): Promise<ImportedConversationShare | null> {
    const shareRoot = join(input.workspacePath, ".zcode-share");
// readdir 失败等价于「该 workspace 从未导入过」，返回 null 而不是抛错：
// 调用方是渲染路径，不该因为目录不存在而让整块会话视图报错。
    let entries: Dirent[];
    try {
      entries = await readdir(shareRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          await readFile(join(shareRoot, entry.name, "shared-conversation.json"), "utf8"),
        );
      } catch {
        continue;
      }
// 用 safeParse 而不是 parse：单个损坏目录不应让整个查询抛错，跳过继续找。
      const validated = importedConversationShareFileSchema.safeParse(parsed);
// 校验与 contextId 比对放在同一条件里：schema 通过但 contextId 不同的目录
// 属于别的导入，继续扫描；只有两者同时成立才是目标。
      if (!validated.success || validated.data.contextId !== input.contextId) continue;
// 逐行解码并统计不认识的行；formatVersion 更高时额外加 1 作为软提示，
// 这样「用户在新版导入后回退到旧版」不会被静默呈现为完整内容。
      const decoded = decodeConversationShareRows(validated.data.rows);
      // formatVersion 比本端新（用户在新版导入后回退到旧版）时，认不出的行照样计入
      // unsupportedRowCount，让 UI 出软提示——不能静默少内容。
      const unsupportedRowCount =
        decoded.unsupportedCount +
        (validated.data.formatVersion > IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION ? 1 : 0);
      if (unsupportedRowCount > 0) {
        this.logger.info(
          undefined,
          "imported conversation share has content this build can't read",
          {
            formatVersion: validated.data.formatVersion,
            kinds: decoded.unsupportedKinds,
            droppedCount: decoded.unsupportedCount,
            keptCount: decoded.rows.length,
          },
        );
      }
      return {
        shareId: validated.data.shareId,
        contextId: validated.data.contextId,
        title: validated.data.title,
        rows: decoded.rows,
        contentBlocks: validated.data.content_blocks,
        artifacts: validated.data.artifacts,
        unsupportedRowCount,
      };
    }
    return null;
  }

// 索引加载对坏数据极度宽容：JSON 坏了直接返回，单条非法跳过，
// 指向已删除 workspace 的记录也跳过（否则会恢复出一个打不开的会话）。
// 每条 import 记录同时写精确表与宽表，宽表用于重启后的跨请求去重。
  private async loadCompletedImportIndex(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.importIndexPath, "utf8"));
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object") return;
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Partial<ImportConversationShareResult>;
      if (
        typeof record.workspacePath !== "string" ||
        typeof record.sessionId !== "string" ||
        typeof record.title !== "string" ||
        typeof record.contextId !== "string" ||
        typeof record.shareUrl !== "string"
      ) {
        continue;
      }
      try {
// 只接受仍存在的目录：workspace 被删除后，旧的导入会话已无法打开。
        if (!(await stat(record.workspacePath)).isDirectory()) continue;
      } catch {
        continue;
      }
// 索引键是 share\0workspace 的复合串；旧版本写入的键可能缺 workspace 段，
// 此时用记录自身的 workspacePath/identity 重新推导，保证升级后仍能参与去重。
      const keyParts = key.split("\u0000");
      const shareCode = keyParts[0]!;
      const workspaceKey =
        keyParts[1] ?? workspaceKeyOf(record.workspacePath, record.workspaceIdentity);
      const workspaceKeyedShare = importDedupeKey(shareCode, workspaceKey);
      const result: ImportConversationShareResult = {
        workspacePath: record.workspacePath,
        ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
        sessionId: record.sessionId,
        contextId: record.contextId,
        shareUrl: record.shareUrl,
        title: record.title,
        reused: true,
      };
      this.completedImports.set(key, result);
      this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
    }
  }

// 原子写：先写唯一临时文件再 rename，避免进程崩溃留下半个 JSON。
// finally 里无条件删临时文件，成功时它已被 rename 走，rm 无副作用。
// 只序列化精确表：宽表可由精确表重建，存两份会有一致性风险。
  private async writeCompletedImportIndexOnce(): Promise<void> {
    const data = Object.fromEntries(this.completedImports.entries());
// 临时文件名带随机后缀，避免两个进程同时落盘时互相覆盖；
// 放在同一目录下，rename 才是原子替换而不是跨设备复制。
    const temporaryPath = `${this.importIndexPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(data), "utf8");
// 读者要么看到旧索引、要么看到完整的新索引，不存在读到半个 JSON 的窗口。
      await rename(temporaryPath, this.importIndexPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

// [失败路径] 链条本身必须始终 resolved，否则首次写失败会永久阻断后续所有落盘；
// 返回的 run 保持可观测，让调用方自行决定是否吞掉本次失败。
// 用「先 catch 再 then」而不是「then 后 catch」，保证前一环失败不会跳过本次写入。
  private persistCompletedImportIndex(): Promise<void> {
    // 链条原来不 catch，首个写入失败后 importIndexWriteChain 永久 rejected，
    // 之后每一次 persist 都变成静默 no-op（调用点还 .catch(() => undefined) 吞掉）。
    // 索引一丢就没有恢复源（marker 在成功时已删），再导入同一 share 会撞 mkdir EEXIST
    // 而永久报 "already in progress"。修法：存起来的链条始终 resolved，只用来串行化；
    // 返回值保持可观测，让调用方自己决定是否吞掉本次失败。
    const run = this.importIndexWriteChain
      .catch(() => undefined)
      .then(() => this.writeCompletedImportIndexOnce());
    this.importIndexWriteChain = run.catch(() => undefined);
    return run;
  }

// 对外发布入口：默认使用本机 Agent；连接作用域版会走 publishWithAgent。
  async publish(input: PublishTextConversationInput, operationId: string) {
    return this.publishWithAgent(input, operationId, this.zcodeAgentService);
  }

// 发布包装层只负责三件事：成功清理快照、失败补结构化日志、无论成败清 phase。
// 日志字段全部来自错误对象的结构化字段，刻意不记录 message 与任何内容。
// [资源] finally 里删 phase，避免 operationId 在长驻进程里累积。
  private async publishWithAgent(
    input: PublishTextConversationInput,
    operationId: string,
    agentService: ConversationShareAgentService,
  ) {
    this.logger.info(undefined, "conversation share publish started", {
      operationId,
      accessMode: input.accessMode,
      selectionKind: input.selection.kind,
      remoteWorkspace: Boolean(input.workspaceIdentity || input.remoteSessionId),
    });
    try {
      const result = await this.publishInternal(input, operationId, agentService);
      this.logger.info(undefined, "conversation share publish completed", {
        operationId,
        phase: "complete",
      });
      // 发布成功即本次分享结束，该 session 的预检快照不再有消费者：立刻回收，
      // 否则长生命周期的 desktop host 会无限累积 workspace+session+turn 条目。
// 发布成功即本次分享结束；快照只服务于「预检 → 发布」这一对，必须回收。
// 只在这一条成功路径上回收：失败时快照要保留，用户修正后重试仍需要这份「所见」基线。
      this.clearPreviewPreflightSnapshots(input);
      return result;
    } catch (rawError) {
      const error = normalizeConversationShareConnectionError(rawError);
      const record =
        error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
      this.logger.warn(undefined, "conversation share publish failed", {
        operationId,
        phase: this.publishPhases.get(operationId) ?? "collecting",
        kind: typeof record?.kind === "string" ? record.kind : "unknown",
        ...(typeof record?.reasonCode === "string" ? { reasonCode: record.reasonCode } : {}),
        ...(record?.diagnostics && typeof record.diagnostics === "object"
          ? { diagnostics: record.diagnostics }
          : {}),
        ...(typeof record?.status === "number" ? { status: record.status } : {}),
        ...(typeof record?.code === "number" ? { code: record.code } : {}),
        ...(typeof record?.requestId === "string" ? { requestId: record.requestId } : {}),
        ...(error instanceof ConversationShareClientError && error.details?.clientRequestId
          ? { clientRequestId: error.details.clientRequestId }
          : {}),
        errorName:
          typeof record?.name === "string"
            ? record.name
            : error instanceof Error
              ? error.name
              : "UnknownError",
      });
      throw error;
    } finally {
      this.publishPhases.delete(operationId);
    }
  }

// 发布主流程固定六段：collecting → 校验 → uploading → checking → complete。
// 每一段都先 report 再干活，UI 才能看到「正在做什么」而不是长时间停在上一段。
// INV-02 在此落地：confirm 请求里的 rows 只来自 publicProjection，绝不使用 selected.rows。
// agentService 作为参数传入，是为了让连接作用域版能替换成本次连接绑定的 agent。
// [失败路径] 所有异常直接向上抛，清理只在 publishWithAgent 的 finally 里做。
  private async publishInternal(
    input: PublishTextConversationInput,
    operationId?: string,
    agentService: ConversationShareAgentService = this.zcodeAgentService,
  ): Promise<ConversationShareRecord> {
    const report = (
      phase: ConversationSharePublishProgress["phase"],
      completedArtifacts = 0,
      totalArtifacts = 0,
      warnings?: {
        issues: readonly ConversationShareFailureIssue[];
        issueCount: number;
        omittedIssueCount: number;
      },
    ) => {
// 无 operationId 表示调用方不需要进度流（同步调用/测试），此时只跳过上报，
// 不改变任何业务分支，因此发布结果与带进度时完全一致。
      if (!operationId) return;
      this.publishPhases.set(operationId, phase);
      this.logger.info(undefined, "conversation share publish phase changed", {
        operationId,
        phase,
        completedArtifacts,
        totalArtifacts,
        ...(warnings ? { warningCount: warnings.issueCount } : {}),
      });
      this.getProgressEmitter(operationId).fire({
        operationId,
        phase,
        completedArtifacts,
        totalArtifacts,
        ...(warnings
          ? { warnings: warnings.issues, omittedWarningCount: warnings.omittedIssueCount }
          : {}),
      });
    };
// 先上报 collecting 再做任何 I/O：这是 UI 唯一能区分「排队中」与「本地正在计算」的信号。
    report("collecting");
    if (!input.title.trim() || !input.clientRequestId.trim()) {
      throwServiceError("invalid_contract", "Share title and request identity are required");
    }
// 披露确认是合规前置条件，必须是显式的时间戳，而不是布尔值：
// 服务端需要它证明用户确实在本次操作中看过提示，0/NaN 都视为未确认。
    if (!Number.isSafeInteger(input.disclosureAcceptedAt) || input.disclosureAcceptedAt <= 0) {
      throwServiceError("disclosure_required", "Explicit disclosure confirmation is required");
    }
// 按行选择却给了空集合，说明 UI 传参有误；继续下去会得到一份空分享并浪费一次 prepare。
    if (input.selection.kind === "rowAnchors" && input.selection.rowIds.length === 0) {
      throwServiceError("invalid_selection", "At least one conversation row must be selected");
    }

    const capabilities = await this.client.getCapabilities();
// 能力清单是客户端唯一真源：可分享格式、单文件/总量上限、行数上限、payload 上限都在这里。
// 每次发布都重新拉取而不是缓存，避免服务端收紧策略后本地仍按旧上限裁剪。
// 不支持的访问模式在本地就失败：用户不必填完标题、传完产物才发现该模式已下线。
    if (!capabilities.access_modes.includes(input.accessMode)) {
      throwServiceError("feature_disabled", "Requested share access mode is unavailable");
    }

    const conversation = await this.loadAllRows(input, agentService);
// 一次性读出全部行并锁定 (revision, logEpoch) 水位；后续所有阶段都基于这一份快照，
// 因此不存在「前半段是旧版本、后半段是新版本」的拼接风险（INV-01）。
// 选择结果必须在同一份 rows 上计算：rowId 只在同一 revision 内有意义，
// 换一份 rows 再按 rowId 取就会取到别的行。
    const selected = selectRows(conversation.rows, input.selection);
    // 无法公开承载的已定稿结构先降级：删字段或丢整行，换成非阻断提示，
    // 后续所有投影与产物发现都基于这份 sanitized rows。
    const inlineImages = materializeConversationShareInlineImages(
      removeIndependentArtifactRows(sanitizeUnsupportedShareStructures(selected.rows)),
      capabilities,
      turnOrdinalByProductTurn(conversation.rows),
    );
    const artifactSanitized = sanitizeUnsupportedShareArtifacts(
      inlineImages.rows,
      capabilities,
      conversation.rows,
    );
    const workflowSnapshot = await collectConversationShareWorkflowSnapshot({
      agent: agentService,
      input,
      rows: artifactSanitized.rows,
      allRows: conversation.rows,
      capabilities,
      capturedAt: this.now(),
    });
    if (!supportsConversationShareContent(capabilities, "tool-presentation")) {
      for (const row of selected.rows) {
        if (
          row.kind === "toolCall" &&
          (projectShareToolDisplay(row.output?.display) || row.display?.kind === "node_repl_images")
        )
          inlineImages.warnings.push({
            code: "content_unavailable",
            scope: "turn",
            productTurnId: row.productTurnId,
            rowId: row.rowId,
          });
      }
    }
    const selectedRows = workflowSnapshot.rows;
    const contentWarnings: ConversationShareFailureIssue[] = workflowSnapshot.drafts.flatMap(
      (draft) =>
        draft.payload.unavailable ||
        draft.payload.artifacts.some((artifact) => artifact.unavailable) ||
        !supportsConversationShareContent(capabilities)
          ? [
              {
                code: "content_unavailable",
                scope: "turn",
                productTurnId: draft.productTurnId,
                turnOrdinal: turnOrdinalByProductTurn(conversation.rows).get(draft.productTurnId),
              },
            ]
          : [],
    );
// 三路 warning 合并后再统一脱敏上报：内嵌图片、产物净化、工作流草稿，
// 顺序固定以便同一份会话每次得到相同的提示顺序。
    const publishWarnings: ConversationShareFailureIssue[] = [
      ...inlineImages.warnings,
      ...artifactSanitized.warnings,
      ...contentWarnings,
    ];
    // 修复原因：此前公开投影遇到第一个不支持结构就直接退出，用户无法知道还有哪些轮次需要取消；
    // 现在先完成整组选中内容的结构预检，返回脱敏 issues 让 UI 给出逐项可操作建议。
// 结构预检在投影之前完成，且收集全部问题而不是遇到第一个就抛，
// 这样 UI 能一次列出所有需要用户取消的轮次，而不是反复试错。
// [失败路径] 只要有结构问题就整体失败：这类内容无法通过裁剪降级成安全载荷。
    const structureIssues = collectShareStructureIssues(selectedRows, conversation.rows);
    if (structureIssues.length > 0) {
      const structureKind = structureIssues.some(
        (issue) => issue.code === "artifact_protocol_not_ready",
      )
        ? "artifact_protocol_not_ready"
        : structureIssues.some((issue) => issue.code === "unsafe_url")
          ? "unsafe_structure"
          : "invalid_conversation";
      throw new ConversationShareServiceError(
        structureKind,
        "Selected conversation contains unsupported structure",
        { issues: structureIssues },
      );
    }
    // 本地运行投影包含 subagent 详情与写入态 ID，后端 V1 会以 3205 拒绝；
    // confirm 前必须先生成独立的公开投影，不能直接发送选中的本地 rows。
    const registeredProjection = buildConversationSharePublicProjection({
      rows: selectedRows,
      selectedProductTurnIds: selected.productTurnIds,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
    });
// 这一次投影只用于「注册态产物」校验：此时还没发现正文引用的文件，
// 但已经能暴露用户显式选中的产物格式是否被服务端接受，失败得更早。
// 产物清单校验是纯本地的：数量、单文件大小、总量、类型白名单、id 唯一性，
// 全部在发请求之前完成，避免用户白等一次上传。
    this.validateArtifactManifest(capabilities, registeredProjection.artifacts);
// 把本次选中的轮次对应的预检快照收集起来交给发现阶段：它能判断
// 「用户当时看到的候选」与「现在能发现的候选」是否一致，不一致就要求重新预检。
// 这里只读不删，回收由发布终态统一处理（见 publishWithAgent）。
    const preflightPreviewSnapshots = new Map<string, ConversationSharePreviewPreflightSnapshot>();
    for (const productTurnId of selected.productTurnIds) {
      const snapshot = this.previewPreflightSnapshots.get(
        previewPreflightKey(input, productTurnId),
      );
      if (snapshot) preflightPreviewSnapshots.set(productTurnId, snapshot);
    }
// 唯一的读盘阶段：附件、已注册产物、正文引用文件都在这里读成字节并算摘要。
// 传入 revision/logEpoch 是为了让发现阶段在读取期间复验水位，变了就直接失败。
// [资源] 返回的 bytesBySourceRef 持有全部产物字节，生命周期只到本次发布结束。
    const artifactSnapshot = await buildConversationShareArtifactSnapshot({
      zcodeAgentService: agentService,
      artifactSource: this.artifactSource,
      input,
      selectedRows,
      registeredArtifacts: registeredProjection.artifacts,
      inlineBytesBySourceRef: new Map([
        ...inlineImages.bytesBySourceRef,
        ...workflowSnapshot.bytes,
      ]),
      capabilities,
      revision: conversation.revision,
      logEpoch: conversation.logEpoch,
      turnOrdinalByProductTurnId: turnOrdinalByProductTurn(conversation.rows),
      preflightPreviewSnapshots,
      currentCapabilitiesFingerprint: capabilitiesFingerprint(capabilities),
    });
// issues 是阻断项（容量/安全结构），warnings 才是可跳过项；
// 这里的区分决定了用户看到的是「不能分享」还是「部分内容被跳过」。
    if (artifactSnapshot.issues.length > 0) {
      throw new ConversationShareServiceError(
        "artifact_not_allowed",
        "Conversation result artifacts are not allowed by server capabilities",
        { issues: artifactSnapshot.issues },
      );
    }
// 发现阶段的 warning 与前面三路合并后再统一上报，保证一次 publish 只有一次
// warning 事件，UI 不必自己去做增量合并。
    if (artifactSnapshot.warnings.length > 0) {
      publishWarnings.push(...artifactSnapshot.warnings);
    }
    if (publishWarnings.length > 0) {
      // 非阻断：正文引用的文件或用户输入附件无法物化时，发布照常继续，但要让分享者
      // 知道哪些真实文件没有进入链接；内部 marker 已移除，内嵌图片已转换为 artifact。
      report("collecting", 0, 0, sanitizeConversationShareIssues(publishWarnings));
    }
// 第二次投影使用发现阶段产出的 rows（已插入正式 artifact 行）与附加产物清单，
// 保证 confirm 载荷里的行、manifest、contentBlocks 三者引自同一份快照。
    const publicProjection = buildConversationSharePublicProjection({
      rows: artifactSnapshot.rows,
      selectedProductTurnIds: selected.productTurnIds,
      additionalArtifacts: artifactSnapshot.additionalArtifacts,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
      ...(supportsConversationShareContent(capabilities)
        ? { contentDrafts: workflowSnapshot.drafts }
        : {}),
    });
    this.validateArtifactManifest(capabilities, publicProjection.artifacts);
// 行数上限在投影之后判断：投影会新增 artifact 行，用选中行数判断会低估最终载荷。
    if (publicProjection.rows.length > capabilities.max_rows) {
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation contains too many rows to share",
        {
          issues: [
            {
              code: "rows_limit",
              scope: "conversation",
              actual: publicProjection.rows.length,
              limit: capabilities.max_rows,
            },
          ],
        },
      );
    }

// DTO 字段名与嵌套结构属于协议契约（snake_case），必须由 builder 统一生成；
// disclosure_confirmation.version 固定为 1，避免本地与服务端对提示版本理解不一致。
    const confirmRequest = buildConversationShareConfirmRequest({
      selected_product_turn_ids: publicProjection.selectedProductTurnIds,
      projection: {
        rows: publicProjection.rows,
        ...(publicProjection.contentBlocks
          ? { content_blocks: publicProjection.contentBlocks }
          : {}),
      },
      artifacts: publicProjection.artifacts.map((artifact) => artifact.descriptor),
      disclosure_confirmation: {
        version: 1,
        accepted_at: input.disclosureAcceptedAt,
        acknowledged_no_secret_detection: true,
      },
    });
    if (
      Buffer.byteLength(JSON.stringify(confirmRequest), "utf8") > capabilities.max_payload_bytes
    ) {
      const actualBytes = Buffer.byteLength(JSON.stringify(confirmRequest), "utf8");
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation share payload is too large",
        {
          issues: [
            {
              code: "payload_size_limit",
              scope: "conversation",
              actual: actualBytes,
              limit: capabilities.max_payload_bytes,
            },
          ],
        },
      );
    }

// 摘要基于 JCS 规范化后的 JSON，键序与空白不影响结果；
// 服务端用它验证 prepare 与 confirm 提交的是同一份载荷，防止两者被分别替换。
    const payloadSha256 = sha256ConversationShareJson(confirmRequest);
// prepare 以 client_request_id 做幂等：同一请求重放会拿到同一个 preparation_id。
// schema_version 与 artifact_count 一并上报，服务端可在上传前就发现数量不符。
    const preparation = await this.client.createPreparation({
      client_request_id: input.clientRequestId,
      title: input.title.trim(),
      schema_version: 1,
      access_mode: input.accessMode,
      payload_sha256: payloadSha256,
      artifact_count: publicProjection.artifacts.length,
    });
// 服务端已有同 payload 的已确认分享：跳过上传与轮询直接返回，
// 这是网络重试路径上最常见的复用情况，也保证重放不会产生第二份分享。
    if (preparation.status === "confirmed") {
      report("complete", publicProjection.artifacts.length, publicProjection.artifacts.length);
      return localizePublishedShare(preparation.share, input.locale);
    }
// 进入上传前把完成数归零并给出总数：UI 只有先拿到 total 才能画进度条。
    report("uploading", 0, publicProjection.artifacts.length);
    let uploadedArtifacts = 0;
    for (const artifact of publicProjection.artifacts) {
// 用 sourceRef 取字节而不是重新读盘：发布必须上传「校验过的同一份字节」，
// 重新读取会让用户在预检后修改文件的行为绕过 size/sha256 校验。
      const bytes = artifactSnapshot.bytesBySourceRef.get(artifact.sourceRef);
      if (!bytes) {
        throwServiceError(
          "invalid_conversation",
          "Conversation artifact bytes are missing from the publication snapshot",
        );
      }
// Blob 里先复制一份独立 ArrayBuffer：Buffer 可能来自共享内存池，
// 直接把底层 ArrayBuffer 交出去会把池中相邻数据一并发送。
// [资源] 复制使单个产物的峰值内存翻倍，因此上传是串行的（见 uploadedArtifacts 递增）。
      const upload = await this.client.uploadArtifact(
        preparation.preparation_id,
        artifact.descriptor,
        new Blob([Uint8Array.from(bytes).buffer], {
          type: artifact.descriptor.mime_type,
        }),
      );
      if (
// 回执必须与 manifest 逐字段一致：id/size/sha256 任一不同都说明
// 服务端存下的不是我们计算过的那份字节，后续 confirm 的摘要将失去意义。
// [失败路径] 这里不可重试地失败，因为重传同一份字节只会得到同样的回执。
        upload.artifact_id !== artifact.descriptor.artifact_id ||
        upload.size_bytes !== artifact.descriptor.size_bytes ||
        upload.sha256 !== artifact.descriptor.sha256
      ) {
        throw new ConversationShareServiceError(
          "upload_incomplete",
          "Conversation artifact upload acknowledgement does not match the manifest",
          {
            issues: [
              {
                code: "upload_incomplete",
                scope: "artifact",
                artifactDisplayName: artifact.descriptor.display_name,
                artifactType: artifact.descriptor.artifact_type,
                extension: artifact.descriptor.extension,
                mimeType: artifact.descriptor.mime_type,
                actual: upload.size_bytes,
                limit: artifact.descriptor.size_bytes,
              },
            ],
          },
        );
      }
// 只有回执校验通过才推进计数：进度条不会出现「回退了」的观感。
      uploadedArtifacts += 1;
      report("uploading", uploadedArtifacts, publicProjection.artifacts.length);
    }
// checking 阶段的完成数沿用产物总数，表示「上传部分已全部完成」，
// 具体压在安全检查上的是时间而不是数量，因此不再单独造一个计数。
    report("checking", uploadedArtifacts, publicProjection.artifacts.length);
// confirm 内部的 3215 重试不是错误而是正常等待，因此这里拿到的一定是终态记录。
    const share = await this.confirmUntilReady(preparation.preparation_id, confirmRequest);
    report("complete", uploadedArtifacts, publicProjection.artifacts.length);
    // 服务端目前不接收 locale，只能把下发的链接改写到界面语言对应的站点；
    // localizeConversationShareUrl 只认已知分享路径形状，其它形状原样保留。
    return localizePublishedShare(share, input.locale);
  }

  private getProgressEmitter(operationId: string): Emitter<ConversationSharePublishProgress> {
    const existing = this.progressEmitters.get(operationId);
    if (existing) return existing;
// [资源] emitter 以 operationId 为键缓存，若只 set 不删，长驻 host 会随发布次数单调增长；
// progressEmitters 以 removeLastListener 为销毁信号并从表中删除，不做定时清理。
    const emitter = new Emitter<ConversationSharePublishProgress>({
      onDidRemoveLastListener: () => {
        this.progressEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.progressEmitters.set(operationId, emitter);
    return emitter;
  }

  private getImportProgressEmitter(operationId: string): Emitter<ConversationShareImportProgress> {
    const existing = this.importProgressEmitters.get(operationId);
    if (existing) return existing;
// 导入进度与发布进度各用一张表：两者 operationId 空间不同，混用会串台。
    const emitter = new Emitter<ConversationShareImportProgress>({
      onDidRemoveLastListener: () => {
        this.importProgressEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.importProgressEmitters.set(operationId, emitter);
    return emitter;
  }

  private reportImportProgress(
    operationId: string,
    phase: ConversationShareImportProgress["phase"],
    completedArtifacts: number,
    totalArtifacts: number,
  ) {
// 没有任何监听者时 fire 是空操作，因此导入可以完全不关心是否有人在看进度。
    this.getImportProgressEmitter(operationId).fire({
      operationId,
      phase,
      completedArtifacts,
      totalArtifacts,
    });
  }

// 启动后的兜底清扫：进程在导入中途崩溃会留下 .zcode-share/<id>/ 与 marker，
// 这里逐目录判断「marker 指向的会话是否真的存在」，据此决定保留还是删除。
// [失败路径] 判断本身失败（listSessions 抛错）时一律保留：
// 宁可留下垃圾目录，也不能把暂时性错误升级成删除用户已导入的结果物。
  private async cleanupAbandonedImports(): Promise<void> {
    if (!this.zcodeSessionService) return;
    await this.completedImportsLoaded;
    // 只扫描默认 conversation workspace 的 import-owned 子目录；其它 workspace 的 marker
    // 在下一次带 target 的导入请求中处理，避免启动期枚举并触碰用户项目目录。
    const shareRoot = join(this.conversationWorkspaceRoot, ".zcode-share");
// 目录不存在是正常情况（从未导入过），因此 readdir 失败直接当空列表，
// 不能让一次启动清扫把 Host 启动流程打断。
    const imports = await readdir(shareRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of imports) {
      if (!entry.isDirectory()) continue;
      const importRoot = join(shareRoot, entry.name);
      const markerPath = join(importRoot, ".zcode-share-import.json");
      let marker: {
        sessionId?: unknown;
        shareCode?: unknown;
        clientRequestId?: unknown;
        workspaceKey?: unknown;
        contextId?: unknown;
        shareUrl?: unknown;
      };
      try {
        marker = JSON.parse(await readFile(markerPath, "utf8")) as typeof marker;
      } catch {
        continue;
      }
// 只处理本服务创建的会话前缀：目录里可能有人手放的文件或其它功能的 marker，
// 前缀不匹配就跳过，绝不删除不属于导入的目录。
      if (typeof marker.sessionId !== "string" || !marker.sessionId.startsWith("share-import-"))
        continue;
      try {
// 每个目录都单独查一次会话列表而不是一次性缓存全量：导入目录数量通常是个位数，
// 而缓存全量列表会在长会话列表下占用更多内存；limit 100 覆盖单个 workspace 的常见规模。
        const sessions = await this.zcodeSessionService.listSessions({
          workspacePath: this.conversationWorkspaceRoot,
          limit: 100,
        });
        const session = sessions.find((item) => item.sessionId === marker.sessionId);
        if (session) {
          if (
            typeof marker.shareCode === "string" &&
            typeof marker.clientRequestId === "string" &&
            typeof marker.contextId === "string" &&
            typeof marker.shareUrl === "string"
          ) {
            const workspaceKeyedShare = importDedupeKey(
              marker.shareCode,
              typeof marker.workspaceKey === "string"
                ? marker.workspaceKey
                : this.conversationWorkspaceRoot,
            );
            const result: ImportConversationShareResult = {
              workspacePath: this.conversationWorkspaceRoot,
              sessionId: session.sessionId,
              contextId: marker.contextId,
              shareUrl: marker.shareUrl,
              title: session.title,
              reused: true,
            };
            this.completedImports.set(
              `${workspaceKeyedShare}\u0000${marker.clientRequestId}`,
              result,
            );
            this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
            await this.persistCompletedImportIndex().catch(() => undefined);
          }
// 会话存在即视为导入成功：把内存表补齐（等价于「发现了一条历史完成记录」）
// 后删掉 marker，之后同一 share 的导入请求会命中幂等表而不是重新下载。
// 不删 importRoot：会话仍然引用里面的结果物。
          await rm(markerPath, { force: true });
        } else {
          // 只删除带合法 marker 且没有匹配 session 的本次 importRoot。
          await rm(importRoot, { recursive: true, force: true });
        }
      } catch {
        // 无法证明 session 状态时保留 importRoot，禁止把暂时性错误升级为数据删除。
      }
    }
  }

// 产物清单的本地校验：数量、单文件大小、类型白名单、id 唯一性、声明总量。
// 全部基于 descriptor 的声明值，不读盘也不信任字节，因此可在上传前快速失败。
// 返回 issues 而不是抛错，是为了让上层能一次展示所有不合格项（含允许的格式列表）。
  private collectArtifactManifestIssues(
    capabilities: ConversationShareCapabilities,
    artifacts: Array<{
      sourceRef: string;
      descriptor: ConversationShareArtifactDescriptor;
    }>,
  ): ConversationShareFailureIssue[] {
// 用 Set 而不是数组做查重：清单规模受 max_artifact_count 限制，但重复 id 会导致
// 服务端主键冲突，必须在本地先拦下。
    const artifactIds = new Set<string>();
    const issues: ConversationShareFailureIssue[] = [];
// 数量超限只报一条 conversation 级 issue，不为每个多余产物重复报错。
    if (artifacts.length > capabilities.max_artifact_count) {
      issues.push({
        code: "artifact_count_limit",
        scope: "conversation",
        actual: artifacts.length,
        limit: capabilities.max_artifact_count,
      });
    }
// 增量累加而不是事后 reduce：重复 id 已被 continue 跳过，因此这里统计的是
// 「唯一产物」的声明总量，与最终上传的字节集合一致。
    let declaredTotalBytes = 0;
    for (const { descriptor } of artifacts) {
// 重复 id 直接跳过后续检查：重复项的错误信息只会干扰用户，
// 真正要修的是「为什么同一个 artifact_id 出现了两次」。
      if (artifactIds.has(descriptor.artifact_id)) {
        issues.push({
          code: "artifact_manifest",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
        });
        continue;
      }
      artifactIds.add(descriptor.artifact_id);
// 用声明值而非实际读取长度：这一步发生在读盘之前，因此只能按 manifest 计算。
      declaredTotalBytes += descriptor.size_bytes;
      if (descriptor.size_bytes > capabilities.max_artifact_bytes) {
        issues.push({
          code: "artifact_size_limit",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
          artifactType: descriptor.artifact_type,
          extension: descriptor.extension,
          mimeType: descriptor.mime_type,
          actual: descriptor.size_bytes,
          limit: capabilities.max_artifact_bytes,
        });
      }
// 类型/扩展名/MIME 三元组必须同时命中：只看扩展名会被改名的可执行文件绕过，
// 只看 MIME 则会被错误的 content-type 误放行。
// 扩展名比较先去掉前导点再 toLowerCase，因为能力清单与服务端回写的大小写不一致。
// 未命中时下面的 issue 会带上完整允许列表，用户不必再去别处查「到底能传什么」。
      const allowed = capabilities.allowed_artifacts.some(
        (candidate) =>
          candidate.type === descriptor.artifact_type &&
          candidate.extensions.some(
            (extension) => extension.replace(/^\./u, "").toLowerCase() === descriptor.extension,
          ) &&
          candidate.mime_types.some(
            (mimeType) => mimeType.toLowerCase() === descriptor.mime_type.toLowerCase(),
          ),
      );
      if (!allowed) {
        issues.push({
          code: "artifact_type_not_allowed",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
          artifactType: descriptor.artifact_type,
          extension: descriptor.extension,
          mimeType: descriptor.mime_type,
          allowedFormats: allowedFormatLabels(capabilities),
          allowedArtifacts: allowedArtifactSummaries(capabilities),
        });
      }
    }
// 总量在循环结束后统一判断，单文件都合规也可能合计超限。
    if (declaredTotalBytes > capabilities.max_total_artifact_bytes) {
      issues.push({
        code: "artifact_total_size_limit",
        scope: "conversation",
        actual: declaredTotalBytes,
        limit: capabilities.max_total_artifact_bytes,
      });
    }
    return issues;
  }

// 把 issues 翻译成异常：调用方只关心「能不能继续」，不需要知道具体哪条限制。
// 错误分类影响 UI 文案与重试策略，因此不在内部抛，而由这里统一映射。
  private validateArtifactManifest(
    capabilities: ConversationShareCapabilities,
    artifacts: Array<{
      sourceRef: string;
      descriptor: ConversationShareArtifactDescriptor;
    }>,
  ): void {
    const issues = this.collectArtifactManifestIssues(capabilities, artifacts);
    if (issues.length > 0) {
// 混合问题时优先报 artifact_not_allowed：它需要用户删除/更换内容，
// 而 limit_exceeded 只需减少数量或体积，两者的可操作建议完全不同。
      const hasTypeIssue = issues.some((issue) => issue.code === "artifact_type_not_allowed");
      throw new ConversationShareServiceError(
        hasTypeIssue ? "artifact_not_allowed" : "limit_exceeded",
        "Conversation artifacts cannot be shared",
        { issues },
      );
    }
  }

// confirm 的 3215（safety_check_pending）是非终态：同一 preparation + 同一 DTO 串行重试，
// 直到拿到终态记录、超时、或遇到真正的错误。
// [并发] 这里刻意不并发重试：同一 preparation 并发 confirm 可能被服务端判为重复提交。
// [资源] 每次重试都复用同一个 confirmRequest 对象，不重新构建载荷，避免摘要漂移。
  private async confirmUntilReady(
    preparationId: string,
    request: ConversationShareConfirmRequest,
  ): Promise<ConversationShareRecord> {
// 截止时间惰性初始化：只有真的遇到 3215 才开始计时，
// 这样上传耗时不会被算进「安全检查等待」预算里。
    let deadline: number | undefined;
    let lastRequestId: string | undefined;
    let lastStatus: number | undefined;
    let lastCode: number | undefined;
    while (true) {
      try {
        return await this.client.confirm(preparationId, request);
      } catch (error) {
        if (
          !(error instanceof ConversationShareClientError) ||
          error.kind !== "safety_check_pending"
        ) {
          throw error;
        }
        lastRequestId = error.requestId ?? lastRequestId;
// 逐次记录最后一次 3215 的 requestId/status/code：超时错误必须带上它们，
// 否则线上只能看到「超时」而无法定位是哪一次检查卡住。
        lastStatus = error.status ?? lastStatus;
        lastCode = error.code ?? lastCode;

        // 3215 是后端安全检查的非终态，同一 preparation/DTO 必须串行重试；
        // 不能重新 prepare，也不能无限等待。
        const currentTime = this.now();
// 用 ??= 而不是赋值：多次 3215 共享同一个截止时间，超时是总预算而非每次重试的预算。
        deadline ??= currentTime + this.confirmPollTimeoutMs;
        const remainingMs = deadline - currentTime;
        if (remainingMs <= 0) {
          throw new ConversationShareServiceError(
            "safety_check_timeout",
            "Conversation share safety check timed out",
            {
              ...(lastRequestId === undefined ? {} : { requestId: lastRequestId }),
              ...(lastStatus === undefined ? {} : { status: lastStatus }),
              ...(lastCode === undefined ? {} : { code: lastCode }),
            },
          );
        }
// 服务端 Retry-After 优先，但必须 min 到剩余时间：否则一次过长的建议等待会让
// 本次调用越过截止时间却仍在 sleep，用户看到的超时会滞后。
        const requestedDelayMs = error.retryAfterMs ?? this.confirmPollIntervalMs;
        await this.sleep(Math.min(requestedDelayMs, remainingMs));
// 睡醒后再判一次：sleep 可能被测试注入或受事件循环延迟影响，
// 不能假设实际等待时长正好等于请求的延迟。
        if (this.now() >= deadline) {
          throw new ConversationShareServiceError(
            "safety_check_timeout",
            "Conversation share safety check timed out",
            {
              ...(lastRequestId === undefined ? {} : { requestId: lastRequestId }),
              ...(lastStatus === undefined ? {} : { status: lastStatus }),
              ...(lastCode === undefined ? {} : { code: lastCode }),
            },
          );
        }
      }
    }
  }

// 分批向前读取会话行（beforeRowId 游标），并在每批之后复验水位。
// [事务] 语义上是一次「快照读」：所有批次必须来自同一 revision + logEpoch，
// 否则宁可失败也不能拼接出跨版本的会话。
// 返回顺序为 rowId 升序，与协议全局序一致。
  private async loadAllRows(
    input: Pick<
      PublishTextConversationInput,
      "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
    >,
    agentService: ConversationShareAgentService,
  ): Promise<ConversationRowsRead> {
// 协议只支持向前翻页，因此页是倒序拿到的；这里按页保存，最后一次性 flat，
// 避免每页都做一次 O(n) 的头部插入。
    const pages: ConversationRow[][] = [];
    let beforeRowId: number | undefined;
    let logEpoch: string | undefined;
    let revision: number | undefined;

    while (true) {
      const result = await agentService.conversationRowsRangeV4({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
        sessionId: input.sessionId,
        ...(beforeRowId === undefined ? {} : { beforeRowId }),
        limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
      });
      if (
// 首屏不比较（还没有基准值），之后每一页都必须与首屏一致。
// logEpoch 管「日志是否被重写」，revision 管「是否有新行写入」，两者缺一不可。
        (logEpoch !== undefined && result.atLogEpoch !== logEpoch) ||
        (revision !== undefined && result.atRevision !== revision)
      ) {
        throwServiceError("invalid_conversation", "Conversation changed while preparing share");
      }
      logEpoch = result.atLogEpoch;
      revision = result.atRevision;
// 页数与页大小都有上限（会话长度受协议限制），unshift 的搬移成本可接受。
      pages.unshift(result.rows);
      if (!result.hasMore) break;
// 游标必须严格前进：hasMore 为真但首个 rowId 没变，说明服务端分页实现有问题，
// 继续循环会变成死循环，因此这里主动失败。
      const firstRowId = result.rows[0]?.rowId;
      if (firstRowId === undefined || firstRowId === beforeRowId) {
        throwServiceError("invalid_contract", "Conversation row pagination did not advance");
      }
      beforeRowId = firstRowId;
    }

// 拼接后仍要自证顺序：协议承诺全局有序，但跨页边界最容易出现重复行。
    const rows = pages.flat();
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!;
      const current = rows[index]!;
// 用 >= 而不是 >：重复 rowId 同样是非法的，它会让后续按 rowId 建索引时静默丢行。
      if (previous.rowId >= current.rowId) {
        throwServiceError("invalid_contract", "Conversation rows are not globally ordered");
      }
    }
// 空会话也会走完循环，此时两个水位仍未赋值；没有水位就无法在后续阶段复验一致性，
// 因此空会话也要求服务端给出水位，缺了按协议违约处理。
    if (logEpoch === undefined || revision === undefined) {
      throwServiceError("invalid_contract", "Conversation rows are missing a read watermark");
    }
    return { rows, revision, logEpoch };
  }
}
