// INV-01 请求体只开放官方子集：守住位置 对象形状；改错故障 未实现能力被静默接受。
// INV-02 未知字段一律拒绝：守住位置 严格模式；改错故障 扩展字段绕过限制。
// INV-03 消息数量设上下限：守住位置 数组约束；改错故障 空请求或海量消息进入模型。
// INV-04 文本块受字节上限约束：守住位置 长度约束；改错故障 单块撑爆请求。
// INV-05 图片只接受白名单类型：守住位置 枚举约束；改错故障 任意类型被转发。
// INV-06 图片编码做线性校验：守住位置 精化函数；改错故障 大图触发正则栈溢出。
// INV-07 图片解码后字节数复核：守住位置 二次精化；改错故障 编码膨胀绕过上限。
// INV-08 消息角色只允许两种：守住位置 枚举约束；改错故障 系统角色被注入对话。
// INV-09 系统提示词单独受限：守住位置 字段约束；改错故障 超长提示词进入请求。
// INV-10 令牌数必须正整数：守住位置 类型链；改错故障 零或小数令牌被接受。
// INV-11 上下文取值固定为无：守住位置 字面量；改错故障 未实现能力被请求。
// INV-12 模型偏好三项统一区间：守住位置 复用模式；改错故障 越界优先级传入排序。
// INV-13 提示名称长度受限：守住位置 字符串约束；改错故障 超长名称进入统计。
// INV-14 总预算含元数据体积：守住位置 精化计算；改错故障 扩展字段绕过载荷限制。
// INV-15 元数据不转发但仍计量：守住位置 预算表达式；改错故障 大元数据拖垮传输。
// INV-16 结果只接受文本内容：守住位置 结果形状；改错故障 未实现类型进入渲染层。
// INV-17 结果必须带模型与停止原因：守住位置 必填字符串；改错故障 界面显示空来源。
// INV-18 超限统一报一条自定义问题：守住位置 问题追加；改错故障 收到多条重复错误。
//
// 模块职责：MCP Apps 采样请求与结果的校验模式。
// 状态所有权：无状态；常量即上限，校验全在模式内完成。
// 阅读顺序：先看块模式，再看参数模式，最后看结果模式与字节估算。
import { z } from "zod";
import { MCP_APPS_IMAGE_MAX_BYTES, MCP_APPS_IMAGE_MIME_TYPES } from "./contract.js";

export const MCP_APPS_SAMPLING_TIMEOUT_MS = 60_000;
export const MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS = 65_000;
export const MCP_APPS_SAMPLING_MAX_BYTES = 8 * 1024 * 1024;
export const MCP_APPS_SAMPLING_MAX_BLOCKS = 64;
export const MCP_APPS_SAMPLING_MAX_PER_SESSION = 4;
export const MCP_APPS_SAMPLING_MAX_PER_AGENT = 8;
export const MCP_APPS_SAMPLING_MAX_OPERATIONS = 4096;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const annotations = z
  .object({
    audience: z.array(z.enum(["user", "assistant"])).optional(),
    priority: z.number().min(0).max(1).optional(),
    lastModified: z.string().optional(),
  })
  .strict()
  .optional();
const samplingBlockSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().max(MCP_APPS_SAMPLING_MAX_BYTES),
      annotations,
      _meta: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      mimeType: z.enum(MCP_APPS_IMAGE_MIME_TYPES),
      data: z
        .string()
        .min(1)
        .max(Math.ceil(MCP_APPS_IMAGE_MAX_BYTES / 3) * 4)
        // 重复四字符分组会在 MiB 级图片上耗尽 V8 正则栈；平坦字符检查保持线性。
        .refine((data) => data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data))
        .refine((data) => decodedBytes(data) <= MCP_APPS_IMAGE_MAX_BYTES),
      annotations,
      _meta: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]);
const priority = z.number().min(0).max(1).optional();
/** 只开放宿主确实实现的官方子集；不静默剥除 tools/audio/模型配置等字段。 */
// messages 的 .min(1) 与 .max(MCP_APPS_SAMPLING_MAX_BLOCKS) 同时限制条数与块数。
// systemPrompt 单独受 MCP_APPS_SAMPLING_MAX_BYTES 限制，与消息预算分开。
// includeContext 只接受字面量 "none"，宿主不支持上下文注入。
// metadataBytes 计入 .superRefine 的总字节上限，不额外放行。
export const mcpAppsSamplingParamsSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.union([
              samplingBlockSchema,
              z.array(samplingBlockSchema).min(1).max(MCP_APPS_SAMPLING_MAX_BLOCKS),
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(MCP_APPS_SAMPLING_MAX_BLOCKS),
    systemPrompt: z.string().max(MCP_APPS_SAMPLING_MAX_BYTES).optional(),
    maxTokens: z.number().int().positive().safe(),
    includeContext: z.literal("none").optional(),
    modelPreferences: z
      .object({
        hints: z
          .array(z.object({ name: z.string().max(256).optional() }).strict())
          .max(16)
          .optional(),
        costPriority: priority,
        speedPriority: priority,
        intelligencePriority: priority,
      })
      .strict()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((params, ctx) => {
    const blocks = params.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [message.content],
    );
    let bytes = utf8Bytes(params.systemPrompt ?? "");
    for (const block of blocks)
      bytes += block.type === "image" ? decodedBytes(block.data) : utf8Bytes(block.text);
    // metadata 不转发给 provider，但仍计入边界预算，避免任意扩展字段绕过载荷限制。
    const metadataBytes = utf8Bytes(
      JSON.stringify({
        metadata: params.metadata,
        _meta: params._meta,
        blockMetadata: blocks.map((b) => ({ _meta: b._meta, annotations: b.annotations })),
      }),
    );
    if (
      blocks.length > MCP_APPS_SAMPLING_MAX_BLOCKS ||
      bytes + metadataBytes > MCP_APPS_SAMPLING_MAX_BYTES
    )
      ctx.addIssue({ code: "custom", message: "Sampling content exceeds host limits" });
  });
// decodedBytes 按 base64 四字符三字节估算原始长度。
// 末尾 "==" 由 base64 填充规则扣 2 字节，单个 "=" 扣 1 字节。
// decodedBytes 的结果与 .refine 里的 MCP_APPS_IMAGE_MAX_BYTES 比较。
function decodedBytes(data: string): number {
  return (data.length * 3) / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
// result.role 是 z.literal("assistant")，模型不能改角色。
// model 与 stopReason 都是 .min(1) 必填，空串会被拒。
// content 是 .strict() 的 text 块，image 与 audio 不接受。
export const mcpAppsSamplingResultSchema = z
  .object({
    role: z.literal("assistant"),
    model: z.string().min(1),
    content: z
      .object({ type: z.literal("text"), text: z.string().max(MCP_APPS_SAMPLING_MAX_BYTES) })
      .strict(),
    stopReason: z.string().min(1),
  })
  .strict();
export type McpAppsSamplingParams = z.infer<typeof mcpAppsSamplingParamsSchema>;
export type McpAppsSamplingResult = z.infer<typeof mcpAppsSamplingResultSchema>;
