/* oxlint-disable eslint(max-lines) -- 公开 Row 的 allow-list 构建与闭包校验必须同处一个策略边界，拆分会让 builder/validator 规则漂移。 */
import {
// 公开投影：把本机会话行改写成「跨账号、跨版本、无本地身份」的分享行。
// 做法是 allow-list 重建 + ID 重编号 + 引用闭包校验，而不是删字段式浅拷贝。
// INV-01：公开行必须整体闭合：所有 turnId/entityId/toolCallId/artifactVersionId 都已被重编号（守住它：requiredMappedId）。
// INV-02：任何本地读取引用（zcode-artifact://、file:、data:）都不得出现在公开载荷里（守住它：assertSafeString）。
// INV-03：进行中/流式的行不得分享，否则接收者会看到永远不结束的会话（守住它：assertTerminalAndSafe）。
// INV-04：rowId 必须从 1 连续递增，productTurn 必须各有一个 header（守住它：validator 的两处遍历）。
// 改错后果：接收端解析失败、导入出指向本机路径的悬空引用，或分享内容泄漏 Host 内部命令/工作流身份。
// [权衡] builder 与 validator 放在同一文件，是为了让「允许的字段」与「校验的字段」在同一处演进；
// 拆开后最容易出现的故障是 builder 加了新字段而 validator 没跟上，反之亦然。
  projectShareToolDisplay,
  conversationShareContentBlockSchema,
  type ConversationShareContentBlock,
  type ConversationShareArtifactDescriptor,
} from "@zcode/shared";
import { toolCallDisplaySchema } from "@zcode/shared/zcode-protocol-v4";
import type { ArtifactRow, ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";

import { ConversationShareServiceError } from "./conversationShare.js";

import type { ShareContentDraft } from "./conversationShareWorkflowSnapshot.js";

// selectedProductTurnIds 是重编号后的 ID，不是原始 ID：它是分享侧的稳定标识，
// 服务端与导入端只认这个，原始 productTurnId 不离开本机。
// artifacts 是 manifest 的来源：每个 artifact 行必须在这里有一条 descriptor。
// contentBlocks 可选：老版本或纯文本会话没有结构化卡片。
export interface ConversationSharePublicProjection {
  contentBlocks?: ConversationShareContentBlock[];
  rows: ConversationRow[];
  selectedProductTurnIds: string[];
  artifacts: ConversationSharePublicArtifact[];
}

// sourceRef 是本地取字节的键，descriptor 是公开描述；两者在分享后不再同源，
// 因此需要成对保存，上传阶段用 sourceRef 找字节，manifest 用 descriptor。
export interface ConversationSharePublicArtifact {
  sourceRef: string;
  descriptor: ConversationShareArtifactDescriptor;
}

// 六张映射表覆盖所有会被引用的 ID 类型；缺一类就会出现「原样泄漏本机 ID」。
interface PublicIdMaps {
  productTurnIds: Map<string, string>;
  turnIds: Map<string, string>;
  entityIds: Map<string, string>;
  toolCallIds: Map<string, string>;
  artifactIds: Map<string, string>;
  artifactKeys: Map<string, string>;
}

// 这三种状态都表示工具尚未定稿：参数可能还在流入、审批可能被拒、结果可能还会追加。
// 用 Set 而不是取反判断，是为了在协议新增终态时默认「不认识即不放行」需要显式补充。
const ACTIVE_TOOL_STATUSES = new Set(["inputStreaming", "pendingApproval", "running"]);
// 公开 ID 的形状在校验期是硬约束：它让「原始 ID 漏进载荷」变成可检测的错误，
// 而不是只能靠人工 review 发现。[1-9]\d* 排除 0 与前导零，保证与 allocateIds 的编号完全一致。
const PUBLIC_PRODUCT_TURN_ID = /^share-product-turn-[1-9]\d*$/u;
const PUBLIC_TURN_ID = /^share-turn-[1-9]\d*$/u;
const PUBLIC_ENTITY_ID = /^share-entity-[1-9]\d*$/u;
const PUBLIC_TOOL_CALL_ID = /^share-tool-call-[1-9]\d*$/u;
const PUBLIC_ARTIFACT_ID = /^share-artifact-[1-9]\d*$/u;

// 统一抛 invalid_conversation，并带上 rowKind/rowId/field 便于定位；
// diagnostics 只放结构性字段（不含具体值），因此可以安全跨 RPC。
function throwProjectionError(
  kind: ConstructorParameters<typeof ConversationShareServiceError>[0],
  message: string,
  diagnostics?: { rowKind?: string; rowId?: number; field?: string },
): never {
  throw new ConversationShareServiceError(kind, message, { diagnostics });
}

// 深度遍历所有字符串：安全规则要覆盖嵌套的 marker/output/segments，
// 只检查顶层字段会漏掉 `marker.sourceRef` 这类深层引用。
// 只看 string/array/object 三种，其它标量与 null 直接忽略。
function visitStrings(value: unknown, visitor: (value: string) => void): void {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) visitStrings(entry, visitor);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      visitStrings(entry, visitor);
    }
  }
}

// zcode-artifact:// 与 file:/data: 的处理不同：前者本应被正式 artifact 行替代，
// 属于「协议未就绪」；后者是本地/内联资源，属于不安全结构。
// 分类不同是为了让 UI 给出不同建议：升级客户端 vs 删除该内容。
function assertSafeString(value: string): void {
  if (/^zcode-artifact:\/\//iu.test(value)) {
    throwProjectionError(
      "artifact_protocol_not_ready",
      "Artifact references must be represented by formal conversation artifact rows",
    );
  }
  if (/^(?:data|file):/iu.test(value)) {
    throwProjectionError("unsafe_structure", "Local and inline URLs cannot be shared");
  }
}

// display 的闭集独立于 row.kind 演进；复用正式 schema，避免浅拷贝把未知嵌套字段送到 confirm。
// 复用正式 schema 解析后再重建，而不是浅拷贝：display 是联合类型，
// 浅拷贝会把新版本新增的嵌套字段原样带到 confirm 请求里。
// 解析失败说明本地数据已损坏或版本超前，直接失败而不是丢掉 display。
function projectToolDisplay(row: ToolCallRow) {
  const parsed = toolCallDisplaySchema.safeParse(row.display);
  if (!parsed.success) {
    throwProjectionError("invalid_conversation", "Invalid tool display in shared conversation", {
      rowKind: row.kind,
      rowId: row.rowId,
      field: ["display", ...(parsed.error.issues[0]?.path ?? [])].join("."),
    });
  }
  // 插件交互资源属于宿主能力，公开卡片只保留 MCP 的静态描述。
// mcp_tool 的 ui 字段是插件交互资源（可执行 UI），属于宿主能力，
// 公开卡片只保留静态描述；这里用解构丢弃而不是逐字段挑，避免漏字段。
  if (parsed.data.kind === "mcp_tool") {
    const { ui: _ui, ...display } = parsed.data;
    return display;
  }
  return parsed.data;
}

// 只接受 share 命名空间下的引用：`zcode-artifact://share/<id>`。
// 字符集限制为 URL-safe 集合，防止 id 里带路径分隔符或查询串改变语义。
function isPublicArtifactRef(value: string): boolean {
  return /^zcode-artifact:\/\/share\/[A-Za-z0-9._~-]+$/u.test(value);
}

// 前置闸门：所有行必须已定稿且不含本地读取引用。builder 与 validator 都先调它，
// 保证两处对「什么可以分享」的判断不会分叉。
// [失败路径] 这里全部是硬失败：定稿状态是分享语义的前提，无法降级。
// 每类行只检查自己可能出现的「进行中」字段，而不是统一看 status，
// 因为不同 kind 的状态枚举并不一致。
// 顺序无所谓，但都要在投影前完成，避免后续 builder 处理半成品数据。
function assertTerminalAndSafe(rows: ConversationRow[]): void {
  for (const row of rows) {
// 没有轮次归属的行无法挂到任何 productTurn 上，重编号时必然失败；提前报错能指明具体行。
    if (row.productTurnId === undefined) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation row is missing its product turn identity",
      );
    }
// 运行中的轮次仍在写文件与追加行，分享出去必然与最终状态不一致。
    if (row.kind === "turnHeader" && row.state === "running") {
      throwProjectionError("invalid_conversation", "Running turns cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
// streaming 行的 text 只是当前片段，接收者会看到半句话；这与「分享一次已完成对话」的语义冲突。
    if ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") {
      throwProjectionError("invalid_conversation", "Streaming rows cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
    if (row.kind === "toolCall" && ACTIVE_TOOL_STATUSES.has(row.status)) {
      throwProjectionError("invalid_conversation", "Active tool calls cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
// 子代理本身在 V1 投影里会被过滤掉，但这里仍要拦 running：
// 过滤发生在 builder，validator 面对的是任意输入，必须独立成立。
    if (row.kind === "subagent" && row.status === "running") {
      throwProjectionError("invalid_conversation", "Active subagents cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
    if (
      row.kind === "timelineMarker" &&
      ((row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running"))
    ) {
      throwProjectionError("invalid_conversation", "Active timeline operations cannot be shared");
    }
    if (row.kind === "toolCall") {
      if (row.display?.kind === "node_repl_images") {
        throwProjectionError("unsafe_structure", "Inline tool images cannot be shared", {
          rowKind: row.kind,
          rowId: row.rowId,
        });
      }
    }
    if (row.kind === "timelineMarker") {
      if (
        row.marker.type === "forkNotice" ||
        row.marker.type === "forkCreated" ||
        row.marker.type === "checkpointRestored"
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Timeline references outside the shared projection are not supported",
        );
      }
      if (row.marker.type === "compact" && row.marker.summaryRef !== undefined) {
        throwProjectionError(
          "artifact_protocol_not_ready",
          "Conversation summary references require the artifact row protocol",
        );
      }
    }
    // artifact.ref 是 Host 内部授权的读取引用，公开投影会替换；它不能参与通用 URL 泄漏检查。
    if (row.kind === "artifact") {
// artifact 行的 ref 是本机授权读取引用，投影阶段会被替换成公开 ref，
// 所以不能拿它做通用 URL 检查；其余字段仍要逐个查。
// [失败路径] 若某处忘记替换 ref，validator 的 ref 形状检查会兜住。
      const { ref: _localRef, ...safeFields } = row;
      visitStrings(safeFields, assertSafeString);
// 工具输出只保留 text：truncated.ref 是本地按需读取大输出的句柄，
// 它不会出现在请求里，纳入安全校验会误伤同轮的正式结果物。
    } else if (row.kind === "toolCall" && row.output) {
      // truncated.ref 只用于本地按需读取大工具输出，公开投影本来就只保留 output.text；
      // 对不会出现在请求里的内部 ref 做安全校验会误阻断同一轮正式结果物上传。
      visitStrings({ ...row, output: { text: row.output.text } }, assertSafeString);
    } else if (row.kind === "userInput") {
// 附件单独处理：合法的附件 ref 本来就是 zcode-artifact://share/...，
// 若参与通用检查会被自己拦下；合法性由附件分支的 isPublicArtifactRef 负责。
      const { attachments: _attachments, ...safeFields } = row;
      visitStrings(safeFields, assertSafeString);
    } else {
      visitStrings(row, assertSafeString);
    }
  }
}

// 重编号规则：按首次出现顺序分配 prefix-1、prefix-2……，保证同输入同输出。
// 已存在的键不重复分配，这样同一实体的多次引用会映射到同一个公开 ID。
// 用 result.size + 1 而不是外部计数器，避免跳过重复项后出现空洞。
function allocateIds(values: Iterable<string>, prefix: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    if (!result.has(value)) {
      result.set(value, `${prefix}-${result.size + 1}`);
    }
  }
  return result;
}

// 引用闭包的核心：映射不到就说明该 ID 来自未选择的内容或已被过滤，
// 此时必须失败而不是回落成原值——回落正是本地 ID 泄漏的典型路径。
// label 只用于错误文案，让用户知道是哪类引用越界。
function requiredMappedId(ids: Map<string, string>, sourceId: string, label: string): string {
  const mapped = ids.get(sourceId);
  if (!mapped) {
    throwProjectionError(
      "invalid_conversation",
      `Conversation ${label} reference is outside the shared projection`,
    );
  }
  return mapped;
}

// 六类 ID 全部从「实际保留的行」里收集，而不是从原始全量行：
// 这样被过滤掉的 subagent/hook 行不会占用编号，公开 ID 保持连续。
// productTurn 用显式选择列表而不是从行推导，保证顺序与用户选择一致。
// entityId 用 flatMap 过滤 undefined：可选字段直接 map 会得到 undefined 条目。
function buildIdMaps(rows: ConversationRow[], selectedProductTurnIds: string[]): PublicIdMaps {
  return {
    productTurnIds: allocateIds(selectedProductTurnIds, "share-product-turn"),
    turnIds: allocateIds(
      rows.map((row) => row.turnId),
      "share-turn",
    ),
    entityIds: allocateIds(
      rows.flatMap((row) => (row.entityId ? [row.entityId] : [])),
      "share-entity",
    ),
    toolCallIds: allocateIds(
      rows.flatMap((row) => (row.kind === "toolCall" ? [row.toolCallId] : [])),
      "share-tool-call",
    ),
    artifactIds: allocateIds(
      rows.flatMap((row) => (row.kind === "artifact" ? [row.artifactVersionId] : [])),
      "share-artifact",
    ),
    artifactKeys: allocateIds(
      rows.flatMap((row) => (row.kind === "artifact" ? [row.logicalArtifactKey] : [])),
      "share-artifact-key",
    ),
  };
}

// 所有 kind 共用的字段在这里统一重建：rowId 改为连续序号，
// 其余 ID 一律走映射，visibility/时间戳原样复制（它们不含本地身份）。
function projectBase(row: ConversationRow, index: number, ids: PublicIdMaps) {
  if (!row.productTurnId) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation row is missing its product turn identity",
    );
  }
  return {
// 用数组下标重编号而不是保留原 rowId：原值是本机会话内的全局序号，
// 既会泄漏「这条消息在本地是第几条」，也会在被过滤后出现空洞。
// createdAt/createdAtSeq 保留，因为接收端需要按时间线排序。
    rowId: index + 1,
    turnId: requiredMappedId(ids.turnIds, row.turnId, "turn"),
    ...(row.entityId
      ? {
          entityId: requiredMappedId(ids.entityIds, row.entityId, "entity"),
        }
      : {}),
    productTurnId: requiredMappedId(ids.productTurnIds, row.productTurnId, "product turn"),
    ...(row.visibility ? { visibility: row.visibility } : {}),
    createdAt: row.createdAt,
    createdAtSeq: row.createdAtSeq,
  } as const;
}

// marker 也需要重建：compact 带 token 统计，其余类型目前全是可公开的静态字段。
// fork/checkpoint 类 marker 指向分享范围之外的历史，必须整体拒绝。
function projectTimelineMarker(
  row: Extract<ConversationRow, { kind: "timelineMarker" }>,
): Extract<ConversationRow, { kind: "timelineMarker" }>["marker"] {
  switch (row.marker.type) {
// compact 显式挑字段而不是展开：它可能带 summaryRef（见上面的安全检查），
// 展开会把未来新增的本地字段一起带出去。
    case "compact":
      return {
        type: "compact",
        origin: row.marker.origin,
        status: row.marker.status,
        ...(row.marker.tokensBefore === undefined ? {} : { tokensBefore: row.marker.tokensBefore }),
        ...(row.marker.tokensAfter === undefined ? {} : { tokensAfter: row.marker.tokensAfter }),
      };
// 其余 marker 目前无本地引用，整体展开即可；新增字段时需回到这里确认。
    case "modelChange":
      return { ...row.marker };
    case "goalSet":
      return { ...row.marker };
    case "goalVerify":
      return { ...row.marker };
    case "retryNotice":
      return { ...row.marker };
// 三种 fork/checkpoint marker 都引用分享范围之外的会话历史，无法在公开载荷里表达，
// 与前置检查保持一致地抛错。
    case "forkNotice":
    case "forkCreated":
    case "checkpointRestored":
      throwProjectionError(
        "invalid_conversation",
        "Timeline references outside the shared projection are not supported",
      );
  }
}

/**
 * 每类 Row 用 allow-list 新建对象。
 *
 * 这个 switch 故意穷尽且**不带 default**：返回类型非可选，所以 conversationRowSchema 新增
 * 一种 kind 时这里会编译失败。那是有意的闸门——公开投影是跨版本数据交换格式，往里加一种
 * 老客户端读不了的 kind 必须是个显式决定，不能靠 default 悄悄放过去。
 */
// 每种 kind 用字面量重建对象，且不使用 default：新增 kind 时这里编译失败，
// 强迫作者显式决定「这个新结构能不能公开」。
// 可选字段统一用「undefined 才省略」的展开，避免向 RPC 发送显式 undefined。
function projectRow(row: ConversationRow, index: number, ids: PublicIdMaps): ConversationRow {
  const base = projectBase(row, index, ids);
  switch (row.kind) {
// workSegments 里的 triggerEntityId 也要重映射：它是本地实体 ID，
// 直接复制会同时泄漏并破坏引用闭包。
    case "turnHeader":
      return {
        ...base,
        kind: "turnHeader",
        origin: row.origin,
        ...(row.executionKind ? { executionKind: row.executionKind } : {}),
        state: row.state,
        startedAt: row.startedAt,
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
        ...(row.activeMs === undefined ? {} : { activeMs: row.activeMs }),
        ...(row.workSegments
          ? {
              workSegments: row.workSegments.map((segment) => ({
                segmentId: segment.segmentId,
                ...(segment.triggerEntityId
                  ? {
                      triggerEntityId: requiredMappedId(
                        ids.entityIds,
                        segment.triggerEntityId,
                        "work segment entity",
                      ),
                    }
                  : {}),
                startedAt: segment.startedAt,
                ...(segment.endedAt === undefined ? {} : { endedAt: segment.endedAt }),
                ...(segment.activeMs === undefined ? {} : { activeMs: segment.activeMs }),
              })),
            }
          : {}),
        ...(row.fileChanges ? { fileChanges: { ...row.fileChanges } } : {}),
      };
// userInput 是唯一允许带附件的行；originMeta 只保留展示性字段：
// backgroundSource/senderLabel 可公开，workId 等写入身份必须丢弃。
// 空 originMeta 不输出：否则接收端会看到一个空对象并误以为有元数据。
    case "userInput": {
      const originMeta = row.originMeta
        ? {
            ...(row.originMeta.backgroundSource
              ? { backgroundSource: row.originMeta.backgroundSource }
              : {}),
            ...(row.originMeta.senderLabel ? { senderLabel: row.originMeta.senderLabel } : {}),
          }
        : undefined;
// 非法引用直接丢弃而不是抛错：input 附件由发现阶段改写，
// 没被改写的（类型不支持）本来就应视为「没有可分享附件」。
// previewRef 若存在也必须合法，否则同一份内容会带出一个本地预览句柄。
      const attachments = row.attachments?.flatMap((attachment) => {
        if (!isPublicArtifactRef(attachment.ref)) return [];
        if (attachment.previewRef !== undefined && !isPublicArtifactRef(attachment.previewRef)) {
          return [];
        }
        return [
          {
            ref: attachment.ref,
            fileName: attachment.fileName,
            mime: attachment.mime,
            bytes: attachment.bytes,
            ...(attachment.previewRef ? { previewRef: attachment.previewRef } : {}),
          },
        ];
      });
      return {
        ...base,
        kind: "userInput",
        text: row.text,
        origin: row.origin,
        ...(originMeta && Object.keys(originMeta).length > 0 ? { originMeta } : {}),
        ...(row.guided ? { guided: row.guided } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
    }
// 正文类行只保留 text/state/model，feedback 等本地标注不公开。
    case "assistantText":
      return {
        ...base,
        kind: "assistantText",
        text: row.text,
        state: row.state,
        ...(row.model ? { model: row.model } : {}),
      };
// reasoning 的 durationMs 是展示信息，可公开；模型名在 reasoning 行上没有，故不处理。
    case "reasoning":
      return {
        ...base,
        kind: "reasoning",
        text: row.text,
        state: row.state,
        ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
      };
// 工具行的 output 只保留 text，display 通过 projectToolDisplay 走 schema 闭集，
// progress/approvalInteractionId/workId 等运行态字段一律不复制。
// error 整体展开：它只含规范化错误信息，不含本地路径。
    case "toolCall":
      return {
        ...base,
        kind: "toolCall",
        toolCallId: requiredMappedId(ids.toolCallIds, row.toolCallId, "tool call"),
        toolName: row.toolName,
        status: row.status,
        inputText: row.inputText,
        ...(row.input === undefined ? {} : { input: row.input }),
        ...(row.output ? { output: { text: row.output.text } } : {}),
        ...(row.display ? { display: projectToolDisplay(row) } : {}),
        ...(row.error ? { error: { ...row.error } } : {}),
        ...(row.backgrounded ? { backgrounded: row.backgrounded } : {}),
        ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
      };
// artifact 行的 ref 必须重写成基于新 artifactVersionId 的 share 引用，
// 这是「公开引用闭合」的关键一步，也是 validator 会逐行核对的形状。
// sha256/size 原样保留，导入端据此校验下载字节。
    case "artifact": {
      const artifactVersionId = requiredMappedId(
        ids.artifactIds,
        row.artifactVersionId,
        "artifact",
      );
      return {
        ...base,
        kind: "artifact",
        artifactVersionId,
        logicalArtifactKey: requiredMappedId(
          ids.artifactKeys,
          row.logicalArtifactKey,
          "artifact key",
        ),
        displayName: row.displayName,
        artifactType: row.artifactType,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        ref: `zcode-artifact://share/${artifactVersionId}`,
        state: row.state,
      };
    }
// lane 是展示用的泳道标识，可公开；marker 交给专用投影函数处理。
    case "timelineMarker":
      return {
        ...base,
        kind: "timelineMarker",
        ...(row.lane ? { lane: row.lane } : {}),
        marker: projectTimelineMarker(row),
      };
// subagent 详情包含子会话的完整上下文，V1 投影明确不支持；
// builder 已提前过滤，走到这里说明调用方绕过了 builder。
    case "subagent":
      throwProjectionError(
        "invalid_conversation",
        "Subagent detail rows must be filtered before public projection",
      );
// hook 调用含本机脚本路径与执行环境，属于宿主实现细节，不进入公开格式。
    case "hookInvocation":
      throwProjectionError(
        "invalid_conversation",
        "Hook invocation rows are not part of the V1 public projection",
      );
  }
}

// 唯一性用 Set 大小比较：重复 ID 会让接收端按 ID 建索引时互相覆盖，
// 表现为「两条消息只剩一条」，比解析失败更难排查。
function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throwProjectionError(
      "invalid_conversation",
      `Conversation public ${label} identities must be unique`,
    );
  }
}

// 投影的独立校验器：它只依赖公开行自身的形状，不信任 builder 做过什么。
// 这样即使调用方手工构造 projection（或 builder 被改坏），也能在发送前拦下。
// 校验分四段：终态与安全 → ID 唯一性与形状 → 逐行身份闭包 → 跨行引用闭包。
// 全部失败都归为 invalid_conversation：这是本端构造的载荷有问题，不是服务端错误。
// [权衡] `assertConversationSharePublicProjection` 用 O(n) 多趟遍历而非单趟：清晰度优先，分享行数远小于性能敏感区。
export function assertConversationSharePublicProjection(input: {
  rows: ConversationRow[];
  selectedProductTurnIds: string[];
}): void {
// 空行或空选择都无意义：服务端会拒绝，但在这里失败能给出更准确的本地错误。
  if (input.rows.length === 0 || input.selectedProductTurnIds.length === 0) {
    throwProjectionError("invalid_conversation", "Conversation public projection cannot be empty");
  }
  assertTerminalAndSafe(input.rows);
// 选择列表先查重：重复选择会让 productTurn 映射只保留一个，
// 后续「每个 productTurn 恰好一个 header」的检查就会得到误导性结论。
  assertUnique(input.selectedProductTurnIds, "product turn");
  if (
    input.selectedProductTurnIds.some(
      (productTurnId) => !PUBLIC_PRODUCT_TURN_ID.test(productTurnId),
    )
  ) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation public product turn identity is invalid",
    );
  }

  const selectedProductTurnIds = new Set(input.selectedProductTurnIds);
// headerCounts 统计每个轮次的 turnHeader 数量，用于最后检查「恰好一个」。
// toolCallIds/artifactIds 用数组是为了查重；entityIds/turnIds 用 Set 是为了查闭包。
  const headerCounts = new Map<string, number>();
// 实体集合只用于 workSegments 的引用闭包检查，不要求行间唯一。
  const entityIds = new Set<string>();
// 用数组而非 Set：这里既要去重也要拿到原始顺序，重复即报错而不是静默合并。
  const toolCallIds: string[] = [];
// artifactIds 收集版本 ID 用于跨行查重：同一版产物出现在两行会让 manifest 出现重复主键。
  const artifactIds: string[] = [];
// turnIds 只用于判断「投影里是否还存在至少一个 turn」，因此用 Set 即可。
  const turnIds = new Set<string>();

  for (const [index, row] of input.rows.entries()) {
// 行号必须严格等于下标 + 1：接收端与 service 端都假设 rowId 连续，
// 出现空洞会让分页/定位逻辑错位，且往往是「过滤后忘记重编号」的信号。
    if (row.rowId !== index + 1) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public row identities must be contiguous",
      );
    }
// turnId 形状检查同时兜住「忘重编号」与「重编号前缀写错」两类问题。
    if (!PUBLIC_TURN_ID.test(row.turnId)) {
      throwProjectionError("invalid_conversation", "Conversation public turn identity is invalid");
    }
    turnIds.add(row.turnId);
    if (
// 行所属轮次必须既合法又曾被选中：未选中的行留在载荷里等于泄漏用户没打算分享的内容。
      !row.productTurnId ||
      !PUBLIC_PRODUCT_TURN_ID.test(row.productTurnId) ||
      !selectedProductTurnIds.has(row.productTurnId)
    ) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation row belongs to an unselected product turn",
      );
    }
// entityId 形状非法说明它还是原始值；同一实体可跨多行，因此只收集不查重。
    if (row.entityId) {
      if (!PUBLIC_ENTITY_ID.test(row.entityId)) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public entity identity is invalid",
        );
      }
      // entityId 是持久实体身份，同一实体可以对应多个 Row；这里只收集引用闭包，不校验 Row 间唯一性。
// 收集合法实体 ID 供第二趟闭包检查；不查重是因为同一实体天然出现在多行。
      entityIds.add(row.entityId);
    }
// actions 是本地可执行操作（重试/复制/打开文件等），携带宿主能力句柄，
// 公开行必须完全没有这个字段，连空数组都不允许。
    if (row.actions !== undefined) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public rows cannot contain local actions",
      );
    }
// turnHeader 的 originMeta 含 workId 等本地工作身份，公开投影只允许 origin 枚举。
// 这里用 headerCounts 累加，稍后统一检查每个轮次恰好一个 header。
    if (row.kind === "turnHeader") {
// 累加而不是记录布尔：多个 header 需要被检出，用 +1 才能发现重复。
      headerCounts.set(row.productTurnId, (headerCounts.get(row.productTurnId) ?? 0) + 1);
// 公开 header 只允许 origin 枚举，originMeta 是本机工作流身份，出现即失败。
      if (row.originMeta !== undefined) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public turn headers cannot contain local work identity",
        );
      }
    } else if (row.kind === "userInput") {
      if (
        row.sourceCommandId !== undefined ||
        row.rootSourceCommandId !== undefined ||
        row.clientId !== undefined ||
        row.originMeta?.workId !== undefined ||
// 用户输入的写入身份（命令 ID、客户端 ID、会话 ID）全部禁止；
// 它们能反推出本机进程与写权限来源。
// 附件引用逐个校验形状，previewRef 存在时也必须合法。
        row.originMeta?.senderSessionId !== undefined
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public input contains local write identity",
        );
      }
// 注意这里是「抛错」而不是丢弃：走到 validator 阶段说明发现阶段已处理过，
// 仍不合法只能是构造流程被绕过。
      for (const attachment of row.attachments ?? []) {
        if (!isPublicArtifactRef(attachment.ref)) {
          throwProjectionError(
            "invalid_conversation",
            "Conversation public input attachment reference is invalid",
          );
        }
        if (attachment.previewRef !== undefined && !isPublicArtifactRef(attachment.previewRef)) {
          throwProjectionError(
            "invalid_conversation",
            "Conversation public input preview reference is invalid",
          );
        }
      }
// assistantText 的 feedback 是本地用户评价（点赞/点踩及备注），与分享内容无关。
    } else if (row.kind === "assistantText") {
// 只要字段存在就拒绝，即使是 undefined 之外的空值：投影应当从不产生该键。
      if (row.feedback !== undefined) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public assistant text contains local feedback",
        );
      }
// 工具调用 ID 必须已重编号并全局唯一；progress/approval/work 三类字段是运行态句柄，禁止出现。
    } else if (row.kind === "toolCall") {
      if (!PUBLIC_TOOL_CALL_ID.test(row.toolCallId)) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public tool call identity is invalid",
        );
      }
      toolCallIds.push(row.toolCallId);
      if (
        row.progress !== undefined ||
        row.approvalInteractionId !== undefined ||
        row.workId !== undefined
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public tool call contains local runtime identity",
        );
      }
// artifact 的 ref 必须严格等于由自身 artifactVersionId 拼出的 share 引用：
// 这条等式是「引用闭合」的最强检查，任何残留的本地 ref 都会在这里暴露。
    } else if (row.kind === "artifact") {
      if (
        !PUBLIC_ARTIFACT_ID.test(row.artifactVersionId) ||
        row.ref !== `zcode-artifact://share/${row.artifactVersionId}`
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public artifact identity is invalid",
        );
      }
      artifactIds.push(row.artifactVersionId);
// marker 的本地命令身份会指向产生该标记的命令，属于写入链路信息，禁止公开。
    } else if (row.kind === "timelineMarker") {
// timelineMarker 的 sourceCommandId 指向产生该标记的本机命令，属于写入链路身份。
      if (row.sourceCommandId !== undefined) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public timeline contains local command identity",
        );
      }
// subagent 行必须在投影前被过滤；出现在结果里说明过滤条件被改坏。
    } else if (row.kind === "subagent") {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public projection cannot contain subagent details",
      );
    }
  }

// 工具调用与产物 ID 要求全局唯一：接收端把它们当作跨行的稳定主键。
  assertUnique(toolCallIds, "tool call");
  assertUnique(artifactIds, "artifact");
// 没有任何 turn 意味着行集合不可用；通常是调用方传了空 rows 或全被过滤。
  if (turnIds.size === 0) {
    throwProjectionError("invalid_conversation", "Conversation public projection has no turns");
  }
// 每个被选中的轮次必须恰好有一个 header：零个则无法展示轮次边界，
// 多个则说明数据里存在重复 header，重编号后会出现两个同 ID 的 turn。
  for (const productTurnId of input.selectedProductTurnIds) {
    if (headerCounts.get(productTurnId) !== 1) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public product turns require exactly one header",
      );
    }
  }

  for (const row of input.rows) {
    if (row.kind !== "turnHeader") continue;
// 第二趟遍历专门检查跨行闭包：workSegments 的 triggerEntityId 必须能在本载荷里找到。
// 分两趟做是因为此时 entityIds 才收集完整，单趟无法判断前向引用。
    for (const segment of row.workSegments ?? []) {
// 这是唯一一条「行引用了另一行」的检查：workSegment 的触发实体必须在同一投影内，
// 否则接收端渲染分段时会找不到触发者。
// 引用闭包无法在单行内自证，所以必须等所有 entityId 收集完再统一验证。
      if (segment.triggerEntityId !== undefined && !entityIds.has(segment.triggerEntityId)) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation work segment entity reference is unresolved",
        );
      }
    }
  }
}

// 投影构建：过滤 → 重编号 → 逐行重建 → 生成 manifest → 追加 content blocks → 自校验。
// additionalArtifacts 来自输入附件，其 producer_product_turn_id 需要重新映射。
// toolImages 把工具行内图片的 resourceId 关联到已重编号的 artifact，使卡片能引用图片。
// sourceRows 是「过滤前的原始行」，用于取 subagent 类型与 cua 应用名等展示信息。
// [事务] 最后一定调用 validator：builder 自己保证的事，交给独立检查再确认一次。
// [失败路径] 任何一步失败都整体抛错，不返回部分投影——半份分享比失败更危险。
export function buildConversationSharePublicProjection(input: {
  rows: ConversationRow[];
  selectedProductTurnIds: string[];
  additionalArtifacts?: ConversationSharePublicArtifact[];
  contentDrafts?: ShareContentDraft[];
  toolPresentation?: boolean;
  toolImages?: ReadonlyMap<number, Array<{ resourceId: string; mimeType: string }>>;
  sourceRows?: readonly ConversationRow[];
}): ConversationSharePublicProjection {
  assertTerminalAndSafe(input.rows);
  assertUnique(input.selectedProductTurnIds, "source product turn");
// builder 入口的第一道判断：空选择直接失败，避免后面生成一个没有任何轮次的投影。
  if (input.selectedProductTurnIds.length === 0) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation product turn selection cannot be empty",
    );
  }

  const selectedProductTurnIds = new Set(input.selectedProductTurnIds);
  if (
// 用 Set 做成员判断，避免逐行线性查找选择列表。
// 同时校验「每行都属于已选轮次」：选择阶段可能漏掉行，这里必须显式失败而不是静默过滤。
    input.rows.some((row) => !row.productTurnId || !selectedProductTurnIds.has(row.productTurnId))
  ) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation rows fall outside the selected product turns",
    );
  }

  // 本地运行投影包含 subagent 详情和写入态标识，不能直接作为公开载荷；
  // 必须先过滤非 V1 Row，再基于剩余内容生成一套闭合的公开 ID。
// 先过滤 subagent 与 hookInvocation：它们含子会话上下文与本机脚本路径，
// 且 V1 公开格式没有对应 kind，留着会让 projectRow 抛错。
// 过滤后再建 ID 映射，保证公开 ID 连续无空洞（validator 会强制这一点）。
  const retainedRows = input.rows.filter(
    (row) => row.kind !== "subagent" && row.kind !== "hookInvocation",
  );
// 产物行单独抽出来生成 manifest；两个唯一性检查分别针对版本 ID 与逻辑键，
// 因为同一逻辑产物理论上可有多版本，但分享阶段只支持「一版一行」。
  const sourceArtifactRows = retainedRows.filter(
    (row): row is ArtifactRow => row.kind === "artifact",
  );
  assertUnique(
    sourceArtifactRows.map((row) => row.artifactVersionId),
// 版本 ID 重复意味着两行声明了同一版产物，manifest 会出现两条相同 artifact_id。
    "source artifact",
  );
  assertUnique(
    sourceArtifactRows.map((row) => row.logicalArtifactKey),
// 逻辑键重复说明同一产物被拆成多行；V1 只支持一版一行，必须显式拒绝。
    "source artifact logical key",
  );
// IDs 一次性建好再逐行投影：若边投影边分配，同一实体的不同行可能拿到不同编号。
  const ids = buildIdMaps(retainedRows, input.selectedProductTurnIds);
// 下标直接来自过滤后的顺序，因此 rowId 连续；这是 validator 能强制 rowId === index + 1 的原因。
  const rows = retainedRows.map((row, index) => projectRow(row, index, ids));
// manifest 的字段取自「投影后的行」而不是原始行：只有投影后的值已重编号，
// 与服务端将要看到的 rows 一致。
// 通过 artifactVersionId 映射反查投影行，避免按下标对齐（过滤后下标会错位）。
  const artifacts = sourceArtifactRows.map((sourceRow) => {
    const projected = rows.find(
      (row): row is ArtifactRow =>
        row.kind === "artifact" &&
        row.artifactVersionId === ids.artifactIds.get(sourceRow.artifactVersionId),
    );
// 反查不到投影行或缺少轮次，说明重编号表与行集合不一致，manifest 会出现悬空引用。
    if (!projected?.productTurnId) {
      throwProjectionError("invalid_conversation", "Projected artifact row is missing");
    }
// 扩展名从展示名推导且必须存在：服务端据此决定 Content-Type 与下载文件名。
    const extension = extensionOf(projected.displayName);
    return {
      sourceRef: sourceRow.ref,
      descriptor: {
        artifact_id: projected.artifactVersionId,
        logical_artifact_key: projected.logicalArtifactKey,
        producer_product_turn_id: projected.productTurnId,
        artifact_version: 1,
        state: projected.state,
        ref: projected.ref,
        artifact_type: projected.artifactType,
        display_name: projected.displayName,
        extension,
        mime_type: projected.mimeType,
        size_bytes: projected.sizeBytes,
        sha256: projected.sha256,
      },
    };
  });
// 输入附件的 descriptor 已由发现阶段生成，这里只做一件事：把 producer_product_turn_id
// 从原始轮次 ID 映射成公开 ID。
// 若不映射，manifest 里会残留原始 ID，validator 查不出（它只查未选中的轮次），
// 但服务端按公开 ID 建索引时会对不上。
// 展开顺序保证 descriptor 的其它字段原样保留。
  const additionalArtifacts = (input.additionalArtifacts ?? []).map((artifact) => ({
    ...artifact,
    descriptor: {
      ...artifact.descriptor,
      producer_product_turn_id: requiredMappedId(
        ids.productTurnIds,
        artifact.descriptor.producer_product_turn_id,
        "input attachment product turn",
      ),
    },
  }));
// 两类 artifact 合并后统一查 artifact_id 唯一性：
// 它们最终进同一个 manifest，重名会被服务端当作重复上传。
  const allArtifactIds = [
    ...artifacts.map((artifact) => artifact.descriptor.artifact_id),
    ...additionalArtifacts.map((artifact) => artifact.descriptor.artifact_id),
  ];
// 合并后的 manifest 再做一次唯一性检查：两类 artifact 各自合法但可能撞 ID（例如
// 发现阶段与输入附件都用了序号 1），这条检查是最后一道防线。
  assertUnique(allArtifactIds, "artifact manifest");
// selectedProductTurnIds 也换成公开 ID：调用方随后用它做确认请求，必须与行内一致。
// artifacts 顺序为「先结果物、后输入附件」，与 manifest 展示顺序一致。
  const projection: ConversationSharePublicProjection = {
    rows,
    selectedProductTurnIds: input.selectedProductTurnIds.map((productTurnId) =>
      requiredMappedId(ids.productTurnIds, productTurnId, "product turn"),
    ),
    artifacts: [...artifacts, ...additionalArtifacts],
  };
// content block 的 fallback_row_id 必须指向真实存在的公开行：
// 老客户端不认识该 block 时会退化成这条行来展示。
// id 用序号生成，保证同一次投影内唯一且稳定；不参与 ID 映射，因为它是块而非实体。
// resource_ids 从 artifacts 的 resource_id 派生，保证「块里引用的图」与 manifest 一致。
  if (input.contentDrafts?.length) {
    projection.contentBlocks = input.contentDrafts.map((draft, index) => {
      const entityId = requiredMappedId(ids.entityIds, draft.entityId, "content fallback");
// 用重编号后的 entityId 反查：draft 里存的是原始 ID，必须先映射再找行。
// 找不到说明 fallback 行被过滤掉了（例如 subagent），此时不能产出悬空引用的块。
      const fallback = rows.find((row) => row.entityId === entityId);
      if (!fallback) throwProjectionError("invalid_conversation", "Content fallback is missing");
// 只有带 resource_id 的 artifact 需要重映射；其它形状原样保留，
// 因为 payload 的 schema 由 shared 包负责，这里不重复解释它。
      const contentArtifacts = draft.payload.artifacts.map((artifact) =>
        "resource_id" in artifact && artifact.resource_id
          ? {
              ...artifact,
              resource_id: requiredMappedId(
                ids.artifactIds,
                artifact.resource_id,
                "content resource",
              ),
            }
          : artifact,
      );
      return conversationShareContentBlockSchema.parse({
        id: `share-content-${index + 1}`,
        type: "workflow",
        version: draft.version ?? 1,
        product_turn_id: requiredMappedId(ids.productTurnIds, draft.productTurnId, "content turn"),
        fallback_row_id: fallback.rowId,
        captured_at: draft.capturedAt,
        resource_ids: contentArtifacts.flatMap((artifact) =>
          "resource_id" in artifact && artifact.resource_id ? [artifact.resource_id] : [],
        ),
        payload: { ...draft.payload, artifacts: contentArtifacts },
      });
    });
  }
// tool-presentation 块是可选的增强：它让公开页以卡片形式展示工具调用，
// 而不是一段纯文本；不支持该特性的客户端会退化成 fallback 行。
// originalRows 用原始 rowId 索引：工具行的 cua 应用名可能只在过滤前的行上。
// agentTypes 只从 subagent 行提取，而 subagent 行已被过滤，所以必须查 sourceRows。
  if (input.toolPresentation) {
// 原始行按 rowId 建索引：过滤只改变数组内容，不改变 rowId，因此仍可精确回查。
// sourceRows 缺省时退化为空 Map，下面会回落到过滤后的行。
    const originalRows = new Map(input.sourceRows?.map((row) => [row.rowId, row] as const) ?? []);
// subagentType 只存在于被过滤掉的 subagent 行，必须从 sourceRows 取；
// 键是 parentToolCallId，这样能把它挂回发起该子代理的工具卡片。
    const agentTypes = new Map(
      input.sourceRows?.flatMap((row) =>
        row.kind === "subagent" ? [[row.parentToolCallId, row.subagentType] as const] : [],
      ) ?? [],
    );
// 用 flatMap 让「不产块」的分支返回空数组，保持结果扁平；
// index 与 rows 一一对应，用于取该行的公开 rowId/productTurnId 作为 fallback。
    const toolBlocks = retainedRows.flatMap((sourceRow, index) => {
// 只有工具调用才产 presentation 块；其它行没有可视卡片。
      if (sourceRow.kind !== "toolCall") return [];
// 复用 shared 的展示投影：它与本地 UI 的渲染规则同源，避免公开页与本地看到的卡片不一致。
      const display = projectShareToolDisplay(sourceRow.output?.display);
// toolImages 的 resourceId 是发现阶段分配的本地 artifact ID，必须映射成公开 ID；
// 映射不到说明该图片没进 manifest（例如类型不支持），此时丢弃而不是留本地 ID。
      const images = (input.toolImages?.get(sourceRow.rowId) ?? []).flatMap((image) => {
        const id = ids.artifactIds.get(image.resourceId);
        return id ? [{ resource_id: id, mime_type: image.mimeType }] : [];
      });
// 键用 toolCallId 而不是 rowId：同一工具可能有多行状态更新。
      const agentType = agentTypes.get(sourceRow.toolCallId);
      const original = originalRows.get(sourceRow.rowId);
// 优先用原始行取应用名：过滤前的行保留 cua/node_repl 的 display 细节，
// 投影后的行只保留了公开 display，可能已丢掉应用信息。
      const originalTool = original?.kind === "toolCall" ? original : sourceRow;
// 应用名按优先级回退：cua 直连字段 → cua display 的 targetApp → node_repl 的 app。
// 这三个来源对应不同工具形态，回退顺序即「信息可靠度」顺序。
      const appName =
        originalTool.cuaApp?.name ??
        (originalTool.output?.display?.kind === "cua"
          ? originalTool.output.display.targetApp?.displayName
          : undefined) ??
        (originalTool.display?.kind === "node_repl_images"
          ? originalTool.display.app?.displayName
          : undefined);
// 四项全空时不产出块：空块既占体积又会让公开页出现空白卡片。
      if (!display && !images.length && !agentType && !appName) return [];
      return [
        conversationShareContentBlockSchema.parse({
          id: `share-content-${(projection.contentBlocks?.length ?? 0) + index + 1}`,
          type: "tool-presentation",
          version: 1,
          product_turn_id: rows[index]!.productTurnId,
          fallback_row_id: rows[index]!.rowId,
          captured_at: sourceRow.endedAt ?? sourceRow.createdAt,
          resource_ids: [...new Set(images.map((image) => image.resource_id))],
          payload: {
            ...(display ? { display } : {}),
            ...(images.length ? { images } : {}),
            ...(agentType ? { agent_type: agentType } : {}),
            ...(appName ? { app_name: appName } : {}),
          },
        }),
      ];
    });
// 追加在已有 workflow 块之后、自校验之前：两种块共用一个数组，顺序即展示顺序。
    if (toolBlocks.length)
      projection.contentBlocks = [...(projection.contentBlocks ?? []), ...toolBlocks];
  }
// `assertConversationSharePublicProjection` 是最后一道闸：重编号与闭包假设在发送前被独立复核。
  assertConversationSharePublicProjection(projection);
  return projection;
}

// 与发现阶段的 extensionOf 语义不同：这里没有「未知扩展名」的概念，
// 产物必须有类型，否则服务端无法决定 content-type。
function extensionOf(displayName: string): string {
  const fileName = displayName.trim();
  const dot = fileName.lastIndexOf(".");
// 隐藏文件与「以点结尾」都不算有扩展名，直接失败而不是猜一个默认值。
  if (dot <= 0 || dot === fileName.length - 1) {
    throwProjectionError("invalid_conversation", "Conversation artifact extension is missing");
  }
  return fileName.slice(dot + 1).toLowerCase();
}
