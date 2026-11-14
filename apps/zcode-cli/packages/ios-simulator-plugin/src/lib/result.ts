/**
 * MCP 工具结果构造工具：把业务返回值包装成协议要求的 CallToolResult。
 *
 * 职责边界：只做序列化与错误标记，不判断业务成功、不执行 IO。
 * 输出口径：JSON 统一 2 空格缩进；图片结果固定为「文本 + image block」，文本放元数据、image 放 base64。
 * 失败语义：fail() 设置 isError=true；本模块自身不抛错。
 * 维护约束：所有工具都应经此模块构造返回值，避免各 handler 自行拼接 content 导致格式漂移。
 */
import type { CallToolResult } from "@modelcontextprotocol/server";

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

/**
 * 把业务对象序列化为缩进 JSON 文本结果。
 * 入参必须是可 JSON 序列化的普通数据；循环引用/BigInt 会让 JSON.stringify 抛错，本函数不做兜底。
 */
export function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

/**
 * 构造失败结果，供参数非法、外部命令失败或无可用模拟器时返回。
 * 字符串原样输出，其它类型按 JSON 落文本（避免 Error 对象序列化丢字段）；
 * 设置 isError=true 后由 MCP 层转为错误响应。不抛错、不记录日志。
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
 * content 顺序固定为 [text, image]，模型侧先读描述再看图，顺序不可调整；
 * data 必须是 base64，本函数不校验编码，错误会在协议层暴露。
 */
export function image(value: unknown, data: string, mimeType = "image/png"): CallToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(value, null, 2) },
      { type: "image", data, mimeType },
    ],
  };
}
