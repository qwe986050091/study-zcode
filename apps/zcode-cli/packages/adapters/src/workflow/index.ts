/**
 * ============================================================================
 * workflow/index.ts —— 工作流运行态与定义的文件存储
 * ============================================================================
 *
 * 【目录布局】rootDir 默认 ~/.zcode/cli/workflows：
 *   index.json           运行摘要索引（按 updatedAt 倒序）
 *   definitions/<id>.json 工作流定义
 *   runs/<runId>/run.json 运行快照
 *   runs/<runId>/events.jsonl、graph.jsonl 追加式事件/图记录
 *   runs/<runId>/<artifact> 产物（限制在 run 目录内）
 *
 * 【写入语义】JSON 快照/索引走 temp+rename 原子替换；events/graph 走 append
 * 单行 JSONL（并发追加依赖操作系统原子 append，不额外加锁）。写快照后必须
 * 更新索引，二者不是同一事务，崩溃可能留下"快照新、索引旧"的状态。
 *
 * 【校验】入口先过 zod schema（事件/图/快照/定义），防止坏数据落盘；读取时
 * 再 parse 一次，坏文件抛错而非静默降级。ENOENT 是常态，读取返回 null/[]。
 *
 * 【路径安全】runId/definitionId 都做字符白名单；artifact 相对路径 normalize
 * 后拒绝绝对路径与 `..`，确保不会写出 run 目录。
 *
 * 【取消】每个 IO 阶段前检查 signal；取消抛 signal.reason 或给定消息。
 * ============================================================================
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize, parse } from "node:path";
import type {
  WorkflowDefinition,
  WorkflowDefinitionStorePort,
  WorkflowEvent,
  WorkflowGraphRecord,
  WorkflowKind,
  WorkflowRunSnapshot,
  WorkflowRunListItem,
  WorkflowStorePort,
} from "@zcode/contracts";
import {
  WorkflowDefinitionSchema,
  WorkflowEventSchema,
  WorkflowGraphRecordSchema,
  WorkflowRunSnapshotSchema,
} from "@zcode/contracts";

export interface NodeWorkflowStoreOptions {
  rootDir?: string;
}

export interface NodeWorkflowDefinitionStoreOptions {
  definitionsDir?: string;
  rootDir?: string;
}

interface WorkflowIndexFile {
  runs: WorkflowRunListItem[];
}

const DEFAULT_WORKFLOW_ROOT = join(homedir(), ".zcode", "cli", "workflows");
const WORKFLOW_DEFINITION_FILE_EXTENSION = ".json";

/**
 * 运行态存储：事件、图、快照、产物与索引。
 *
 * rootDir 可在构造时注入（测试/多工作区隔离）；所有方法无进程内缓存，
 * 直接读写文件，避免多进程场景下内存与磁盘不一致。
 */
export class NodeWorkflowStore implements WorkflowStorePort {
  private readonly rootDir: string;

  constructor(options: NodeWorkflowStoreOptions = {}) {
    this.rootDir = options.rootDir ?? DEFAULT_WORKFLOW_ROOT;
  }

  /**
   * 追加一条工作流事件到 runs/<runId>/events.jsonl。
   *
   * 先按 schema 校验再写；单行追加不重写历史。取消在写前检查。
   * 写入失败向上抛（事件丢失意味着状态机无法重放，不能吞）。
   */
  async appendEvent(event: WorkflowEvent, options?: { signal?: AbortSignal }): Promise<void> {
    throwIfAborted(options?.signal, "Workflow event append cancelled");
    WorkflowEventSchema.parse(event);
    await appendJsonLine(this.eventsPath(event.runId), event, options?.signal);
  }

  /**
   * 追加一条图记录到 graph.jsonl。
   *
   * 与 appendEvent 同样的 schema + 追加语义；graph 用于可视化/诊断，
   * 不做跨记录一致性校验。
   */
  async appendGraphRecord(
    runId: string,
    record: WorkflowGraphRecord,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    throwIfAborted(options?.signal, "Workflow graph append cancelled");
    WorkflowGraphRecordSchema.parse(record);
    await appendJsonLine(this.graphPath(runId), record, options?.signal);
  }

  /**
   * 列出运行摘要。
   *
   * 按 cwd/kind 过滤后按 updatedAt 倒序；limit 为 undefined 返回全部。
   * 只读 index.json（不扫描 runs 目录），因此可能滞后于实际快照文件。
   */
  async listRuns(
    options: { cwd?: string; kind?: WorkflowKind; limit?: number } = {},
    signalOptions?: { signal?: AbortSignal },
  ): Promise<WorkflowRunListItem[]> {
    throwIfAborted(signalOptions?.signal, "Workflow run list cancelled");
    const index = await this.readIndex(signalOptions?.signal);
    const filtered = index.runs.filter(
      (run) =>
        (options.cwd === undefined || run.cwd === options.cwd) &&
        (options.kind === undefined || run.kind === options.kind),
    );
    const sorted = filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return options.limit === undefined ? sorted : sorted.slice(0, options.limit);
  }

  /**
   * 读取某次运行的全部事件（按写入顺序）。
   *
   * 文件不存在返回空数组；任一行 schema 不合法则整次读取抛错，
   * 避免把部分损坏的事件流交给状态机。
   */
  async readEvents(runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowEvent[]> {
    throwIfAborted(options?.signal, "Workflow event read cancelled");
    const lines = await readJsonLines(this.eventsPath(runId), options?.signal);
    return lines.map((line) => WorkflowEventSchema.parse(line));
  }

  /**
   * 取最近一次运行快照。
   *
   * 先 listRuns(limit=1) 找 runId，再读 run.json；没有运行或快照缺失返回 null。
   * 注意"最近"依据索引的 updatedAt，而非文件 mtime。
   */
  async readLatestRun(
    options: { cwd?: string; kind?: WorkflowKind } = {},
    signalOptions?: { signal?: AbortSignal },
  ): Promise<WorkflowRunSnapshot | null> {
    const [latest] = await this.listRuns({ ...options, limit: 1 }, signalOptions);
    if (!latest) return null;
    return await this.readRun(latest.runId, signalOptions);
  }

  /**
   * 读取单次运行快照。
   *
   * 文件不存在返回 null；存在但 schema 不合法抛错（不返回残缺快照）。
   */
  async readRun(
    runId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowRunSnapshot | null> {
    throwIfAborted(options?.signal, "Workflow snapshot read cancelled");
    const parsed = await readJson(this.snapshotPath(runId), options?.signal);
    return parsed === null ? null : WorkflowRunSnapshotSchema.parse(parsed);
  }

  /**
   * 写运行产物到 runs/<runId>/<relativePath>。
   *
   * relativePath 先 normalize 并拒绝绝对路径/`..`；写入走 temp+rename 原子替换，
   * 返回绝对路径与规范化后的相对路径。runId 经 sanitizePathSegment 处理。
   */
  async writeArtifact(
    runId: string,
    relativePath: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }> {
    throwIfAborted(options?.signal, "Workflow artifact write cancelled");
    const safeRelativePath = normalizeRelativePath(relativePath);
    const path = join(this.runRoot(runId), safeRelativePath);
    await writeTextFile(path, content, options?.signal);
    return { path, relativePath: safeRelativePath };
  }

  /** 写 report.md 的便捷入口，等价于 writeArtifact(runId, "report.md")。 */
  async writeReport(
    runId: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }> {
    return await this.writeArtifact(runId, "report.md", content, options);
  }

  /**
   * 写运行快照并更新索引。
   *
   * 两步是独立原子写、非同一事务：先 run.json 后 index.json。若第二步失败，
   * 快照已落盘但索引缺失，listRuns 看不到该运行（读取 run.json 仍可用）。
   * schema 校验失败时两步都不发生。
   */
  async writeSnapshot(
    snapshot: WorkflowRunSnapshot,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    throwIfAborted(options?.signal, "Workflow snapshot write cancelled");
    WorkflowRunSnapshotSchema.parse(snapshot);
    await writeJsonFile(this.snapshotPath(snapshot.runId), snapshot, options?.signal);
    await this.upsertIndex(snapshot, options?.signal);
  }

  /**
   * 以 runId 为键 upsert 索引项并整体重写 index.json。
   *
   * 先过滤掉旧同 runId 项再插入新项，保证同一次运行只占一行；排序仍按
   * updatedAt 倒序。并发写同一 index 时后写覆盖先写（无锁，单进程假设）。
   */
  private async upsertIndex(snapshot: WorkflowRunSnapshot, signal?: AbortSignal): Promise<void> {
    const index = await this.readIndex(signal);
    const item: WorkflowRunListItem = {
      completedAt: snapshot.completedAt,
      createdAt: snapshot.createdAt,
      cwd: snapshot.cwd,
      kind: snapshot.kind,
      runId: snapshot.runId,
      status: snapshot.status,
      task: snapshot.task,
      updatedAt: snapshot.updatedAt,
    };
    const nextRuns = [item, ...index.runs.filter((run) => run.runId !== snapshot.runId)].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    );
    await writeJsonFile(this.indexPath(), { runs: nextRuns }, signal);
  }

  /**
   * 读取索引；文件缺失或 runs 字段不是数组时退化为空索引。
   *
   * 这里刻意宽松：索引只是目录，损坏时宁可丢失列表也不阻塞单次运行读写。
   */
  private async readIndex(signal?: AbortSignal): Promise<WorkflowIndexFile> {
    const parsed = await readJson(this.indexPath(), signal);
    if (parsed === null) return { runs: [] };
    const runs = Array.isArray((parsed as { runs?: unknown }).runs)
      ? (parsed as { runs: WorkflowRunListItem[] }).runs
      : [];
    return { runs };
  }

  private eventsPath(runId: string): string {
    return join(this.runRoot(runId), "events.jsonl");
  }

  private graphPath(runId: string): string {
    return join(this.runRoot(runId), "graph.jsonl");
  }

  private indexPath(): string {
    return join(this.rootDir, "index.json");
  }

  private runRoot(runId: string): string {
    return join(this.rootDir, "runs", sanitizePathSegment(runId));
  }

  private snapshotPath(runId: string): string {
    return join(this.runRoot(runId), "run.json");
  }
}

/** 创建运行态存储；options.rootDir 缺省为 ~/.zcode/cli/workflows。 */
export function createNodeWorkflowStore(options: NodeWorkflowStoreOptions = {}): WorkflowStorePort {
  return new NodeWorkflowStore(options);
}

/**
 * 工作流定义存储：definitions/<id>.json 的列举与读取。
 *
 * 只读；定义文件由上层（用户/导入器）写入。definitionId 同时用作文件名，
 * 因此读取前必须做文件安全校验。
 */
export class NodeWorkflowDefinitionStore implements WorkflowDefinitionStorePort {
  private readonly definitionsDir: string;

  constructor(options: NodeWorkflowDefinitionStoreOptions = {}) {
    this.definitionsDir =
      options.definitionsDir ?? join(options.rootDir ?? DEFAULT_WORKFLOW_ROOT, "definitions");
  }

  /**
   * 列出全部定义（按 definitionId 字典序）。
   *
   * 目录不存在返回空数组；只收 .json，文件名（去掉扩展名）即 definitionId。
   * 单个定义读取失败/校验失败会抛错（不跳过），保证调用方看到真实损坏。
   */
  async listDefinitions(options?: { signal?: AbortSignal }): Promise<WorkflowDefinition[]> {
    throwIfAborted(options?.signal, "Workflow definition list cancelled");
    let entries: string[];
    try {
      entries = await readdir(this.definitionsDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const definitionIds = entries
      .filter((entry) => extname(entry) === WORKFLOW_DEFINITION_FILE_EXTENSION)
      .map((entry) => parse(entry).name)
      .sort((a, b) => a.localeCompare(b));
    const definitions: WorkflowDefinition[] = [];
    for (const definitionId of definitionIds) {
      const definition = await this.readDefinition(definitionId, options);
      if (definition) definitions.push(definition);
    }
    return definitions;
  }

  /**
   * 按 definitionId 读取定义。
   *
   * 文件不存在返回 null；定义内 definitionId 必须与请求一致，否则抛错
   * （防止文件重命名/复制后身份错位）。definitionId 先过 validateDefinitionId。
   */
  async readDefinition(
    definitionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowDefinition | null> {
    throwIfAborted(options?.signal, "Workflow definition read cancelled");
    validateDefinitionId(definitionId);
    const parsed = await readJson(this.definitionPath(definitionId), options?.signal);
    if (parsed === null) return null;
    const definition = WorkflowDefinitionSchema.parse(parsed);
    if (definition.definitionId !== definitionId) {
      throw new Error(
        `Workflow definition id mismatch: requested ${definitionId}, file declares ${definition.definitionId}`,
      );
    }
    return definition;
  }

  private definitionPath(definitionId: string): string {
    return join(this.definitionsDir, `${definitionId}${WORKFLOW_DEFINITION_FILE_EXTENSION}`);
  }
}

/** 创建定义存储；definitionsDir 缺省为 <rootDir>/definitions。 */
export function createNodeWorkflowDefinitionStore(
  options: NodeWorkflowDefinitionStoreOptions = {},
): WorkflowDefinitionStorePort {
  return new NodeWorkflowDefinitionStore(options);
}

/** 默认工作流根目录（~/.zcode/cli/workflows），供上层展示/创建目录。 */
export function getDefaultWorkflowRoot(): string {
  return DEFAULT_WORKFLOW_ROOT;
}

/** 默认定义目录 <root>/definitions。 */
export function getDefaultWorkflowDefinitionsRoot(): string {
  return join(DEFAULT_WORKFLOW_ROOT, "definitions");
}

/**
 * 追加一行 JSON（JSONL 语义）。
 *
 * 目录按需递归创建；appendFile 依赖 OS 的追加原子性，因此多进程并发写同一
 * 文件时每条记录仍完整（不保证顺序）。取消在 mkdir 前检查。
 */
async function appendJsonLine(path: string, value: unknown, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal, "Workflow JSONL append cancelled");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

/**
 * 读 JSON；ENOENT 返回 null（"不存在"是常态），其他错误（语法/权限）抛出。
 *
 * 调用方据此区分"没有数据"与"数据坏了"。
 */
async function readJson(path: string, signal?: AbortSignal): Promise<unknown | null> {
  throwIfAborted(signal, "Workflow JSON read cancelled");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 读 JSONL 并逐行 parse。
 *
 * 空行（含纯空白）被忽略；ENOENT 返回空数组；其余错误（含某行 JSON 损坏）
 * 直接抛出，避免半损坏日志被误读。
 */
async function readJsonLines(path: string, signal?: AbortSignal): Promise<unknown[]> {
  throwIfAborted(signal, "Workflow JSONL read cancelled");
  try {
    const content = await readFile(path, "utf8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

/** JSON 美化写盘（2 空格缩进 + 末尾换行），复用 writeTextFile 的原子替换。 */
async function writeJsonFile(path: string, value: unknown, signal?: AbortSignal): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`, signal);
}

/**
 * 原子写文本：同目录 temp 文件 + rename。
 *
 * rename 在同一文件系统内原子，读者要么看到旧文件要么看到新文件，不会读到
 * 半个 JSON。temp 名带 UUID，避免并发写互相覆盖。
 */
async function writeTextFile(path: string, content: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal, "Workflow file write cancelled");
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

/**
 * 校验产物相对路径。
 *
 * normalize 后拒绝绝对路径、`..` 本身或以 `..\`/`../` 开头；返回规范化路径。
 * 注意只做字符串判定，不解析 symlink（run 目录由本适配器独占创建）。
 */
function normalizeRelativePath(value: string): string {
  const normalized = normalize(value);
  if (
    isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..\\`) ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Workflow artifact path must stay inside the run directory: ${value}`);
  }
  return normalized;
}

/** 把 runId 转成单层安全目录名：非 [A-Za-z0-9._-] 一律替换为 _，限长 120，空则 unknown。 */
function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

/**
 * 校验 definitionId 可安全用作文件名。
 *
 * 拒绝空、`.`/`..`、含 `/` 或 `\`、normalize 后变形、以及白名单外字符；
 * 不合法抛普通 Error（调用方输入问题）。
 */
function validateDefinitionId(value: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    normalize(value) !== value ||
    !/^[a-zA-Z0-9._-]+$/.test(value)
  ) {
    throw new Error(`Workflow definition id must be a file-safe name: ${value}`);
  }
}

/**
 * 取消检查。
 *
 * 已中止时优先抛 signal.reason（保留原始取消原因），否则抛带 message 的
 * Error；未中止静默返回。
 */
function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
