// ===========================================================================
// memoryService：用户级记忆读写 + 项目级记忆目录的只读编目与读取。
// INV-01：用户记忆固定为 ~/.claude/memory/MEMORY.md，agentId 不参与路径；
//         改成分 agent 文件名时旧内容会全部读不到，表现为记忆静默丢失。
// INV-02：项目记忆根与各级子目录必须是普通目录，符号链接一律拒绝，否则
//         readdir/realpath 会跟到数据目录之外，把任意本地文件列进 catalog。
// INV-03：对外文件名必须是单段名，并与 readdir 结果逐字相等；大小写不敏感
//         的文件系统会把 memory.md 解析到 MEMORY.md，绕过 catalog 白名单。
// INV-04：校验与读取之间必须可重入校验（稳定句柄 + validatePath），只在入口
//         查一次会让校验后被替换的目标被读到。
// INV-05：列表是只读快照，并发消失的 workspace/file 跳过而不报错，避免一次清理
//         拖垮整个刷新。INV-06：排序确定（index 优先 + en 字典序；时间降序 + id）。
// ===========================================================================
import type { Memory, MemoryConfig } from "@zcode/shared";
import {
  type IMemoryService,
  type ProjectMemoryFileSummary,
  type ProjectMemoryWorkspaceSummary,
} from "./memory.js";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { readProjectMemoryFileFromStableHandle } from "#src/memory/projectMemoryStableRead.js";
import { getZCodeDataRootDir } from "#src/paths.js";

// catalog 的 index/item 语义由这两个常量定义：MEMORY.md 是目录索引，
// 其余 .md 才是条目；若把索引也当条目，UI 会重复展示同一份内容。
const PROJECT_MEMORY_INDEX_FILE_NAME = "MEMORY.md";
// 每个 workspace 目录下只认一层 memory/，更深的层级不扫描，
// 否则 Agent 写入的临时产物会被误识别为长期记忆。
const PROJECT_MEMORY_DIRECTORY_NAME = "memory";
// workspaceId 形如 slug-16 位 hex；只用于剥出展示名，不修改原 id，
// 因为 id 还要原样拼回磁盘目录。
const PROJECT_KEY_SUFFIX_PATTERN = /^(.*)-[a-f0-9]{16}$/i;

// [失败路径] 只有 ENOENT 代表不存在；EACCES/ELOOP/ENOTDIR 必须继续上抛，
// 否则权限或环路问题会被伪装成空目录，用户看到的是记忆凭空消失。
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

// 项目记忆根的唯一构造点，跟随 ~/.zcode 数据根；不要在别处手拼。
function getProjectMemoriesRoot(): string {
  return join(getZCodeDataRootDir(), "cli", "memories", "projects");
}

// 单段名校验是路径穿越的唯一防线：空串、点、点点、含分隔符、
// basename 不相等都拒绝；只拦点点的话 a/../b 仍能逃出 workspace 根。
function isValidPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

// 文件名白名单按扩展名放宽，大小写等细节留到 readdir 精确比对再收紧。
function isProjectMemoryFileName(fileName: string): boolean {
  return (
    fileName === PROJECT_MEMORY_INDEX_FILE_NAME ||
    (fileName.endsWith(".md") && fileName !== PROJECT_MEMORY_INDEX_FILE_NAME)
  );
}

// 展示名优先取 slug，后缀不匹配或为空时回退原始 id，保证标签非空。
function resolveWorkspaceLabel(workspaceId: string): string {
  const slug = PROJECT_KEY_SUFFIX_PATTERN.exec(workspaceId)?.[1];
  return slug?.trim() || workspaceId;
}

// 用 lstat 看链接本身而不是跟随；两个条件同时成立才认普通目录，
// 因为部分挂载点上的 isDirectory() 会跟随链接。
async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

// 与 isPlainDirectory 的差别是「不存在即报错」：调用方已认定路径应存在。
async function requirePlainDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `Project Memory directory is not a regular directory: ${path}`,
    );
  }
}

// INV-02：根目录自身也要校验。只校验子目录时，挂在根上的 symlink
// 会让 list/read 整体跟随到数据目录之外，等于绕过全部子路径检查。
async function requireProjectMemoriesRoot(): Promise<string> {
  const projectsRoot = getProjectMemoriesRoot();
  // 只校验 workspace 子目录时，projectsRoot symlink 会让 list/read 跟随到本地数据目录外。
  await requirePlainDirectory(projectsRoot);
  return projectsRoot;
}

// 先 readdir 取磁盘真实名字再逐字比较，而不是直接 join 后打开：
// 大小写不敏感文件系统里 memory.md 会命中 MEMORY.md，按请求名就绕过白名单。
async function requireExactProjectMemoryFile(
  memoryRoot: string,
  fileName: string,
): Promise<string> {
  const memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
  const fileEntry = memoryEntries.find((entry) => entry.name === fileName);
  const requestedFilePath = join(memoryRoot, fileName);
  if (!fileEntry) {
    // 文件确实不存在时继续透传原始 ENOENT；只有大小写别名能命中时才拒绝读取。
// [失败路径] 文件确实不存在时让 lstat 抛出原始 ENOENT 向上透传；
// 只有大小写别名能命中时才走到下面的显式拒绝。
    await lstat(requestedFilePath);
    throw new Error(
      `Project Memory file name does not match exactly: ${fileName}`,
    );
  }
  if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) {
    throw new Error(`Project Memory file is not a regular file: ${fileName}`);
  }
  return requestedFilePath;
}

// [失败路径] realpath 后用 relative 判包含，比字符串前缀可靠：前缀比较会把
// /root-evil 当成 /root 的子路径。三段判断覆盖 ..、../ 开头与跨盘符的绝对路径；
// realpath 失败直接上抛，绝不放行。
async function assertContainedProjectMemoryPath(
  projectsRoot: string,
  targetPath: string,
): Promise<void> {
  const projectsRootRealPath = await realpath(projectsRoot);
  const targetRealPath = await realpath(targetPath);
  const relativePath = relative(projectsRootRealPath, targetRealPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Project Memory path is outside the local profile: ${targetPath}`,
    );
  }
}

// 固定 en locale 排序，避免不同机器/系统 locale 下同一条目顺序漂移。
function compareProjectMemoryFiles(
  left: ProjectMemoryFileSummary,
  right: ProjectMemoryFileSummary,
): number {
  if (left.kind !== right.kind) {
    return left.kind === "index" ? -1 : 1;
  }
  return left.name.localeCompare(right.name, "en");
}

// HOME 与 USERPROFILE 都可能存在但为空串，先 trim 判空再回退 homedir()，
// 否则会拼出 /.claude/memory 这种根目录路径。
function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

// 用户记忆目录固定为 ~/.claude/memory，与 workspace 无关，这是跨项目事实。
function getUserMemoryDir(): string {
  return join(resolveUserHomeDir(), ".claude", "memory");
}

/**
 * 获取 agent 对应的 memory 文件名
 */
// INV-01：当前所有 agent 共用 MEMORY.md，agentId 只是为将来分文件预留；
// 真按 agent 拆分前必须先迁移旧文件，否则既有记忆会读不到。
function getMemoryFileName(_agentId: string): string {
  // 目前只支持 MEMORY.md，后续可以根据 agent 类型扩展
  return "MEMORY.md";
}

/**
 * 创建 Memory 服务实例
 */
// 闭包工厂而非类：路径函数在每个实例中被捕获，测试可用替身隔离，
// 也避免调用方把实例当全局单例缓存。params.workspacePath 仅为接口兼容。
export function createMemoryService(): IMemoryService {
// 读语义：文件不存在返回 null（不是错误）；存在但为空返回空串 + enabled。
// 记忆是增强能力，读失败降级为 null，不能阻断会话启动。
  async function loadMemory(params: {
    workspacePath: string;
    agentId: string;
  }): Promise<{ memory: Memory | null }> {
    const { agentId } = params;

    try {
      const fileName = getMemoryFileName(agentId);
      const memoryDir = getUserMemoryDir();

      // 直接从用户级 ~/.claude/memory 目录读取
      const filePath = join(memoryDir, fileName);
      try {
// 一次性读入而非流式：记忆是用户手写的小文件，内容需整体交给模型。
        const content = await readFile(filePath, "utf-8");
        return {
          memory: {
// 空文件也返回 memory 对象并置 enabled，让 UI 能区分「功能可用但为空」
            content: content || "",
            enabled: true,
          },
        };
      } catch {
        // 文件不存在，返回 null
        return { memory: null };
      }
    } catch (error) {
// [失败路径] 外层只兜路径/环境异常；记录后返回 null，不向上抛。
      console.error("Failed to load memory:", error);
      return { memory: null };
    }
  }

// 写语义与读不对称：save 失败必须 rethrow 让用户知道没存上；
// mkdir recursive 保证首次使用时目录不存在也能一次写成功。
  async function saveMemory(params: {
    workspacePath: string;
    agentId: string;
    config: MemoryConfig;
  }): Promise<void> {
    const { agentId, config } = params;

    try {
      // 直接保存到用户级 ~/.claude/memory 目录
      const memoryDir = getUserMemoryDir();
      await mkdir(memoryDir, { recursive: true });

      const fileName = getMemoryFileName(agentId);
      const filePath = join(memoryDir, fileName);
// [权衡] 直接覆盖而非临时文件加 rename：崩溃最多丢本次编辑，
// 换来无需处理跨设备 rename 与权限继承；记忆不是事务性数据。
      await writeFile(filePath, config.content, "utf-8");
    } catch (error) {
      console.error("Failed to save memory:", error);
      throw error;
    }
  }

// 清空写成空串而不是 unlink：保留文件存在性，loadMemory 仍返回
// enabled 的空记忆，UI 不会把「已清空」误判为「功能不可用」。
  async function clearMemory(params: {
    workspacePath: string;
    agentId: string;
  }): Promise<void> {
    const { agentId } = params;

    try {
      const fileName = getMemoryFileName(agentId);
      const memoryDir = getUserMemoryDir();
      const filePath = join(memoryDir, fileName);

      try {
// [失败路径] 内层吞掉写失败：清空是幂等操作，只读或父目录缺失不必报错。
        await writeFile(filePath, "", "utf-8");
      } catch {
        // 文件不存在，忽略错误
      }
    } catch (error) {
      console.error("Failed to clear memory:", error);
      throw error;
    }
  }

// 返回前尽力建目录，让调用方拿到即可写；建目录失败不抛，真正写时再暴露。
  async function getUserMemoryDirectory(): Promise<{ path: string }> {
    const memoryDir = getUserMemoryDir();
    try {
      await mkdir(memoryDir, { recursive: true });
    } catch {
      // 目录已存在
    }
    return { path: memoryDir };
  }

// INV-05：列表是尽力而为的只读快照。根目录 ENOENT 说明从未用过项目记忆，
// 返回空数组而非错误；其它错误继续上抛。遍历中消失的条目直接跳过，
// 不重试补全，避免多次 readdir 之间看到不一致的目录版本。
  async function listProjectMemories(): Promise<
    ProjectMemoryWorkspaceSummary[]
  > {
    let projectsRoot: string;
    let projectEntries;
    try {
      projectsRoot = await requireProjectMemoriesRoot();
      projectEntries = await readdir(projectsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

// 只收集至少有一个合法文件的 workspace，空目录对 UI 没有信息量。
    const workspaces: ProjectMemoryWorkspaceSummary[] = [];
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) {
        continue;
      }

// 目录名就是 workspaceId，不做归一化：它同时用于拼路径和展示，
// 改写会让后续 readProjectMemoryFile 找不到同一目录。
      const workspaceId = projectEntry.name;
      const workspaceRoot = join(projectsRoot, workspaceId);
      const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
      if (
        !(await isPlainDirectory(workspaceRoot)) ||
        !(await isPlainDirectory(memoryRoot))
      ) {
        continue;
      }

      let memoryEntries;
      try {
// 目录检查之后仍可能被 Memory Agent 删除，这里再兜一次 ENOENT 并跳过。
        memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
      } catch (error) {
        // 目录检查后 Memory Agent 仍可能删除目录；catalog 快照只跳过已消失的 workspace。
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }
// withFileTypes 只给类型快照，大小与 mtime 仍要逐文件 lstat。
      const files: ProjectMemoryFileSummary[] = [];
      for (const memoryEntry of memoryEntries) {
        if (
          !memoryEntry.isFile() ||
          memoryEntry.isSymbolicLink() ||
          !isProjectMemoryFileName(memoryEntry.name)
        ) {
          continue;
        }

// entry.name 来自 readdir，天然是单段名；仍只与 memoryRoot 拼接。
        const filePath = join(memoryRoot, memoryEntry.name);
        let fileMetadata;
        try {
          fileMetadata = await lstat(filePath);
        } catch (error) {
          // readdir 后事实文件可能被并发删除；它不再属于本次只读快照。
          if (isNotFoundError(error)) {
            continue;
          }
          throw error;
        }
// [并发] readdir 与 lstat 之间文件可能被换成链接，以 lstat 为准再拒一次，
// 堵住「放普通文件、随后替换为指向别处的链接」这个窗口。
        if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
          continue;
        }
// kind 由文件名决定，保证徽标与排序键同源；size/mtime 取自同一次 lstat。
        files.push({
          name: memoryEntry.name,
          path: filePath,
          kind:
            memoryEntry.name === PROJECT_MEMORY_INDEX_FILE_NAME
              ? "index"
              : "item",
          size: fileMetadata.size,
          updatedAt: fileMetadata.mtimeMs,
        });
      }

// 空 workspace 不落 catalog：残留目录没有可读条目，
// 若保留会让已清理的项目长期占据列表。
      if (files.length === 0) {
        continue;
      }

// 在本次快照私有的数组上原地排序，不影响其它 workspace。
      files.sort(compareProjectMemoryFiles);
      workspaces.push({
        id: workspaceId,
        label: resolveWorkspaceLabel(workspaceId),
// workspace 时间取成员最大值：只改文件不改目录时目录 mtime 不会变，
// 取成员时间才能把它正确顶到列表前方。
        updatedAt: Math.max(...files.map((file) => file.updatedAt)),
        files,
      });
    }

// 外层按更新时间降序，再用 id 升序打破平局，保证同毫秒更新时顺序稳定。
    workspaces.sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.id.localeCompare(right.id, "en"),
    );
    return workspaces;
  }

// INV-03/INV-04：入口做单段名与白名单校验，之后每一步都重新解析目录，
// 并把「再次校验」回调交给稳定句柄，保证校验与读取指向同一目标。
  async function readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }> {
    if (
      !isValidPathSegment(params.workspaceId) ||
      !isValidPathSegment(params.fileName) ||
      !isProjectMemoryFileName(params.fileName)
    ) {
// [失败路径] 非法输入统一同一消息，不暴露是哪一段不合法，避免成为探测面。
      throw new Error("Invalid Project Memory path");
    }

    const projectsRoot = await requireProjectMemoriesRoot();
    const workspaceRoot = join(projectsRoot, params.workspaceId);
    const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
    await requirePlainDirectory(workspaceRoot);
    await requirePlainDirectory(memoryRoot);

    // Bugfix：大小写不敏感文件系统会让请求名称命中不同大小写的磁盘文件，绕过 catalog 白名单。
    const filePath = await requireExactProjectMemoryFile(
      memoryRoot,
      params.fileName,
    );
// 稳定句柄在读取前后各调一次 validatePath：校验不是读前检查，而是
// 同一句柄上的重新确认，路径被替换时读取直接失败而不是读到别的文件。
    return readProjectMemoryFileFromStableHandle({
      fileName: params.fileName,
      filePath,
      validatePath: async () => {
        await requireProjectMemoriesRoot();
        await requirePlainDirectory(workspaceRoot);
        await requirePlainDirectory(memoryRoot);
        await requireExactProjectMemoryFile(memoryRoot, params.fileName);
// 最后一道 realpath 包含性校验，防住前面各次 lstat 之后发生的路径替换。
        await assertContainedProjectMemoryPath(projectsRoot, filePath);
      },
    });
  }

  return {
// 只暴露接口约定的六个方法，内部辅助函数不泄漏到 IMemoryService 之外。
    loadMemory,
    saveMemory,
    clearMemory,
    getUserMemoryDirectory,
// 列表与单文件读取分开：列表只做目录编目，不读文件内容。
    listProjectMemories,
// 读取走稳定句柄，是本服务唯一会返回文件内容的入口。
    readProjectMemoryFile,
  };
}
