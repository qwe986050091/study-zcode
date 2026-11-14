// 内嵌工具图片（node_repl images / CUA media）转成正式的 artifact Row。
// 为什么必须转换：V1 公开投影的 allow-list 没有「行内 base64」这种形态，
// 直接把 base64 塞进 payload 会被后端拒绝，也会把本地读取通道带进分享。
// INV-01：预检与发布调用同一函数，产出的 rowId、ref、sha256 必须完全一致（守住它：本函数纯函数性）。
// INV-02：只有 capability 允许的 image 扩展名才转换，其余降级为 warning，绝不上传未知类型（守住它：extension 分支）。
// INV-03：bytesBySourceRef 的 key 与 artifact Row 的 ref 必须相等，上传阶段靠它取字节（守住它：ref 生成处）。
// 改错后果：图片在 UI 可见但分享链接里丢失，或上传阶段取不到字节导致整次发布失败。
import { createHash } from "node:crypto";
import type { ConversationShareCapabilities } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationShareFailureIssue } from "./conversationShare.js";

/** 内嵌图片转为既有 artifact；预检和发布使用同一份确定性转换，不新增文件读取通道。 */
// 不做 IO：所有字节已在 Row 里（data URL）或由 artifact 协议另行读取，
// 因此本函数是确定性的，可在预检与发布各跑一次而不产生竞态。
// 返回 toolImages 供 content-block 的 tool-presentation 复用同一批 resourceId。
export function materializeConversationShareInlineImages(
  sourceRows: readonly ConversationRow[],
  capabilities: ConversationShareCapabilities,
  turnOrdinals: ReadonlyMap<string, number>,
): {
  rows: ConversationRow[];
  bytesBySourceRef: Map<string, Uint8Array>;
  warnings: ConversationShareFailureIssue[];
  toolImages: Map<number, Array<{ resourceId: string; mimeType: string }>>;
} {
// nextRowId 从现有最大 rowId 起增：新插入的 artifact Row 必须大于所有已有行，
// 否则下游按 rowId 排序/分页时会把它排到中间，破坏「会话行严格递增」的假设。
  const rows: ConversationRow[] = [];
  const toolImages = new Map<number, Array<{ resourceId: string; mimeType: string }>>();
  const bytesBySourceRef = new Map<string, Uint8Array>();
  const warnings: ConversationShareFailureIssue[] = [];
  let nextRowId = sourceRows.reduce((max, row) => Math.max(max, row.rowId), 0);
// 非 toolCall 行原样透传（同一对象引用），只有 toolCall 需要被拆成「原行 + 若干 artifact 行」。
  for (const row of sourceRows) {
    if (row.kind !== "toolCall") {
      rows.push(row);
      continue;
    }
// display 只认 node_repl_images：其它 display 形态（cua、mcp_tool 等）由公开投影的
// schema 自行裁剪，这里不做二次解释，避免两处对同一结构给出不同语义。
    const display = row.display?.kind === "node_repl_images" ? row.display : undefined;
// CUA 媒体有两种形态：带 data 的内联字节，和只带 artifactUri 的引用。后者无法离线读取。
    const media = row.output?.display?.kind === "cua" ? row.output.display.media : undefined;
    if (media?.some((item) => item.artifactUri && !item.data)) {
      // 只有资源引用、没有公开可读取字节时保持文本回退，不把本地读取权限带入分享。
      warnings.push({
        code: "content_unavailable",
        scope: "turn",
        rowId: row.rowId,
        productTurnId: row.productTurnId,
      });
    }
// 合并两个来源：node_repl 的 display.images 与 CUA media 里带 data 的图片项。
// 只认 image/ 前缀，视频/音频不在此转换（公开投影没有对应 artifact 类型）。
    const images = [
      ...(display?.images ?? []),
      ...(media ?? []).flatMap((item) =>
        item.data && item.mimeType.startsWith("image/")
          ? [{ base64: item.data.replace(/^data:[^;]+;base64,/u, ""), mimeType: item.mimeType }]
          : [],
      ),
    ];
// [权衡] 剥掉 display 而不是整行替换：原行还要保留 inputText/output.text，
// 只是把行内图片从 display 里摘走，防止同一份字节既进 artifact 又留在 payload 里。
    if (display) {
      const { display: _display, ...toolRow } = row;
      rows.push(toolRow);
    } else rows.push(row);
// index 参与 ref 命名，保证同一行多张图各自稳定；不能用长度累加，否则过滤掉一张后序号会漂移。
    for (const [index, image] of images.entries()) {
      const mimeType = image.mimeType.toLowerCase();
      const allowed = capabilities.allowed_artifacts.find(
        (candidate) =>
          candidate.type === "image" &&
          candidate.mime_types.some((mime) => mime.toLowerCase() === mimeType),
      );
      const extensions: Record<string, string[]> = {
        "image/png": ["png"],
        "image/jpeg": ["jpg", "jpeg"],
        "image/webp": ["webp"],
        "image/gif": ["gif"],
        "image/svg+xml": ["svg"],
      };
// 扩展名必须同时满足「capability 声明」与「mime 对应的候选表」；
// 只取 capability 会给 image/webp 之类配上 png 后缀，服务端按后缀判类型时就错了。
      const extension = allowed?.extensions
        .map((value) => value.replace(/^\./u, "").toLowerCase())
        .find((value) => extensions[mimeType]?.includes(value));
// 展示名不进文件系统路径，但仍用 rowId+序号保证同一次分享内可区分；
// 扩展名缺失时退化为 image 字面量，仅用于 warning 文案，不会真的上传。
      const displayName = `tool-image-${row.rowId}-${index + 1}.${extension ?? "image"}`;
// 三个失败分支（类型不允许 / base64 损坏）共用同一份定位信息，
// 保证 UI 无论命中哪条路径都能把问题挂到具体轮次与具体图片上。
      const issue = {
        scope: "artifact" as const,
        rowId: row.rowId,
        productTurnId: row.productTurnId,
        turnOrdinal: row.productTurnId ? turnOrdinals.get(row.productTurnId) : undefined,
        artifactDisplayName: displayName,
        artifactType: "image",
        mimeType,
      };
// [失败路径] 未匹配到扩展名只跳过这一张图并记 warning，不阻断整轮：
// [失败路径] 单张图扩展名不在 allowed_artifacts 时只跳过并记 artifact_type_not_allowed，整轮分享继续：不支持的图不能拖垮整段对话。
      if (!extension) {
        warnings.push({
          ...issue,
          code: "artifact_type_not_allowed",
          allowedArtifacts: capabilities.allowed_artifacts.map((candidate) => ({
            type: candidate.type,
            extensions: candidate.extensions,
            mimeTypes: candidate.mime_types,
          })),
        });
        continue;
      }
// [失败路径] Buffer.from 对非法 base64 是宽松的（丢弃非法字符），所以必须回编码比对；
// 校验失败说明 Row 里的 data URL 已损坏，跳过该图而不是上传一个坏文件。
      const bytes = Buffer.from(image.base64, "base64");
      // Buffer.from 对非法 base64 宽松容错，必须复核，避免分享一个已损坏的图片文件。
      if (
        !bytes.length ||
        bytes.toString("base64").replace(/=+$/u, "") !== image.base64.replace(/=+$/u, "")
      ) {
        warnings.push({
          ...issue,
          code: "artifact_read_failed",
          availability: "unknown",
        });
        continue;
      }
// ref 用 sourceRow 的 rowId 而非新分配的 rowId：上传阶段是按 ref 回查字节的，
// 若用自增 rowId 会在多次调用间变化，预检产出的 manifest 与发布就对不上。
      const ref = `inline-tool-image:${row.rowId}:${index}`;
// [资源] 字节只在这里登记一次，上传阶段按 ref 取；不复制 Buffer，避免大图被内存持有两份。
      bytesBySourceRef.set(ref, bytes);
// toolImages 记录「哪个源工具行产出了哪些 resourceId」，供 tool-presentation 的 content-block 引用。
      const references = toolImages.get(row.rowId) ?? [];
      references.push({ resourceId: ref, mimeType });
      toolImages.set(row.rowId, references);
      rows.push({
        kind: "artifact",
        rowId: ++nextRowId,
        turnId: row.turnId,
        productTurnId: row.productTurnId,
        createdAt: row.createdAt,
        createdAtSeq: row.createdAtSeq,
        artifactVersionId: ref,
        logicalArtifactKey: ref,
        displayName,
        artifactType: "image",
        mimeType,
        sizeBytes: bytes.byteLength,
// sha256 在转换当场算定，后续发现阶段复验同一 ref 的字节时以此为准，用作完整性锚点。
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ref,
        state: "current",
      });
    }
  }
  return { rows, bytesBySourceRef, warnings, toolImages };
}
