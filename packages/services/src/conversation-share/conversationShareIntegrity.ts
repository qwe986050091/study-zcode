// 分享内容的完整性边界：把「服务端/发布端算过的摘要」和「本端读到的原始 JSON」
// 放在同一套规范化规则下重算，任何一处规则漂移都会让合法分享被判成被篡改。
// INV-01：canonicalize 的输出必须只取决于语义值，与对象键顺序、undefined、Unicode 形式无关（守住它：canonicalizeValue）。
// INV-02：confirm 端与 verify 端必须对同一份数据得出同一字节串，否则所有跨版本分享都会失败（守住它：buildConversationShareConfirmRequest / verifyConversationShareIntegrity）。
// INV-03：artifacts 摘要只覆盖 descriptor 的业务字段，不含服务端签名 URL，因为 URL 会随签发时刻变化（守住它：ARTIFACT_URL_KEYS）。
// 改错任何一条：老客户端会报「分享文件校验失败」，用户看到的是「内容被改过」，实际只是契约漂移。
import { createHash } from "node:crypto";

import {
  conversationShareConfirmRequestSchema,
  type ConversationShareArtifactDescriptor,
  type ConversationShareConfirmRequest,
} from "@zcode/shared";

type ConversationShareConfirmRequestBase = Omit<ConversationShareConfirmRequest, "integrity"> & {
  artifacts: ConversationShareArtifactDescriptor[];
};

// 逐 UTF-16 code unit 扫描，拒绝孤立代理项。
// JSON.stringify 会把孤立代理项转义成 \ud800 形态，不同实现对它的处理不一致；
// 若放任通过，两端算出的摘要可能相同也可能不同，取决于各自 JSON 库，等于把校验变成运气。
function assertValidUnicode(value: string): void {
  // 逐 code unit 前进，遇到合法代理对时 index += 1 跳过低位，避免把低位再当成孤立代理项误判。
  for (let index = 0; index < value.length; index += 1) {
    // charCodeAt 按下标取 16-bit 单元，越界返回 NaN，因此循环边界必须由 length 严格控制。
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      // 高位后面必须是低位；next 越界时 charCodeAt 返回 NaN，比较结果为 false，同样走抛错分支。
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Conversation share JSON contains invalid Unicode");
      }
      index += 1;
      continue;
    }
    // 能走到这里说明该低位没有被前面的高位吞掉，属于孤立低位代理项，同样拒绝。
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Conversation share JSON contains invalid Unicode");
    }
  }
}

// 手写 JCS 风格规范化，而不是直接 JSON.stringify：后者保留对象插入顺序。
// undefined 必须显式拒绝：JSON.stringify 会把它变成 null 或整个键消失，两种都不是原值。
function canonicalizeValue(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      // 布尔按 JSON 字面量输出；用 String(value) 在部分环境会得到非协议文本。
      return value ? "true" : "false";
    case "number": {
      // NaN/Infinity 在 JSON.stringify 下会变成 null，两端序列化结果不一致，必须先抛 TypeError。
      if (!Number.isFinite(value)) {
        throw new TypeError("Conversation share JSON numbers must be finite");
      }
      // 数字交给 JSON.stringify 输出最短往返表示，这正是 JCS 对 number 的序列化口径。
      return JSON.stringify(value);
    }
    // 字符串先验代理对再交给 JSON.stringify：后者虽然会转义，但不同实现对孤立代理项的字节输出并不统一。
    case "string":
      assertValidUnicode(value);
      return JSON.stringify(value);
    // typeof 为 object 时还要排除 null 与数组；函数、symbol 等类型落到 default 分支直接抛错。
    case "object": {
      // 数组保序、不排序：元素顺序本身是语义，排序会把 [a,b] 与 [b,a] 摘要成同一串。
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalizeValue(entry)).join(",")}]`;
      }

      const record = value as Record<string, unknown>;
      // 对象键必须按 UTF-16 码元升序排序才是 JCS 规定的成员顺序；两端各自独立排序才能得到同一结果。
      const entries = Object.keys(record)
        .sort()
        .map((key) => {
          // 键名同样要过 Unicode 校验，否则孤立代理项会从 `JSON.stringify(key)` 这一侧漏过检查。
          assertValidUnicode(key);
          const entry = record[key];
          // 显式拒绝 undefined 而不是跳过键：跳过会让 `{a:undefined}` 与 `{}` 摘要相同，凭空抹掉字段存在性。
          if (entry === undefined) {
            throw new TypeError("Conversation share JSON cannot contain undefined values");
          }
          // 拼接前不做任何空白填充，JCS 要求紧凑格式；冒号两侧多一个空格就会与发布端摘要不等。
          return `${JSON.stringify(key)}:${canonicalizeValue(entry)}`;
        });
      // 对象用逗号连接且不加空格；键序已在 entries 排序时固定，这里再排一次只会增加开销。
      return `{${entries.join(",")}}`;
    }
    default:
      // default 分支兜住 function/symbol/bigint，静默转字符串会让摘要比较在类型层面失真。
      throw new TypeError(`Conversation share JSON cannot contain ${typeof value}`);
  }
}

// 公开入口只做转发；单独导出 canonicalizeConversationShareJson 是为了让发布端与导入端共用同一实现。
export function canonicalizeConversationShareJson(value: unknown): string {
  // 导出即转发，不在包装层加 try/catch：规范化抛错的含义（非法 JSON）必须原样传到调用方。
  return canonicalizeValue(value);
}

// 摘要固定按 UTF-8 编码取字节，不接受调用方传编码，防止同一字符串出现两种哈希。
export function sha256ConversationShareJson(value: unknown): string {
  // digest 固定 hex：只要有一端输出 base64，artifact_set_sha256 就永远对不上，且报错只会显示校验失败。
  return createHash("sha256")
    // 先规范化再按 utf8 编码，两步顺序不能反：先编码会把代理项差异固化进哈希字节。
    .update(canonicalizeConversationShareJson(value), "utf8")
    .digest("hex");
}

// [事务] confirm 请求一旦带上这三个摘要，服务端就把它当作提交时快照：之后本地文件再变也不会回滚。
// 因此摘要必须在「上传字节已确定」之后计算，且 artifacts 先按 id 排序，抵消调用方的集合顺序差异。
// projection.rows 直接取原对象而不做清洗：清洗由公开投影负责，这里若顺手改字段就会与服务端算法分叉。
export function buildConversationShareConfirmRequest(
  input: ConversationShareConfirmRequestBase,
): ConversationShareConfirmRequest {
  // 复制一份再排序，避免 sort 原地改动调用方数组；该数组随后还要用于上传，顺序变化会影响其他摘要。
  const artifacts = [...input.artifacts].sort((left, right) =>
    // 按 artifact_id 排序而不是按数组下标；调用方集合顺序不同但内容相同时摘要必须一致。
    left.artifact_id.localeCompare(right.artifact_id),
  );
  // projection.rows 必须是已定稿的投影行；若在确认之后本地再改行，服务端持有的快照不会回滚。
  const projectionSha256 = sha256ConversationShareJson(input.projection.rows);
  // 摘要覆盖排好序的完整 descriptor 集合，单个 artifact_id 变化都会让该值变化。
  const artifactSetSha256 = sha256ConversationShareJson(artifacts);
  // 用解构摘掉 artifacts，防止它既进 confirmRequest 又单独参与摘要，让服务端收到两份口径不同的列表。
  const { artifacts: _artifacts, ...confirmRequest } = input;

  return conversationShareConfirmRequestSchema.parse({
    ...confirmRequest,
    integrity: {
      // content_blocks 缺失时整个 content_blocks_sha256 都不写；写空串会被服务端当成“空内容块”参与比对。
      ...(input.projection.content_blocks === undefined
        ? {}
        : { content_blocks_sha256: sha256ConversationShareJson(input.projection.content_blocks) }),
      projection_sha256: projectionSha256,
      artifact_set_sha256: artifactSetSha256,
    },
  });
}

/**
 * 服务端签发 signed URL 时才有的字段，不参与 artifact set 摘要。
 *
 * 这是一份「服务端在读取时附加的字段」名单，不是「本端认识的字段」白名单——两者方向相反，
 * 选前者才对得上版本歪斜：
 * - 更新版发布端给 descriptor 加字段 → 它进了服务端存储、也进了服务端算的摘要，
 *   老导入端按原始值算同样包含它，哈希对得上（这正是要保住的方向）；
 * - 若改成按本端已知字段投影，那个新字段会被削掉，哈希立刻不一致。
 *
 * 代价是：服务端将来在读取响应里新增字段（而不是回显上传内容）必须同步加进这份名单，
 * 否则摘要会不一致。这属于服务端违反 revision 契约（continuation integrity 定义在
 * descriptor 集合上），且症状明确、修法就是往这里加一个键。
 */
const ARTIFACT_URL_KEYS = ["download_url", "download_url_expires_at", "url", "url_expires_at"];

function artifactIdOf(value: unknown): string {
  const id = (value as { artifact_id?: unknown } | null)?.artifact_id;
  return typeof id === "string" ? id : "";
}

function stripArtifactUrls(value: unknown): unknown {
  // 数组直接原样返回：artifact 集合的排序在外层完成，strip 只负责剔除对象键，不碰数组形状。
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const stripped: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  // 逐键 delete 而非重建对象，保留其余键及其原型链之外的属性顺序无关性——摘要端会重新排序。
  for (const key of ARTIFACT_URL_KEYS) delete stripped[key];
  return stripped;
}

/**
 * 用服务端**原样发来的** rows / artifacts 复核两个摘要。
 *
 * 关键点是「原始值」：以前这里拿的是 zod 解析产物，而 zod 默认剥掉未知字段，所以发布端
 * 只要给 row 加一个 optional 字段，老导入端重算的哈希就必然不一致，报出「分享文件校验
 * 失败」——一条看着像被篡改的告警，加一个永远不会成功的重试按钮。
 *
 * 校验对原始字节之后，完整性与 schema 认知彻底解耦：schema 可以自由 additive 演进，而
 * 哈希不一致重新变成它本该表达的意思——内容真的被改过或损坏了。
 */
// [失败路径] 返回 boolean 而不是抛错：调用方需要把 false 转成 invalid_contract 并保留 requestId；
// [权衡] 服务端下发 artifacts 时可能已按 id 排序，这里仍重排一次，避免依赖对端实现细节。
export function verifyConversationShareIntegrity(input: {
  rawRows: unknown;
  rawContentBlocks?: unknown;
  rawArtifacts: unknown;
  integrity: {
    projection_sha256: string;
    artifact_set_sha256: string;
    content_blocks_sha256?: string;
  };
}): boolean {
  const artifacts = Array.isArray(input.rawArtifacts)
    // 展开复制后才能安全 sort；直接对服务端下发的数组原地排序会污染调用方后续的渲染顺序。
    ? [...(input.rawArtifacts as unknown[])]
        .sort((left, right) => artifactIdOf(left).localeCompare(artifactIdOf(right)))
        .map(stripArtifactUrls)
    // rawArtifacts 不是数组时原样参与摘要，类型不符自然会得到不同的 sha256 值。
    : input.rawArtifacts;
  return (
    // 两端同时缺失才算一致；只有一端有 content_blocks 说明版本契约不一致，直接判 false 交给上层报 invalid_contract。
    (input.rawContentBlocks === undefined
      ? input.integrity.content_blocks_sha256 === undefined
      : sha256ConversationShareJson(input.rawContentBlocks) ===
        input.integrity.content_blocks_sha256) &&
    // rows 必须用原始值重算；经 zod 解析会剥掉未知字段，从而把合法分享误判成篡改。
    sha256ConversationShareJson(input.rawRows) === input.integrity.projection_sha256 &&
    sha256ConversationShareJson(artifacts) === input.integrity.artifact_set_sha256
  );
}
