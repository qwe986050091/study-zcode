// ============================================================
// memory/recall/manifest —— 记忆目录扫描与选择器所需的 manifest
// ============================================================
//
// 【定位】Semantic Recall 的“目录层”：递归扫描 memoryRoot 下所有 .md
//   （排除 MEMORY.md 本身），产出带 filename/description/type/mtime 的条目。
//
// 【读写边界】只读：listDirectory、stat、readTextFileRange；不写文件与索引。
// 【字段口径】
//   filename：相对 memoryRoot 的 POSIX 路径，是选择器返回值的匹配键。
//   mtimeMs：stat 的修改时间，用于按新到旧排序与过期提示；缺失回退 0。
//   description/type：取自文件前 30 行的 frontmatter，不读取正文其余部分。
// 【缓存口径】manifest 缓存在会话 state 上，首次非空扫描后不再重扫；
//   会话中途新增/删除的文件不会反映，直到 state 重建。
// 【失败语义】扫描整体异常返回空数组；单文件失败由 allSettled 丢弃。
// ============================================================
import { basename, relative, sep } from "node:path";
import type { FileSystemPort } from "@zcode/contracts";
import { parse as parseYaml } from "yaml";

import {
  MEMORY_RECALL_TYPES,
  type MemoryManifestEntry,
  type MemoryRecallState,
  type MemoryRecallType,
} from "./types.js";

// manifest 条目上限：按 mtime 取最新 200 个，避免超大记忆库撑爆选择器 prompt。
const MANIFEST_FILE_LIMIT = 200;
// 只读前 30 行提取 frontmatter，足够覆盖 description/type，且避免整文件读取。
const MANIFEST_PREVIEW_LINE_LIMIT = 30;

/**
 * 全量扫描 memoryRoot 生成 manifest（不写缓存）。
 * 输入：FileSystemPort、rootDir（memoryRoot 绝对路径）、可选 abortSignal。
 * 输出：按 mtime 从新到旧、最多 200 条的 MemoryManifestEntry。
 * 副作用：只读文件系统，可能产生多次 list/stat/读文件。
 * 失败语义：目录不可读或递归异常时整批返回空数组（降级为“没有可用记忆”）；
 *   单个文件读取失败只丢弃该项。
 * 不变量：排序后截断保证选择器看到的是最新记忆；
 *   同一文件不会重复出现（递归收集阶段按路径去重语义天然成立）。
 */
export async function scanMemoryManifest(input: {
  fileSystem: FileSystemPort;
  rootDir: string;
  signal?: AbortSignal;
}): Promise<MemoryManifestEntry[]> {
  try {
    const paths = await collectMemoryPaths(input.fileSystem, input.rootDir, input.signal);
    const settled = await Promise.allSettled(
      paths.map((filePath) =>
        readManifestEntry(input.fileSystem, input.rootDir, filePath, input.signal),
      ),
    );
    return settled
      .filter(
        (result): result is PromiseFulfilledResult<MemoryManifestEntry> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value)
      // 新到旧排序后再截断：优先保留最近改动过的记忆。
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, MANIFEST_FILE_LIMIT);
  } catch {
    // 目录不存在/不可读等整体失败：返回空 manifest，召回链路静默降级。
    return [];
  }
}

/**
 * 读取会话级 manifest（优先复用缓存）。
 * 输入：FileSystemPort、rootDir、可选 abortSignal、会话 state。
 * 输出：MemoryManifestEntry[]；失败或 aborted 时为 []。
 * 副作用：首次扫描会读目录；成功时写入 state.manifest 与 state.selectorMessages。
 * 失败语义：不抛错；扫描异常由 scanMemoryManifest 降级为空数组。
 * 不变量：aborted 时绝不写缓存——否则会话会永久持有一份不完整的 manifest；
 *   空 manifest 不写缓存，允许下一次查询重新扫描。
 */
export async function getMemoryRecallManifest(input: {
  fileSystem: FileSystemPort;
  rootDir: string;
  signal?: AbortSignal;
  state: MemoryRecallState;
}): Promise<MemoryManifestEntry[]> {
  // 已有非空缓存直接复用；空数组视为“未扫描成功”，继续走重新扫描。
  if (input.state.manifest && input.state.manifest.length > 0) {
    return input.state.manifest;
  }

  const manifest = await scanMemoryManifest(input);
  // abort 后不写任何缓存：调用方已放弃本轮，缓存不完整会污染后续查询。
  if (input.signal?.aborted) return [];
  if (manifest.length > 0) {
    input.state.manifest = manifest;
    // 同时初始化粘性对话的第一条消息，后续 selector 请求不必重复拼 manifest。
    input.state.selectorMessages = [createManifestMessage(manifest)];
  }
  return manifest;
}

/**
 * 把 manifest 渲染成给选择器/模型阅读的文本清单。
 * 每行：`- [type] filename (ISO 时间)`，有 description 时追加 `: 描述`。
 * 输出：以换行连接的字符串；空 manifest 时为 ""。
 * 副作用：无。
 * 不变量：时间用 mtime 的 ISO 字符串，便于模型判断新旧；不输出绝对路径，
 *   避免泄露本机目录结构。
 */
export function formatMemoryManifest(manifest: readonly MemoryManifestEntry[]): string {
  return manifest
    .map((entry) => {
      const type = entry.type ? `[${entry.type}] ` : "";
      const timestamp = new Date(entry.mtimeMs).toISOString();
      const base = `- ${type}${entry.filename} (${timestamp})`;
      return entry.description ? `${base}: ${entry.description}` : base;
    })
    .join("\n");
}

/**
 * 构造 selector 粘性对话的第一条 user 消息（“Available memories: …”）。
 * cacheControl=ephemeral：该清单在多次查询间不变，适合走 prompt 缓存。
 */
function createManifestMessage(manifest: readonly MemoryManifestEntry[]) {
  return {
    role: "user" as const,
    content: `Available memories:\n${formatMemoryManifest(manifest)}`,
    cacheControl: { type: "ephemeral" as const },
  };
}

/**
 * 递归收集 memoryRoot 下所有候选记忆文件路径。
 * 输入：文件系统、起始目录、abortSignal。
 * 输出：绝对路径数组（顺序为目录列举顺序，最终由 manifest 排序覆盖）。
 * 副作用：只读目录与 stat。
 * 失败语义：目录列举失败或 abort 会向上抛，由 scanMemoryManifest 整体降级；
 *   失效的 symlink 单独吞掉。
 * 不变量：MEMORY.md 不进入 manifest（它是索引，不是可召回的记忆正文）。
 */
async function collectMemoryPaths(
  fileSystem: FileSystemPort,
  directory: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const listed = await fileSystem.listDirectory({ path: directory }, { signal });
  const paths: string[] = [];

  for (const entry of listed.entries) {
    if (entry.kind === "directory") {
      paths.push(...(await collectMemoryPaths(fileSystem, entry.path, signal)));
      continue;
    }
    if (entry.kind === "file") {
      if (isMemoryCandidate(entry.path)) paths.push(entry.path);
      continue;
    }
    // symlink 只有指向普通文件才纳入；指向目录不递归，避免环与越界遍历。
    if (entry.kind !== "symlink" || !isMemoryCandidate(entry.path)) continue;

    try {
      const target = await fileSystem.stat({ path: entry.path }, { signal });
      if (target.kind === "file") paths.push(entry.path);
    } catch {
      // 单个失效的文件 symlink 与单个无法读取的事实文件一样，不影响其他 manifest 项。
    }
  }

  return paths;
}

/**
 * 候选判定：.md 且 basename 不是 MEMORY.md。
 * 不看路径层级；memoryRoot 内的任意子目录都允许存放记忆。
 */
function isMemoryCandidate(filePath: string): boolean {
  return filePath.endsWith(".md") && basename(filePath) !== "MEMORY.md";
}

/**
 * 读取单个文件的 manifest 条目（stat 与前 30 行并发）。
 * 输入：文件系统、rootDir、文件路径、abortSignal。
 * 输出：MemoryManifestEntry；filename 统一为 POSIX 分隔符。
 * 副作用：只读 stat 与文件头。
 * 失败语义：stat/读取失败向上抛，由 scanMemoryManifest 的 allSettled 丢弃该项。
 * 不变量：description/type 只在解析成功且非空时写入，避免产生 undefined 字段；
 *   mtime 缺失时回退 0，排序时自然沉底。
 */
async function readManifestEntry(
  fileSystem: FileSystemPort,
  rootDir: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<MemoryManifestEntry> {
  const [stat, preview] = await Promise.all([
    fileSystem.stat({ path: filePath }, { signal }),
    fileSystem.readTextFileRange(
      { path: filePath, offsetLine: 0, limitLines: MANIFEST_PREVIEW_LINE_LIMIT },
      { signal },
    ),
  ]);
  const frontmatter = parseMemoryFrontmatter(preview.content);
  return {
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    filePath,
    filename: relative(rootDir, filePath).split(sep).join("/"),
    mtimeMs: stat.mtimeMs ?? 0,
    ...(frontmatter.type ? { type: frontmatter.type } : {}),
  };
}

/**
 * 从文件头解析 frontmatter 的 description 与 type。
 * 输入：文件前 30 行文本；输出：{description?, type?}，解析失败为 {}。
 * 副作用：无。
 * 失败语义：不抛错——BOM/CRLF 已归一化；没有开头 ---、缺少闭合 ---、
 *   YAML 异常、顶层不是 mapping，都返回空对象。
 * 不变量：type 优先取 metadata.type，其次顶层 type；只接受枚举内取值，
 *   非法值直接丢弃而不是降级成默认分类。
 */
function parseMemoryFrontmatter(content: string): {
  description?: string;
  type?: MemoryRecallType;
} {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  // frontmatter 必须从文件第一行开始；前面有空行或 BOM 残留都视为没有元数据。
  if (lines[0] !== "---") return {};

  const end = lines.indexOf("---", 1);
  if (end < 0) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, end).join("\n"));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};

  const description = typeof parsed.description === "string" ? parsed.description : undefined;
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : undefined;
  // 兼容两种写法：新格式 metadata.type 优先，旧格式顶层 type 兜底。
  const typeCandidate = metadata?.type ?? parsed.type;
  const type = isMemoryRecallType(typeCandidate) ? typeCandidate : undefined;
  return {
    ...(description ? { description } : {}),
    ...(type ? { type } : {}),
  };
}

/**
 * 普通对象守卫：排除 null 与数组（YAML 解析结果可能为标量/列表）。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryRecallType(value: unknown): value is MemoryRecallType {
  return typeof value === "string" && (MEMORY_RECALL_TYPES as readonly string[]).includes(value);
}
