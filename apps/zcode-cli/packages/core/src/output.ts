import type { JsonValue } from "@zcode/shared-types";

export { type JsonValue };

// 把 JsonValue 序列化为带 2 空格缩进、以换行结尾的多行文本。
// 输出直接面向终端/文件，故末尾补 \n；序列化失败（循环引用、BigInt）由 JSON.stringify 抛出。
// 纯函数，不做截断与转义，调用方需自行保证 value 可被 JSON 表示。
export const formatJson = (value: JsonValue): string => `${JSON.stringify(value, null, 2)}\n`;

// 判断输出流是否应启用 ANSI 颜色：显式 noColor（如 NO_COLOR/--no-color）优先关闭，
// 其余仅看 stream.isTTY，非 TTY（重定向/管道）不输出转义序列。
// 只做能力判定，不写流、不读环境变量。
export const supportsColor = (stream: NodeJS.WriteStream, noColor: boolean): boolean => {
  if (noColor) {
    return false;
  }

  return Boolean(stream.isTTY);
};

// ANSI 样式工具集合：每个方法在 enabled=false 时原样返回文本，保证关闭颜色后输出宽度不变。
// 只包裹 SGR 序列，不重置其它终端状态；调用方需传入 supportsColor 的结果。
export const color = {
  // 加粗：\x1b[1m ... \x1b[22m（22 为加粗/暗淡的成对关闭）。
  bold: (text: string, enabled: boolean) => (enabled ? `\x1b[1m${text}\x1b[22m` : text),
  // 青色前景：\x1b[36m ... \x1b[39m（39 恢复默认前景色）。
  cyan: (text: string, enabled: boolean) => (enabled ? `\x1b[36m${text}\x1b[39m` : text),
  // 暗淡：\x1b[2m ... \x1b[22m，与 bold 共用关闭码。
  dim: (text: string, enabled: boolean) => (enabled ? `\x1b[2m${text}\x1b[22m` : text),
  // 绿色前景：\x1b[32m ... \x1b[39m，常用于成功状态。
  green: (text: string, enabled: boolean) => (enabled ? `\x1b[32m${text}\x1b[39m` : text),
  // 红色前景：\x1b[31m ... \x1b[39m，常用于失败/危险提示。
  red: (text: string, enabled: boolean) => (enabled ? `\x1b[31m${text}\x1b[39m` : text),
};
