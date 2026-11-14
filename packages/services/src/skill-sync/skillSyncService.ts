// 本文件负责用户级 skill 的双向同步：候选扫描、按目录名/名称去重、归档导出与安全导入。
// 所有读写都必须落在 ~/.zcode/skills 或 ~/.agents/skills 之内，越界即视为攻击。
// INV-01：候选必须来自 walkSkillMarkdownPaths（有界深度加软链去重），自写递归会漏掉
//          MAX_SKILL_SCAN_DEPTH，遇到环形目录软链会挂起（守住：collectUserSkillCandidatesInRoot）。
// INV-02：.zcode/skills 覆盖 .agents/skills：同目录名或同名只保留 zcode 一份，
//          否则同一 skill 出现两个来源，设置页显示重复（守住：collectUserSkillCandidates）。
// INV-03：导入必须先解到 .sync-tmp-* 临时目录并校验 SKILL.md，再逐个复制到目标根；
//          直接解到 skills 根会让半成品目录污染远端配置（守住：importArchive）。
// INV-04：导入是「只增不改」：目标已存在一律 skipped，绝不覆盖用户内容；
//          覆盖会静默丢失用户手改的 SKILL.md（守住：importArchive 的两处存在性判断）。
// INV-05：临时目录必须在 finally 中递归删除，异常路径也不得残留（守住：importArchive 的 finally）。
// INV-06：归档解包总字节受 maxArchiveBytes 约束，先判压缩体积再解包，防压缩炸弹撑爆磁盘。
/* eslint-disable max-lines -- skill 同步服务集中维护候选扫描、远端判重和导入流程，避免拆分时扩大远端同步回归面。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  SkillSyncArchiveExportResult,
  SkillSyncCandidate,
  SkillSyncCandidateListResult,
  SkillSyncImportResult,
  SkillSyncRemoteStatusResult,
} from "@zcode/shared";
import type { ISkillSyncService } from "./skillSync.js";
import { createSkillSyncArchive, extractSkillSyncArchive } from "./skillSyncArchive.js";
import { normalizeSkillSyncRelativePath, resolveSkillSyncPathWithin } from "./skillSyncPath.js";
import { createSkillSyncSizeLimitError } from "./skillSyncErrors.js";
import {
  MAX_SKILL_SCAN_DEPTH,
  shouldWalkSkillDirectoryEntry,
  walkSkillMarkdownPaths,
} from "../skills/skillDiscoveryWalk.js";
import { checkRemoteSyncDirectoryWriteAccess } from "../remote-sync/remoteSyncWriteAccess.js";

// 「是不是 skill」的唯一判据是目录内存在 SKILL.md：不读配置也不看目录名，
// 保证候选、覆盖判定、导入三条路径的口径完全一致。
const SKILL_FILE_NAME = "SKILL.md";
// 20MB 可容纳含脚本与资源的正常 skill；导出与导入两侧都检查上限，
// 缺任一侧都会让超限归档在另一侧才暴露，白白多传一次。
const DEFAULT_MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

// 服务实例不持有可变状态，每次调用都重新扫描磁盘：skill 目录可能被外部编辑器改动，
// 缓存候选会让列表与真实目录不一致。maxArchiveBytes 由宿主注入，便于测试用小值覆盖上限分支。
export function createSkillSyncService(options?: { maxArchiveBytes?: number }): ISkillSyncService {
  const maxArchiveBytes = options?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  return {
// 列表同时回传 maxArchiveBytes，让 UI 在勾选阶段就能预估超限，无需先发一次导出请求。
    async listLocalUserSkillCandidates(): Promise<SkillSyncCandidateListResult> {
      return {
        candidates: await collectUserSkillCandidates(),
        maxArchiveBytes,
      };
    },
// 远端拉取前先判断这些 skill 在本机是否已存在，避免把用户已有内容再推一遍。
// 入参来自 renderer 或远端客户端，全部经 normalizeSkillSyncRelativePath 收窄，
// 不假设 UI 传来的 directoryName 已经是安全相对路径。
    async listRemoteUserSkillStatuses(params): Promise<SkillSyncRemoteStatusResult> {
// 判定根固定为用户级 .zcode/skills：项目级 skill 不参与远端同步，避免把仓库内文件推给他人。
      const root = getUserZcodeSkillRoot();
      const existingSkillPathByName = await collectUserSkillDirectoryPathByName();
      // skill sync service 会通过 RPC 暴露给 renderer / remote 客户端；
      // directoryName 不能只信 UI 候选，必须在服务端限制为 skills 根内的安全相对路径。
// [失败路径] 规范化失败（绝对路径、.. 逃逸）会直接抛错让整个请求失败；
// 静默丢弃非法项会让 UI 误以为该 skill 不存在，反而诱导用户重新推送。
      const directoryNames = params.directoryNames.map((directoryName) =>
        normalizeSkillSyncRelativePath(directoryName),
      );
// 同时维护 directoryName 到 name 的反查表：远端可能只记得名称而目录名已改，
// 允许按 name 命中本机已有目录，避免把同一 skill 当成新条目再推一次。
// key 与查询处使用同一个规范化函数，否则查表永远不命中。
      const requestedSkillNameByDirectory = new Map(
        (params.skills ?? []).map((skill) => [
          normalizeSkillSyncRelativePath(skill.directoryName),
          skill.name,
        ]),
      );
      return {
        statuses: directoryNames.map((directoryName) => {
          const path = resolveSkillSyncPathWithin(root, directoryName);
          if (existsSync(path)) {
            return { directoryName, exists: true, path };
          }
// [权衡] 先按目录命中再按名称兜底：目录命中说明路径未变，是更强的一致性证据；
// 两者都不中才报告不存在，避免误报让用户重复同步。
          const requestedName = requestedSkillNameByDirectory.get(directoryName);
          const existingPath = requestedName
            ? existingSkillPathByName.get(normalizeSkillNameKey(requestedName))
            : undefined;
          return existingPath
            ? { directoryName, exists: true, path: existingPath }
            : { directoryName, exists: false };
        }),
      };
    },
// 按 id 选中候选而不是按目录名：id 是目录路径的哈希，重命名不会串号。
// 体积二次校验必要，因为候选来自另一次扫描，期间文件可能被外部改大。
    async exportSkillsArchive(params): Promise<SkillSyncArchiveExportResult> {
      const candidates = await collectUserSkillCandidates();
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const selected = params.skillIds.map((id) => {
// [失败路径] 未知 id 直接抛错而不是跳过：导出集合必须与用户勾选一一对应，
// 静默少打包会让用户以为内容已包含。
        const candidate = candidateById.get(id);
        if (!candidate) {
          throw new Error(`skill sync candidate not found: ${id}`);
        }
        return candidate;
      });
// [资源] 归档条目取 realpath(dirname(path)) 而非原路径：软链必须解到真实目录，
// 否则打包会跟随链接吃到 skills 根之外的内容。
// archivePath 用 directoryName 保留用户在 skills 内的相对层级，导入端据此还原目录。
      const archiveEntries = await Promise.all(
        selected.map(async (candidate) => ({
          sourcePath: await realpath(dirname(candidate.path)),
          archivePath: candidate.directoryName,
        })),
      );
      const selectedBytes = selected.reduce((total, candidate) => total + candidate.sizeBytes, 0);
// [失败路径] 打包前就拒绝，避免先压出一个超大 Buffer 再丢弃；
// phase 字段让调用方区分「原始内容超限」与「归档超限」。
      if (selectedBytes > maxArchiveBytes) {
        throw createSkillSyncSizeLimitError({
          actualBytes: selectedBytes,
          maxBytes: maxArchiveBytes,
          phase: "selected-content",
        });
      }
      const archive = await createSkillSyncArchive(archiveEntries);
// 压缩后仍超限同样拒绝：内容是已压缩文件时压缩率接近 1，这一关是真实兜底。
      if (archive.byteLength > maxArchiveBytes) {
        throw createSkillSyncSizeLimitError({
          actualBytes: archive.byteLength,
          maxBytes: maxArchiveBytes,
          phase: "archive",
        });
      }
      return {
        archive,
        archiveBytes: archive.byteLength,
        skills: selected.map(({ id, name, directoryName }) => ({
          id,
          name,
          directoryName,
        })),
      };
    },
// 只探测 skills 根可写性，不创建任何文件：权限问题要在同步开始前暴露，
// 而不是等用户确认完才失败。
    async checkRemoteUserSkillWriteAccess() {
      return checkRemoteSyncDirectoryWriteAccess(getUserZcodeSkillRoot());
    },
// [失败路径] overwrite 一律拒绝而不是忽略：调用方若以为会覆盖，会得到与预期相反的结果，
// 显式报错才能让上层收敛到「只增不改」的语义（见 INV-04）。
    async importSkillsArchive(params): Promise<SkillSyncImportResult> {
      if (params.overwrite) {
        throw new Error("skill sync overwrite is not supported");
      }
// 解包前先按压缩体积快速拒绝，省掉一次临时目录创建与解压。
      if (params.archive.byteLength > maxArchiveBytes) {
        throw createSkillSyncSizeLimitError({
          actualBytes: params.archive.byteLength,
          maxBytes: maxArchiveBytes,
          phase: "archive",
        });
      }
      return await importArchive(params.archive, maxArchiveBytes);
    },
  };
}

// HOME 与 USERPROFILE 都要看：Windows 上只有后者稳定，Unix 上只有前者，
// 两者皆空才回落 os.homedir()，保证精简环境下的远端 server 也能定位用户目录。
function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

// 用户级 skill 根的唯一构造点，其它函数必须复用它；手写字符串会让判重与写入落到不同目录。
function getUserZcodeSkillRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "skills");
}

// .agents/skills 是兼容目录：只读参与候选与判重，写入一律落到 .zcode/skills。
function getUserAgentsSkillRoot(): string {
  return join(resolveUserHomeDir(), ".agents", "skills");
}

// 候选 = zcode 根优先 + agents 根补位，两级去重：
// 先按目录名与名称排除被 zcode 覆盖的项，再按 realpath 排除同一物理目录（软链别名）。
// 顺序反过来会把 agents 的同名 skill 留在列表里，直接违反 INV-02。
// 结果按 directoryName 排序，让 UI 与导出顺序稳定、可比对。
async function collectUserSkillCandidates(): Promise<SkillSyncCandidate[]> {
  const seenSkillRealpaths = new Set<string>();
  const userZcodeSkillRoot = getUserZcodeSkillRoot();
// 先扫 zcode，再算它覆盖了哪些目录名，两次读取同一棵树是刻意的：
// 覆盖判定需要全部含 SKILL.md 的目录，而候选只需要可用于同步的条目。
  const rawZcodeCandidates = await collectUserSkillCandidatesInRoot(userZcodeSkillRoot);
  const zcodeDirectoryNames = await collectCoveredSkillDirectoryNamesInRoot(userZcodeSkillRoot);
  const zcodeSkillNameKeys = new Set(
    rawZcodeCandidates.map((candidate) => normalizeSkillNameKey(candidate.name)),
  );
// [并发] seen 集合跨两个根共享，先到者占位：物理目录相同时 zcode 根优先，
// 这就是 INV-02 的实现方式，顺序不可调换。
  const zcodeCandidates = await dedupeCandidatesByCanonicalSkillPath(
    rawZcodeCandidates,
    seenSkillRealpaths,
  );
// 过滤同时排除「目录名被 zcode 覆盖」与「name 被 zcode 覆盖」：
// 后者针对同名但目录不同的情况，用户视角只有一份，不能出现两个候选。
  const agentsCandidates = await dedupeCandidatesByCanonicalSkillPath(
    (await collectUserSkillCandidatesInRoot(getUserAgentsSkillRoot())).filter(
      (candidate) =>
        !zcodeDirectoryNames.has(candidate.directoryName) &&
        !zcodeSkillNameKeys.has(normalizeSkillNameKey(candidate.name)),
    ),
    seenSkillRealpaths,
  );

  return [...zcodeCandidates, ...agentsCandidates].sort((left, right) =>
    left.directoryName.localeCompare(right.directoryName),
  );
}

// [权衡] 按 realpath 而非路径字符串去重：同一目录常以软链出现在两个根下，
// 字符串比较会漏掉；realpath 失败（链接已断）时退回原路径，宁可不去重也不丢候选。
// 去重只影响列表，不删除磁盘上的任何目录。
async function dedupeCandidatesByCanonicalSkillPath(
  candidates: SkillSyncCandidate[],
  seenSkillRealpaths: Set<string>,
): Promise<SkillSyncCandidate[]> {
  const result: SkillSyncCandidate[] = [];
  for (const candidate of candidates) {
    const canonicalPath = await realpath(candidate.path).catch(() => candidate.path);
    if (seenSkillRealpaths.has(canonicalPath)) {
      continue;
    }
    seenSkillRealpaths.add(canonicalPath);
    result.push(candidate);
  }
  return result;
}

// 根不存在时返回空列表而非抛错：全新安装或用户从未创建 skills 目录是正常状态。
async function collectUserSkillCandidatesInRoot(root: string): Promise<SkillSyncCandidate[]> {
  if (!existsSync(root)) {
    return [];
  }
  const candidates: SkillSyncCandidate[] = [];
  for await (const skillPath of walkSkillMarkdownPaths(root)) {
    const directoryPath = dirname(skillPath);
    const relativePath = normalizeSkillDirectoryRelativePath(root, directoryPath);
// 相对路径为空说明命中的是根本身（根下直接放 SKILL.md）：
// 根不是可同步的 skill 单位，跳过以免把整个 skills 目录打包成一个 skill。
    if (!relativePath) {
      continue;
    }
    const content = await readSkillFileOrNull(skillPath);
    if (content !== null) {
      const metadata = parseSkillMetadata(content, basename(relativePath));
      candidates.push({
        id: createCandidateId(directoryPath),
        name: metadata.name,
        directoryName: relativePath,
        description: metadata.description,
        path: skillPath,
        sizeBytes: await computeRecursiveSize(directoryPath),
      });
    }
  }

  // 远端同步候选必须复用设置页已有的有界扫描策略；
  // 自己维护递归会漏掉 MAX_SKILL_SCAN_DEPTH 和软链 realpath 去重，遇到环形目录软链会卡住。
  return candidates.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}

// 覆盖集合刻意用独立 DFS：需要记录所有含 SKILL.md 的目录，
// 而 walkSkillMarkdownPaths 只产出文件路径并按深度剪枝，两者用途不同不能合并。
// 深度仍受 MAX_SKILL_SCAN_DEPTH 约束，与候选扫描保持同一语义。
// 用显式栈而非递归：目录树可能很深，递归会在恶意软链结构上耗尽调用栈。
// 集合的值是相对 root 的路径，与候选的 directoryName 同形才可直接比较。
async function collectCoveredSkillDirectoryNamesInRoot(root: string): Promise<Set<string>> {
  const directoryNames = new Set<string>();
  if (!existsSync(root)) {
    return directoryNames;
  }
  const stack: Array<{ directoryPath: string; relativePath: string; depth: number }> = [
    { directoryPath: root, relativePath: "", depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const skillFilePath = join(current.directoryPath, SKILL_FILE_NAME);
    if (current.relativePath && (await readSkillFileOrNull(skillFilePath))) {
      directoryNames.add(current.relativePath);
    }
// 达到上限即停止下钻，但保留当前目录的判定结果：深于上限的 skill 不会出现在候选里，
// 这是与设置页扫描一致的有意取舍，不是遗漏。
    if (current.depth >= MAX_SKILL_SCAN_DEPTH) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current.directoryPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
// 忽略规则与候选扫描共用同一函数：两处一旦分叉，覆盖集合会与候选集合不一致，
// 结果是同一 skill 既被判定覆盖又没被覆盖，判重静默失效。
      if (!shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      const entryPath = join(current.directoryPath, entry.name);
      const isDirectory =
        entry.isDirectory() ||
// [资源] 软链只有能 stat 到且指向目录才下钻；断链与指向文件的链接都排除，
// 避免 stat 抛错终止整次扫描。环形链接由深度上限兜底。
        (entry.isSymbolicLink() && (await stat(entryPath).catch(() => undefined))?.isDirectory());
      if (!isDirectory) {
        continue;
      }
      stack.push({
        directoryPath: entryPath,
        relativePath: joinSkillRelativePath(current.relativePath, entry.name),
        depth: current.depth + 1,
      });
    }
  }

  return directoryNames;
}

// 统一用正斜杠：Windows 天然产出反斜杠，不归一会让同一 skill 在去重时得到两个 key，
// 也会让归档内的路径与实际目录层级对不上。
function normalizeSkillDirectoryRelativePath(root: string, directoryPath: string): string {
  return relative(root, directoryPath).replaceAll("\\", "/");
}

// 名称比较大小写不敏感：SKILL.md 的 name 由作者手写，大小写差异不应产生第二个来源。
function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function joinSkillRelativePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

// [失败路径] 只有 ENOENT 映射为 null（文件不存在是「不是 skill」的正常情形），
// 权限与 IO 错误必须上抛，否则不可读的 skill 会被静默当成不存在。
async function readSkillFileOrNull(skillPath: string): Promise<string | null> {
  try {
    return await readFile(skillPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// 解析 frontmatter 的 name 与 description：任何失败都退回目录名加空描述，
// 因为一个手写错的 YAML 不该让整个列表请求失败。
// [权衡] 用正则切出 --- 块而不是 parse 全文：SKILL.md 正文常含 --- 分隔线，
// 全文解析会把正文当 YAML 而抛错。
function parseSkillMetadata(
  content: string,
  fallbackName: string,
): {
  name: string;
  description: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) {
    return { name: fallbackName, description: "" };
  }

// [失败路径] YAML 语法错误一律降级为默认元数据；不记录错误详情，避免把文件内容写进日志。
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return { name: fallbackName, description: "" };
  }
  const metadata = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const name =
    typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : fallbackName;
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  return { name, description };
}

// id 由绝对目录路径哈希得出：跨请求稳定，UI 可据此保持选中态；改名即换 id，
// 与「改名是一次新的选择」的交互语义一致。
function createCandidateId(skillDirectoryPath: string): string {
  return createHash("sha256").update(skillDirectoryPath).digest("hex");
}

// [资源] 递归求大小必须同时防软链环与重复计入：visitedDirectories 按 realpath 记录，
// 否则同一目录经两条链接被访问会放大体积，进而误触发 maxArchiveBytes。
// 该函数只服务体积预估，任何单项读取失败都按 0 处理而不是让整个列表失败。
// 结果不缓存：候选每次重新扫描，这里复用缓存会与磁盘实际内容脱节。
async function computeRecursiveSize(
  path: string,
  visitedDirectories = new Set<string>(),
): Promise<number> {
  const pathStat = await lstat(path);
// [权衡] 软链单独分支而不是直接用 lstat.size：链接本身的大小无意义，
// 但完全跳过会让「用软链组织 skill 目录」的用户导出体积恒为 0。
  if (pathStat.isSymbolicLink()) {
    const targetStat = await stat(path).catch(() => null);
    if (!targetStat) {
      return 0;
    }
    if (targetStat.isFile()) {
      return targetStat.size;
    }
    if (targetStat.isDirectory()) {
      return await computeDirectorySize(path, visitedDirectories);
    }
    return 0;
  }
  if (pathStat.isFile()) {
    return pathStat.size;
  }
  if (!pathStat.isDirectory()) {
    return 0;
  }
  return await computeDirectorySize(path, visitedDirectories);
}

// 每个子项并发求和；结果只用于上限判断，因此不追求精确的增量一致性。
async function computeDirectorySize(
  path: string,
  visitedDirectories: Set<string>,
): Promise<number> {
  const canonicalPath = await realpath(path).catch(() => path);
  if (visitedDirectories.has(canonicalPath)) {
    return 0;
  }
  visitedDirectories.add(canonicalPath);
  const children = await readdir(path, { withFileTypes: true });
  const childSizes = await Promise.all(
    children.map((child) => computeRecursiveSize(join(path, child.name), visitedDirectories)),
  );
  return childSizes.reduce((total, size) => total + size, 0);
}

// 名称到目录的索引，用于导入时判定「同名 skill 是否已在其它目录存在」。
// 同一名称只保留首个命中，与候选列表的优先级一致（先扫到的赢）。
// 只索引含 SKILL.md 且可读的目录，解析失败的条目用目录名兜底后仍参与判重。
async function collectSkillDirectoryPathByName(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!existsSync(root)) {
    return result;
  }
  for await (const skillPath of walkSkillMarkdownPaths(root)) {
    const content = await readSkillFileOrNull(skillPath);
    if (content === null) {
      continue;
    }
    const directoryPath = dirname(skillPath);
    const metadata = parseSkillMetadata(content, basename(directoryPath));
    const nameKey = normalizeSkillNameKey(metadata.name);
    if (!result.has(nameKey)) {
      result.set(nameKey, directoryPath);
    }
  }
  return result;
}

// [权衡] agents 根只补空缺而不覆盖 zcode 的同名项：写入目标是 .zcode/skills，
// 已经在那里存在的 skill 才是用户当前真正使用的版本。
async function collectUserSkillDirectoryPathByName(): Promise<Map<string, string>> {
  const result = await collectSkillDirectoryPathByName(getUserZcodeSkillRoot());
  const agentsSkillPathByName = await collectSkillDirectoryPathByName(getUserAgentsSkillRoot());
  for (const [nameKey, directoryPath] of agentsSkillPathByName) {
    if (!result.has(nameKey)) {
      result.set(nameKey, directoryPath);
    }
  }
  return result;
}

// 导入主流程：建临时目录 → 解包 → 逐个校验并复制 → finally 清理。
// 用 results 逐条返回而不是首个失败即抛出：单个 skill 失败不应让其它条目回滚，
// 上层按条目展示部分成功，与 UI 的逐行状态一一对应。
async function importArchive(
  archive: Uint8Array,
  maxArchiveBytes: number,
): Promise<SkillSyncImportResult> {
// 导入只写 .zcode/skills：agents 目录是兼容读取位，向其写入会让同一 skill 出现两个来源。
  const targetRoot = getUserZcodeSkillRoot();
  await mkdir(targetRoot, { recursive: true });
// [资源] 临时目录放在 skills 根之下：跨设备复制会丢权限位甚至失败；
// 随机后缀保证并发导入互不干扰，也让残留目录可被识别与清理。
  const tempRoot = join(targetRoot, `.sync-tmp-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    // 远端同步接收的是本机传来的归档，必须先解到临时目录并校验 SKILL.md，
    // 再逐个复制到用户级 skills 根，避免路径穿越或半成品目录污染远端配置。
    await extractSkillSyncArchive(archive, tempRoot, {
      maxExtractedBytes: maxArchiveBytes,
    });
// 解包后重新扫描而不是相信归档里的条目清单：只认可磁盘上真实存在 SKILL.md 的目录，
// 空目录、符号链接与多层嵌套自然不会进入导入循环。
    const extractedSkillDirectories = await collectExtractedSkillDirectories(tempRoot);
    // 远端 SkillsService 会同时读取用户级 .zcode/skills 和 .agents/skills。
    // 同名 skill 已在兼容目录存在时也必须跳过，避免同步后在 .zcode 下生成重复来源。
    const existingSkillPathByName = await collectUserSkillDirectoryPathByName();
// 顺序处理而不是并发复制：后面的同名判重依赖前面条目已写入并更新索引。
    const results: SkillSyncImportResult["results"] = [];
    for (const extracted of extractedSkillDirectories) {
// 直接复用解包时算出的相对路径，保证落盘层级与归档内一致。
      const { directoryName, sourcePath } = extracted;
// directoryName 来自解包结果，理论上已受控，落盘前仍做一次根内约束：
// 这是防路径穿越的最后一道闸，绕过它就能写到用户目录任意位置。
      const targetPath = resolveSkillSyncPathWithin(targetRoot, directoryName);
      const skillContent = await readSkillFileOrNull(join(sourcePath, SKILL_FILE_NAME));
// [失败路径] 缺 SKILL.md 记为 failed 而不是 skipped：这不是「已存在」，
// 需要让用户知道归档本身不完整。
      if (skillContent === null) {
        results.push({
          name: basename(directoryName),
          directoryName,
          status: "failed",
          error: "SKILL.md is missing",
        });
        continue;
      }

// 解析出的 name 才是用户视角的唯一标识，目录名只用于展示与落盘位置；
// 因此同名判定必须用 metadata.name 而不是目录名。
      const metadata = parseSkillMetadata(skillContent, directoryName);
      const nameKey = normalizeSkillNameKey(metadata.name);
// [事务] 目标目录已存在即跳过，绝不合并或覆盖（见 INV-04）；
// 用存在性判断而不是 try-catch cp，是为了在复制前就给出准确的 skipped 状态。
      if (existsSync(targetPath)) {
        results.push({
          name: metadata.name,
          directoryName,
          status: "skipped",
          path: targetPath,
        });
        continue;
      }
// 目录名不同但 name 相同也跳过：用户级 skills 按 name 去重加载，
// 写入第二份会让实际生效版本取决于加载顺序，属于不可诊断的行为。
// 命中时回填已有路径，让 UI 能提示「已存在于别处」。
      const existingPathForName = existingSkillPathByName.get(nameKey);
      if (existingPathForName) {
        results.push({
          name: metadata.name,
          directoryName,
          status: "skipped",
          path: existingPathForName,
        });
        continue;
      }

      try {
        await mkdir(dirname(targetPath), { recursive: true });
// [事务] cp 关闭覆盖（errorOnExist 与 force:false）：即使前面的存在性判断有竞态，
// 复制本身也不会覆盖已有目录，最坏结果是抛错并记 failed。
// recursive 必须开启：SKILL.md 之外还可能有脚本与资源文件，只复制入口文件会让 skill 残缺。
        await cp(sourcePath, targetPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        results.push({
          name: metadata.name,
          directoryName,
          status: "synced",
          path: targetPath,
        });
// 成功后立刻更新索引，使同一归档内后续同名条目也能被正确跳过。
        existingSkillPathByName.set(nameKey, targetPath);
      } catch (error) {
        results.push({
          name: metadata.name,
          directoryName,
          status: "failed",
          path: targetPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
// 部分成功同样返回结果集：只有解包、建临时目录这类整体性失败才会抛出。
    return { results };
  } finally {
// [资源] finally 中无条件递归删除临时目录：force 让「已被清理」不报错，
// 但这行若抛错会覆盖原始异常，因此不在此处追加捕获逻辑。
// 删除对象必须是 tempRoot，绝不能是 targetRoot，两者的作用域不可混用。
    await rm(tempRoot, { recursive: true, force: true });
  }
}

// 遍历解包结果收集含 SKILL.md 的目录；与候选扫描不同这里不设深度上限，
// 归档层级由导出方生成，裁剪会把合法的深层 skill 静默丢掉。
async function collectExtractedSkillDirectories(root: string): Promise<
  Array<{
    directoryName: string;
    sourcePath: string;
  }>
> {
  const directories: Array<{ directoryName: string; sourcePath: string }> = [];
  const stack: Array<{ directoryPath: string; relativePath: string }> = [
    { directoryPath: root, relativePath: "" },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
// 根目录本身不算一个 skill（relativePath 为空），与候选扫描的口径保持一致。
    if (current.relativePath && existsSync(join(current.directoryPath, SKILL_FILE_NAME))) {
      directories.push({
        directoryName: current.relativePath,
        sourcePath: current.directoryPath,
      });
    }
// [失败路径] 这里不吞 ENOENT：临时目录由本函数独占，读不到说明被外部删除，
// 属于必须暴露的异常，而不是「目录为空」。
    const entries = await readdir(current.directoryPath, { withFileTypes: true });
    for (const entry of entries) {
// 只下钻真实目录且复用统一忽略规则（.git、node_modules 等）：
// 解包目录可能携带隐藏目录，规则不一致会导出又导入一批噪声。
      if (!entry.isDirectory() || !shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      stack.push({
        directoryPath: join(current.directoryPath, entry.name),
        relativePath: joinSkillRelativePath(current.relativePath, entry.name),
      });
    }
  }
// 排序让导入结果与归档内目录顺序无关，便于比对与测试断言。
  return directories.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}
