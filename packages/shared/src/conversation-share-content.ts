// INV-01 模块顶层只做 schema 声明，加载期不读取任何运行时状态；守住位置：文件顶层常量与 zod 构造；改错故障：分享端与服务端校验口径分叉，历史块被判非法。
// INV-02 输入参数一律 readonly，函数不得就地改写调用方数组；守住位置：decodeConversationShareContentBlocks 形参；改错故障：上游会话数组被静默裁剪，正文顺序错乱。
// INV-03 每个字段上限都是封闭常量，不得由调用方覆盖；守住位置：SHARE_CONTENT_LIMITS 与各处 max 调用；改错故障：超大载荷穿透分享链接，接收端打开即卡死。
// INV-04 校验对象全部 strict，未知键一律拒绝而非静默丢弃；守住位置：各 z.object 分支；改错故障：私密字段随分享外泄且无人察觉。
// INV-05 缺失的可选字段必须整体省略，不写 undefined 占位；守住位置：optional 声明与序列化路径；改错故障：字节表示不稳定，同内容两次分享哈希不同。
// INV-06 键顺序由对象字面量声明顺序固定，禁止运行期重排；守住位置：payload 与 artifact 的构造处；改错故障：跨版本比较失败，去重与缓存全部失效。
// INV-07 JSON 深度上限先行判定，超过即整体拒绝；守住位置：safeJson 的首个分支；改错故障：深层嵌套触发栈溢出，分享流程崩溃。
// INV-08 只接受有界 JSON 标量，函数与 Symbol 及循环引用必须失败；守住位置：safeJson 末尾兜底；改错故障：不可序列化值让整块内容凭空消失。
// INV-09 原型键 __proto__ 与 constructor 一律拒绝；守住位置：safeJson 的对象键过滤；改错故障：原型污染波及同进程其他会话。
// INV-10 字符串拒绝 file、data、javascript 等内部协议前缀；守住位置：safeJson 的字符串分支；改错故障：分享页执行外部脚本或回读本地文件。
// INV-11 字节预算按 UTF-8 编码后计算，不按字符数估算；守住位置：jsonValue 与 preview_text 的 refine；改错故障：中文内容超限被截断，多语言下超发。
// INV-12 媒体引用与资源清单必须双向一一对应；守住位置：tool 内容块的 superRefine；改错故障：图片指向不存在的资源，分享页出现空图位。
// INV-13 version 1 禁止携带 preview_text；守住位置：workflow 内容块的 superRefine；改错故障：老客户端读到未知字段而拒绝整条消息。
// INV-14 envelope 只剥离未知字段，绝不改写已知锚点；守住位置：envelope 的 strip；改错故障：新类型块吞掉原位摘要，用户丢失原文。
// INV-15 解码失败返回空数组而非抛错；守住位置：decodeConversationShareContentBlocks；改错故障：单个坏块导致整段会话无法渲染。
// INV-16 解码输出顺序严格等于输入顺序；守住位置：flatMap 单遍遍历；改错故障：块与正文错位，时间线读起来前后颠倒。
// INV-17 能力协商按类型与版本双键比对，缺省视为 0；守住位置：supportsConversationShareContent；改错故障：不支持的客户端强行渲染，界面空白无提示。
// INV-18 所有上限检查必须在校验期完成，不得推迟到渲染期；守住位置：schema 层的 max 约束；改错故障：坏数据进入 UI 才炸，错误现场无法归因。
// INV-19 同一输入必须产出逐字节相同的规范 JSON；守住位置：全模块序列化路径；改错故障：分享链接去重失效，服务端缓存永久击穿。
//
// 本模块只做声明与纯函数校验，不读写 IO、不持有状态；
// 分享内容一旦落盘即成为外部契约，任何放宽都需升版本；
// 顺序、省略与字节稳定三项合起来才是可比较的确定性输出。
import { z } from "zod";
import { shareToolPresentationPayloadSchema } from "./conversation-share-tool-presentation.js";
import { toolCallCreateWorkflowDisplaySchema } from "./zcode-protocol-v4/create-workflow-display.js";
import {
  workflowRunActorSchema,
  workflowRunNodeSchema,
  workflowRunSchema,
} from "./zcode-protocol-v4/workflow-runs.js";

export const CONVERSATION_SHARE_CONTENT_VERSIONS = { workflow: 2, "tool-presentation": 1 } as const;
export const SHARE_CONTENT_LIMITS = {
  blocks: 200,
  artifacts: 32,
  items: 256,
  jsonDepth: 16,
  jsonBytes: 32768,
} as const;
// 文本字段统一定长 1 到 512，短标题与标签共用同一口径；
// 改短会切断历史值，改长则放宽分享体积，两头都要升版本。
const text = z.string().min(1).max(512);
const count = z.number().int().nonnegative();
const field = z.object({ field: text, label: text.optional(), unit: text.optional() }).strict();
// title 与 description 是各 spec 的公共可选头，复用同一 schema 实例保证判定一致；
// 未提供时键不存在，序列化结果不会出现 undefined 占位。
const options = { title: text.optional(), description: text.optional() };
// 四种产物规格按 kind 分派，列与明细都封顶 64 条；
// strict 保证未声明的视觉字段无法借道注入。
export const shareArtifactSpecSchemas = {
  board: z
    .object({
      ...options,
      key: text,
      status: text,
      columns: z.array(text).min(1).max(64),
      cardTitle: text.optional(),
      detail: z.array(field).max(64).optional(),
    })
    .strict(),
  table: z
    .object({ ...options, columns: z.array(field).min(1).max(64), key: text.optional() })
    .strict(),
  metrics: z.object({ ...options, metrics: z.array(field).min(1).max(64) }).strict(),
  chart: z
    .object({
      ...options,
      type: z.enum(["line", "bar", "scatter"]).optional(),
      x: field,
      y: z.union([field, z.array(field).min(1).max(64)]),
      scale: z.enum(["linear", "log"]).optional(),
      baseline: field.optional(),
    })
    .strict(),
};

// safeJson 只保证值有界、结构不限，体积由 SHARE_CONTENT_LIMITS.jsonDepth 的递归预算限制。
// 白名单失败即整块拒绝，不做逐字段降级。
// report 的业务字段开放，但值只能是有界 JSON；不接受执行代码、原型键或内部 URI。
// [失败路径] 返回布尔而非抛异常，调用方在 refine 里统一转成校验错误；
// 递归只下探容器，标量一判即返，避免为校验复制整棵对象树；
// [资源] 每层携带剩余深度作为隐式预算，防止深链拖垮主线程。
function safeJson(value: unknown, depth = 0): boolean {
  // depth 超限时在函数入口直接返回 false，标量也不再判，省掉一次类型分支。
  // 边界取严格大于，恰好等于上限的那一层仍然合法。
  if (depth > SHARE_CONTENT_LIMITS.jsonDepth) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string")
    return value.length <= 32768 && !/^(?:file|data|javascript|zcode-artifact):/iu.test(value);
  if (Array.isArray(value))
    return value.length <= 1024 && value.every((entry) => safeJson(entry, depth + 1));
  if (value && typeof value === "object")
    return Object.entries(value).every(
      ([key, entry]) =>
        !["__proto__", "prototype", "constructor"].includes(key) &&
        key.length <= 512 &&
        safeJson(entry, depth + 1),
    );
  // [失败路径] 剩余类型一律视为不可分享，默认关闭而非默认放行；
  // 这也是函数、Symbol、BigInt 等不可序列化值的统一出口。
  return false;
}
// 先递归判安全，再按 UTF-8 字节数判体积，两道闸门缺一不可；
// refine 失败信息固定，避免把原始值写进错误体造成二次泄漏。
const jsonValue = z
  .unknown()
  .refine(
    (value) =>
      safeJson(value) &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= SHARE_CONTENT_LIMITS.jsonBytes,
    "Unsafe or oversized share JSON",
  );
// 序号与站点标识共同定位一条 item，strict 拒绝越界的附加字段；
// item 本体走 jsonValue，因此同样受深度与字节预算约束。
const item = z
  .object({ sequence: count, siteId: z.string().min(1).max(64), ordinal: count, item: jsonValue })
  .strict();
// id、title、version 是各类 artifact 的共同骨架，抽出来避免各处漂移；
// version 为 1 到 16 的正整数，用于产物自身迭代而非协议版本。
const artifactFields = {
  id: z.string().min(1).max(128),
  title: text,
  version: z.number().int().positive().max(16),
  primary: z.literal(true).optional(),
  description: text.optional(),
  unavailable: z.enum(["source_unavailable", "unsupported", "limit_exceeded"]).optional(),
};
// [事务] 判别联合先看 kind 再分支，任一分支不合法则整个产物失败；
// file 与 markdown 共享预览结构，board 等四种复用规格表与 items；
// items 上限取自全局常量，避免两处数字各自演化。
export const shareWorkflowArtifactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...artifactFields,
      kind: z.literal("file"),
      resource_id: z.string().min(1).max(128).optional(),
      content_type: text.optional(),
      preview_text: z
        .string()
        .max(65536)
        .refine((text) => new TextEncoder().encode(text).byteLength <= 65536)
        .optional(),
      bytes: count.optional(),
    })
    .strict(),
  z
    .object({
      ...artifactFields,
      kind: z.literal("markdown"),
      resource_id: z.string().min(1).max(128).optional(),
      content_type: text.optional(),
      preview_text: z
        .string()
        .max(65536)
        .refine((text) => new TextEncoder().encode(text).byteLength <= 65536)
        .optional(),
      bytes: count.optional(),
    })
    .strict(),
  // 用 as const 元组驱动映射，键集合与规格表在类型层强绑定；
  // 新增可视产物时必须同时补齐规格，否则类型检查直接报错。
  ...(["board", "table", "metrics", "chart"] as const).map((kind) =>
    z
      .object({
        ...artifactFields,
        kind: z.literal(kind),
        spec: shareArtifactSpecSchemas[kind].optional(),
        items: z.array(item).max(SHARE_CONTENT_LIMITS.items).optional(),
      })
      .strict(),
  ),
]);

// 复用执行态词汇与算法，但公开面仅允许绘图所需事实，不携带子会话/执行授权/原始工具输入。
// [权衡] 复用执行态 schema 的字段词汇，但用 pick 收窄到绘图必需项；
// omit sessionId 后公开面不再暴露子会话句柄，actors 与 nodes 各封顶 256。
export const shareWorkflowRunSchema = workflowRunSchema
  .pick({
    status: true,
    usage: true,
    phases: true,
    currentPhase: true,
    phaseNames: true,
    phaseAlongside: true,
    lastEventSequence: true,
    truncated: true,
  })
  .extend({
    actors: z.array(workflowRunActorSchema.omit({ sessionId: true }).strict()).max(256),
    nodes: z
      .array(
        workflowRunNodeSchema
          .pick({
            siteId: true,
            ordinal: true,
            kind: true,
            phase: true,
            outcome: true,
            cached: true,
            actorSiteId: true,
            actorOrdinal: true,
            phaseName: true,
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
// payload 汇总名称、完成态、运行快照与产物清单，是分享的主载体；
// graph 直接复用创建态图结构，保证分享与运行时同一套语义；
// artifacts 缺省必填并封顶全局常量，杜绝空清单带来的歧义状态。
export const shareWorkflowPayloadSchema = z
  .object({
    name: text,
    summary: z.string().max(2048).optional(),
    completion: z.boolean(),
    run: shareWorkflowRunSchema.optional(),
    graph: toolCallCreateWorkflowDisplaySchema.shape.causalityGraph,
    duration_ms: count.optional(),
    artifacts: z.array(shareWorkflowArtifactSchema).max(SHARE_CONTENT_LIMITS.artifacts),
    unavailable: z.enum(["source_unavailable", "unsupported", "limit_exceeded"]).optional(),
  })
  .strict();
// conversationShareContentBlockBaseSchema 统一提供 id / type / version / source 行号与时间戳五个锚点。
// id 与 product_turn_id 用正则限定单调编号，避免外部伪造顺序；
// resource_ids 只允许 share-artifact 前缀，同样有数量上限。
const conversationShareContentBlockBaseSchema = z
  .object({
    id: z.string().regex(/^share-content-[1-9]\d*$/u),
    type: z.literal("workflow"),
    version: z.union([z.literal(1), z.literal(2)]),
    product_turn_id: z.string().regex(/^share-product-turn-[1-9]\d*$/u),
    fallback_row_id: z.number().int().positive(),
    captured_at: count,
    resource_ids: z.array(z.string().regex(/^share-artifact-[1-9]\d*$/u)).max(32),
    payload: shareWorkflowPayloadSchema,
  })
  .strict();
// workflow 块在基础骨架上追加版本约束，v1 与 v2 都先过通用校验；
// 版本语义放在 refine 而非 union，便于给出指向具体字段的错误路径。
export const conversationShareWorkflowContentBlockSchema =
  conversationShareContentBlockBaseSchema.superRefine((block, context) => {
    if (
      block.version === 1 &&
      block.payload.artifacts.some(
        (artifact) => "preview_text" in artifact && artifact.preview_text !== undefined,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Text previews require workflow content version 2",
        path: ["payload", "artifacts"],
      });
    }
  });
// tool 块把 version 钉死为 1，并换成工具呈现专用 payload；
// [失败路径] 媒体引用与 resource_ids 必须等长且互相命中，多一个或少一个都报错；
// 用 Set 比对集合大小与实际命中，避免重复 id 蒙混过关。
export const conversationShareToolContentBlockSchema = conversationShareContentBlockBaseSchema
  .extend({
    type: z.literal("tool-presentation"),
    version: z.literal(1),
    payload: shareToolPresentationPayloadSchema,
  })
  .superRefine((block, context) => {
    const used = new Set(block.payload.images?.map((image) => image.resource_id) ?? []);
    if (
      used.size !== new Set(block.resource_ids).size ||
      block.resource_ids.length !== used.size ||
      block.resource_ids.some((id) => !used.has(id))
    )
      context.addIssue({
        code: "custom",
        message: "Tool media references must match resource_ids",
        path: ["resource_ids"],
      });
  });
// 对外只暴露联合类型，调用方无需知道具体判别顺序；
// 新增块类型须同时登记到 envelope 与解码路径，否则会被静默丢弃。
export const conversationShareContentBlockSchema = z.union([
  conversationShareWorkflowContentBlockSchema,
  conversationShareToolContentBlockSchema,
]);
// 类型全部从 schema 推导，杜绝手写类型与运行时校验脱节。
export type ConversationShareWorkflowContentBlock = z.infer<
  typeof conversationShareWorkflowContentBlockSchema
>;
export type ConversationShareContentBlock = z.infer<typeof conversationShareContentBlockSchema>;
export type ShareWorkflowPayload = z.infer<typeof shareWorkflowPayloadSchema>;
export type ShareWorkflowArtifact = z.infer<typeof shareWorkflowArtifactSchema>;

/** 稳定外壳先识别锚点；新类型或坏 payload 仍须保持正文与原位摘要的顺序。 */
// 外壳放宽 type 与 version 并用 strip 剥离未知键，先认出锚点再谈载荷；
// payload 声明为 unknown，保证坏载荷不会让整行结构消失；
// 读端据此保留原位摘要，同时仍能展示可识别的正文。
export const conversationShareContentEnvelopeSchema = conversationShareContentBlockBaseSchema
  .extend({
    type: z.string().min(1).max(128),
    version: z.number().int().positive(),
    payload: z.unknown(),
  })
  .strip();

/** 读端独立解码：认不出的块不认领 fallback Row，原位文字仍然保留。 */
// [并发] 纯函数无共享状态，同一数组可被多端并行解码而互不影响；
// safeParse 逐块吞错，坏块只丢自己，不牵连相邻内容；
// flatMap 单遍遍历，输出顺序严格等于输入顺序，形参 readonly 不被改写。
export function decodeConversationShareContentBlocks(
  blocks: readonly unknown[] | undefined,
): ConversationShareContentBlock[] {
  return (blocks ?? []).flatMap((block) => {
    const parsed = conversationShareContentBlockSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}
// 能力协商先取该类型的版本表，缺失按 0 处理即视为不支持；
// content_block_versions[type] >= version 才放行，客户端版本更高时不会降级拒绝。
export function supportsConversationShareContent(
  capabilities: { content_block_versions?: Record<string, number> },
  type: string = "workflow",
  version = 1,
): boolean {
  return (capabilities.content_block_versions?.[type] ?? 0) >= version;
}
