/**
 * tool/handlers/node-repl-model-content.ts —— js（node_repl）结果转模型内容
 *
 * 输出是"模型可见投影"，不是原始 JsOutput：顺序固定为 error → logs → result →
 * 截图路径 → （可选）image 块。错误只保留 stack 的帧部分（首行 name/message 已单独输出，
 * 且 message 可能多行，必须按完整 header 剥离）；有图片时 image 块排在文本摘要之前，
 * 与 canonical result order 一致。本文件不产生副作用，也不参与预算/截断。
 */
import type { JsOutput, ModelMessageContent, ModelMessageContentBlock } from "@zcode/contracts";

export function formatJsModelContent(output: unknown): ModelMessageContent {
  const o = output as JsOutput;
  const parts: string[] = [];
  if (o.error) {
    const errorHeader = `${o.error.name}: ${o.error.message}`;
    parts.push(errorHeader);
    // Error.stack 首行已经重复 name/message；再拼完整 stack 会让模型看到两遍
    // 同一错误正文。message 可能包含多行 locator context，必须剥离完整 header，不能只删第一行。
    const stackFrames = o.error.stack
      ? o.error.stack.startsWith(`${errorHeader}\n`)
        ? o.error.stack.slice(errorHeader.length + 1).trimEnd()
        : o.error.stack.split("\n").slice(1).join("\n").trimEnd()
      : undefined;
    if (stackFrames?.trim()) parts.push(stackFrames);
  }
  if (o.logs) parts.push(o.logs);
  if (o.result !== undefined) parts.push(`=> ${o.result}`);
  if (o.browserScreenshotPaths && o.browserScreenshotPaths.length > 0) {
    parts.push(
      o.browserScreenshotPaths.map((path) => `Browser screenshot saved to: ${path}`).join("\n"),
    );
  }
  const text = parts.length > 0 ? parts.join("\n") : "(no output)";
  // nodeRepl.emitImage 收集的图片 → image 内容块（dataUrl），让模型直接"看"到截图。
  // Canonical result order puts emitted rasters before their textual summary.
  if (o.images && o.images.length > 0) {
    const blocks: ModelMessageContentBlock[] = [];
    for (const img of o.images) {
      blocks.push({
        type: "image",
        mediaType: img.mimeType,
        dataUrl: `data:${img.mimeType};base64,${img.base64}`,
      });
    }
    blocks.push({ type: "text", text });
    return blocks;
  }
  return text;
}
