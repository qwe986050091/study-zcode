import { BashOutputSchema, type ToolResultDisplayPayload } from "@zcode/contracts";

/**
 * 由 Bash 工具输出构造桌面端的 `bash_output` 展示卡；不可展示时返回 undefined（调用方退回通用卡片）。
 *
 * 门禁：输出必须通过 `BashOutputSchema`；已转后台、图像产物、带 `structuredContent` 的结果
 * 一律不出卡（它们各有专用渲染）；既未截断又没有落盘路径时也不出卡。
 *
 * 副作用：无。display 是**独立于模型 result budget** 的有界投影：正文按 UTF-8 字节截到
 * 150_000，超界即置 `truncated`，并与 stdout/stderr 的截断标记取并集，不覆盖既有事实。
 *
 * `outputPath` 只透传落盘路径，供客户端按需读取；它不是工具内的 artifact 引用协议。
 */
export function createBashResultDisplay(output: unknown): ToolResultDisplayPayload | undefined {
  const parsed = BashOutputSchema.safeParse(output);
  // 为什么：schema 不匹配说明输出形状已变，继续读字段会拼出一张错卡；宁可退回通用卡片。
  if (!parsed.success) return undefined;
  const result = parsed.data;
  // 已转后台 / 图像 / 结构化内容各自由别的卡片负责，这里不重复造一张会误导的 bash 卡。
  if (result.status === "backgrounded" || result.isImage || result.structuredContent?.length)
    return undefined;
  const outputPath = result.persistedOutputPath ?? result.rawOutputPath;
  const truncated = result.stdoutTruncated === true || result.stderrTruncated === true;
  // 既没截断也没落盘路径 → 卡上没有额外事实可画，直接走通用结果卡。
  if (!truncated && !outputPath) return undefined;

  // 原因：模型 envelope 会再次缩短正文且隐藏 Bash 的截断事实；Desktop 必须使用
  // 独立的有界头部展示，不能解析模型文案或把文件路径误当协议按需读取 ref。
  // 注意：150_000 是 display 通道自己的界，不是模型 result budget；display 不是发给模型的
  // 内容，所以必须在这里独立限长。
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const exceedsDisplayBudget = Buffer.byteLength(text, "utf8") > 150_000;
  // 用 stream:true 解码字节前缀：在 150_000 处切断时不会抛出，也不会把半个 UTF-8 字符
  // 解成替换字符；被切掉的尾部本来就落在 display 预算之外。
  const bounded = exceedsDisplayBudget
    ? new TextDecoder().decode(Buffer.from(text).subarray(0, 150_000), { stream: true })
    : text;
  return {
    kind: "bash_output",
    output: bounded,
    truncated: truncated || exceedsDisplayBudget,
    ...(outputPath ? { outputPath } : {}),
  };
}
