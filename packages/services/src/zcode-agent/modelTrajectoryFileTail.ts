import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataBaseDir } from "#src/paths.js";

// 32 MiB 足以覆盖常规最近调用，同时避免 64/256 MiB 诊断文件造成 Host 内存峰值。
const MAX_TRAJECTORY_READ_BYTES = 32 * 1024 * 1024;

// 返回值同时给出文本、实际读取字节与是否截断，调用方可据此决定是否需要回退诊断。
export interface TrajectoryFileTail {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

// debug（开发态）与 rollout（生产态）都尝试，避免数据目录环境变量差异导致读不到。
// 两个根目录都尝试：不同安装形态下数据目录可能落在用户家目录或应用数据目录。
export function resolveModelIODirs(): string[] {
  const roots = new Set<string>([
    join(homedir(), ".zcode", "cli"),
    join(getDataBaseDir(), ".zcode", "cli"),
  ]);
// 每个根目录展开为 debug 与 rollout 两个来源，顺序固定，调用方可按序探测。
  return [...roots].flatMap((root) => [join(root, "debug"), join(root, "rollout")]);
}

// 与 runner-debug.ts 的 sanitizeFileSegment 保持一致：仅保留文件名安全字符。
// 会话 id 来自外部，必须清洗成安全文件片段：非法字符折叠为连字符并去掉首尾连字符。
export function sanitizeSessionSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
// 长度上限防止超长 id 生成不可用的文件名。
    .slice(0, 80);
}

// 只读取文件尾部固定窗口，避免把整个诊断文件读进内存。
export async function readTrajectoryFileTail(filePath: string): Promise<TrajectoryFileTail> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
// [资源] 起点按上限回退：小文件从头读，大文件只保留最后 32 MiB。
// start 同时决定 truncated 标志，二者不能分开计算。
    const start = Math.max(0, size - MAX_TRAJECTORY_READ_BYTES);
    const length = size - start;
// allocUnsafe 只暴露实际读入的字节，未填充部分不会被 toString 读到。
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
// 读到 0 字节说明文件在读取期间被截断，跳出而不是空转。
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }

    let text = buffer.subarray(0, bytesRead).toString("utf8");
// 截断读取时首行很可能是不完整的 JSON，丢弃到第一个换行之后。
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
// truncated 只反映「是否从中途开始读」，与首行是否被丢掉无关。
    return { text, bytesRead, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}
