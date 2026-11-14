// Claude 原生会话历史（JSONL）：一行一条记录，空行忽略，解析失败必须带行号定位。
// 提供全量与只读文件头两种读取方式，后者用于大文件抽样而不加载整份历史。
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { JsonLineRecord } from "#src/session/claude-native/jsonLineRecord.js";

// 单行解析：错误信息里保留文件路径与行号，导入失败时用户可直接定位坏行。
// 这里不做字段级校验，返回值仅保证是 JSON 对象或标量。
function parseJsonLine(filePath: string, line: string, lineNumber: number): JsonLineRecord {
  try {
    return JSON.parse(line) as JsonLineRecord;
// 解析失败立即抛出：静默跳过坏行会让导入结果与源文件不一致。
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[claude-native] 解析 JSONL 失败 ${filePath}:${lineNumber} ${reason}`);
  }
}

// 全量读取：整文件加载后再切行，适用于需要完整历史的导入场景。
// `readJsonLinesFile` 过滤空行后再编号，空行不进入统计。
export async function readJsonLinesFile(filePath: string): Promise<JsonLineRecord[]> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
// 行号从 1 开始，未过滤空行时会与文件真实行号错位，这是全量读取路径的已知取舍。
  return lines.map((line, index) => parseJsonLine(filePath, line, index + 1));
}

// 只读前 maxLines 条有效记录：流式读取，读完即销毁句柄。
// 调用方传入非正数时直接返回空数组，不打开文件。
export async function readJsonLinesFileHead(
  filePath: string,
  maxLines: number,
): Promise<JsonLineRecord[]> {
// 提前返回避免为 0 条记录创建流和 readline 接口。
  if (maxLines <= 0) {
    return [];
  }

  const records: JsonLineRecord[] = [];
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

// 行号按物理行递增（含被跳过的空行），保证报错位置与编辑器一致。
  let lineNumber = 0;
  try {
    for await (const line of reader) {
      lineNumber += 1;
// `maxLines` 配额与解析都跳过空行：行号仍按物理行递增。
      if (line.trim().length === 0) {
        continue;
      }
      records.push(parseJsonLine(filePath, line, lineNumber));
      if (records.length >= maxLines) {
        break;
      }
    }
    return records;
// 无论正常读完还是中途抛错，都必须关闭 readline 与底层流。
  } finally {
// 先关 readline 再销毁流，避免接口继续向已销毁的流发起读取。
    reader.close();
    stream.destroy();
  }
}
