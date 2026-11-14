// INV-01 运行目录可反推：守住位置 getRunDir 的两级拼接；改错故障 列表扫描找不到已写入的运行。
// INV-02 分片前缀取前 8 位：守住位置 runId.slice(0, 8)；改错故障 单目录条目过多拖慢遍历。
// INV-03 建目录幂等：守住位置 mkdir recursive；改错故障 重跑同一 runId 抛已存在。
// INV-04 原始流追加写：守住位置 flags: "a"；改错故障 第二轮采集覆盖第一轮。
// INV-05 每条记录一行：守住位置 换行拼接；改错故障 多行 JSON 破坏 ndjson 逐行解析。
// INV-06 关闭需等待落盘：守住位置 closeStream 的 Promise；改错故障 退出时尾部记录丢失。
// INV-07 摘要写入自建目录：守住位置 writeJson 内 mkdir；改错故障 首次写摘要报 ENOENT。
// INV-08 列表按时间倒序：守住位置 createdAt 比较；改错故障 最新运行沉到列表底部。
// INV-09 缺根目录视为空：守住位置 readdir 的 catch；改错故障 首次启动直接报错。
// INV-10 只认 summary.json：守住位置 文件名判断；改错故障 raw.ndjson 被当摘要解析。
// INV-11 递归结果扁平化：守住位置 paths.flat()；改错故障 嵌套数组混入运行列表。
// INV-12 原始行只取尾部：守住位置 slice(-limit)；改错故障 面板显示最旧日志。
// INV-13 空行必须过滤：守住位置 filter(Boolean)；改错故障 尾部空串被当成一条记录。
// INV-14 相对路径基于数据目录：守住位置 toDataRelativePath；改错故障 前端拼错静态资源地址。
//
// 模块职责：stream-animate 服务端的运行数据落盘、读取与路径约定。
// 阅读顺序：先看路径构造函数，再看写入与读取，最后看扫描与流关闭的边界。
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Writable } from "node:stream";
import type { RunSummary } from "../shared/types.js";

export const DATA_DIR_NAME = ".stream-animate-data";

// createRunId 由时间戳加随机后缀组成，同秒多次启动也不会撞名。
export function createRunId(now = new Date()) {
  // 压成 14 位数字串，便于目录按名排序。
  const stamp = now.toISOString().replaceAll(/[-:.TZ]/gu, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export function getDataDir(packageRoot: string) {
  return join(packageRoot, DATA_DIR_NAME);
}

// 目录分两级，前 8 位充当分片。
export function getRunDir(packageRoot: string, runId: string) {
  // 分片名只取前缀，完整 id 才是叶子目录。
  return join(getDataDir(packageRoot), "runs", runId.slice(0, 8), runId);
}

export async function ensureRunDir(packageRoot: string, runId: string) {
  const runDir = getRunDir(packageRoot, runId);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

// createRawWriter 以 flags: "a" 追加写出原始记录，支持断点续采。
export function createRawWriter(runDir: string) {
  const rawPath = join(runDir, "raw.ndjson");
  // flags 必须是 "a" 而不是 "w"，否则重启会覆盖已采数据。
  const stream = createWriteStream(rawPath, { encoding: "utf-8", flags: "a" });
  return {
    path: rawPath,
    write(record: unknown) {
      stream.write(`${JSON.stringify(record)}\n`);
    },
    close: () => closeStream(stream),
  };
}

export async function writeRunSummary(runDir: string, summary: RunSummary) {
  await writeJson(join(runDir, "summary.json"), summary);
}

export async function writeResponseText(runDir: string, responseText: string) {
  await writeFile(join(runDir, "response.txt"), responseText, "utf-8");
}

// 运行集合靠扫描摘要文件反推。
export async function listRuns(packageRoot: string) {
  const runsRoot = join(getDataDir(packageRoot), "runs");
  const summaryPaths = await collectSummaryPaths(runsRoot);
  const runs = await Promise.all(
    summaryPaths.map(async (summaryPath) => JSON.parse(await readFile(summaryPath, "utf-8")) as RunSummary),
  );
  // ISO 时间戳可直接比较，倒序即最新在前。
  return runs.sort((first, second) => second.createdAt.localeCompare(first.createdAt));
}

export async function readRun(packageRoot: string, runId: string) {
  const summaryPath = join(getRunDir(packageRoot, runId), "summary.json");
  return JSON.parse(await readFile(summaryPath, "utf-8")) as RunSummary;
}

// 只取尾部若干行，避免整份日志回传前端。
export async function readRawLines(packageRoot: string, runId: string, limit: number) {
  const rawPath = join(getRunDir(packageRoot, runId), "raw.ndjson");
  const text = await readFile(rawPath, "utf-8");
  // 兼容 CRLF，过滤空行后取尾部。
  return text.split(/\r?\n/u).filter(Boolean).slice(-limit);
}

export function toDataRelativePath(packageRoot: string, filePath: string) {
  return relative(getDataDir(packageRoot), filePath);
}

// 递归收集所有摘要文件路径。
async function collectSummaryPaths(root: string): Promise<string[]> {
  let entries;
  try {
    // 读目录失败按空处理，首次运行没有数据目录属正常。
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const paths = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        return collectSummaryPaths(entryPath);
      }
      return entry.name === "summary.json" ? [entryPath] : [];
    }),
  );
  return paths.flat();
}

async function writeJson(path: string, body: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
}

// 等 end 回调再判定完成，防止尾部记录被截断。
async function closeStream(stream: Writable) {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}
