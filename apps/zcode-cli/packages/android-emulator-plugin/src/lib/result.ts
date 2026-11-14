/**
 * MCP 工具结果构造工具：把任意业务返回值包装成协议要求的 CallToolResult。
 *
 * 职责边界：只做序列化与错误标记，不判断业务成功与否，也不执行任何 IO。
 * 输出口径：所有字段统一走 JSON.stringify(..., null, 2)，保证模型看到的稳定文本格式；
 * 图片结果固定为「一段文本 + 一张 image block」，文本放元数据，image 放 base64。
 * 失败语义：fail() 会设置 isError=true，工具层据此走错误分支；本模块自身不抛错。
 * 维护约束：只允许通过本模块构造返回值，避免各工具散落拼接 content 数组导致格式漂移。
 */
import type { CallToolResult } from "@modelcontextprotocol/server";

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

/**
 * 把业务对象序列化为缩进 JSON 文本结果。
 *
 * 输入为可 JSON 序列化的任意值，输出单个 text content。
 * 注意：若 value 含循环引用或 BigInt，JSON.stringify 会抛错；调用方需保证入参是可序列化的普通数据。
 * 无副作用、无错误标记。
 */
export function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

/**
 * 构造失败结果，供工具在预检失败、外部命令失败或参数非法时返回。
 *
 * 字符串原样输出（通常已是可读错误信息），其余类型按 JSON 落文本，避免上层传 Error 对象时丢字段。
 * 副作用：设置 isError=true 后由 MCP 层转换为错误响应；本函数不抛错、不记录日志。
 * 调用方应在 value 中带上足够上下文（命令、退出码、stderr 摘要），便于模型自查。
 */
export function fail(value: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

/**
 * 构造「元数据文本 + 图片」的复合结果，用于截图类工具。
 *
 * 输入 value 为伴随说明（如文件路径、分辨率），data 为 base64 编码的图像内容，mimeType 默认 PNG。
 * 输出 content 顺序固定为 [text, image]，模型侧先读描述再看图；顺序变动会影响解析，不可调整。
 * 副作用无；失败语义：data 非 base64 时协议层才报错，本函数不做校验，调用方需保证编码正确。
 */
export function image(value: unknown, data: string, mimeType = "image/png"): CallToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(value, null, 2) },
      { type: "image", data, mimeType },
    ],
  };
}
