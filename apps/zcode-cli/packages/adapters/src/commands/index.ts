// INV-01 扫描顺序按优先级升序，先扫到的同名命令胜出：守住位置 排序与冲突分支；改错故障 低优先级定义覆盖高优先级。
// INV-02 同名只记警告不覆盖：守住位置 冲突诊断；改错故障 命令来源悄悄改变。
// INV-03 禁用路径在发现阶段剔除：守住位置 禁用集合判断；改错故障 发现与读取口径不一致。
// INV-04 禁用路径统一解析为绝对路径：守住位置 构造时集合映射；改错故障 相对路径漏禁。
// INV-05 每个循环层级都检查取消：守住位置 中止检查；改错故障 大目录扫描无法中断。
// INV-06 命令名匹配固定小写与字符集：守住位置 名称正则；改错故障 非法字符进入调用语法。
// INV-07 插件命名空间使用小写加斜杠前缀：守住位置 名称拼接；改错故障 插件间同名冲突。
// INV-08 frontmatter 只接受六个白名单键：守住位置 白名单集合；改错故障 未知键被静默丢弃。
// INV-09 未知键只警告不拒绝：守住位置 诊断严重级别；改错故障 升级后旧命令失效。
// INV-10 描述缺失时回退到正文首个有效行：守住位置 描述推导；改错故障 命令被误判无效。
// INV-11 正文与描述都为空才报错：守住位置 空值判断；改错故障 纯标题文件被拒绝。
// INV-12 描述长度上限 1024：守住位置 截断调用；改错故障 超长描述撑爆列表。
// INV-13 读取上限默认 100KB：守住位置 常量；改错故障 超大命令整份读入内存。
// INV-14 超限时只读文件头并标记截断：守住位置 随机读分支；改错故障 截断标记与真实大小矛盾。
// INV-15 返回的字节数来自实际读取量：守住位置 缓冲区长度；改错故障 统计口径错误。
// INV-16 内容必须剥离 frontmatter 后去空白：守住位置 返回字段；改错故障 正文混入元数据。
// INV-17 扫描深度上限 12：守住位置 深度判断；改错故障 深层目录无限递归。
// INV-18 悬空符号链接跳过而不中断：守住位置 目标检查捕获；改错故障 一个坏链接让整目录为空。
//
// 模块职责：发现、解析并按名读取自定义命令文件，产出元数据与诊断。
// 状态所有权：无状态；禁用集合在构造时固化，其余数据按调用即时计算。
// 阅读顺序：先看发现流程与冲突处理，再读按名读取，最后看扫描与 frontmatter 解析。
// ============================================================
// Node Custom Command Adapter
// ============================================================
/**
 * ============================================================================
 * commands/index.ts —— 自定义 .md 命令的发现/解析/读取
 * ============================================================================
 *
 * 【定位】扫描所有 command roots（优先级小的先扫），把 `.md` 文件名转为
 * 命令名（相对路径分隔符换成 ":"，可带 root.namespace 前缀），解析极简
 * frontmatter（平铺 key: value），产出元数据。
 *
 * 【同名冲突】先扫到的 root 优先；后来的同名命令只记 warning，不覆盖已有项。
 *
 * 【输入口径】discoverCommands 返回 commands（按名排序）+ diagnostics +
 * totalDiscovered（含重复/被禁用前的总数）。loadCommand 按名回查后读正文，
 * 超过 maxBytes（默认 100KB）只读前 N 字节并标记 truncated。
 *
 * 【副作用】只读文件系统；符号链接会 stat 跟随，悬空链接跳过。
 *
 * 【失败语义】根目录不存在视为空；单文件读取/扫描失败降级为 diagnostic，
 * 不中断整体发现。只有"命令不存在"和"操作取消"会抛错。
 * ============================================================================
 */

import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type {
  CustomCommandContent,
  CustomCommandDiagnostic,
  CustomCommandLoadOutcome,
  CustomCommandMetadata,
  CustomCommandOperationOptions,
  CustomCommandPort,
  CustomCommandRoot,
} from "@zcode/contracts";
import {
  resolveDefaultCustomCommandRoots,
  type CustomCommandRootResolutionOptions,
} from "./roots.js";

const COMMAND_EXTENSION = ".md";
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_:-]{0,63}$/;
const DEFAULT_MAX_COMMAND_BYTES = 100_000;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_SCAN_DEPTH = 12;
const SAFE_FRONTMATTER_KEYS = new Set([
  "allowed-tools",
  "argument-hint",
  "description",
  "disable-noninteractive",
  "model",
  "skills",
]);

export interface NodeCustomCommandAdapterOptions extends CustomCommandRootResolutionOptions {
  // 被禁用的命令 .md 绝对路径集合（来自 config.json 的 command.<path>.enable=false）。
  // 命中的命令在发现阶段直接剔除，使 discover/load/inspect 全链路保持一致。
  disabledPaths?: Iterable<string>;
}

// NodeCustomCommandAdapter 无跨调用状态：构造只把 options.disabledPaths 逐个 resolve 存成 ReadonlySet，discover/load 每次都重新经 resolveDefaultCustomCommandRoots 解析根；唯一持久状态就是这份禁用集合，discover 的 has 判断与 load 复用同一次 discover，漏禁会让 enable=false 的命令仍被按名读到。
// discoverCommands 与 loadCommand 都收 CustomCommandOperationOptions，取消检查由 throwIfAborted 在每层 root/文件循环前执行；不要在 parseCommand 内补检查，否则单文件读取期间无法中断。
export class NodeCustomCommandAdapter implements CustomCommandPort {
  /** 规范化后的禁用路径集合；构造时一次解析，后续只做 O(1) 命中判断。 */
  private readonly disabledPaths: ReadonlySet<string>;

  /** 构造：把 disabledPaths 全部 resolve 成绝对路径，避免相对/绝对混写导致漏禁。 */
  constructor(private readonly options: NodeCustomCommandAdapterOptions = {}) {
    this.disabledPaths = new Set(Array.from(options.disabledPaths ?? [], (path) => resolve(path)));
  }

  /**
   * 发现所有 root 下的自定义命令。
   *
   * roots 未传时按默认顺序解析（项目/用户/插件等）；优先级数字小的 root 先扫，
   * 因此同名时它胜出。返回按命令名排序的元数据、诊断与总发现数（含重复）。
   * 只读文件系统；取消在每层循环间检查。
   */
  // 顺序是契约：先 throwIfAborted，再用 resolve(request.workingDirectory) 解析默认根，然后按 priority 升序 toSorted 扫描；同名时 selected 保留先到的 metadata，后来者只推 custom_command_duplicate_name 警告，反转优先级或改成覆盖会让低优先级 root 抢走命令名。
  // 禁用判断必须在 totalDiscovered++ 之前，且对 resolve(parsed.path) 再规范一次，保证与构造期集合的键一致；漏掉这步会让 config 中 enable=false 的命令仍出现在 loadCommand 的结果里。
  async discoverCommands(
    request: { roots?: CustomCommandRoot[]; workingDirectory: string },
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandLoadOutcome> {
    throwIfAborted(options);

    const workingDirectory = resolve(request.workingDirectory);
    const roots =
      request.roots ?? (await resolveDefaultCustomCommandRoots(workingDirectory, this.options));
    const diagnostics: CustomCommandDiagnostic[] = [];
    const selected = new Map<string, CustomCommandMetadata>();
    let totalDiscovered = 0;

    for (const root of roots.toSorted((a, b) => a.priority - b.priority)) {
      throwIfAborted(options);
      const commandPaths = await this.commandFilesUnderRoot(root, diagnostics);
      for (const path of commandPaths) {
        throwIfAborted(options);
        const parsed = await this.parseCommand(path, root, diagnostics);
        if (!parsed) continue;
        // 命中 config 禁用名单的命令不进入可用集合
        if (this.disabledPaths.has(resolve(parsed.path))) continue;
        totalDiscovered++;
        if (selected.has(parsed.name)) {
          // 保留先扫到的定义（priority 小者优先），后来的只报 warning，不覆盖。
          diagnostics.push({
            code: "custom_command_duplicate_name",
            commandName: parsed.name,
            message: `Duplicate custom command ignored: ${parsed.name}`,
            path,
            severity: "warning",
          });
          continue;
        }
        selected.set(parsed.name, parsed);
      }
    }

    return {
      commands: Array.from(selected.values()).toSorted((a, b) => a.name.localeCompare(b.name)),
      diagnostics,
      totalDiscovered,
    };
  }

  /**
   * 按名读取命令正文。
   *
   * 先完整 discover 再按规范化名称查找，保证与实际可用集合口径一致；
   * 输入 maxBytes 控制最大读取字节数（默认 100KB），超限时只读文件头并标记
   * truncated=true，sizeBytes 始终是文件真实大小。返回 content 已剥离 frontmatter。
   * 命令不存在抛 Error；文件 IO 错误原样抛出。
   */
  // loadCommand 不独立查找：先完整 discoverCommands，再按 normalizeCommandName(request.name) 匹配 outcome.commands，所以禁用、重复名与名称校验的结论与 discover 完全一致；匹配不到时抛 `Custom command not found`。
  // 读取方式由 stat(metadata.path).size 与 maxBytes（默认 DEFAULT_MAX_COMMAND_BYTES）比较决定：truncated 时 readFirstBytes 只取前 N 字节，sizeBytes 仍写 info.size；content 必须 stripFrontmatter 后再 trim，否则 frontmatter 会混进正文。
  async loadCommand(
    request: {
      maxBytes?: number;
      name: string;
      roots?: CustomCommandRoot[];
      workingDirectory: string;
    },
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandContent> {
    throwIfAborted(options);

    const outcome = await this.discoverCommands(
      {
        roots: request.roots,
        workingDirectory: request.workingDirectory,
      },
      options,
    );
    const normalizedName = normalizeCommandName(request.name);
    const metadata = outcome.commands.find((command) => command.name === normalizedName);
    if (!metadata) {
      throw new Error(`Custom command not found: ${request.name}`);
    }

    const maxBytes = request.maxBytes ?? DEFAULT_MAX_COMMAND_BYTES;
    // 先 stat 再决定读法：大文件用随机读只取前 N 字节，避免把超大命令整个读进内存。
    const info = await stat(metadata.path);
    const truncated = info.size > maxBytes;
    const buffer = truncated
      ? await readFirstBytes(metadata.path, maxBytes)
      : await readFile(metadata.path);

    return {
      metadata,
      bytesRead: buffer.byteLength,
      content: stripFrontmatter(buffer.toString("utf8")).trim(),
      sizeBytes: info.size,
      truncated,
    };
  }

  /**
   * 列出某个 root 下的候选 .md 文件。
   *
   * root 不存在或不是目录时返回空数组（不产生诊断）；其他扫描异常降级为
   * warning 并返回空，保证一个坏 root 不影响其余 root。
   */
  // commandFilesUnderRoot 把「根不存在/不是目录」与「扫描抛错」分开：stat(root.path) 后 !info.isDirectory() 或 isNotFoundError 都返回 [] 且不写诊断，其余异常才推 custom_command_scan_failed 的 warning；一个坏 root 不能中断 discoverCommands 对其余 root 的循环。
  // 取消检查留给调用方在遍历 commandPaths 时执行，这里不重复 throwIfAborted。
  private async commandFilesUnderRoot(
    root: CustomCommandRoot,
    diagnostics: CustomCommandDiagnostic[],
  ): Promise<string[]> {
    try {
      const info = await stat(root.path);
      if (!info.isDirectory()) return [];
      return await scanMarkdownFiles(root.path, diagnostics);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      diagnostics.push({
        code: "custom_command_scan_failed",
        message:
          error instanceof Error ? error.message : `Failed to scan command root: ${root.path}`,
        path: root.path,
        severity: "warning",
      });
      return [];
    }
  }

  /**
   * 解析单个命令文件为元数据。
   *
   * 失败一律返回 null 并写 diagnostic（读取失败/名称非法/缺少 description），
   * 由调用方跳过。name 由相对 root 的路径推导；namespace 存在时加
   * `<namespace>/<name>` 前缀，避免插件间同名冲突。
   */
  private async parseCommand(
    path: string,
    root: CustomCommandRoot,
    diagnostics: CustomCommandDiagnostic[],
  ): Promise<CustomCommandMetadata | null> {
    let rawContent: string;
    try {
      rawContent = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) return null;
      diagnostics.push({
        code: "custom_command_read_failed",
        message: error instanceof Error ? error.message : `Failed to read custom command: ${path}`,
        path,
        severity: "warning",
      });
      return null;
    }

    const name = commandNameFromPath(path, root.path);
    // 名称白名单限制为小写字母/数字开头，防止非法字符进入命令调用语法。
    if (!COMMAND_NAME_PATTERN.test(name)) {
      diagnostics.push({
        code: "custom_command_invalid_name",
        commandName: name,
        message: `Invalid custom command name: ${name}`,
        path,
        severity: "error",
      });
      return null;
    }

    const frontmatter = extractFrontmatter(rawContent);
    const parsed = frontmatter ? parseFlatYaml(frontmatter, path, diagnostics) : emptyFrontmatter();
    const body = stripFrontmatter(rawContent).trim();
    // description 缺失时退化为正文第一行（去掉标题/列表符号），仍为空才报错。
    const description = parseScalar(parsed.values.description) ?? extractDescription(body);
    if (!description) {
      diagnostics.push({
        code: "custom_command_invalid_frontmatter",
        commandName: name,
        message: `Custom command must include a description or non-empty body: ${path}`,
        path,
        severity: "error",
      });
      return null;
    }

    for (const key of parsed.keys) {
      // 未知 key 只警告不拒绝：向前兼容用户手写 frontmatter，避免升级后命令失效。
      if (SAFE_FRONTMATTER_KEYS.has(key)) continue;
      diagnostics.push({
        code: "custom_command_unknown_frontmatter",
        commandName: name,
        message: `Unknown custom command frontmatter key: ${key}`,
        path,
        severity: "warning",
      });
    }

    return {
      allowedTools: parseList(parsed.values["allowed-tools"]),
      argumentHint: parseScalar(parsed.values["argument-hint"]),
      description: truncate(description, MAX_DESCRIPTION_LENGTH),
      disableNonInteractive: parseBoolean(parsed.values["disable-noninteractive"]),
      frontmatterKeys: parsed.keys,
      model: parseScalar(parsed.values.model),
      name: root.namespace ? `${root.namespace.toLowerCase()}/${name}` : name,
      path,
      plugin: root.plugin,
      rootPath: root.path,
      scope: root.scope,
      skills: parseList(parsed.values.skills),
      source: root.source,
    };
  }
}

/** 创建无状态自定义命令适配器。 */
export function createNodeCustomCommandAdapter(
  options: NodeCustomCommandAdapterOptions = {},
): NodeCustomCommandAdapter {
  return new NodeCustomCommandAdapter(options);
}

// 递归边界：depth > MAX_SCAN_DEPTH 直接返回空；readdir 的 entry 先按 entry.isDirectory()/isFile() 分派，符号链接必须 await stat(path) 取目标类型，stat 抛错（悬空链接/无权限）时 continue 只跳过该项。
// 只有 isFile 且 name.toLowerCase().endsWith(COMMAND_EXTENSION) 的路径进入结果；readdir 抛错时推 custom_command_scan_failed 的 warning 并返回 []，单个目录失败不影响其余 root。
async function scanMarkdownFiles(
  directory: string,
  diagnostics: CustomCommandDiagnostic[],
  depth = 0,
): Promise<string[]> {
  // 深度上限 12，防止恶意/意外的深层目录导致无限递归；符号链接按目标类型处理，
  // 但不会做环检测（上层 root 通常是受控目录）。
  if (depth > MAX_SCAN_DEPTH) return [];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(path);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          // 悬空 symlink 或无权限：跳过该条目，继续扫描其余命令
          continue;
        }
      }
      if (isDirectory) {
        results.push(...(await scanMarkdownFiles(path, diagnostics, depth + 1)));
      } else if (isFile && entry.name.toLowerCase().endsWith(COMMAND_EXTENSION)) {
        results.push(path);
      }
    }
    return results;
  } catch (error) {
    diagnostics.push({
      code: "custom_command_scan_failed",
      message:
        error instanceof Error ? error.message : `Failed to scan command directory: ${directory}`,
      path: directory,
      severity: "warning",
    });
    return [];
  }
}

function commandNameFromPath(path: string, rootPath: string): string {
  const relativePath = relative(rootPath, path);
  const withoutExtension = relativePath.slice(0, -COMMAND_EXTENSION.length);
  return normalizeCommandName(withoutExtension.split(/[\\/]+/).join(":"));
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return null;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join("\n");
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return content;
  const lines = normalized.split(/\r?\n/);
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return content;
  return lines.slice(endIndex + 1).join("\n");
}

function emptyFrontmatter(): { keys: string[]; values: Record<string, string> } {
  return { keys: [], values: {} };
}

function parseFlatYaml(
  frontmatter: string,
  path: string,
  diagnostics: CustomCommandDiagnostic[],
): { keys: string[]; values: Record<string, string> } {
  const values: Record<string, string> = {};
  const keys: string[] = [];

  for (const [index, line] of frontmatter.split(/\r?\n/).entries()) {
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;

    const separator = line.indexOf(":");
    if (separator <= 0) {
      diagnostics.push({
        code: "custom_command_invalid_frontmatter",
        message: `Invalid frontmatter line ${index + 1} in ${basename(path)}`,
        path,
        severity: "warning",
      });
      continue;
    }

    const key = line.slice(0, separator).trim();
    keys.push(key);
    values[key] = line.slice(separator + 1).trim();
  }

  return { keys, values };
}

function parseScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseBoolean(value: string | undefined): boolean {
  const scalar = parseScalar(value)?.toLowerCase();
  return scalar === "true" || scalar === "yes";
}

function parseList(value: string | undefined): string[] {
  const scalar = parseScalar(value);
  if (!scalar) return [];
  const withoutBrackets = scalar.replace(/^\[/, "").replace(/\]$/, "");
  return withoutBrackets
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractDescription(body: string): string | undefined {
  const line = body
    .split(/\r?\n/)
    .map((candidate) =>
      candidate
        .replace(/^#+\s*/, "")
        .replace(/^[-*]\s*/, "")
        .trim(),
    )
    .find(Boolean);
  return line ? truncate(line, MAX_DESCRIPTION_LENGTH) : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

async function readFirstBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function throwIfAborted(options: CustomCommandOperationOptions | undefined): void {
  if (options?.signal?.aborted) {
    throw new Error("Custom command operation cancelled");
  }
}
